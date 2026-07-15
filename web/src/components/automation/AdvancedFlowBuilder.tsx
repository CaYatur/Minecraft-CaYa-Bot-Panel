import { useMemo, useState, type ReactNode } from "react";
import { ItemPicker } from "../ItemPicker";

export type FlowAction = Record<string, unknown> & { type: string };
export type BotCondition = Record<string, unknown> & { type: string };

export type CompareOperator =
  | "eq"
  | "neq"
  | "contains"
  | "not_contains"
  | "starts_with"
  | "ends_with"
  | "regex"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "exists"
  | "not_exists"
  | "truthy"
  | "falsy";

export type ConditionNode =
  | { kind: "bot"; condition: BotCondition }
  | { kind: "compare"; left: string; operator: CompareOperator; right?: string | number | boolean | null }
  | ConditionGroup;

export interface ConditionGroup {
  kind: "group";
  operator: "all" | "any" | "not";
  items: ConditionNode[];
}

interface NodeBase {
  id: string;
  label?: string;
  disabled?: boolean;
}

export type FlowNode =
  | (NodeBase & {
      type: "action";
      action: FlowAction;
      saveAs?: string;
      waitForTask?: boolean;
      timeoutMs?: number;
      retries?: number;
      retryDelayMs?: number;
      continueOnError?: boolean;
      onError?: FlowNode[];
    })
  | (NodeBase & { type: "if"; condition: ConditionGroup; then: FlowNode[]; else?: FlowNode[] })
  | (NodeBase & { type: "set"; name: string; value: string | number | boolean | null })
  | (NodeBase & {
      type: "wait";
      seconds?: number;
      until?: ConditionGroup;
      timeoutMs?: number;
      pollMs?: number;
    })
  | (NodeBase & {
      type: "repeat";
      times?: number | string;
      while?: ConditionGroup;
      maxIterations?: number;
      body: FlowNode[];
    })
  | (NodeBase & { type: "stop_flow"; result?: "success" | "failed"; message?: string });

interface MetaField {
  type: string;
  label: string;
  fields: string[];
  hint?: string;
  category?: string;
}

type Translate = (key: string, vars?: Record<string, string | number>) => string;

interface Props {
  value: FlowNode[];
  onChange: (flow: FlowNode[]) => void;
  actionMeta: MetaField[];
  conditionMeta: MetaField[];
  catalogVersion: string;
  t: Translate;
  metaLabel: (kind: "conditions" | "actions", type: string, fallback?: string) => string;
  catLabel: (category?: string) => string;
}

const fieldCls =
  "rounded-lg border border-zinc-700 bg-zinc-800 px-2.5 py-1.5 text-xs text-zinc-100 outline-none focus:border-indigo-500";

const newId = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `flow-${Date.now()}-${Math.random().toString(16).slice(2)}`;

export const emptyConditionGroup = (): ConditionGroup => ({
  kind: "group",
  operator: "all",
  items: [{ kind: "bot", condition: { type: "task_idle" } }]
});

export const makeFlowNode = (type: FlowNode["type"]): FlowNode => {
  if (type === "action") {
    return {
      id: newId(),
      type,
      action: { type: "panel_notify", message: "Rule triggered", level: "info" },
      timeoutMs: 120_000,
      retries: 0,
      retryDelayMs: 500
    };
  }
  if (type === "if") return { id: newId(), type, condition: emptyConditionGroup(), then: [], else: [] };
  if (type === "set") return { id: newId(), type, name: "value", value: "" };
  if (type === "wait") return { id: newId(), type, seconds: 1, timeoutMs: 30_000, pollMs: 250 };
  if (type === "repeat") return { id: newId(), type, times: 3, maxIterations: 100, body: [] };
  return { id: newId(), type: "stop_flow", result: "success", message: "" };
};

export function legacyRuleToFlow(
  conditions: BotCondition[],
  actions: FlowAction[],
  elseActions: FlowAction[]
): FlowNode[] {
  const toNodes = (list: FlowAction[]) =>
    list.map((action) => ({
      id: newId(),
      type: "action" as const,
      action: { ...action },
      timeoutMs: 120_000,
      retries: 0,
      retryDelayMs: 500
    }));
  if (!conditions.length) return toNodes(actions);
  return [
    {
      id: newId(),
      type: "if",
      condition: {
        kind: "group",
        operator: "all",
        items: conditions.map((condition) => ({ kind: "bot" as const, condition: { ...condition } }))
      },
      then: toNodes(actions),
      else: toNodes(elseActions)
    }
  ];
}

