import { parse } from "acorn";

/**
 * Tiny source-instrumentation layer for the code visualizer.
 *
 * We don't interpret JavaScript. Instead we parse the snippet with acorn and
 * inject a `__vizStep(...)` call in front of every statement (and inside every
 * loop body). The injected call receives getters for the variables that are
 * currently in scope, so a worker can record a complete trace of the run while
 * the real JavaScript engine does the actual work.
 *
 * Inserted text never contains a newline, so editor line numbers stay correct.
 */

type AnyNode = any;

export type ParamInfo = {
  /** Position of the parameter in the signature. */
  index: number;
  /** Human readable label, e.g. `items` or `{ name, age }`. */
  label: string;
  /** Every identifier introduced by the parameter pattern. */
  bindingNames: string[];
  /** Source text of a default value, when there is one. */
  defaultText?: string;
};

export type CodeAnalysis = {
  functionName: string;
  /** Every top-level function that could be used as an entry point. */
  functions: string[];
  params: ParamInfo[];
};

export type CompileError = {
  ok: false;
  error: string;
  line?: number;
  column?: number;
};

export type AnalyzeResult = { ok: true; analysis: CodeAnalysis } | CompileError;

export type InstrumentResult =
  | {
      ok: true;
      code: string;
      functionName: string;
      params: ParamInfo[];
    }
  | CompileError;

type Insertion = { pos: number; text: string; order: number };

type WalkContext = {
  visible: string[];
  fnName: string;
  insertions: Insertion[];
};

function isFunctionNode(node: AnyNode): boolean {
  return (
    !!node &&
    (node.type === "FunctionDeclaration" ||
      node.type === "FunctionExpression" ||
      node.type === "ArrowFunctionExpression")
  );
}

function eachChild(node: AnyNode, visit: (child: AnyNode) => void) {
  for (const key of Object.keys(node)) {
    if (
      key === "loc" ||
      key === "start" ||
      key === "end" ||
      key === "range" ||
      key === "parent"
    ) {
      continue;
    }
    const value = node[key];
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item && typeof item.type === "string") visit(item);
      }
    } else if (value && typeof value === "object" && typeof value.type === "string") {
      visit(value);
    }
  }
}

function collectPatternNames(pattern: AnyNode, into: Set<string>) {
  if (!pattern) return;
  switch (pattern.type) {
    case "Identifier":
      into.add(pattern.name);
      break;
    case "ObjectPattern":
      for (const property of pattern.properties) {
        if (property.type === "RestElement") collectPatternNames(property.argument, into);
        else collectPatternNames(property.value, into);
      }
      break;
    case "ArrayPattern":
      for (const element of pattern.elements) collectPatternNames(element, into);
      break;
    case "AssignmentPattern":
      collectPatternNames(pattern.left, into);
      break;
    case "RestElement":
      collectPatternNames(pattern.argument, into);
      break;
    default:
      break;
  }
}

/** Bindings declared directly inside a scope, ignoring nested function bodies. */
function collectScopeBindings(root: AnyNode): Set<string> {
  const names = new Set<string>();

  const visit = (node: AnyNode) => {
    if (!node) return;
    if (isFunctionNode(node)) {
      if (node.type === "FunctionDeclaration" && node.id) names.add(node.id.name);
      return;
    }
    if (node.type === "VariableDeclaration") {
      for (const declaration of node.declarations) {
        collectPatternNames(declaration.id, names);
      }
    }
    if (node.type === "ClassDeclaration" && node.id) names.add(node.id.name);
    if (node.type === "CatchClause" && node.param) collectPatternNames(node.param, names);
    eachChild(node, visit);
  };

  eachChild(root, visit);
  return names;
}

function collectFunctionBindings(fn: AnyNode): Set<string> {
  const names = new Set<string>();
  if (fn.id) names.add(fn.id.name);
  for (const param of fn.params) collectPatternNames(param, names);
  for (const name of collectScopeBindings(fn.body)) names.add(name);
  return names;
}

function mergeVisible(parent: string[], own: Set<string>): string[] {
  const merged = new Map<string, true>();
  for (const name of parent) merged.set(name, true);
  for (const name of own) merged.set(name, true);
  return Array.from(merged.keys());
}

function patternLabel(node: AnyNode, source: string): string {
  if (node.type === "Identifier") return node.name;
  if (node.type === "RestElement") return "..." + patternLabel(node.argument, source);
  const label = source.slice(node.start, node.end).replace(/\s+/g, " ");
  return label.length > 34 ? label.slice(0, 31) + "..." : label;
}

function toParams(fn: AnyNode, source: string): ParamInfo[] {
  return fn.params.map((param: AnyNode, index: number) => {
    let pattern = param;
    let defaultText: string | undefined;
    if (param.type === "AssignmentPattern") {
      pattern = param.left;
      defaultText = source.slice(param.right.start, param.right.end);
    }
    const bindingSet = new Set<string>();
    collectPatternNames(param, bindingSet);
    return {
      index,
      label: patternLabel(pattern, source),
      bindingNames: Array.from(bindingSet),
      defaultText,
    };
  });
}

