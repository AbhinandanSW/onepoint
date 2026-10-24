import type { ReactNode } from "react";
import type { SerializedValue } from "@/lib/visualizer/run";

export type PreferredView = "stack" | "queue" | "tree" | undefined;

type ValueViewProps = {
  value: SerializedValue;
  depth?: number;
  compact?: boolean;
  preferred?: PreferredView;
};

type PrimitiveValue = Extract<SerializedValue, { kind: "primitive" }>;
type ArrayValue = Extract<SerializedValue, { kind: "array" }>;
type ObjectValue = Extract<SerializedValue, { kind: "object" }>;
type MapValue = Extract<SerializedValue, { kind: "map" }>;
type SetValue = Extract<SerializedValue, { kind: "set" }>;

const PRIMITIVE_COLORS: Record<string, string> = {
  string: "text-amber-300",
  number: "text-sky-300",
  boolean: "text-violet-300",
  undefined: "text-zinc-500",
  null: "text-zinc-500",
  bigint: "text-sky-300",
  symbol: "text-pink-300",
  date: "text-cyan-300",
  regexp: "text-teal-300",
  error: "text-rose-300",
};

export function preferredViewForName(name: string): PreferredView {
  const lower = name.toLowerCase();
  if (lower.includes("stack")) return "stack";
  if (lower.includes("queue")) return "queue";
  if (
    lower.includes("tree") ||
    lower.includes("root") ||
    lower.endsWith("node") ||
    lower === "bst"
  ) {
    return "tree";
  }
  return undefined;
}

function isComplex(value: SerializedValue): boolean {
  return (
    value.kind === "array" ||
    value.kind === "object" ||
    value.kind === "map" ||
    value.kind === "set"
  );
}

function primitiveText(value: PrimitiveValue): string {
  if (value.type === "string") return JSON.stringify(value.text);
  return value.text;
}

function summary(value: SerializedValue): string {
  switch (value.kind) {
    case "primitive":
      return primitiveText(value);
    case "function":
      return `function ${value.name}()`;
    case "array":
      return `Array(${value.length})`;
    case "object":
      return value.className === "Object"
        ? `{${value.entries.slice(0, 3).map((entry) => entry.key).join(", ")}${value.keyCount > 3 ? ", ..." : ""}}`
        : value.className;
    case "map":
      return `Map(${value.size})`;
    case "set":
      return `Set(${value.size})`;
    case "circular":
      return "[Circular]";
    case "unserializable":
      return "[Unserializable]";
  }
}

function Primitive({ value }: { value: PrimitiveValue }) {
  return (
    <span
      className={`font-mono ${PRIMITIVE_COLORS[value.type] ?? "text-zinc-300"}`}
    >
      {primitiveText(value)}
    </span>
  );
}

function CompactValue({ value }: { value: SerializedValue }) {
  switch (value.kind) {
    case "primitive":
      return <Primitive value={value} />;
    case "function":
      return <span className="font-mono text-pink-300">ƒ {value.name}()</span>;
    case "circular":
      return <span className="font-mono italic text-zinc-500">[Circular]</span>;
    case "unserializable":
      return (
        <span className="font-mono italic text-zinc-500">
          {value.note ?? "[Unserializable]"}
        </span>
      );
    case "array":
      return (
        <span className="font-mono text-zinc-400">
          [
          {value.items
            .slice(0, 5)
            .map((item) => summary(item))
            .join(", ")}
          {value.length > 5 ? ", ..." : ""}]
        </span>
      );
    case "object":
      return (
        <span className="font-mono text-zinc-400">
          {value.className !== "Object" ? `${value.className} ` : ""}
          {"{"}
          {value.entries
            .slice(0, 4)
            .map((entry) => `${entry.key}: ${summary(entry.value)}`)
            .join(", ")}
          {value.keyCount > 4 ? ", ..." : ""}
          {"}"}
        </span>
      );
    case "map":
      return <span className="font-mono text-indigo-300">Map({value.size})</span>;
    case "set":
      return <span className="font-mono text-indigo-300">Set({value.size})</span>;
  }
}

function ValueCount({ children }: { children: ReactNode }) {
  return (
    <span className="rounded border border-white/[0.07] bg-black/20 px-1.5 py-0.5 font-mono text-[9px] text-zinc-500">
      {children}
    </span>
  );
}