export function countFlowNodes(nodes: FlowNode[]): number {
  return nodes.reduce((total, node) => {
    if (node.type === "if") return total + 1 + countFlowNodes(node.then) + countFlowNodes(node.else ?? []);
    if (node.type === "repeat") return total + 1 + countFlowNodes(node.body);
    if (node.type === "action") return total + 1 + countFlowNodes(node.onError ?? []);
    return total + 1;
  }, 0);
}

export function AdvancedFlowBuilder(props: Props) {
  const [flowJsonError, setFlowJsonError] = useState("");
  return (
    <div className="space-y-3 rounded-lg border border-indigo-900/50 bg-indigo-950/10 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <div>
          <div className="text-[11px] font-semibold tracking-wide text-indigo-300 uppercase">
            {props.t("automations.advanced.flowTitle")}
          </div>
          <p className="mt-0.5 text-[10px] text-zinc-500">{props.t("automations.advanced.flowHint")}</p>
        </div>
        <span className="ml-auto rounded bg-zinc-900 px-2 py-1 text-[10px] text-zinc-400">
          {props.t("automations.advanced.nodeCount", { n: countFlowNodes(props.value) })}
        </span>
      </div>
      <div className="rounded-lg border border-indigo-900/40 bg-zinc-950/50 px-3 py-2 text-[10px] leading-relaxed text-zinc-500">
        <div className="font-medium text-indigo-300">{props.t("automations.advanced.resultTitle")}</div>
        <div>{props.t("automations.advanced.resultHint")}</div>
        <code className="mt-1 block text-[10px] text-zinc-400">
          {"{mineResult.status} · {mineResult.taskId} · {mineResult.error} · {last.status}"}
        </code>
      </div>
      <details className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-2">
        <summary className="cursor-pointer text-[10px] font-medium text-zinc-400">
          {props.t("automations.advanced.flowJson")}
        </summary>
        <p className="my-1 text-[10px] text-zinc-600">{props.t("automations.advanced.flowJsonHint")}</p>
        <textarea
          key={JSON.stringify(props.value)}
          defaultValue={JSON.stringify(props.value, null, 2)}
          onBlur={(event) => {
            try {
              const parsed = JSON.parse(event.target.value) as unknown;
              if (!Array.isArray(parsed)) throw new Error(props.t("automations.advanced.flowArrayError"));
              props.onChange(parsed as FlowNode[]);
              setFlowJsonError("");
            } catch (error) {
              setFlowJsonError(error instanceof Error ? error.message : String(error));
            }
          }}
          className={`${fieldCls} mono mt-2 min-h-48 w-full`}
        />
        {flowJsonError && <p className="mt-1 text-[10px] text-red-400">{flowJsonError}</p>}
      </details>
      <FlowList {...props} nodes={props.value} onChange={props.onChange} depth={0} />
    </div>
  );
}

interface FlowListProps extends Omit<Props, "value" | "onChange"> {
  nodes: FlowNode[];
  onChange: (nodes: FlowNode[]) => void;
  depth: number;
  title?: string;
  tone?: "then" | "else" | "body" | "error";
}

