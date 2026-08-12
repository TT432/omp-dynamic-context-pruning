import type { CandidateLog, RuleUnit, SharedProcedure, SkillContract, WorkflowUnit } from "./types";
import { approxTokens, normalizeText } from "./scanner";

function scopeFamily(scopeId: string, parents: Map<string, string | null>): string {
  let current = scopeId;
  let parent = parents.get(current);
  while (parent && parent !== "root") {
    current = parent;
    parent = parents.get(current);
  }
  return current === "root" ? scopeId : current;
}

function ruleKey(rule: RuleUnit, parents: Map<string, string | null>): string {
  return [rule.modality, rule.namespace ?? "", scopeFamily(rule.scopeId, parents), normalizeText(rule.guard ?? ""), normalizeText(rule.predicate)].join("\0");
}

function workflowSignature(unit: WorkflowUnit): string {
  // Exact scope identity is deliberately conservative: incompatible branches
  // must never share a procedure merely because their action text matches.
  return [unit.scopeId, unit.kind, normalizeText(unit.action), unit.tool ?? "", [...unit.requiredArgs].sort().join(",")].join("\0");
}
function mergeSpans<T extends { spans: Array<{ blockId: string; startLine: number; endLine: number }> }>(target: T, source: T): void {
  const known = new Set(target.spans.map((span) => `${span.blockId}:${span.startLine}:${span.endLine}`));
  for (const span of source.spans) {
    const key = `${span.blockId}:${span.startLine}:${span.endLine}`;
    if (!known.has(key)) {
      target.spans.push(span);
      known.add(key);
    }
  }
}

function deduplicateRules(contract: SkillContract, logs: CandidateLog[]): void {
  const parents = new Map(contract.scopes.map((scope) => [scope.id, scope.parentId]));
  const firstByKey = new Map<string, RuleUnit>();
  const kept: RuleUnit[] = [];
  for (const rule of contract.rules) {
    const key = ruleKey(rule, parents);
    const existing = firstByKey.get(key);
    if (!existing || existing.scopeId !== rule.scopeId) {
      firstByKey.set(key, rule);
      kept.push(rule);
      continue;
    }
    const before = approxTokens(existing.predicate) + approxTokens(rule.predicate);
    const after = approxTokens(existing.predicate);
    mergeSpans(existing, rule);
    for (const record of contract.coverage) {
      if (record.unitId === rule.id) record.renderedBy = existing.id;
    }
    logs.push({ kind: "DEDUP", accepted: true, beforeTokens: before, afterTokens: after, savingTokens: before - after, covered: [existing.id, rule.id], reason: "exact normalized rule under identical hard compatibility key" });
  }
  contract.rules = kept;
}

function liftRules(contract: SkillContract, logs: CandidateLog[]): void {
  const children = new Map<string, string[]>();
  for (const scope of contract.scopes) {
    if (!scope.parentId) continue;
    const list = children.get(scope.parentId) ?? [];
    list.push(scope.id);
    children.set(scope.parentId, list);
  }
  for (const [parentId, childIds] of children) {
    if (childIds.length < 2) continue;
    const childSet = new Set(childIds);
    const groups = new Map<string, RuleUnit[]>();
    for (const rule of contract.rules) {
      if (!childSet.has(rule.scopeId)) continue;
      const key = [rule.modality, rule.namespace ?? "", normalizeText(rule.guard ?? ""), normalizeText(rule.predicate)].join("\0");
      const list = groups.get(key) ?? [];
      list.push(rule);
      groups.set(key, list);
    }
    for (const group of groups.values()) {
      if (new Set(group.map((rule) => rule.scopeId)).size !== childIds.length) continue;
      const before = group.reduce((sum, rule) => sum + approxTokens(rule.predicate) + approxTokens(rule.scopeId), 0);
      const representative = group[0];
      const after = approxTokens(representative.predicate) + approxTokens(parentId);
      if (after >= before) {
        logs.push({ kind: "SCOPE_LIFT", accepted: false, beforeTokens: before, afterTokens: after, savingTokens: before - after, covered: group.map((rule) => rule.id), reason: "scope lift would not shorten rendering" });
        continue;
      }
      representative.scopeId = parentId;
      representative.liftedFrom = group.map((rule) => rule.id);
      for (const other of group.slice(1)) mergeSpans(representative, other);
      const removed = new Set(group.slice(1));
      contract.rules = contract.rules.filter((rule) => !removed.has(rule));
      for (const rule of group.slice(1)) {
        for (const record of contract.coverage) {
          if (record.unitId === rule.id) record.renderedBy = representative.id;
        }
      }
      logs.push({ kind: "SCOPE_LIFT", accepted: true, beforeTokens: before, afterTokens: after, savingTokens: before - after, covered: group.map((rule) => rule.id), reason: "same rule covers every direct child scope" });
    }
  }
}