function findEntries(program: AnyNode): { node: AnyNode; name: string }[] {
  const entries: { node: AnyNode; name: string }[] = [];
  for (const statement of program.body) {
    if (statement.type === "FunctionDeclaration" && statement.id) {
      entries.push({ node: statement, name: statement.id.name });
      continue;
    }
    if (statement.type === "VariableDeclaration") {
      for (const declaration of statement.declarations) {
        if (
          declaration.id.type === "Identifier" &&
          declaration.init &&
          isFunctionNode(declaration.init)
        ) {
          entries.push({ node: declaration.init, name: declaration.id.name });
        }
      }
      continue;
    }
    if (
      statement.type === "ExpressionStatement" &&
      statement.expression.type === "AssignmentExpression" &&
      statement.expression.left.type === "Identifier" &&
      isFunctionNode(statement.expression.right)
    ) {
      entries.push({
        node: statement.expression.right,
        name: statement.expression.left.name,
      });
    }
  }
  return entries;
}

/** Prefer the caller's choice, otherwise assume the last function is the main one. */
function chooseEntry(
  entries: { node: AnyNode; name: string }[],
  preferredName?: string,
): { node: AnyNode; name: string } | null {
  if (!entries.length) return null;
  if (preferredName) {
    const match = entries.find((entry) => entry.name === preferredName);
    if (match) return match;
  }
  return entries[entries.length - 1];
}

function parseProgram(code: string): AnyNode {
  return parse(code, {
    ecmaVersion: "latest",
    sourceType: "script",
    locations: true,
  });
}

function fail(error: unknown): CompileError {
  const err = error as AnyNode;
  return {
    ok: false,
    error: err?.message ? String(err.message).replace(/\s*\(\d+:\d+\)$/, "") : "Could not parse the snippet.",
    line: err?.loc?.line,
    column: err?.loc?.column !== undefined ? err.loc.column + 1 : undefined,
  };
}

export function analyzeCode(code: string, preferredName?: string): AnalyzeResult {
  try {
    const program = parseProgram(code);
    const entries = findEntries(program);
    const entry = chooseEntry(entries, preferredName);
    if (!entry) {
      return {
        ok: false,
        error: "No function found. Declare one with `function name(...) { ... }`.",
      };
    }
    return {
      ok: true,
      analysis: {
        functionName: entry.name,
        functions: Array.from(new Set(entries.map((candidate) => candidate.name))),
        params: toParams(entry.node, code),
      },
    };
  } catch (error) {
    return fail(error);
  }
}

function snapshotText(line: number, ctx: WalkContext): string {
  const getters = ctx.visible
    .map((name) => `get ${name}(){return ${name};}`)
    .join(",");
  return `__vizStep(${line},${JSON.stringify(ctx.fnName)},{${getters}})`;
}

function applyInsertions(code: string, insertions: Insertion[]): string {
  const ordered = [...insertions].sort((a, b) => a.pos - b.pos || a.order - b.order);
  let cursor = 0;
  let output = "";
  for (const insertion of ordered) {
    if (insertion.pos < cursor) continue;
    output += code.slice(cursor, insertion.pos) + insertion.text;
    cursor = insertion.pos;
  }
  return output + code.slice(cursor);
}

function propertyName(node: AnyNode): string | undefined {
  const key = node.key;
  if (!key) return undefined;
  if (key.type === "Identifier") return key.name;
  if (key.type === "Literal" && typeof key.value === "string") return key.value;
  return undefined;
}