function FlowList({ nodes, onChange, depth, title, tone, ...props }: FlowListProps) {
  const add = (type: FlowNode["type"]) => onChange([...nodes, makeFlowNode(type)]);
  const move = (index: number, delta: number) => {
    const target = index + delta;
    if (target < 0 || target >= nodes.length) return;
    const next = [...nodes];
    [next[index], next[target]] = [next[target]!, next[index]!];
    onChange(next);
  };
  const duplicate = (index: number) => {
    const copy = cloneNode(nodes[index]!);
    const next = [...nodes];
    next.splice(index + 1, 0, copy);
    onChange(next);
  };
  const toneClass =
    tone === "then"
      ? "border-emerald-900/40 bg-emerald-950/10"
      : tone === "else"
        ? "border-violet-900/40 bg-violet-950/10"
        : tone === "error"
          ? "border-red-900/40 bg-red-950/10"
          : "border-zinc-800 bg-zinc-950/30";

  return (
    <div className={`space-y-2 rounded-lg border p-2 ${toneClass}`}>
      {title && <div className="text-[10px] font-semibold tracking-wide text-zinc-400 uppercase">{title}</div>}
      {nodes.length === 0 && (
        <p className="rounded border border-dashed border-zinc-800 px-3 py-4 text-center text-[10px] text-zinc-600">
          {props.t("automations.advanced.emptyBranch")}
        </p>
      )}
      {nodes.map((node, index) => (
        <div key={node.id} className="relative">
          <div className="absolute top-2 right-2 z-10 flex gap-1">
            <MiniButton disabled={index === 0} onClick={() => move(index, -1)} title="↑">↑</MiniButton>
            <MiniButton disabled={index === nodes.length - 1} onClick={() => move(index, 1)} title="↓">↓</MiniButton>
            <MiniButton onClick={() => duplicate(index)} title={props.t("automations.advanced.duplicate")}>⧉</MiniButton>
            <MiniButton
              onClick={() => onChange(nodes.filter((_, itemIndex) => itemIndex !== index))}
              title={props.t("automations.advanced.remove")}
              danger
            >
              ✕
            </MiniButton>
          </div>
          <NodeEditor
            {...props}
            node={node}
            depth={depth}
            onChange={(next) => onChange(nodes.map((item, itemIndex) => (itemIndex === index ? next : item)))}
          />
        </div>
      ))}
      <div className="flex flex-wrap gap-1.5 border-t border-zinc-800/80 pt-2">
        <AddButton onClick={() => add("action")}>+ {props.t("automations.advanced.addAction")}</AddButton>
        <AddButton onClick={() => add("if")}>+ {props.t("automations.advanced.addIf")}</AddButton>
        <AddButton onClick={() => add("set")}>+ {props.t("automations.advanced.addSet")}</AddButton>
        <AddButton onClick={() => add("wait")}>+ {props.t("automations.advanced.addWait")}</AddButton>
        <AddButton onClick={() => add("repeat")}>+ {props.t("automations.advanced.addRepeat")}</AddButton>
        <AddButton onClick={() => add("stop_flow")}>+ {props.t("automations.advanced.addStop")}</AddButton>
      </div>
    </div>
  );
}

interface NodeEditorProps extends Omit<FlowListProps, "nodes" | "onChange" | "title" | "tone"> {
  node: FlowNode;
  onChange: (node: FlowNode) => void;
}

