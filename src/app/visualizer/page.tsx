"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  ChangeEvent,
  KeyboardEvent as ReactKeyboardEvent,
  UIEvent,
} from "react";
import {
  analyzeCode,
  instrumentCode,
  type ParamInfo,
} from "@/lib/visualizer/instrument";
import {
  parseArgument,
  runInWorker,
  type LogEntry,
  type RunResponse,
  type TraceStep,
  type VariableSnapshot,
} from "@/lib/visualizer/run";
import { ValueView, preferredViewForName } from "@/components/ValueView/ValueView";
import "./visualizer.css";

const DEFAULT_CODE = `function orderTotal(items, taxRate = 0.08) {
  let subtotal = 0;

  for (const item of items) {
    subtotal += item.price * item.qty;
  }

  const tax = subtotal * taxRate;
  const total = subtotal + tax;

  return {
    subtotal: Number(subtotal.toFixed(2)),
    tax: Number(tax.toFixed(2)),
    total: Number(total.toFixed(2)),
  };
}`;

const TREE_CODE = `function sumTree(node) {
  if (!node) return 0;

  const left = sumTree(node.left);
  const right = sumTree(node.right);
  const total = node.value + left + right;

  return total;
}`;

const STRUCTURES_CODE = `class Stack {
  constructor() { this.items = []; }
  push(value) { this.items.push(value); }
}

class Queue {
  constructor() { this.items = []; }
  enqueue(value) { this.items.push(value); }
}

function structures(values) {
  const stack = new Stack();
  const queue = new Queue();

  for (const value of values) {
    stack.push(value);
    queue.enqueue(value);
  }

  return { stack, queue };
}`;

const COLLECTIONS_CODE = `function collections(words) {
  const counts = new Map();
  const unique = new Set();

  for (const word of words) {
    counts.set(word, (counts.get(word) ?? 0) + 1);
    unique.add(word);
  }

  return { counts, unique };
}`;

const EXAMPLES = [
  { label: "Order total", code: DEFAULT_CODE },
  { label: "Tree walk", code: TREE_CODE },
  { label: "Stack & queue", code: STRUCTURES_CODE },
  { label: "Map & set", code: COLLECTIONS_CODE },
];

const SAMPLE_ARGS: Record<string, string> = {
  items:
    '[{"name":"Keyboard","price":80,"qty":2},{"name":"Mouse","price":25,"qty":1}]',
  numbers: "[4, 8, 15, 16, 23, 42]",
  values: "[3, 1, 4, 1, 5, 9]",
  words: '["apple", "pear", "apple", "kiwi", "pear", "apple"]',
  node: '{"value":8,"left":{"value":4,"left":null,"right":null},"right":{"value":12,"left":{"value":10,"left":null,"right":null},"right":null}}',
  list: "[1, 2, 3]",
  n: "8",
  count: "5",
  name: '"Ada"',
  text: '"hello"',
  value: "21",
  target: "24",
  multiplier: "2",
};

function defaultArgText(param: ParamInfo): string {
  if (param.defaultText) return param.defaultText;
  const key = param.label.toLowerCase().replace(/\s+/g, "");
  return SAMPLE_ARGS[key] ?? "";
}

const INITIAL_ANALYSIS = analyzeCode(DEFAULT_CODE);
const INITIAL_SIGNATURE = INITIAL_ANALYSIS.ok
  ? `${INITIAL_ANALYSIS.analysis.functionName}:${INITIAL_ANALYSIS.analysis.params
      .map((param) => param.label)
      .join("|")}`
  : "__invalid__";
const INITIAL_ARG_TEXTS: Record<number, string> = INITIAL_ANALYSIS.ok
  ? Object.fromEntries(
      INITIAL_ANALYSIS.analysis.params.map((param) => [
        param.index,
        defaultArgText(param),
      ]),
    )
  : {};

function quickType(text: string): string {
  const value = text.trim();
  if (!value) return "undefined";
  if (value === "true" || value === "false") return "boolean";
  if (value === "null") return "null";
  if (value === "undefined") return "undefined";
  if (/^-?\d/.test(value)) return "number";
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'")) ||
    (value.startsWith("`") && value.endsWith("`"))
  ) {
    return "string";
  }
  if (value.startsWith("[")) return "array";
  if (value.startsWith("{")) return "object";
  return "expression";
}

const TYPE_STYLES: Record<string, string> = {
  number: "border-sky-400/25 bg-sky-400/10 text-sky-300",
  string: "border-amber-400/25 bg-amber-400/10 text-amber-300",
  boolean: "border-violet-400/25 bg-violet-400/10 text-violet-300",
  object: "border-emerald-400/25 bg-emerald-400/10 text-emerald-300",
  array: "border-teal-400/25 bg-teal-400/10 text-teal-300",
  function: "border-pink-400/25 bg-pink-400/10 text-pink-300",
  undefined: "border-zinc-500/25 bg-zinc-500/10 text-zinc-400",
  null: "border-zinc-500/25 bg-zinc-500/10 text-zinc-400",
  uninitialized: "border-zinc-600/30 bg-zinc-700/10 text-zinc-500",
  error: "border-rose-400/25 bg-rose-400/10 text-rose-300",
  date: "border-cyan-400/25 bg-cyan-400/10 text-cyan-300",
  map: "border-indigo-400/25 bg-indigo-400/10 text-indigo-300",
  set: "border-indigo-400/25 bg-indigo-400/10 text-indigo-300",
};

function typeClass(type: string): string {
  return (
    TYPE_STYLES[type] ?? "border-zinc-500/25 bg-zinc-500/10 text-zinc-400"
  );
}

function PlayIcon({ className = "h-4 w-4" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden>
      <path d="M8 5.14v13.72c0 .79.86 1.28 1.54.9l11.1-6.86a1.05 1.05 0 0 0 0-1.8L9.54 4.24A1.05 1.05 0 0 0 8 5.14Z" />
    </svg>
  );
}

function PauseIcon({ className = "h-4 w-4" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden>
      <rect x="6.5" y="5" width="4" height="14" rx="1" />
      <rect x="13.5" y="5" width="4" height="14" rx="1" />
    </svg>
  );
}

