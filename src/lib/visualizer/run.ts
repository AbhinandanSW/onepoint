/**
 * Runs instrumented user code inside a disposable Web Worker.
 *
 * A worker is used so a runaway loop can be terminated without freezing the
 * page, and so the user's snippet cannot touch the UI. The worker records a
 * complete trace (line, function, scoped variables) which the page replays as
 * a time-travel debugger.
 */

export type SerializedValue =
  | { kind: "primitive"; type: string; text: string }
  | { kind: "function"; name: string }
  | { kind: "array"; items: SerializedValue[]; length: number; truncated: boolean }
  | {
      kind: "object";
      className: string;
      hint?: "stack" | "queue" | "tree";
      entries: { key: string; value: SerializedValue }[];
      keyCount: number;
      truncated: boolean;
    }
  | {
      kind: "map";
      entries: { key: SerializedValue; value: SerializedValue }[];
      size: number;
      truncated: boolean;
    }
  | { kind: "set"; items: SerializedValue[]; size: number; truncated: boolean }
  | { kind: "circular" }
  | { kind: "unserializable"; note?: string };

export type VariableSnapshot = {
  name: string;
  type: string;
  preview: string;
  value: SerializedValue;
};

export type TraceStep = {
  index: number;
  line: number;
  fn: string;
  vars: VariableSnapshot[];
};

export type LogEntry = {
  level: "log" | "info" | "warn" | "error" | "debug";
  text: string;
  step: number;
  line: number;
};

export type RunError = {
  name: string;
  message: string;
  line?: number;
};

export type RunResponse = {
  ok: boolean;
  steps: TraceStep[];
  logs: LogEntry[];
  result?: VariableSnapshot;
  error?: RunError;
  durationMs: number;
  truncated?: boolean;
};

export type RunRequest = {
  code: string;
  functionName: string;
  args: unknown[];
  maxSteps?: number;
};