function NodeEditor({ node, onChange, depth, ...props }: NodeEditorProps) {
  const shell = "rounded-lg border border-zinc-700/80 bg-zinc-900/80 p-3 pr-32";
  if (node.type === "action") {
    return (
      <div className={shell}>
        <NodeHeading title={props.t("automations.advanced.actionNode")} node={node} onChange={onChange} t={props.t} />
        <ActionEditor
          action={node.action}
          onChange={(action) => onChange({ ...node, action })}
          {...props}
        />
        <div className="mt-2 grid gap-2 md:grid-cols-2 xl:grid-cols-4">
          <Field label={props.t("automations.advanced.saveAs")}>
            <input
              value={node.saveAs ?? ""}
              onChange={(event) => onChange({ ...node, saveAs: event.target.value })}
              placeholder="mineResult"
              className={fieldCls}
            />
          </Field>
          <Field label={props.t("automations.advanced.timeoutMs")}>
            <input
              type="number"
              value={node.timeoutMs ?? 120000}
              onChange={(event) => onChange({ ...node, timeoutMs: Number(event.target.value) })}
              className={fieldCls}
            />
          </Field>
          <Field label={props.t("automations.advanced.retries")}>
            <input
              type="number"
              min={0}
              max={10}
              value={node.retries ?? 0}
              onChange={(event) => onChange({ ...node, retries: Number(event.target.value) })}
              className={fieldCls}
            />
          </Field>
          <Field label={props.t("automations.advanced.retryDelayMs")}>
            <input
              type="number"
              value={node.retryDelayMs ?? 500}
              onChange={(event) => onChange({ ...node, retryDelayMs: Number(event.target.value) })}
              className={fieldCls}
            />
          </Field>
        </div>
        <div className="mt-2 flex flex-wrap gap-4 text-[11px] text-zinc-400">
          <Check
            checked={Boolean(node.waitForTask)}
            onChange={(checked) => onChange({ ...node, waitForTask: checked })}
            label={props.t("automations.advanced.waitForTask")}
          />
          <Check
            checked={Boolean(node.continueOnError)}
            onChange={(checked) => onChange({ ...node, continueOnError: checked })}
            label={props.t("automations.advanced.continueOnError")}
          />
        </div>
        {(node.onError?.length ?? 0) > 0 ? (
          <div className="mt-3">
            <FlowList
              {...props}
              nodes={node.onError ?? []}
              onChange={(onError) => onChange({ ...node, onError })}
              depth={depth + 1}
              tone="error"
              title={props.t("automations.advanced.nodeOnError")}
            />
          </div>
        ) : (
          <button
            type="button"
            onClick={() => onChange({ ...node, onError: [makeFlowNode("action")] })}
            className="mt-2 text-[10px] text-red-400 hover:underline"
          >
            + {props.t("automations.advanced.addNodeOnError")}
          </button>
        )}
      </div>
    );
  }

  if (node.type === "if") {
    return (
      <div className={`${shell} border-sky-800/70 bg-sky-950/15`}>
        <NodeHeading title={props.t("automations.advanced.ifNode")} node={node} onChange={onChange} t={props.t} />
        <ConditionGroupEditor
          group={node.condition}
          onChange={(condition) => onChange({ ...node, condition })}
          {...props}
        />
        <div className="mt-3 grid gap-3 xl:grid-cols-2">
          <FlowList
            {...props}
            nodes={node.then}
            onChange={(then) => onChange({ ...node, then })}
            depth={depth + 1}
            tone="then"
            title={props.t("automations.advanced.thenBranch")}
          />
          <FlowList
            {...props}
            nodes={node.else ?? []}
            onChange={(elseNodes) => onChange({ ...node, else: elseNodes })}
            depth={depth + 1}
            tone="else"
            title={props.t("automations.advanced.elseBranch")}
          />
        </div>
        <button
          type="button"
          onClick={() => onChange({ ...node, else: [...(node.else ?? []), makeFlowNode("if")] })}
          className="mt-2 text-[10px] text-violet-300 hover:underline"
        >
          + {props.t("automations.advanced.addElseIf")}
        </button>
      </div>
    );
  }

  if (node.type === "set") {
    return (
      <div className={`${shell} border-cyan-900/60 bg-cyan-950/10`}>
        <NodeHeading title={props.t("automations.advanced.setNode")} node={node} onChange={onChange} t={props.t} />
        <div className="grid gap-2 md:grid-cols-2">
          <Field label={props.t("automations.advanced.variableName")}>
            <input value={node.name} onChange={(event) => onChange({ ...node, name: event.target.value })} className={fieldCls} />
          </Field>
          <Field label={props.t("automations.advanced.variableValue")}>
            <input
              value={String(node.value ?? "")}
              onChange={(event) => onChange({ ...node, value: event.target.value })}
              placeholder="{arg0}"
              className={fieldCls}
            />
          </Field>
        </div>
      </div>
    );
  }

  if (node.type === "wait") {
    const untilMode = Boolean(node.until);
    return (
      <div className={`${shell} border-amber-900/60 bg-amber-950/10`}>
        <NodeHeading title={props.t("automations.advanced.waitNode")} node={node} onChange={onChange} t={props.t} />
        <div className="mb-2 flex gap-2">
          <button
            type="button"
            onClick={() => onChange({ ...node, until: undefined, seconds: node.seconds ?? 1 })}
            className={`rounded px-2 py-1 text-[10px] ${!untilMode ? "bg-amber-700 text-white" : "bg-zinc-800 text-zinc-400"}`}
          >
            {props.t("automations.advanced.waitDuration")}
          </button>
          <button
            type="button"
            onClick={() => onChange({ ...node, until: node.until ?? emptyConditionGroup() })}
            className={`rounded px-2 py-1 text-[10px] ${untilMode ? "bg-amber-700 text-white" : "bg-zinc-800 text-zinc-400"}`}
          >
            {props.t("automations.advanced.waitUntil")}
          </button>
        </div>
        {untilMode ? (
          <>
            <ConditionGroupEditor group={node.until!} onChange={(until) => onChange({ ...node, until })} {...props} />
            <div className="mt-2 grid gap-2 md:grid-cols-2">
              <Field label={props.t("automations.advanced.timeoutMs")}>
                <input type="number" value={node.timeoutMs ?? 30000} onChange={(event) => onChange({ ...node, timeoutMs: Number(event.target.value) })} className={fieldCls} />
              </Field>
              <Field label={props.t("automations.advanced.pollMs")}>
                <input type="number" value={node.pollMs ?? 250} onChange={(event) => onChange({ ...node, pollMs: Number(event.target.value) })} className={fieldCls} />
              </Field>
            </div>
          </>
        ) : (
          <Field label={props.t("automations.advanced.seconds")}>
            <input type="number" min={0} step={0.1} value={node.seconds ?? 1} onChange={(event) => onChange({ ...node, seconds: Number(event.target.value) })} className={fieldCls} />
          </Field>
        )}
      </div>
    );
  }

  if (node.type === "repeat") {
    return (
      <div className={`${shell} border-fuchsia-900/60 bg-fuchsia-950/10`}>
        <NodeHeading title={props.t("automations.advanced.repeatNode")} node={node} onChange={onChange} t={props.t} />
        <div className="grid gap-2 md:grid-cols-2">
          <Field label={props.t("automations.advanced.repeatTimes")}>
            <input value={String(node.times ?? 3)} onChange={(event) => onChange({ ...node, times: event.target.value })} placeholder="3 / {arg0}" className={fieldCls} />
          </Field>
          <Field label={props.t("automations.advanced.maxIterations")}>
            <input type="number" value={node.maxIterations ?? 100} onChange={(event) => onChange({ ...node, maxIterations: Number(event.target.value) })} className={fieldCls} />
          </Field>
        </div>
        <div className="mt-2">
          <Check
            checked={Boolean(node.while)}
            onChange={(checked) => onChange({ ...node, while: checked ? emptyConditionGroup() : undefined })}
            label={props.t("automations.advanced.useWhile")}
          />
        </div>
        {node.while && (
          <div className="mt-2">
            <ConditionGroupEditor group={node.while} onChange={(whileGroup) => onChange({ ...node, while: whileGroup })} {...props} />
          </div>
        )}
        <div className="mt-3">
          <FlowList
            {...props}
            nodes={node.body}
            onChange={(body) => onChange({ ...node, body })}
            depth={depth + 1}
            tone="body"
            title={props.t("automations.advanced.repeatBody")}
          />
        </div>
      </div>
    );
  }

  return (
    <div className={`${shell} border-red-900/60 bg-red-950/10`}>
      <NodeHeading title={props.t("automations.advanced.stopNode")} node={node} onChange={onChange} t={props.t} />
      <div className="grid gap-2 md:grid-cols-2">
        <Field label={props.t("automations.advanced.stopResult")}>
          <select value={node.result ?? "success"} onChange={(event) => onChange({ ...node, result: event.target.value as "success" | "failed" })} className={fieldCls}>
            <option value="success">{props.t("automations.advanced.success")}</option>
            <option value="failed">{props.t("automations.advanced.failed")}</option>
          </select>
        </Field>
        <Field label={props.t("automations.advanced.stopMessage")}>
          <input value={node.message ?? ""} onChange={(event) => onChange({ ...node, message: event.target.value })} className={fieldCls} />
        </Field>
      </div>
    </div>
  );
}