function ArrayView({
  value,
  depth,
}: {
  value: ArrayValue;
  depth: number;
}) {
  const allObjects =
    value.items.length > 0 &&
    value.items.every(
      (item) => item.kind === "object" && item.entries.length > 0,
    ) &&
    depth <= 2;

  if (allObjects) {
    return <ObjectTable value={value} depth={depth} />;
  }

  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap gap-1.5">
        {value.items.map((item, index) => (
          <div
            key={index}
            className="flex min-w-[54px] max-w-[190px] flex-col overflow-hidden rounded-md border border-white/[0.07] bg-black/20"
          >
            <div className="border-b border-white/[0.05] bg-white/[0.03] px-1.5 py-0.5 text-center font-mono text-[9px] text-zinc-600">
              {index}
            </div>
            <div className="min-w-0 break-all px-2 py-1.5 text-[11px] leading-4">
              <ValueView
                value={item}
                depth={depth + 1}
                compact={isComplex(item) || depth >= 2}
              />
            </div>
          </div>
        ))}
        {value.truncated && (
          <div className="flex min-w-[54px] flex-col items-center justify-center rounded-md border border-dashed border-white/10 px-2 py-1.5 font-mono text-[10px] text-zinc-600">
            +{value.length - value.items.length}
          </div>
        )}
      </div>
      <div className="flex items-center gap-1.5">
        <ValueCount>
          {value.length} item{value.length === 1 ? "" : "s"}
        </ValueCount>
        {value.truncated && (
          <span className="text-[9px] text-zinc-600">
            first {value.items.length} shown
          </span>
        )}
      </div>
    </div>
  );
}