function createInstrumenter() {
  const insertions: Insertion[] = [];

  function instrumentStatementList(statements: AnyNode[], ctx: WalkContext) {
    for (const statement of statements) {
      if (!statement || statement.type === "EmptyStatement") continue;
      insertions.push({
        pos: statement.start,
        text: snapshotText(statement.loc.start.line, ctx) + ";",
        order: 20,
      });
      visitStatement(statement, ctx);
    }
  }

  /** Instrument a statement used as the body of if/for/while/... */
  function instrumentSubStatement(node: AnyNode, ctx: WalkContext) {
    if (!node || node.type === "EmptyStatement") return;
    if (node.type === "BlockStatement") {
      instrumentStatementList(node.body, ctx);
      return;
    }
    insertions.push({
      pos: node.start,
      text: `{${snapshotText(node.loc.start.line, ctx)};`,
      order: 20,
    });
    insertions.push({ pos: node.end, text: "}", order: 5 });
    visitStatement(node, ctx);
  }

  function walkFunction(fn: AnyNode, context: WalkContext, suggestedName?: string) {
    const own = collectFunctionBindings(fn);
    const visible = mergeVisible(context.visible, own);
    const fnName = fn.id?.name || suggestedName || context.fnName || "anonymous";
    const ctx: WalkContext = { ...context, visible, fnName };

    if (fn.body.type === "BlockStatement") {
      instrumentStatementList(fn.body.body, ctx);
    } else {
      // Expression-bodied arrow: use a sequence expression so this works for
      // object literals, nested arrows, and anything else the body returns.
      insertions.push({
        pos: fn.body.start,
        text: `(${snapshotText(fn.body.loc.start.line, ctx)},`,
        order: 10,
      });
      insertions.push({ pos: fn.body.end, text: ")", order: 0 });
      walkExpression(fn.body, ctx);
    }
  }

  function walkExpression(node: AnyNode, ctx: WalkContext) {
    if (!node || typeof node.type !== "string") return;

    if (isFunctionNode(node)) {
      walkFunction(node, ctx);
      return;
    }

    if (node.type === "VariableDeclarator") {
      if (node.init && isFunctionNode(node.init)) {
        walkFunction(
          node.init,
          ctx,
          node.id.type === "Identifier" ? node.id.name : undefined,
        );
      } else {
        walkExpression(node.id, ctx);
        walkExpression(node.init, ctx);
      }
      return;
    }

    if (node.type === "AssignmentExpression" && isFunctionNode(node.right)) {
      walkFunction(
        node.right,
        ctx,
        node.left.type === "Identifier" ? node.left.name : undefined,
      );
      return;
    }

    if (node.type === "Property" && isFunctionNode(node.value)) {
      walkFunction(node.value, ctx, propertyName(node));
      return;
    }

    eachChild(node, (child) => walkExpression(child, ctx));
  }

  function visitStatement(statement: AnyNode, ctx: WalkContext) {
    switch (statement.type) {
      case "FunctionDeclaration":
        walkExpression(statement, ctx);
        break;
      case "BlockStatement":
        instrumentStatementList(statement.body, ctx);
        break;
      case "VariableDeclaration":
        for (const declaration of statement.declarations) {
          walkExpression(declaration.id, ctx);
          walkExpression(declaration.init, ctx);
        }
        break;
      case "ExpressionStatement":
        walkExpression(statement.expression, ctx);
        break;
      case "IfStatement":
        walkExpression(statement.test, ctx);
        instrumentSubStatement(statement.consequent, ctx);
        if (statement.alternate) instrumentSubStatement(statement.alternate, ctx);
        break;
      case "ForStatement":
        walkExpression(statement.init, ctx);
        walkExpression(statement.test, ctx);
        walkExpression(statement.update, ctx);
        instrumentSubStatement(statement.body, ctx);
        break;
      case "ForInStatement":
      case "ForOfStatement":
        walkExpression(statement.left, ctx);
        walkExpression(statement.right, ctx);
        instrumentSubStatement(statement.body, ctx);
        break;
      case "WhileStatement":
        walkExpression(statement.test, ctx);
        instrumentSubStatement(statement.body, ctx);
        break;
      case "DoWhileStatement":
        instrumentSubStatement(statement.body, ctx);
        walkExpression(statement.test, ctx);
        break;
      case "ReturnStatement":
      case "ThrowStatement":
        walkExpression(statement.argument, ctx);
        break;
      case "SwitchStatement":
        walkExpression(statement.discriminant, ctx);
        for (const switchCase of statement.cases) {
          walkExpression(switchCase.test, ctx);
          instrumentStatementList(switchCase.consequent, ctx);
        }
        break;
      case "TryStatement":
        instrumentStatementList(statement.block.body, ctx);
        if (statement.handler) {
          instrumentStatementList(statement.handler.body.body, ctx);
        }
        if (statement.finalizer) {
          instrumentStatementList(statement.finalizer.body, ctx);
        }
        break;
      case "LabeledStatement":
        instrumentSubStatement(statement.body, ctx);
        break;
      case "WithStatement":
        walkExpression(statement.object, ctx);
        instrumentSubStatement(statement.body, ctx);
        break;
      case "ClassDeclaration":
      case "ClassExpression":
        walkExpression(statement, ctx);
        break;
      default:
        walkExpression(statement, ctx);
        break;
    }
  }

  function walkProgram(program: AnyNode) {
    const global = collectScopeBindings(program);
    const ctx: WalkContext = {
      visible: Array.from(global),
      fnName: "global",
      insertions,
    };
    for (const statement of program.body) {
      walkExpression(statement, ctx);
    }
  }

  return { insertions, walkProgram };
}

export function instrumentCode(code: string, preferredName?: string): InstrumentResult {
  try {
    const program = parseProgram(code);
    const entries = findEntries(program);
    const entry = chooseEntry(entries, preferredName);
    if (!entry) {
      return {
        ok: false,
        error: "No function found. Declare one with `function name(...) { ... }`.",
      };
    }

    const instrumenter = createInstrumenter();
    instrumenter.walkProgram(program);

    return {
      ok: true,
      code: applyInsertions(code, instrumenter.insertions),
      functionName: entry.name,
      params: toParams(entry.node, code),
    };
  } catch (error) {
    return fail(error);
  }
}