function NodeHeading({ title, node, onChange, t }: { title: string; node: FlowNode; onChange: (node: FlowNode) => void; t: Translate }) {
  return (
    <div className="mb-2 flex min-w-0 items-center gap-2 pr-8">
      <span className="rounded bg-zinc-950 px-2 py-0.5 text-[10px] font-semibold text-zinc-300">{title}</span>
      <input
        value={node.label ?? ""}
        onChange={(event) => onChange({ ...node, label: event.target.value })}
        placeholder={t("automations.advanced.nodeLabel")}
        className="min-w-0 flex-1 border-b border-transparent bg-transparent px-1 text-[10px] text-zinc-500 outline-none focus:border-zinc-700"
      />
      <Check checked={!node.disabled} onChange={(checked) => onChange({ ...node, disabled: !checked })} label={t("automations.active")} />
    </div>
  );
}

function ConditionGroupEditor({ group, onChange, ...props }: Omit<Props, "value" | "onChange"> & { group: ConditionGroup; onChange: (group: ConditionGroup) => void }) {
  const updateItem = (index: number, item: ConditionNode) =>
    onChange({ ...group, items: group.items.map((current, itemIndex) => (itemIndex === index ? item : current)) });
  const removeItem = (index: number) => onChange({ ...group, items: group.items.filter((_, itemIndex) => itemIndex !== index) });
  return (
    <div className="space-y-2 rounded border border-sky-900/40 bg-zinc-950/35 p-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[10px] text-zinc-500">{props.t("automations.advanced.groupMode")}</span>
        <select value={group.operator} onChange={(event) => onChange({ ...group, operator: event.target.value as ConditionGroup["operator"] })} className={fieldCls}>
          <option value="all">{props.t("automations.advanced.all")}</option>
          <option value="any">{props.t("automations.advanced.any")}</option>
          <option value="not">{props.t("automations.advanced.not")}</option>
        </select>
      </div>
      {group.items.map((item, index) => (
        <div key={index} className="flex items-start gap-2 rounded border border-zinc-800 bg-zinc-900/50 p-2">
          <div className="min-w-0 flex-1">
            {item.kind === "group" ? (
              <ConditionGroupEditor group={item} onChange={(next) => updateItem(index, next)} {...props} />
            ) : item.kind === "bot" ? (
              <BotConditionEditor condition={item.condition} onChange={(condition) => updateItem(index, { kind: "bot", condition })} {...props} />
            ) : (
              <CompareConditionEditor condition={item} onChange={(next) => updateItem(index, next)} t={props.t} />
            )}
          </div>
          <MiniButton onClick={() => removeItem(index)} danger title={props.t("automations.advanced.remove")}>✕</MiniButton>
        </div>
      ))}
      <div className="flex flex-wrap gap-1.5">
        <AddButton onClick={() => onChange({ ...group, items: [...group.items, { kind: "bot", condition: { type: "task_idle" } }] })}>
          + {props.t("automations.advanced.botCondition")}
        </AddButton>
        <AddButton onClick={() => onChange({ ...group, items: [...group.items, { kind: "compare", left: "{last.status}", operator: "eq", right: "done" }] })}>
          + {props.t("automations.advanced.valueCondition")}
        </AddButton>
        <AddButton onClick={() => onChange({ ...group, items: [...group.items, emptyConditionGroup()] })}>
          + {props.t("automations.advanced.subgroup")}
        </AddButton>
      </div>
    </div>
  );
}