function ObjectTable({
  value,
  depth,
}: {
  value: ArrayValue;
  depth: number;
}) {
  const rows = value.items.filter(
    (item): item is ObjectValue => item.kind === "object",
  );
  const columns = Array.from(
    new Set(rows.flatMap((row) => row.entries.map((entry) => entry.key))),
  ).slice(0, 8);
  const hasMoreColumns = rows.some((row) => row.keyCount > columns.length);

  return (
    <div className="overflow-hidden rounded-lg border border-white/[0.07]">
      <div className="viz-scroll overflow-x-auto">
        <table className="w-full border-collapse text-left font-mono text-[10px]">
          <thead>
            <tr className="bg-white/[0.03] text-[9px] uppercase tracking-wide text-zinc-500">
              <th className="w-8 px-2 py-1.5 text-right font-medium">#</th>
              {columns.map((column) => (
                <th
                  key={column}
                  className="whitespace-nowrap px-2 py-1.5 font-medium"
                >
                  {column}
                </th>
              ))}
              {hasMoreColumns && <th className="px-2 py-1.5">...</th>}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => (
              <tr
                key={index}
                className="border-t border-white/[0.04] align-top transition hover:bg-white/[0.025]"
              >
                <td className="px-2 py-1.5 text-right text-[9px] text-zinc-600">
                  {index}
                </td>
                {columns.map((column) => {
                  const entry = row.entries.find(
                    (candidate) => candidate.key === column,
                  );
                  return (
                    <td
                      key={column}
                      className="max-w-[180px] break-all px-2 py-1.5 text-zinc-400"
                    >
                      {entry ? (
                        <ValueView
                          value={entry.value}
                          depth={depth + 2}
                          compact
                        />
                      ) : (
                        <span className="text-zinc-700">-</span>
                      )}
                    </td>
                  );
                })}
                {hasMoreColumns && (
                  <td className="px-2 py-1.5 text-zinc-600">...</td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex items-center justify-between border-t border-white/[0.05] bg-black/10 px-2 py-1 text-[9px] text-zinc-600">
        <span>
          {value.length} object{value.length === 1 ? "" : "s"}
        </span>
        {value.truncated && <span>first {value.items.length} shown</span>}
      </div>
    </div>
  );
}

function ObjectRow({
  entry,
  depth,
}: {
  entry: { key: string; value: SerializedValue };
  depth: number;
}) {
  const entryValue = entry.value;
  const nested = isComplex(entryValue) && depth >= 2;

  if (nested) {
    return (
      <details className="group">
        <summary className="flex cursor-pointer list-none items-center gap-1.5 px-2 py-1.5 text-[11px] transition hover:bg-white/[0.03] [&::-webkit-details-marker]:hidden">
          <span className="text-[10px] text-zinc-600 transition group-open:rotate-90">
            &gt;
          </span>
          <span className="font-mono text-zinc-300">{entry.key}</span>
          <span className="text-zinc-700">:</span>
          <span className="truncate font-mono text-[10px] text-zinc-500">
            {summary(entryValue)}
          </span>
        </summary>
        <div className="border-l border-white/[0.06] px-2 pb-2 pl-5">
          <ValueView value={entryValue} depth={depth + 1} />
        </div>
      </details>
    );
  }

  return (
    <div className="flex items-start gap-2 px-2 py-1.5">
      <span className="shrink-0 font-mono text-[11px] text-zinc-300">
        {entry.key}
      </span>
      <span className="shrink-0 text-zinc-700">:</span>
      <div className="min-w-0 flex-1 break-all text-[11px] leading-4">
        <ValueView
          value={entryValue}
          depth={depth + 1}
          compact={isComplex(entryValue) && depth >= 1}
        />
      </div>
    </div>
  );
}

function ObjectView({ value, depth }: { value: ObjectValue; depth: number }) {
  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-center gap-1.5">
        {value.className !== "Object" && (
          <span className="rounded border border-emerald-400/20 bg-emerald-400/[0.07] px-1.5 py-0.5 font-mono text-[9px] text-emerald-300">
            {value.className}
          </span>
        )}
        <ValueCount>{value.keyCount} keys</ValueCount>
        {value.hint === "tree" && <ValueCount>tree</ValueCount>}
        {value.truncated && (
          <span className="text-[9px] text-zinc-600">
            first {value.entries.length} shown
          </span>
        )}
      </div>
      <div className="divide-y divide-white/[0.035] overflow-hidden rounded-lg border border-white/[0.055] bg-black/15">
        {value.entries.map((entry) => (
          <ObjectRow key={entry.key} entry={entry} depth={depth} />
        ))}
        {value.entries.length === 0 && (
          <p className="px-2 py-2 font-mono text-[10px] text-zinc-600">
            empty object
          </p>
        )}
      </div>
    </div>
  );
}

function MapView({ value, depth }: { value: MapValue; depth: number }) {
  return (
    <div className="overflow-hidden rounded-lg border border-indigo-400/15">
      <div className="flex items-center justify-between border-b border-indigo-400/10 bg-indigo-400/[0.05] px-2 py-1 font-mono text-[9px] text-indigo-300/80">
        <span>Map</span>
        <span>{value.size} entries</span>
      </div>
      <div className="divide-y divide-white/[0.04]">
        {value.entries.map((entry, index) => (
          <div key={index} className="flex items-start gap-2 px-2 py-1.5">
            <span className="mt-0.5 w-4 shrink-0 text-right font-mono text-[9px] text-zinc-600">
              {index}
            </span>
            <div className="min-w-0 flex-1 break-all text-[11px] leading-4">
              <ValueView value={entry.key} depth={depth + 1} compact />
            </div>
            <span className="mt-0.5 text-[10px] text-zinc-600">-&gt;</span>
            <div className="min-w-0 flex-[1.4] break-all text-[11px] leading-4">
              <ValueView
                value={entry.value}
                depth={depth + 1}
                compact={isComplex(entry.value) && depth >= 1}
              />
            </div>
          </div>
        ))}
        {value.entries.length === 0 && (
          <p className="px-2 py-2 font-mono text-[10px] text-zinc-600">
            empty map
          </p>
        )}
      </div>
      {value.truncated && (
        <div className="border-t border-white/[0.05] px-2 py-1 text-[9px] text-zinc-600">
          first {value.entries.length} shown
        </div>
      )}
    </div>
  );
}

function SetView({ value, depth }: { value: SetValue; depth: number }) {
  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap gap-1.5">
        {value.items.map((item, index) => (
          <div
            key={index}
            className="flex max-w-[190px] items-stretch overflow-hidden rounded-md border border-indigo-400/15 bg-black/20"
          >
            <span className="flex w-6 shrink-0 items-center justify-center border-r border-indigo-400/10 bg-indigo-400/[0.05] font-mono text-[9px] text-indigo-300/70">
              {index}
            </span>
            <span className="min-w-0 break-all px-2 py-1.5 text-[11px] leading-4">
              <ValueView
                value={item}
                depth={depth + 1}
                compact={isComplex(item) || depth >= 2}
              />
            </span>
          </div>
        ))}
      </div>
      <div className="flex items-center gap-1.5">
        <ValueCount>Set({value.size})</ValueCount>
        {value.truncated && (
          <span className="text-[9px] text-zinc-600">
            first {value.items.length} shown
          </span>
        )}
      </div>
    </div>
  );
}

function findBackingArray(value: ObjectValue): ArrayValue | null {
  const preferredKeys = [
    "items",
    "data",
    "values",
    "_items",
    "list",
    "elements",
    "array",
  ];
  for (const key of preferredKeys) {
    const entry = value.entries.find((candidate) => candidate.key === key);
    if (entry?.value.kind === "array") return entry.value;
  }
  const fallback = value.entries.find(
    (candidate) => candidate.value.kind === "array",
  );
  if (fallback && fallback.value.kind === "array") return fallback.value;
  return null;
}

function StackView({ value, label }: { value: ArrayValue; label?: string }) {
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between font-mono text-[9px] uppercase tracking-wider text-zinc-500">
        <span>{label ?? "Stack"}</span>
        <span>
          {value.length} item{value.length === 1 ? "" : "s"}
        </span>
      </div>
      <div className="flex flex-col gap-1">
        {[...value.items].reverse().map((item, reversedIndex) => {
          const index = value.items.length - 1 - reversedIndex;
          const isTop = reversedIndex === 0;
          return (
            <div
              key={index}
              className={`flex items-stretch overflow-hidden rounded-md border ${
                isTop
                  ? "border-emerald-400/30 bg-emerald-400/[0.06]"
                  : "border-white/[0.07] bg-black/20"
              }`}
            >
              <span className="flex w-7 shrink-0 items-center justify-center border-r border-white/[0.05] bg-white/[0.02] font-mono text-[9px] text-zinc-600">
                {index}
              </span>
              <span className="min-w-0 flex-1 break-all px-2 py-1.5 text-[11px] leading-4">
                <ValueView
                  value={item}
                  depth={1}
                  compact={isComplex(item)}
                />
              </span>
              {isTop && (
                <span className="flex items-center border-l border-emerald-400/15 px-1.5 font-mono text-[8px] uppercase tracking-wider text-emerald-300">
                  top
                </span>
              )}
            </div>
          );
        })}
      </div>
      {value.truncated && (
        <p className="text-[9px] text-zinc-600">
          first {value.items.length} shown
        </p>
      )}
      <p className="text-center font-mono text-[8px] uppercase tracking-wider text-zinc-700">
        bottom
      </p>
    </div>
  );
}

