import { randomUUID } from "node:crypto";
import type { RuleAction, RuleCondition } from "./RuleEngine.js";

export type AutomationPrimitive = string | number | boolean | null;

export interface AutomationRunPolicy {
  /** Aynı kural hâlâ çalışırken yeni tetik gelirse. */
  concurrency?: "skip" | "parallel";
  /** Sonsuz veya yanlış akışları sınırlayan toplam çalışma süresi. */
  maxRuntimeMs?: number;
  /** Bir çalışmada yürütülebilecek en fazla düğüm. */
  maxSteps?: number;
}

export type AutomationCompareOperator =
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

export interface AutomationBotCondition {
  kind: "bot";
  condition: RuleCondition;
}

export interface AutomationValueCondition {
  kind: "compare";
  /** {mineResult.status}, {health}, düz metin veya sayı. */
  left: string;
  operator: AutomationCompareOperator;
  right?: string | number | boolean | null;
}

export interface AutomationConditionGroup {
  kind: "group";
  operator: "all" | "any" | "not";
  items: AutomationConditionNode[];
}

export type AutomationConditionNode =
  | AutomationBotCondition
  | AutomationValueCondition
  | AutomationConditionGroup;

interface AutomationNodeBase {
  id: string;
  label?: string;
  disabled?: boolean;
}

export interface AutomationActionNode extends AutomationNodeBase {
  type: "action";
  action: RuleAction;
  /** Sonucu {saveAs.status}, {saveAs.taskId}… olarak kaydeder. */
  saveAs?: string;
  /** Aksiyon görev kuyruğuna iş eklediyse tamamlanmasını bekler. */
  waitForTask?: boolean;
  timeoutMs?: number;
  retries?: number;
  retryDelayMs?: number;
  continueOnError?: boolean;
  onError?: AutomationNode[];
}

export interface AutomationIfNode extends AutomationNodeBase {
  type: "if";
  condition: AutomationConditionGroup;
  then: AutomationNode[];
  /** ELSE IF, else fore başka IF eklenerek sınırsız iç içe çalışır. */
  else?: AutomationNode[];
}

export interface AutomationSetNode extends AutomationNodeBase {
  type: "set";
  name: string;
  value: string | number | boolean | null;
}

export interface AutomationWaitNode extends AutomationNodeBase {
  type: "wait";
  seconds?: number;
  until?: AutomationConditionGroup;
  timeoutMs?: number;
  pollMs?: number;
}

export interface AutomationRepeatNode extends AutomationNodeBase {
  type: "repeat";
  /** Sabit sayı veya {arg0} gibi context ifadesi. */
  times?: number | string;
  while?: AutomationConditionGroup;
  maxIterations?: number;
  body: AutomationNode[];
}

export interface AutomationStopNode extends AutomationNodeBase {
  type: "stop_flow";
  result?: "success" | "failed";
  message?: string;
}

export type AutomationNode =
  | AutomationActionNode
  | AutomationIfNode
  | AutomationSetNode
  | AutomationWaitNode
  | AutomationRepeatNode
  | AutomationStopNode;

export function newFlowNodeId(): string {
  return randomUUID();
}

export function defaultConditionGroup(): AutomationConditionGroup {
  return {
    kind: "group",
    operator: "all",
    items: [{ kind: "bot", condition: { type: "task_idle" } }]
  };
}