function BotConditionEditor({ condition, onChange, ...props }: Omit<Props, "value" | "onChange"> & { condition: BotCondition; onChange: (condition: BotCondition) => void }) {
  const type = String(condition.type ?? "task_idle");
  const patch = (values: Record<string, unknown>) => onChange({ ...condition, ...values });
  return (
    <div className="flex flex-wrap items-end gap-2">
      <Field label={props.t("automations.conditionType")}>
        <select value={type} onChange={(event) => onChange({ type: event.target.value })} className={fieldCls}>
          {props.conditionMeta.map((meta) => (
            <option key={meta.type} value={meta.type}>{props.metaLabel("conditions", meta.type, meta.label)}</option>
          ))}
        </select>
      </Field>
      {["has_item", "not_has_item", "item_count"].includes(type) && (
        <ItemPicker version={props.catalogVersion} kind="items" value={String(condition.item ?? "stick")} onChange={(item) => patch({ item })} />
      )}
      {type === "item_count" && (
        <select value={String(condition.comparison ?? "gte")} onChange={(event) => patch({ comparison: event.target.value })} className={fieldCls}>
          <option value="lt">&lt;</option><option value="lte">≤</option><option value="eq">=</option><option value="gte">≥</option><option value="gt">&gt;</option>
        </select>
      )}
      {["health_below", "health_above", "food_below", "food_above", "item_count"].includes(type) && (
        <input type="number" value={Number(condition.threshold ?? 10)} onChange={(event) => patch({ threshold: Number(event.target.value) })} className={`${fieldCls} w-24`} />
      )}
      {["player_near", "player_far"].includes(type) && (
        <>
          <input value={String(condition.player ?? "")} onChange={(event) => patch({ player: event.target.value })} placeholder="{player}" className={`${fieldCls} w-36`} />
          <input type="number" value={Number(condition.radius ?? 16)} onChange={(event) => patch({ radius: Number(event.target.value) })} className={`${fieldCls} w-20`} />
        </>
      )}
      {type === "in_dimension" && <input value={String(condition.dimension ?? "overworld")} onChange={(event) => patch({ dimension: event.target.value })} className={`${fieldCls} w-36`} />}
      {["task_is", "task_label_is", "combat_mode_is", "status_is", "follow_player_is"].includes(type) && (
        <>
          <input
            value={String(condition.taskType ?? condition.value ?? condition.player ?? "")}
            onChange={(event) => patch(type === "follow_player_is" ? { player: event.target.value, value: event.target.value } : type === "task_is" ? { taskType: event.target.value, value: event.target.value } : { value: event.target.value })}
            placeholder="{task} / mine|gather"
            className={`${fieldCls} min-w-[12rem] flex-1`}
          />
          <select value={String(condition.match ?? (type === "task_label_is" ? "contains" : "eq"))} onChange={(event) => patch({ match: event.target.value })} className={fieldCls}>
            <option value="eq">=</option><option value="neq">≠</option><option value="contains">contains</option><option value="startsWith">starts</option><option value="regex">regex</option>
          </select>
        </>
      )}
    </div>
  );
}