function QueueView({ value, label }: { value: ArrayValue; label?: string }) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between font-mono text-[9px] uppercase tracking-wider text-zinc-500">
        <span>{label ?? "Queue"}</span>
        <span>
          {value.length} item{value.length === 1 ? "" : "s"}
        </span>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {value.items.map((item, index) => {
          const isFront = index === 0;
          const isBack = index === value.items.length - 1 && !value.truncated;
          return (
            <div
              key={index}
              className={`flex min-w-[54px] max-w-[190px] flex-col overflow-hidden rounded-md border ${
                isFront
                  ? "border-emerald-400/30 bg-emerald-400/[0.06]"
                  : "border-white/[0.07] bg-black/20"
              }`}
            >
              <div className="flex items-center justify-between border-b border-white/[0.05] bg-white/[0.03] px-1.5 py-0.5 font-mono text-[8px] uppercase tracking-wider text-zinc-600">
                <span>{index}</span>
                {isFront && <span className="text-emerald-300">front</span>}
                {isBack && !isFront && <span>back</span>}
              </div>
              <div className="min-w-0 break-all px-2 py-1.5 text-[11px] leading-4">
                <ValueView
                  value={item}
                  depth={1}
                  compact={isComplex(item)}
                />
              </div>
            </div>
          );
        })}
        {value.truncated && (
          <div className="flex min-w-[54px] flex-col items-center justify-center rounded-md border border-dashed border-white/10 px-2 py-1.5 font-mono text-[10px] text-zinc-600">
            +{value.length - value.items.length}
          </div>
        )}
      </div>
      <p className="text-[9px] text-zinc-600">
        front is removed first{value.truncated ? " · more items hidden" : ""}
      </p>
    </div>
  );
}