function StepIcon({ direction }: { direction: "back" | "forward" }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className="h-4 w-4" aria-hidden>
      {direction === "back" ? (
        <>
          <rect x="5" y="5" width="2.2" height="14" rx="1" />
          <path d="M18.3 6.4 9.5 12l8.8 5.6V6.4Z" />
        </>
      ) : (
        <>
          <rect x="16.8" y="5" width="2.2" height="14" rx="1" />
          <path d="M5.7 6.4 14.5 12l-8.8 5.6V6.4Z" />
        </>
      )}
    </svg>
  );
}

function SkipToBreakpointIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-4 w-4" aria-hidden>
      <path d="M5 5v14M9 8l8 4-8 4V8Z" strokeLinejoin="round" />
    </svg>
  );
}

function SparkIcon({ className = "h-4 w-4" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" className={className} aria-hidden>
      <path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1" strokeLinecap="round" />
      <circle cx="12" cy="12" r="3.2" />
    </svg>
  );
}

function BugIcon({ className = "h-5 w-5" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" className={className} aria-hidden>
      <path d="M8 6.5a4 4 0 0 1 8 0" strokeLinecap="round" />
      <rect x="7" y="7.5" width="10" height="11" rx="5" />
      <path d="M3.5 10H7M17 10h3.5M4.5 16H7M17 16h2.5M6 20l2-2M18 20l-2-2M9 4 7.5 2.5M15 4l1.5-1.5" strokeLinecap="round" />
    </svg>
  );
}

function Spinner() {
  return (
    <span
      className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-zinc-950/30 border-t-zinc-950"
      aria-hidden
    />
  );
}