function CompareConditionEditor({ condition, onChange, t }: { condition: Extract<ConditionNode, { kind: "compare" }>; onChange: (condition: Extract<ConditionNode, { kind: "compare" }>) => void; t: Translate }) {
  const noRight = ["exists", "not_exists", "truthy", "falsy"].includes(condition.operator);
  return (
    <div className="grid gap-2 md:grid-cols-[1fr_10rem_1fr]">
      <Field label={t("automations.advanced.leftValue")}>
        <input value={condition.left} onChange={(event) => onChange({ ...condition, left: event.target.value })} placeholder="{mineResult.status}" className={fieldCls} />
      </Field>
      <Field label={t("automations.advanced.operator")}>
        <select value={condition.operator} onChange={(event) => onChange({ ...condition, operator: event.target.value as CompareOperator })} className={fieldCls}>
          {(["eq", "neq", "contains", "not_contains", "starts_with", "ends_with", "regex", "gt", "gte", "lt", "lte", "exists", "not_exists", "truthy", "falsy"] as CompareOperator[]).map((operator) => (
            <option key={operator} value={operator}>{t(`automations.advanced.operators.${operator}`)}</option>
          ))}
        </select>
      </Field>
      {!noRight && (
        <Field label={t("automations.advanced.rightValue")}>
          <input value={String(condition.right ?? "")} onChange={(event) => onChange({ ...condition, right: event.target.value })} placeholder="done" className={fieldCls} />
        </Field>
      )}
    </div>
  );
}