const WORKER_SOURCE = String.raw`
self.onmessage = async function (event) {
  var payload = event.data || {};
  var steps = [];
  var logs = [];
  var currentStep = 0;
  var currentLine = 0;
  var maxSteps = payload.maxSteps || 2500;
  var truncated = false;
  var started = performance.now();

  function typeName(value) {
    if (value === null) return "null";
    var kind = typeof value;
    if (kind !== "object") return kind;
    if (Array.isArray(value)) return "array";
    if (value instanceof Date) return "date";
    if (value instanceof Map) return "map";
    if (value instanceof Set) return "set";
    if (value instanceof RegExp) return "regexp";
    if (value instanceof Error) return "error";
    var tag = Object.prototype.toString.call(value).slice(8, -1);
    return tag ? tag.toLowerCase() : "object";
  }

  function preview(value, depth, seen) {
    depth = depth || 0;
    seen = seen || [];

    if (value === null) return "null";
    var kind = typeof value;
    if (kind === "undefined") return "undefined";
    if (kind === "string") {
      var text = value.length > 90 ? value.slice(0, 90) + "..." : value;
      return JSON.stringify(text);
    }
    if (kind === "number") return Object.is(value, -0) ? "-0" : String(value);
    if (kind === "boolean") return String(value);
    if (kind === "bigint") return String(value) + "n";
    if (kind === "symbol") return String(value);
    if (kind === "function") return "function " + (value.name || "anonymous") + "()";

    if (seen.indexOf(value) !== -1) return "[Circular]";
    if (value instanceof Date) return "Date(" + value.toISOString() + ")";
    if (value instanceof RegExp) return String(value);
    if (value instanceof Error) return value.name + ": " + value.message;
    if (depth > 2) return Array.isArray(value) ? "[" + value.length + " items]" : "{...}";

    var nextSeen = seen.concat([value]);
    try {
      if (Array.isArray(value)) {
        var items = [];
        for (var i = 0; i < value.length && i < 5; i++) {
          items.push(preview(value[i], depth + 1, nextSeen));
        }
        return "[" + items.join(", ") + (value.length > 5 ? ", ..." : "") + "]";
      }
      if (value instanceof Map) {
        var entries = [];
        var entryIndex = 0;
        value.forEach(function (entryValue, entryKey) {
          if (entryIndex < 5) entries.push(preview(entryKey, depth + 1, nextSeen) + " => " + preview(entryValue, depth + 1, nextSeen));
          entryIndex++;
        });
        return "Map(" + value.size + ") {" + entries.join(", ") + (value.size > 5 ? ", ..." : "") + "}";
      }
      if (value instanceof Set) {
        var setItems = [];
        var setIndex = 0;
        value.forEach(function (item) {
          if (setIndex < 5) setItems.push(preview(item, depth + 1, nextSeen));
          setIndex++;
        });
        return "Set(" + value.size + ") {" + setItems.join(", ") + (value.size > 5 ? ", ..." : "") + "}";
      }
      var keys = Object.keys(value);
      if (!keys.length) return "{}";
      var pairs = [];
      for (var k = 0; k < keys.length && k < 6; k++) {
        var key = keys[k];
        pairs.push(key + ": " + preview(value[key], depth + 1, nextSeen));
      }
      return "{" + pairs.join(", ") + (keys.length > 6 ? ", ..." : "") + "}";
    } catch (error) {
      return "[Unserializable]";
    }
  }

  function snap(value) {
    try {
      return {
        type: typeName(value),
        preview: preview(value, 0, []),
        value: serializeValue(value, 0, []),
      };
    } catch (error) {
      return {
        type: "unknown",
        preview: "[Unserializable]",
        value: { kind: "unserializable", note: "could not read value" },
      };
    }
  }

  function structureHint(value, className) {
    var lower = className.toLowerCase();
    if (lower.indexOf("stack") !== -1) return "stack";
    if (lower.indexOf("queue") !== -1) return "queue";
    if (lower.indexOf("tree") !== -1) return "tree";
    var hasBranches =
      Object.prototype.hasOwnProperty.call(value, "left") ||
      Object.prototype.hasOwnProperty.call(value, "right") ||
      Array.isArray(value.children);
    var hasLabel =
      Object.prototype.hasOwnProperty.call(value, "value") ||
      Object.prototype.hasOwnProperty.call(value, "val") ||
      Object.prototype.hasOwnProperty.call(value, "key") ||
      Object.prototype.hasOwnProperty.call(value, "name") ||
      Object.prototype.hasOwnProperty.call(value, "data");
    if (hasBranches && hasLabel) return "tree";
    return undefined;
  }

  function serializeValue(value, depth, seen) {
    if (value === null) return { kind: "primitive", type: "null", text: "null" };
    var kind = typeof value;
    if (kind === "undefined") return { kind: "primitive", type: "undefined", text: "undefined" };
    if (kind === "string") {
      return {
        kind: "primitive",
        type: "string",
        text: value.length > 240 ? value.slice(0, 240) + "..." : value,
      };
    }
    if (kind === "number" || kind === "boolean" || kind === "bigint" || kind === "symbol") {
      var text = kind === "bigint" ? String(value) + "n" : String(value);
      return { kind: "primitive", type: kind, text: text };
    }
    if (kind === "function") {
      return { kind: "function", name: value.name || "anonymous" };
    }
    if (seen.indexOf(value) !== -1) return { kind: "circular" };
    if (value instanceof Date) {
      return { kind: "primitive", type: "date", text: value.toISOString() };
    }
    if (value instanceof RegExp) {
      return { kind: "primitive", type: "regexp", text: String(value) };
    }
    if (value instanceof Error) {
      return { kind: "primitive", type: "error", text: value.name + ": " + value.message };
    }
    if (depth >= 5) {
      return { kind: "primitive", type: typeName(value), text: preview(value, 0, []) };
    }

    var nextSeen = seen.concat([value]);
    try {
      if (Array.isArray(value)) {
        var items = [];
        var itemLimit = Math.min(value.length, 50);
        for (var i = 0; i < itemLimit; i++) {
          items.push(serializeValue(value[i], depth + 1, nextSeen));
        }
        return {
          kind: "array",
          items: items,
          length: value.length,
          truncated: value.length > itemLimit,
        };
      }

      if (value instanceof Map) {
        var mapEntries = [];
        var mapLimit = Math.min(value.size, 30);
        var mapIndex = 0;
        value.forEach(function (entryValue, entryKey) {
          if (mapIndex < mapLimit) {
            mapEntries.push({
              key: serializeValue(entryKey, depth + 1, nextSeen),
              value: serializeValue(entryValue, depth + 1, nextSeen),
            });
          }
          mapIndex++;
        });
        return {
          kind: "map",
          entries: mapEntries,
          size: value.size,
          truncated: value.size > mapLimit,
        };
      }

      if (value instanceof Set) {
        var setItems = [];
        var setLimit = Math.min(value.size, 40);
        var setIndex = 0;
        value.forEach(function (setValue) {
          if (setIndex < setLimit) {
            setItems.push(serializeValue(setValue, depth + 1, nextSeen));
          }
          setIndex++;
        });
        return {
          kind: "set",
          items: setItems,
          size: value.size,
          truncated: value.size > setLimit,
        };
      }

      var keys = Object.keys(value);
      var className =
        value.constructor && value.constructor.name ? value.constructor.name : "Object";
      var entries = [];
      var keyLimit = Math.min(keys.length, 30);
      for (var k = 0; k < keyLimit; k++) {
        var key = keys[k];
        try {
          entries.push({
            key: key,
            value: serializeValue(value[key], depth + 1, nextSeen),
          });
        } catch (error) {
          entries.push({
            key: key,
            value: { kind: "unserializable", note: "getter threw" },
          });
        }
      }
      return {
        kind: "object",
        className: className,
        hint: structureHint(value, className),
        entries: entries,
        keyCount: keys.length,
        truncated: keys.length > keyLimit,
      };
    } catch (error) {
      return { kind: "unserializable", note: "could not read value" };
    }
  }

  function capture(getters) {
    var vars = [];
    var names = Object.keys(getters || {});
    for (var i = 0; i < names.length; i++) {
      var name = names[i];
      try {
        var value = getters[name];
        var description = snap(value);
        vars.push({
          name: name,
          type: description.type,
          preview: description.preview,
          value: description.value
        });
      } catch (error) {
        vars.push({
          name: name,
          type: "uninitialized",
          preview: "not initialized",
          value: { kind: "primitive", type: "undefined", text: "undefined" }
        });
      }
    }
    return vars;
  }

  var previousSignature = null;

  function signatureFor(step) {
    try {
      return step.line + "|" + step.fn + "|" + JSON.stringify(step.vars);
    } catch (error) {
      return null;
    }
  }

  function __vizStep(line, fnName, getters) {
    currentLine = line;
    if (steps.length >= maxSteps) {
      truncated = true;
      return;
    }
    var step = { index: steps.length, line: line, fn: fnName, vars: capture(getters) };
    var signature = signatureFor(step);
    if (signature !== null && signature === previousSignature) {
      currentStep = steps.length - 1;
      return;
    }
    previousSignature = signature;
    steps.push(step);
    currentStep = step.index;
  }

  function formatLogArg(value) {
    return typeof value === "string" ? value : preview(value, 0, []);
  }

  function installConsole(level) {
    console[level] = function () {
      if (logs.length >= 500) return;
      var parts = [];
      for (var i = 0; i < arguments.length; i++) {
        try {
          parts.push(formatLogArg(arguments[i]));
        } catch (error) {
          parts.push("[Unserializable]");
        }
      }
      logs.push({ level: level, text: parts.join(" "), step: currentStep, line: currentLine });
    };
  }

  installConsole("log");
  installConsole("info");
  installConsole("warn");
  installConsole("error");
  installConsole("debug");

  function finish(ok, extra) {
    var response = {
      ok: ok,
      steps: steps,
      logs: logs,
      durationMs: Math.round((performance.now() - started) * 100) / 100,
      truncated: truncated,
    };
    if (extra) {
      for (var key in extra) {
        if (Object.prototype.hasOwnProperty.call(extra, key)) response[key] = extra[key];
      }
    }
    self.postMessage(response);
  }

  try {
    var factory = new Function(
      "__vizStep",
      payload.code + "\n;return typeof " + payload.functionName + ' === "function" ? ' + payload.functionName + " : undefined;"
    );
    var fn = factory(__vizStep);
    if (typeof fn !== "function") {
      throw new Error("Could not find a function named " + payload.functionName + ".");
    }
    var output = fn.apply(undefined, payload.args || []);
    if (output && typeof output.then === "function") {
      output = await output;
    }
    finish(true, { result: snap(output) });
  } catch (error) {
    finish(false, {
      error: {
        name: error && error.name ? error.name : "Error",
        message: error && error.message ? error.message : String(error),
        line: currentLine || undefined,
      },
    });
  }
};
`;