function TreeBranch({
  value,
  depth,
  label,
}: {
  value: SerializedValue;
  depth: number;
  label: string;
}) {
  return (
    <div className="flex flex-col items-center">
      <span className="mb-1 h-3 w-px bg-white/10" />
      <span className="mb-1 font-mono text-[8px] uppercase tracking-wider text-zinc-600">
        {label}
      </span>
      <TreeView value={value} depth={depth} />
    </div>
  );
}

function TreeView({
  value,
  depth,
}: {
  value: SerializedValue;
  depth: number;
}) {
  if (value.kind !== "object") {
    return <ValueView value={value} depth={depth} compact />;
  }

  const labelKeys = ["value", "val", "data", "key", "name"];
  const labelEntry =
    labelKeys
      .map((key) => value.entries.find((entry) => entry.key === key))
      .find(
        (
          entry,
        ): entry is { key: string; value: SerializedValue } =>
          Boolean(entry && entry.value.kind === "primitive"),
      ) ?? value.entries.find((entry) => entry.value.kind === "primitive");

  const left = value.entries.find((entry) => entry.key === "left")?.value;
  const right = value.entries.find((entry) => entry.key === "right")?.value;
  const childrenEntry = value.entries.find(
    (entry) => entry.key === "children",
  )?.value;
  const children =
    childrenEntry?.kind === "array" ? childrenEntry.items : [];

  const hasChildren = Boolean(
    (left && left.kind !== "primitive") ||
      (right && right.kind !== "primitive") ||
      children.length,
  );

  return (
    <div className="inline-flex flex-col items-center">
      <div className="rounded-lg border border-emerald-400/25 bg-emerald-400/[0.055] px-2.5 py-1.5 text-center shadow-sm shadow-black/20">
        <div className="font-mono text-[8px] uppercase tracking-wider text-zinc-600">
          {value.className}
        </div>
        <div className="mt-0.5 max-w-[160px] break-all font-mono text-[11px] text-zinc-100">
          {labelEntry ? (
            <ValueView value={labelEntry.value} depth={depth + 1} compact />
          ) : (
            "node"
          )}
        </div>
      </div>
      {hasChildren && depth < 4 && (
        <div className="mt-0.5 flex items-start gap-3">
          {left && <TreeBranch value={left} depth={depth + 1} label="left" />}
          {right && (
            <TreeBranch value={right} depth={depth + 1} label="right" />
          )}
          {children.map((child, index) => (
            <TreeBranch
              key={index}
              value={child}
              depth={depth + 1}
              label={`#${index}`}
            />
          ))}
        </div>
      )}
      {hasChildren && depth >= 4 && (
        <span className="mt-1 font-mono text-[9px] text-zinc-600">
          ... children hidden
        </span>
      )}
    </div>
  );
}

export function ValueView({
  value,
  depth = 0,
  compact = false,
  preferred,
}: ValueViewProps) {
  if (compact) return <CompactValue value={value} />;

  switch (value.kind) {
    case "primitive":
      return (
        <span className="break-all whitespace-pre-wrap">
          <Primitive value={value} />
        </span>
      );
    case "function":
      return (
        <span className="font-mono text-pink-300">function {value.name}()</span>
      );
    case "circular":
      return (
        <span className="font-mono italic text-zinc-500">[Circular reference]</span>
      );
    case "unserializable":
      return (
        <span className="font-mono italic text-zinc-500">
          {value.note ?? "[Unserializable]"}
        </span>
      );
    case "array":
      if (preferred === "stack") {
        return <StackView value={value} />;
      }
      if (preferred === "queue") {
        return <QueueView value={value} />;
      }
      return <ArrayView value={value} depth={depth} />;
    case "object": {
      if (preferred === "stack" || value.hint === "stack") {
        const backing = findBackingArray(value);
        if (backing) {
          return (
            <StackView
              value={backing}
              label={value.className !== "Object" ? value.className : "Stack"}
            />
          );
        }
      }
      if (preferred === "queue" || value.hint === "queue") {
        const backing = findBackingArray(value);
        if (backing) {
          return (
            <QueueView
              value={backing}
              label={value.className !== "Object" ? value.className : "Queue"}
            />
          );
        }
      }
      if (preferred === "tree" || value.hint === "tree") {
        return (
          <div className="viz-scroll overflow-x-auto">
            <TreeView value={value} depth={depth} />
          </div>
        );
      }
      return <ObjectView value={value} depth={depth} />;
    }
    case "map":
      return <MapView value={value} depth={depth} />;
    case "set":
      return <SetView value={value} depth={depth} />;
  }
}