interface SequenceOccurrence {
  start: number;
  ids: string[];
}

function extractWorkflowProcedures(contract: SkillContract, logs: CandidateLog[]): void {
  const signatures = contract.workflow.map(workflowSignature);
  const used = new Set<number>();
  const procedures: SharedProcedure[] = [];
  let procedureCounter = 1;
  const maxLength = Math.min(6, Math.floor(signatures.length / 2));
  for (let length = maxLength; length >= 2; length--) {
    const bySequence = new Map<string, SequenceOccurrence[]>();
    for (let start = 0; start + length <= signatures.length; start++) {
      const window = contract.workflow.slice(start, start + length);
      if (window.some((unit, index) => index > 0 && contract.workflow[start + index - 1].next.length > 0 && !contract.workflow[start + index - 1].next.includes(unit.id))) continue;
      const key = signatures.slice(start, start + length).join("\u0001");
      const occurrences = bySequence.get(key) ?? [];
      occurrences.push({ start, ids: window.map((unit) => unit.id) });
      bySequence.set(key, occurrences);
    }
    for (const occurrences of bySequence.values()) {
      const selected: SequenceOccurrence[] = [];
      for (const occurrence of occurrences) {
        const indices = Array.from({ length }, (_, offset) => occurrence.start + offset);
        if (indices.some((index) => used.has(index))) continue;
        if (selected.some((prior) => occurrence.start < prior.start + length)) continue;
        selected.push(occurrence);
      }
      if (selected.length < 2) continue;
      const actionText = contract.workflow.slice(selected[0].start, selected[0].start + length).map((unit) => unit.action).join("\n");
      const before = selected.length * approxTokens(actionText);
      const after = approxTokens(actionText) + selected.length * 3;
      const covered = selected.flatMap((occurrence) => occurrence.ids);
      if (after >= before) {
        logs.push({ kind: "WORKFLOW", accepted: false, beforeTokens: before, afterTokens: after, savingTokens: before - after, covered, reason: "definition plus references is not shorter" });
        continue;
      }
      selected.forEach((occurrence) => {
        for (let index = occurrence.start; index < occurrence.start + length; index++) used.add(index);
      });
      procedures.push({ id: `procedure_${procedureCounter++}`, actionSignatures: signatures.slice(selected[0].start, selected[0].start + length), occurrences: selected.map((occurrence) => occurrence.ids), savingTokens: before - after });
      logs.push({ kind: "WORKFLOW", accepted: true, beforeTokens: before, afterTokens: after, savingTokens: before - after, covered, reason: "repeated compatible contiguous workflow is cheaper as definition plus references" });
    }
  }
  contract.sharedProcedures = procedures;
}

/** Deterministic positive-savings optimizer. It never removes a covered unit. */
export function optimizeContract(contract: SkillContract): SkillContract {
  const optimized = structuredClone(contract);
  const logs: CandidateLog[] = [];
  deduplicateRules(optimized, logs);
  liftRules(optimized, logs);
  extractWorkflowProcedures(optimized, logs);
  optimized.candidates = logs;
  return optimized;
}

export function contractUnitKey(unit: RuleUnit | WorkflowUnit): string {
  if ("predicate" in unit) {
    return ["rule", unit.modality, unit.namespace ?? "", unit.scopeId, normalizeText(unit.guard ?? ""), normalizeText(unit.predicate)].join("\0");
  }
  return ["workflow", unit.kind, unit.scopeId, workflowSignature(unit)].join("\0");
}