export default function VisualizerPage() {
  const [code, setCode] = useState(DEFAULT_CODE);
  const [selectedFn, setSelectedFn] = useState<string | null>(null);
  const [argTexts, setArgTexts] =
    useState<Record<number, string>>(INITIAL_ARG_TEXTS);
  const [breakpoints, setBreakpoints] = useState<Set<number>>(() => new Set());
  const [trace, setTrace] = useState<RunResponse | null>(null);
  const [runError, setRunError] = useState<{ message: string; line?: number } | null>(null);
  const [running, setRunning] = useState(false);
  const [stepIndex, setStepIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [tab, setTab] = useState<"variables" | "trace">("variables");
  const [scrollTop, setScrollTop] = useState(0);

  const gutterRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const currentRowRef = useRef<HTMLButtonElement>(null);
  const runningRef = useRef(false);
  const stepRef = useRef(0);
  const playStartRef = useRef(0);
  const signatureRef = useRef<string>(INITIAL_SIGNATURE);

  const analysis = useMemo(
    () =>
      analyzeCode(code, selectedFn ?? undefined),
    [code, selectedFn],
  );
  const params = useMemo(
    () => (analysis.ok ? analysis.analysis.params : []),
    [analysis],
  );
  const functions = useMemo(
    () => (analysis.ok ? analysis.analysis.functions : []),
    [analysis],
  );
  const signatureKey = analysis.ok
    ? `${analysis.analysis.functionName}:${params.map((param) => param.label).join("|")}`
    : "__invalid__";

  const codeLines = useMemo(() => code.split("\n"), [code]);
  const steps = useMemo(() => trace?.steps ?? [], [trace]);
  const executedLines = useMemo(() => {
    const lines = new Set<number>();
    steps.forEach((step) => lines.add(step.line));
    return lines;
  }, [steps]);
  const lastStepIndex = Math.max(0, steps.length - 1);
  const safeStepIndex = Math.min(stepIndex, lastStepIndex);
  const currentStep = steps[safeStepIndex];
  const previousStep = safeStepIndex > 0 ? steps[safeStepIndex - 1] : undefined;
  const activeLine = currentStep?.line;

  const paramNames = useMemo(() => {
    const names = new Map<string, number>();
    params.forEach((param) => {
      param.bindingNames.forEach((name) => names.set(name, param.index));
    });
    return names;
  }, [params]);

  const orderedVars = useMemo(() => {
    if (!currentStep) return [];
    const rank = (variable: VariableSnapshot): number => {
      if (paramNames.has(variable.name)) return 0;
      if (variable.type === "function") return 3;
      if (variable.type === "uninitialized") return 2;
      return 1;
    };
    return [...currentStep.vars]
      .filter((variable) => variable.type !== "uninitialized")
      .sort((a, b) => rank(a) - rank(b));
  }, [currentStep, paramNames]);

  const previousVars = useMemo(() => {
    const map = new Map<string, VariableSnapshot>();
    previousStep?.vars.forEach((variable) => map.set(variable.name, variable));
    return map;
  }, [previousStep]);

  useEffect(() => {
    stepRef.current = safeStepIndex;
  }, [safeStepIndex]);

  // Keep a selection only while that function still exists in the editor.

  // Rebuild the argument inputs when the entry function or signature changes.
  useEffect(() => {
    if (!analysis.ok) return;
    if (signatureRef.current === signatureKey) return;
    signatureRef.current = signatureKey;
    const next: Record<number, string> = {};
    analysis.analysis.params.forEach((param) => {
      next[param.index] = defaultArgText(param);
    });
    setArgTexts(next);
    setTrace(null);
    setRunError(null);
    setStepIndex(0);
    setPlaying(false);
    setTab("variables");
  }, [analysis, signatureKey]);

  const updateCode = useCallback(
    (next: string) => {
      setCode(next);
      if (trace) {
        setTrace(null);
        setRunError(null);
        setStepIndex(0);
        setPlaying(false);
      }
    },
    [trace],
  );

  const toggleBreakpoint = (line: number) => {
    setBreakpoints((previous) => {
      const next = new Set(previous);
      if (next.has(line)) next.delete(line);
      else next.add(line);
      return next;
    });
  };

  const handleRun = useCallback(async () => {
    if (runningRef.current) return;

    setPlaying(false);
    const compiled = instrumentCode(code, selectedFn ?? undefined);
    if (!compiled.ok) {
      setRunError({
        message: compiled.line
          ? `Line ${compiled.line}: ${compiled.error}`
          : compiled.error,
        line: compiled.line,
      });
      setTrace(null);
      return;
    }

    let args: unknown[];
    try {
      args = compiled.params.map((param) => {
        try {
          return parseArgument(argTexts[param.index] ?? "");
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          throw new Error(`Argument "${param.label}" is not valid JavaScript. ${message}`);
        }
      });
    } catch (error) {
      setRunError({
        message: error instanceof Error ? error.message : String(error),
      });
      setTrace(null);
      return;
    }

    runningRef.current = true;
    setRunning(true);
    setRunError(null);
    setTrace(null);
    setStepIndex(0);

    const response = await runInWorker({
      code: compiled.code,
      functionName: compiled.functionName,
      args,
      maxSteps: 2500,
    });

    runningRef.current = false;
    setRunning(false);
    setTrace(response);

    if (!response.ok) {
      setRunError({
        message: response.error
          ? `${response.error.name}: ${response.error.message}`
          : "Execution failed.",
        line: response.error?.line,
      });
    }

    if (response.steps.length) {
      const firstBreakpoint = response.steps.findIndex((step) =>
        breakpoints.has(step.line),
      );
      const nextIndex = !response.ok
        ? response.steps.length - 1
        : firstBreakpoint >= 0
          ? firstBreakpoint
          : 0;
      setStepIndex(nextIndex);
      stepRef.current = nextIndex;
    }
  }, [argTexts, breakpoints, code, selectedFn]);

  const goToStep = useCallback(
    (next: number) => {
      if (!steps.length) return;
      setStepIndex(Math.min(Math.max(next, 0), steps.length - 1));
    },
    [steps.length],
  );

  const togglePlay = useCallback(() => {
    if (!steps.length) return;
    if (playing) {
      setPlaying(false);
      return;
    }
    if (safeStepIndex >= steps.length - 1) {
      setStepIndex(0);
      stepRef.current = 0;
      playStartRef.current = 0;
    } else {
      playStartRef.current = safeStepIndex;
    }
    setPlaying(true);
  }, [playing, safeStepIndex, steps.length]);

  const jumpToBreakpoint = useCallback(() => {
    if (!steps.length || breakpoints.size === 0) return;
    for (let index = safeStepIndex + 1; index < steps.length; index += 1) {
      if (breakpoints.has(steps[index].line)) {
        setStepIndex(index);
        return;
      }
    }
    for (let index = 0; index <= safeStepIndex; index += 1) {
      if (breakpoints.has(steps[index].line)) {
        setStepIndex(index);
        return;
      }
    }
  }, [breakpoints, safeStepIndex, steps]);

  const jumpToLine = useCallback(
    (line: number) => {
      if (!steps.length) return;
      for (let index = 0; index < steps.length; index += 1) {
        if (steps[index].line === line) {
          setStepIndex(index);
          return;
        }
      }
    },
    [steps],
  );

  useEffect(() => {
    if (!playing || !trace?.steps.length) return;
    const id = setInterval(() => {
      const current = stepRef.current;
      const last = trace.steps.length - 1;
      if (current >= last) {
        setPlaying(false);
        return;
      }
      const next = current + 1;
      stepRef.current = next;
      setStepIndex(next);
      if (next > playStartRef.current && breakpoints.has(trace.steps[next].line)) {
        setPlaying(false);
      }
      if (next >= last) setPlaying(false);
    }, 650);
    return () => clearInterval(id);
  }, [breakpoints, playing, trace]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT" ||
          target.isContentEditable)
      ) {
        return;
      }
      if (event.key === "ArrowRight") {
        event.preventDefault();
        goToStep(safeStepIndex + 1);
      } else if (event.key === "ArrowLeft") {
        event.preventDefault();
        goToStep(safeStepIndex - 1);
      } else if (
        event.key === " " &&
        target?.tagName !== "BUTTON" &&
        target?.tagName !== "A"
      ) {
        event.preventDefault();
        togglePlay();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [goToStep, safeStepIndex, togglePlay]);

  // Auto-scroll the editor to the line that is currently being replayed.
  useEffect(() => {
    if (!activeLine || !editorRef.current) return;
    const editor = editorRef.current;
    const lineTop = (activeLine - 1) * 22;
    const top = editor.scrollTop;
    const bottom = top + editor.clientHeight - 24;
    if (lineTop < top + 22 || lineTop > bottom - 22) {
      const nextScroll = Math.max(0, lineTop - editor.clientHeight / 2);
      editor.scrollTop = nextScroll;
      if (gutterRef.current) gutterRef.current.scrollTop = nextScroll;
      setScrollTop(nextScroll);
    }
  }, [activeLine]);

  useEffect(() => {
    if (tab === "trace") {
      currentRowRef.current?.scrollIntoView({ block: "nearest" });
    }
  }, [safeStepIndex, tab]);

  const handleEditorScroll = (event: UIEvent<HTMLTextAreaElement>) => {
    const next = event.currentTarget.scrollTop;
    setScrollTop(next);
    if (gutterRef.current) gutterRef.current.scrollTop = next;
  };

  const handleTabInsert = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Tab") return;
    event.preventDefault();
    const element = event.currentTarget;
    const start = element.selectionStart;
    const end = element.selectionEnd;
    const next = `${code.slice(0, start)}  ${code.slice(end)}`;
    updateCode(next);
    requestAnimationFrame(() => {
      element.selectionStart = start + 2;
      element.selectionEnd = start + 2;
    });
  };

  const windowStart = Math.max(0, safeStepIndex - 60);
  const visibleSteps = steps.slice(windowStart, windowStart + 140);
  const logCount = trace?.logs.length ?? 0;
  const statusLabel = running
    ? "Running"
    : runError
      ? "Failed"
      : trace?.ok
        ? "Trace ready"
        : "Idle";

  return (
    <div className="viz-shell min-h-screen bg-[#0a0c0f] text-zinc-200">
      <div className="mx-auto flex w-full max-w-[1560px] flex-col px-4 pb-10 pt-6 sm:px-6 lg:px-8">
        <header className="mb-5 flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-gradient-to-br from-emerald-300 via-emerald-400 to-cyan-500 font-mono text-sm font-black text-zinc-950 shadow-lg shadow-emerald-500/20">
              JS
            </div>
            <div>
              <h1 className="text-xl font-semibold tracking-tight text-white">
                Code Visualizer
              </h1>
              <p className="text-sm text-zinc-400">
                Write a function, run it, and inspect every value change.
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-400/20 bg-emerald-400/[0.07] px-3 py-1.5 text-[11px] font-medium text-emerald-300">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 shadow-[0_0_8px] shadow-emerald-400/80" />
              Replay debugger
            </span>
            <Link
              href="/"
              className="rounded-full border border-white/10 bg-white/[0.03] px-3 py-1.5 text-[11px] font-medium text-zinc-400 transition hover:border-white/20 hover:text-zinc-200"
            >
              Home
            </Link>
          </div>
        </header>

        <div className="grid grid-cols-1 items-start gap-5 min-[900px]:grid-cols-[minmax(0,1.08fr)_minmax(0,0.92fr)]">
          <div className="flex min-w-0 flex-col gap-5">
            <section className="overflow-hidden rounded-2xl border border-white/10 bg-[#101318] shadow-2xl shadow-black/40">
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/[0.07] px-4 py-3">
                <div className="flex items-center gap-3">
                  <div className="flex gap-1.5">
                    <span className="h-2.5 w-2.5 rounded-full bg-rose-400/70" />
                    <span className="h-2.5 w-2.5 rounded-full bg-amber-300/70" />
                    <span className="h-2.5 w-2.5 rounded-full bg-emerald-400/70" />
                  </div>
                  <span className="font-mono text-[12px] text-zinc-400">snippet.js</span>
                  <span className="rounded-md border border-white/10 bg-white/[0.03] px-1.5 py-0.5 font-mono text-[10px] text-zinc-500">
                    {codeLines.length} lines
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  {analysis.ok && functions.length > 1 && (
                    <label className="flex items-center gap-1.5 text-[11px] text-zinc-500">
                      Entry
                      <select
                        value={analysis.analysis.functionName}
                        onChange={(event) => setSelectedFn(event.target.value)}
                        className="rounded-md border border-white/10 bg-[#0a0c0f] px-2 py-1 font-mono text-[11px] text-zinc-300 outline-none focus:border-emerald-400/40"
                      >
                        {functions.map((name) => (
                          <option key={name} value={name}>
                            {name}()
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                  <button
                    type="button"
                    onClick={() => {
                      updateCode(DEFAULT_CODE);
                      setSelectedFn(null);
                      setBreakpoints(new Set());
                    }}
                    className="rounded-lg border border-white/10 px-2.5 py-1.5 text-[11px] font-medium text-zinc-400 transition hover:border-white/20 hover:text-zinc-200"
                  >
                    Reset
                  </button>
                  <button
                    type="button"
                    onClick={handleRun}
                    disabled={running}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-400 px-3 py-1.5 text-[12px] font-semibold text-zinc-950 shadow-lg shadow-emerald-500/20 transition hover:bg-emerald-300 disabled:cursor-not-allowed disabled:opacity-70"
                  >
                    {running ? <Spinner /> : <PlayIcon className="h-3.5 w-3.5" />}
                    {running ? "Running" : trace ? "Run again" : "Run code"}
                  </button>
                </div>
              </div>

              <div className="relative flex h-[430px] overflow-hidden">
                <div
                  ref={gutterRef}
                  className="viz-gutter w-14 shrink-0 overflow-hidden border-r border-white/[0.05] bg-black/20 pt-4 font-mono text-[11px] leading-[22px]"
                >
                  {codeLines.map((_, index) => {
                    const line = index + 1;
                    const active = activeLine === line;
                    const breakpoint = breakpoints.has(line);
                    return (
                      <button
                        type="button"
                        key={line}
                        onClick={() => toggleBreakpoint(line)}
                        title={breakpoint ? `Remove breakpoint on line ${line}` : `Add breakpoint on line ${line}`}
                        className={`group flex h-[22px] w-full items-center justify-end gap-1.5 pr-2.5 transition-colors ${
                          active
                            ? "bg-emerald-400/10 text-emerald-300"
                            : "text-zinc-600 hover:bg-white/[0.04] hover:text-zinc-400"
                        }`}
                      >
                        <span
                          className={`h-2 w-2 rounded-full transition ${
                            breakpoint
                              ? "bg-rose-400 shadow-[0_0_7px] shadow-rose-400/70"
                              : "bg-transparent group-hover:bg-zinc-600"
                          }`}
                        />
                        <span className="w-4 text-right">{line}</span>
                      </button>
                    );
                  })}
                </div>
                <div className="relative min-w-0 flex-1">
                  <div className="pointer-events-none absolute inset-0 overflow-hidden">
                    {Array.from(executedLines).map((line) => (
                      <div
                        key={line}
                        className="absolute inset-x-0 bg-emerald-400/[0.028]"
                        style={{
                          top: 16 + (line - 1) * 22 - scrollTop,
                          height: 22,
                          display:
                            line >= 1 && line <= codeLines.length ? "block" : "none",
                        }}
                      />
                    ))}
                  </div>
                  <div
                    className="pointer-events-none absolute inset-x-0 border-l-2 border-emerald-400/70 bg-emerald-400/[0.055]"
                    style={{
                      top: 16 + ((activeLine ?? 0) - 1) * 22 - scrollTop,
                      height: 22,
                      display: activeLine ? "block" : "none",
                    }}
                  />
                  <textarea
                    ref={editorRef}
                    value={code}
                    onChange={(event: ChangeEvent<HTMLTextAreaElement>) =>
                      updateCode(event.target.value)
                    }
                    onScroll={handleEditorScroll}
                    onKeyDown={(event) => {
                      handleTabInsert(event);
                      if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
                        event.preventDefault();
                        handleRun();
                      }
                    }}
                    wrap="off"
                    spellCheck={false}
                    aria-label="JavaScript snippet"
                    className="viz-code relative h-full w-full resize-none overflow-auto bg-transparent px-4 py-4 font-mono text-[13px] leading-[22px] text-zinc-200 caret-emerald-300 outline-none"
                  />
                </div>
              </div>

              <div className="flex flex-wrap items-center justify-between gap-2 border-t border-white/[0.07] px-4 py-2.5 text-[11px]">
                {analysis.ok ? (
                  <span className="text-zinc-500">
                    <span className="text-zinc-300">{analysis.analysis.functionName}</span>
                    <span className="mx-1.5 text-zinc-700">·</span>
                    {params.length} parameter{params.length === 1 ? "" : "s"}
                    <span className="mx-1.5 text-zinc-700">·</span>
                    JavaScript
                  </span>
                ) : (
                  <span className="text-rose-300/90">
                    Syntax error
                    {analysis.line ? ` on line ${analysis.line}` : ""}: {analysis.error}
                  </span>
                )}
                <span className="text-zinc-600">Ctrl/Cmd + Enter to run · click a line to break</span>
              </div>

              <div className="flex flex-wrap items-center gap-1.5 border-t border-white/[0.05] px-4 py-2">
                <span className="mr-1 text-[9px] font-semibold uppercase tracking-wider text-zinc-600">
                  Examples
                </span>
                {EXAMPLES.map((example) => {
                  const active = code === example.code;
                  return (
                    <button
                      type="button"
                      key={example.label}
                      onClick={() => {
                        updateCode(example.code);
                        setSelectedFn(null);
                        setBreakpoints(new Set());
                      }}
                      className={`rounded-md border px-2 py-1 text-[10.5px] font-medium transition ${
                        active
                          ? "border-emerald-400/30 bg-emerald-400/[0.08] text-emerald-300"
                          : "border-white/10 bg-white/[0.02] text-zinc-500 hover:border-white/20 hover:text-zinc-300"
                      }`}
                    >
                      {example.label}
                    </button>
                  );
                })}
              </div>
            </section>

            <section className="rounded-2xl border border-white/10 bg-[#101318] shadow-xl shadow-black/20">
              <div className="flex items-center justify-between border-b border-white/[0.07] px-4 py-3">
                <div className="flex items-center gap-2">
                  <h2 className="text-sm font-semibold text-white">Arguments</h2>
                  <span className="rounded-md border border-white/10 bg-white/[0.03] px-1.5 py-0.5 font-mono text-[10px] text-zinc-500">
                    {params.length}
                  </span>
                </div>
                {analysis.ok && (
                  <code className="font-mono text-[11px] text-zinc-500">
                    {analysis.analysis.functionName}(
                    {params.map((param) => param.label).join(", ")})
                  </code>
                )}
              </div>
              <div className="space-y-3 p-4">
                {!analysis.ok ? (
                  <p className="text-xs text-zinc-500">
                    Fix the syntax error above to edit arguments.
                  </p>
                ) : params.length === 0 ? (
                  <p className="rounded-lg border border-dashed border-white/10 px-3 py-4 text-center text-xs text-zinc-500">
                    This function takes no arguments.
                  </p>
                ) : (
                  params.map((param) => {
                    const value = argTexts[param.index] ?? "";
                    const type = quickType(value);
                    const isCompound = value.trim().startsWith("[") || value.trim().startsWith("{");
                    return (
                      <div key={param.index}>
                        <div className="mb-1.5 flex items-center justify-between gap-2">
                          <label
                            htmlFor={`arg-${param.index}`}
                            className="font-mono text-[12px] text-zinc-300"
                          >
                            {param.label}
                          </label>
                          <span
                            className={`rounded border px-1.5 py-0.5 font-mono text-[10px] ${typeClass(type)}`}
                          >
                            {type}
                          </span>
                        </div>
                        <textarea
                          id={`arg-${param.index}`}
                          value={value}
                          rows={isCompound ? 3 : 1}
                          placeholder="undefined"
                          spellCheck={false}
                          onChange={(event) =>
                            setArgTexts((previous) => ({
                              ...previous,
                              [param.index]: event.target.value,
                            }))
                          }
                          className="w-full resize-y rounded-lg border border-white/10 bg-black/30 px-3 py-2 font-mono text-[12px] leading-5 text-zinc-200 outline-none transition placeholder:text-zinc-700 focus:border-emerald-400/40 focus:ring-2 focus:ring-emerald-400/[0.08]"
                        />
                      </div>
                    );
                  })
                )}
              </div>
            </section>

            <section className="rounded-2xl border border-white/10 bg-[#101318] shadow-xl shadow-black/20">
              <div className="flex items-center justify-between border-b border-white/[0.07] px-4 py-3">
                <h2 className="text-sm font-semibold text-white">Result</h2>
                {trace && (
                  <span className="font-mono text-[10px] text-zinc-500">
                    {trace.steps.length} steps · {trace.durationMs} ms
                  </span>
                )}
              </div>
              <div className="p-4">
                {running ? (
                  <div className="flex items-center gap-2 text-xs text-zinc-400">
                    <span className="h-3 w-3 animate-spin rounded-full border-2 border-zinc-700 border-t-emerald-400" />
                    Capturing trace in the worker...
                  </div>
                ) : runError ? (
                  <div className="rounded-lg border border-rose-400/20 bg-rose-400/[0.06] px-3 py-2.5">
                    <p className="font-mono text-[12px] text-rose-300">{runError.message}</p>
                    {runError.line ? (
                      <p className="mt-1 text-[11px] text-rose-300/60">
                        Stopped near line {runError.line}.
                      </p>
                    ) : null}
                  </div>
                ) : trace?.ok ? (
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <p className="text-[10px] font-medium uppercase tracking-wider text-zinc-500">
                        Return value
                      </p>
                      <div className="viz-scroll mt-1.5 max-h-72 overflow-auto rounded-lg border border-emerald-400/10 bg-emerald-400/[0.025] px-3 py-2 text-[12px] leading-5 text-emerald-200">
                        {trace.result ? (
                          <ValueView value={trace.result.value} />
                        ) : (
                          <span className="font-mono text-zinc-500">undefined</span>
                        )}
                      </div>
                    </div>
                    {trace.error ? null : (
                      <span
                        className={`mt-4 rounded border px-2 py-1 font-mono text-[10px] ${typeClass(trace.result?.type ?? "undefined")}`}
                      >
                        {trace.result?.type ?? "undefined"}
                      </span>
                    )}
                  </div>
                ) : (
                  <p className="text-xs text-zinc-500">
                    Run the snippet to capture its return value and a full trace.
                  </p>
                )}
                {trace?.truncated ? (
                  <p className="mt-2 text-[11px] text-amber-300/80">
                    Trace was capped at {trace.steps.length} steps to keep the debugger responsive.
                  </p>
                ) : null}
              </div>
            </section>

            <section className="rounded-2xl border border-white/10 bg-[#101318] shadow-xl shadow-black/20">
              <div className="flex items-center justify-between border-b border-white/[0.07] px-4 py-3">
                <div className="flex items-center gap-2">
                  <h2 className="text-sm font-semibold text-white">Console</h2>
                  {logCount > 0 && (
                    <span className="rounded-md border border-white/10 bg-white/[0.03] px-1.5 py-0.5 font-mono text-[10px] text-zinc-500">
                      {logCount}
                    </span>
                  )}
                </div>
                <span className="font-mono text-[10px] text-zinc-600">console.*</span>
              </div>
              <div className="viz-scroll max-h-48 overflow-y-auto p-2">
                {logCount === 0 ? (
                  <p className="px-2 py-3 text-xs text-zinc-600">
                    console.log() output appears here after a run.
                  </p>
                ) : (
                  <div className="space-y-0.5">
                    {trace?.logs.map((entry: LogEntry, index: number) => (
                      <div
                        key={`${entry.step}-${index}-${entry.level}`}
                        className="flex items-start gap-2 rounded px-2 py-1 font-mono text-[11.5px] leading-5 hover:bg-white/[0.03]"
                      >
                        <span
                          className={`mt-[3px] inline-block h-1.5 w-1.5 shrink-0 rounded-full ${
                            entry.level === "error"
                              ? "bg-rose-400"
                              : entry.level === "warn"
                                ? "bg-amber-300"
                                : entry.level === "info"
                                  ? "bg-sky-300"
                                  : "bg-zinc-600"
                          }`}
                        />
                        <span
                          className={
                            entry.level === "error"
                              ? "text-rose-300"
                              : entry.level === "warn"
                                ? "text-amber-200"
                                : "text-zinc-300"
                          }
                        >
                          {entry.text}
                        </span>
                        <span className="ml-auto shrink-0 text-[10px] text-zinc-600">
                          {entry.line ? `L${entry.line}` : "global"}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </section>
          </div>

          <aside className="min-w-0 min-[900px]:sticky min-[900px]:top-6">
            <section className="flex min-h-[560px] flex-col overflow-hidden rounded-2xl border border-white/10 bg-[#101318] shadow-2xl shadow-black/40 min-[900px]:max-h-[calc(100vh-3rem)]">
              <div className="flex items-center justify-between border-b border-white/[0.07] px-4 py-3">
                <div className="flex items-center gap-2">
                  <span className="flex h-7 w-7 items-center justify-center rounded-lg border border-emerald-400/20 bg-emerald-400/[0.08] text-emerald-300">
                    <BugIcon className="h-4 w-4" />
                  </span>
                  <div>
                    <h2 className="text-sm font-semibold leading-none text-white">Debugger</h2>
                    <p className="mt-1 text-[10px] leading-none text-zinc-500">
                      Recorded in a Web Worker
                    </p>
                  </div>
                </div>
                <span
                  className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[10px] font-medium ${
                    running
                      ? "border-sky-400/20 bg-sky-400/[0.08] text-sky-300"
                      : runError
                        ? "border-rose-400/20 bg-rose-400/[0.08] text-rose-300"
                        : trace?.ok
                          ? "border-emerald-400/20 bg-emerald-400/[0.08] text-emerald-300"
                          : "border-white/10 bg-white/[0.03] text-zinc-500"
                  }`}
                >
                  <span
                    className={`h-1.5 w-1.5 rounded-full ${
                      running
                        ? "animate-pulse bg-sky-400"
                        : runError
                          ? "bg-rose-400"
                          : trace?.ok
                            ? "bg-emerald-400"
                            : "bg-zinc-600"
                    }`}
                  />
                  {statusLabel}
                </span>
              </div>

              {!running && !trace ? (
                <div className="flex flex-1 flex-col items-center justify-center px-8 py-14 text-center">
                  <div className="mb-5 flex h-16 w-16 items-center justify-center rounded-2xl border border-white/10 bg-white/[0.02] text-zinc-600">
                    <BugIcon className="h-7 w-7" />
                  </div>
                  <h3 className="text-sm font-semibold text-zinc-300">No trace yet</h3>
                  <p className="mt-1.5 max-w-[270px] text-xs leading-5 text-zinc-500">
                    Write a function, fill in its arguments, then run it. Every line will be
                    recorded so you can step back and forth.
                  </p>
                  <div className="mt-5 space-y-2 text-left">
                    {[
                      "Click a line number to set a breakpoint",
                      "Press Run and inspect the argument values",
                      "Step through the trace with ← / →",
                    ].map((tip, index) => (
                      <div key={tip} className="flex items-center gap-2.5 text-[11px] text-zinc-500">
                        <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-white/10 bg-white/[0.03] font-mono text-[9px] text-zinc-500">
                          {index + 1}
                        </span>
                        {tip}
                      </div>
                    ))}
                  </div>
                  <button
                    type="button"
                    onClick={handleRun}
                    className="mt-6 inline-flex items-center gap-1.5 rounded-lg bg-emerald-400 px-3.5 py-2 text-[12px] font-semibold text-zinc-950 transition hover:bg-emerald-300"
                  >
                    <SparkIcon className="h-3.5 w-3.5" />
                    Run the sample
                  </button>
                </div>
              ) : running ? (
                <div className="flex flex-1 flex-col items-center justify-center gap-3 px-8 py-14 text-center">
                  <span className="h-8 w-8 animate-spin rounded-full border-[3px] border-zinc-700 border-t-emerald-400" />
                  <p className="text-xs text-zinc-400">Executing the snippet...</p>
                  <p className="max-w-[260px] text-[11px] leading-5 text-zinc-600">
                    Long loops are stopped automatically so the editor stays responsive.
                  </p>
                </div>
              ) : (
                <>
                  <div className="border-b border-white/[0.07] px-4 py-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 text-[10px] uppercase tracking-wider text-zinc-500">
                          <span>Step {steps.length ? safeStepIndex + 1 : 0}</span>
                          <span className="text-zinc-700">/</span>
                          <span>{steps.length}</span>
                          {currentStep && (
                            <>
                              <span className="text-zinc-700">·</span>
                              <span className="normal-case tracking-normal text-zinc-400">
                                line {currentStep.line}
                              </span>
                              <span className="text-zinc-700">·</span>
                              <span className="normal-case tracking-normal text-emerald-300/80">
                                {currentStep.fn}()
                              </span>
                            </>
                          )}
                        </div>
                        <div className="mt-2 flex min-w-0 items-center gap-2">
                          <span className="shrink-0 rounded bg-white/[0.06] px-1.5 py-0.5 font-mono text-[10px] text-zinc-400">
                            L{currentStep?.line ?? "-"}
                          </span>
                          <code className="viz-scroll overflow-x-auto whitespace-pre font-mono text-[11.5px] text-zinc-300">
                            {currentStep
                              ? codeLines[currentStep.line - 1]?.trimStart() || " "
                              : " "}
                          </code>
                        </div>
                      </div>
                    </div>

                    {steps.length > 0 && (
                      <>
                        <div className="mt-3 flex items-center gap-1.5">
                          <button
                            type="button"
                            onClick={() => {
                              setPlaying(false);
                              goToStep(0);
                            }}
                            disabled={safeStepIndex === 0}
                            title="First step"
                            aria-label="First step"
                            className="viz-control"
                          >
                            <span className="-mr-1"><StepIcon direction="back" /></span>
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setPlaying(false);
                              goToStep(safeStepIndex - 1);
                            }}
                            disabled={safeStepIndex === 0}
                            title="Previous step (←)"
                            aria-label="Previous step"
                            className="viz-control"
                          >
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4" aria-hidden>
                              <path d="m15 18-6-6 6-6" strokeLinecap="round" strokeLinejoin="round" />
                            </svg>
                          </button>
                          <button
                            type="button"
                            onClick={togglePlay}
                            title={playing ? "Pause (Space)" : "Play (Space)"}
                            aria-label={playing ? "Pause" : "Play"}
                            className="flex h-9 w-10 items-center justify-center rounded-lg bg-emerald-400 text-zinc-950 shadow-lg shadow-emerald-500/20 transition hover:bg-emerald-300"
                          >
                            {playing ? <PauseIcon /> : <PlayIcon className="ml-0.5 h-3.5 w-3.5" />}
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setPlaying(false);
                              goToStep(safeStepIndex + 1);
                            }}
                            disabled={safeStepIndex >= steps.length - 1}
                            title="Next step (→)"
                            aria-label="Next step"
                            className="viz-control"
                          >
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4" aria-hidden>
                              <path d="m9 18 6-6-6-6" strokeLinecap="round" strokeLinejoin="round" />
                            </svg>
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setPlaying(false);
                              goToStep(steps.length - 1);
                            }}
                            disabled={safeStepIndex >= steps.length - 1}
                            title="Last step"
                            aria-label="Last step"
                            className="viz-control"
                          >
                            <span className="-ml-1"><StepIcon direction="forward" /></span>
                          </button>
                          <button
                            type="button"
                            onClick={jumpToBreakpoint}
                            disabled={breakpoints.size === 0}
                            title="Jump to next breakpoint"
                            aria-label="Jump to next breakpoint"
                            className="viz-control ml-auto gap-1.5 px-2 text-[11px]"
                          >
                            <SkipToBreakpointIcon />
                            <span className="hidden sm:inline">Breakpoint</span>
                          </button>
                        </div>
                        <input
                          type="range"
                          min={0}
                          max={Math.max(0, steps.length - 1)}
                          value={safeStepIndex}
                          onChange={(event) => {
                            setPlaying(false);
                            goToStep(Number(event.target.value));
                          }}
                          aria-label="Execution timeline"
                          className="viz-range mt-3 w-full"
                        />
                      </>
                    )}
                  </div>

                  {runError && (
                    <div className="mx-4 mt-3 rounded-lg border border-rose-400/20 bg-rose-400/[0.06] px-3 py-2">
                      <p className="font-mono text-[11px] leading-5 text-rose-300">
                        {runError.message}
                      </p>
                    </div>
                  )}

                  <div className="flex items-center gap-1 border-b border-white/[0.07] px-3">
                    <button
                      type="button"
                      onClick={() => setTab("variables")}
                      className={`relative px-3 py-2.5 text-[11px] font-medium transition ${
                        tab === "variables" ? "text-white" : "text-zinc-500 hover:text-zinc-300"
                      }`}
                    >
                      Variables
                      <span className="ml-1.5 rounded bg-white/[0.06] px-1 py-0.5 font-mono text-[9px] text-zinc-400">
                        {orderedVars.length}
                      </span>
                      {tab === "variables" && (
                        <span className="absolute inset-x-2 bottom-0 h-px bg-emerald-400" />
                      )}
                    </button>
                    <button
                      type="button"
                      onClick={() => setTab("trace")}
                      className={`relative px-3 py-2.5 text-[11px] font-medium transition ${
                        tab === "trace" ? "text-white" : "text-zinc-500 hover:text-zinc-300"
                      }`}
                    >
                      Trace
                      <span className="ml-1.5 rounded bg-white/[0.06] px-1 py-0.5 font-mono text-[9px] text-zinc-400">
                        {steps.length}
                      </span>
                      {tab === "trace" && (
                        <span className="absolute inset-x-2 bottom-0 h-px bg-emerald-400" />
                      )}
                    </button>
                  </div>

                  <div className="viz-scroll min-h-0 flex-1 overflow-y-auto p-3">
                    {tab === "variables" ? (
                      currentStep ? (
                        <div className="space-y-1.5">
                          {orderedVars.length === 0 && (
                            <p className="px-2 py-6 text-center text-xs text-zinc-600">
                              No initialized variables at this step.
                            </p>
                          )}
                          {orderedVars.map((variable) => {
                            const previous = previousVars.get(variable.name);
                            const changed = Boolean(
                              previous &&
                                (previous.preview !== variable.preview ||
                                  previous.type !== variable.type),
                            );
                            const added = Boolean(previousStep && !previous);
                            const isParam = paramNames.has(variable.name);
                            return (
                              <div
                                key={variable.name}
                                className={`rounded-lg border px-2.5 py-2 transition ${
                                  changed
                                    ? "border-amber-400/20 bg-amber-400/[0.045]"
                                    : "border-white/[0.05] bg-white/[0.015]"
                                }`}
                              >
                                <div className="flex flex-wrap items-center gap-1.5">
                                  <span className="font-mono text-[12px] text-zinc-100">
                                    {variable.name}
                                  </span>
                                  {isParam && (
                                    <span className="rounded border border-blue-400/20 bg-blue-400/[0.08] px-1 py-0.5 text-[8.5px] font-semibold uppercase tracking-wide text-blue-300">
                                      arg
                                    </span>
                                  )}
                                  <span
                                    className={`rounded border px-1.5 py-0.5 font-mono text-[9px] ${typeClass(variable.type)}`}
                                  >
                                    {variable.type}
                                  </span>
                                  {changed && (
                                    <span className="ml-auto rounded bg-amber-400/10 px-1.5 py-0.5 text-[8.5px] font-semibold uppercase tracking-wide text-amber-300">
                                      changed
                                    </span>
                                  )}
                                  {added && (
                                    <span className="ml-auto rounded bg-sky-400/10 px-1.5 py-0.5 text-[8.5px] font-semibold uppercase tracking-wide text-sky-300">
                                      new
                                    </span>
                                  )}
                                </div>
                                {variable.type === "uninitialized" ? (
                                  <p className="mt-1 font-mono text-[11.5px] italic leading-5 text-zinc-600">
                                    not initialized
                                  </p>
                                ) : (
                                  <div
                                    className="mt-1.5 text-[11.5px] leading-5"
                                    title={variable.preview}
                                  >
                                    <ValueView
                                      value={variable.value}
                                      preferred={preferredViewForName(variable.name)}
                                    />
                                  </div>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      ) : (
                        <p className="px-2 py-6 text-center text-xs text-zinc-600">
                          This run did not capture any variable snapshots.
                        </p>
                      )
                    ) : (
                      <div className="space-y-0.5">
                        {visibleSteps.map((step: TraceStep) => {
                          const isCurrent = step.index === safeStepIndex;
                          const isBreakpoint = breakpoints.has(step.line);
                          return (
                            <button
                              type="button"
                              key={step.index}
                              ref={isCurrent ? currentRowRef : undefined}
                              onClick={() => {
                                setPlaying(false);
                                setStepIndex(step.index);
                              }}
                              className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left font-mono text-[10.5px] transition ${
                                isCurrent
                                  ? "bg-emerald-400/10 text-emerald-200"
                                  : "text-zinc-500 hover:bg-white/[0.03] hover:text-zinc-300"
                              }`}
                            >
                              <span className="w-8 shrink-0 text-right text-zinc-600">
                                #{step.index + 1}
                              </span>
                              <span
                                className={`w-9 shrink-0 rounded px-1 py-0.5 text-center ${
                                  isCurrent
                                    ? "bg-emerald-400/15 text-emerald-300"
                                    : "bg-white/[0.04] text-zinc-500"
                                }`}
                              >
                                L{step.line}
                              </span>
                              <span className="truncate">{step.fn}()</span>
                              {isBreakpoint && (
                                <span className="ml-auto h-1.5 w-1.5 shrink-0 rounded-full bg-rose-400" />
                              )}
                            </button>
                          );
                        })}
                        <p className="px-2 pt-2 text-center text-[10px] text-zinc-600">
                          Showing {windowStart + 1}–
                          {Math.min(windowStart + visibleSteps.length, steps.length)} of{" "}
                          {steps.length}
                        </p>
                      </div>
                    )}
                  </div>

                  <div className="border-t border-white/[0.07] px-4 py-3">
                    <div className="flex items-center justify-between gap-2">
                      <h3 className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
                        Breakpoints
                      </h3>
                      {breakpoints.size > 0 && (
                        <button
                          type="button"
                          onClick={() => setBreakpoints(new Set())}
                          className="text-[10px] text-zinc-500 transition hover:text-rose-300"
                        >
                          Clear all
                        </button>
                      )}
                    </div>
                    {breakpoints.size === 0 ? (
                      <p className="mt-2 text-[10.5px] leading-4 text-zinc-600">
                        Click a line number in the editor to add a breakpoint.
                      </p>
                    ) : (
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {Array.from(breakpoints)
                          .sort((a, b) => a - b)
                          .map((line) => (
                            <span
                              key={line}
                              className="inline-flex items-center overflow-hidden rounded-md border border-rose-400/20 bg-rose-400/[0.07] text-[10px] text-rose-300"
                            >
                              <button
                                type="button"
                                onClick={() => jumpToLine(line)}
                                title={`Jump to line ${line}`}
                                className="px-2 py-1 font-mono transition hover:bg-rose-400/10"
                              >
                                L{line}
                              </button>
                              <button
                                type="button"
                                onClick={() => toggleBreakpoint(line)}
                                title={`Remove breakpoint on line ${line}`}
                                aria-label={`Remove breakpoint on line ${line}`}
                                className="border-l border-rose-400/15 px-1.5 py-1 text-[11px] leading-none transition hover:bg-rose-400/10"
                              >
                                ×
                              </button>
                            </span>
                          ))}
                      </div>
                    )}
                    <p className="mt-3 text-[9.5px] leading-4 text-zinc-700">
                      Tracks are recorded first, then replayed. Breakpoints pause playback
                      without changing the function&apos;s side effects.
                    </p>
                  </div>
                </>
              )}
            </section>
          </aside>
        </div>
      </div>
    </div>
  );
}