function ActionEditor({ action, onChange, ...props }: Omit<Props, "value" | "onChange"> & { action: FlowAction; onChange: (action: FlowAction) => void }) {
  const [jsonOpen, setJsonOpen] = useState(false);
  const [jsonError, setJsonError] = useState("");
  const type = String(action.type ?? "panel_notify");
  const patch = (values: Record<string, unknown>) => onChange({ ...action, ...values, type });
  const extraJson = useMemo(() => JSON.stringify(Object.fromEntries(Object.entries(action).filter(([key]) => key !== "type")), null, 2), [action]);
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-end gap-2">
        <Field label={props.t("automations.actionLabel")}>
          <select value={type} onChange={(event) => onChange({ type: event.target.value })} className={fieldCls}>
            {props.actionMeta.map((meta) => (
              <option key={meta.type} value={meta.type}>{meta.category ? `${props.catLabel(meta.category)}: ` : ""}{props.metaLabel("actions", meta.type, meta.label)}</option>
            ))}
          </select>
        </Field>
        {["goto", "follow", "attack", "protect", "social-follow", "social-attack", "unfollow"].includes(type) && (
          <input value={String(action.player ?? "{player}")} onChange={(event) => patch({ player: event.target.value })} placeholder="{player} / {arg0}" className={`${fieldCls} w-40`} />
        )}
        {type === "send_chat" && <input value={String(action.text ?? "")} onChange={(event) => patch({ text: event.target.value })} placeholder="message" className={`${fieldCls} min-w-[14rem] flex-1`} />}
        {type === "panel_notify" && <input value={String(action.message ?? "")} onChange={(event) => patch({ message: event.target.value })} placeholder="notification" className={`${fieldCls} min-w-[14rem] flex-1`} />}
        {["report_status", "bot_status", "durum-raporu"].includes(type) && (
          <>
            <input value={String(action.message ?? "")} onChange={(event) => patch({ message: event.target.value })} placeholder="Task: {task}" className={`${fieldCls} min-w-[14rem] flex-1`} />
            <select value={String(action.to ?? "panel")} onChange={(event) => patch({ to: event.target.value })} className={fieldCls}><option value="panel">panel</option><option value="chat">chat</option><option value="both">both</option></select>
          </>
        )}
        {["collect", "collect_item", "craft", "withdraw", "mine"].includes(type) && (
          <>
            {type === "mine" ? (
              <ItemPicker version={props.catalogVersion} kind="ores" value={String(action.ore ?? "iron")} onChange={(ore) => patch({ ore: ore.replace(/_ore$/, "") })} />
            ) : (
              <ItemPicker version={props.catalogVersion} kind={type === "collect" || type === "collect_item" ? "blocks" : "items"} value={String(action.item ?? action.block ?? "oak_log")} onChange={(item) => patch({ item, block: item })} />
            )}
            <input value={String(action.count ?? 1)} onChange={(event) => patch({ count: event.target.value })} placeholder="{arg1}" className={`${fieldCls} w-24`} />
          </>
        )}
        {["clear-mobs", "clear_mobs", "hunt", "collect_drops"].includes(type) && <input type="number" value={Number(action.radius ?? 16)} onChange={(event) => patch({ radius: Number(event.target.value) })} className={`${fieldCls} w-24`} />}
        {type === "wait" && <input type="number" value={Number(action.seconds ?? 1)} onChange={(event) => patch({ seconds: Number(event.target.value) })} className={`${fieldCls} w-24`} />}
        <button type="button" onClick={() => setJsonOpen((open) => !open)} className="rounded bg-zinc-800 px-2 py-1.5 text-[10px] text-zinc-400 hover:text-zinc-200">{props.t("automations.advanced.extraJson")}</button>
      </div>
      {jsonOpen && (
        <div>
          <textarea
            key={extraJson}
            defaultValue={extraJson}
            onBlur={(event) => {
              try {
                const parsed = JSON.parse(event.target.value) as Record<string, unknown>;
                onChange({ type, ...parsed });
                setJsonError("");
              } catch (error) {
                setJsonError(error instanceof Error ? error.message : String(error));
              }
            }}
            className={`${fieldCls} mono min-h-28 w-full`}
          />
          {jsonError && <p className="mt-1 text-[10px] text-red-400">{jsonError}</p>}
        </div>
      )}
    </div>
  );
}

function cloneNode(node: FlowNode): FlowNode {
  const cloned = JSON.parse(JSON.stringify(node)) as FlowNode;
  const renew = (current: FlowNode): FlowNode => {
    const next = { ...current, id: newId() } as FlowNode;
    if (next.type === "if") return { ...next, then: next.then.map(renew), else: (next.else ?? []).map(renew) };
    if (next.type === "repeat") return { ...next, body: next.body.map(renew) };
    if (next.type === "action") return { ...next, onError: (next.onError ?? []).map(renew) };
    return next;
  };
  return renew(cloned);
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label className="flex min-w-0 flex-col gap-0.5 text-[10px] text-zinc-500"><span>{label}</span>{children}</label>;
}

function Check({ checked, onChange, label }: { checked: boolean; onChange: (checked: boolean) => void; label: string }) {
  return <label className="flex cursor-pointer items-center gap-1.5 text-[10px] text-zinc-400"><input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} className="h-3.5 w-3.5 rounded border-zinc-700 bg-zinc-900" />{label}</label>;
}

function AddButton({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return <button type="button" onClick={onClick} className="rounded bg-zinc-800 px-2 py-1 text-[10px] text-zinc-300 hover:bg-zinc-700">{children}</button>;
}

function MiniButton({ onClick, children, title, disabled, danger }: { onClick: () => void; children: ReactNode; title: string; disabled?: boolean; danger?: boolean }) {
  return <button type="button" disabled={disabled} onClick={onClick} title={title} className={`rounded bg-zinc-950/90 px-1.5 py-0.5 text-[10px] disabled:opacity-20 ${danger ? "text-red-400 hover:bg-red-950" : "text-zinc-500 hover:text-zinc-200"}`}>{children}</button>;
}