export function runInWorker(request: RunRequest, timeoutMs = 5000): Promise<RunResponse> {
  return new Promise((resolve) => {
    const blob = new Blob([WORKER_SOURCE], { type: "text/javascript" });
    const blobUrl = URL.createObjectURL(blob);
    const worker = new Worker(blobUrl);
    let settled = false;
    const finish = (response: RunResponse) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.terminate();
      URL.revokeObjectURL(blobUrl);
      resolve(response);
    };

    const timer = setTimeout(() => {
      finish({
        ok: false,
        steps: [],
        logs: [],
        durationMs: timeoutMs,
        error: {
          name: "TimeoutError",
          message: `Execution timed out after ${timeoutMs / 1000}s. Check for an infinite loop or a long-running task.`,
        },
      });
    }, timeoutMs);

    worker.onmessage = (event: MessageEvent<RunResponse>) => finish(event.data);
    worker.onerror = (event) => {
      event.preventDefault();
      finish({
        ok: false,
        steps: [],
        logs: [],
        durationMs: 0,
        error: {
          name: "WorkerError",
          message: event.message || "The execution worker crashed.",
        },
      });
    };

    try {
      worker.postMessage(request);
    } catch (error) {
      finish({
        ok: false,
        steps: [],
        logs: [],
        durationMs: 0,
        error: {
          name: "CloneError",
          message:
            error instanceof Error
              ? `Arguments must be plain data: ${error.message}`
              : "Arguments must be plain data.",
        },
      });
    }
  });
}

/** Parse an argument input as a JavaScript literal, falling back to JSON. */
export function parseArgument(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    // Allow single quotes, trailing commas, `new Date(...)`, etc.
    return new Function(`"use strict"; return (${trimmed});`)();
  }
}
