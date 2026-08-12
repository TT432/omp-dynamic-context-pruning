import { createHash } from "node:crypto";
import type {
  CoverageRecord,
  EvidenceUnit,
  ExtractedContract,
  OutputContract,
  OutputField,
  ResidualUnit,
  RuleUnit,
  ScopeUnit,
  ScopedText,
  SkillContract,
  SkillInterface,
  SourceBlock,
  SourceSpan,
  ValidationResult,
  WorkflowUnit,
} from "./types";
import { normalizeText, sourceHash } from "./scanner";

const ROOT_SCOPE = "root";
const MIN_CONFIDENCE = 0.7;

function unitId(prefix: string, value: string): string {
  return `${prefix}_${createHash("sha256").update(value).digest("hex").slice(0, 14)}`;
}

function validSpan(span: SourceSpan, blocks: Map<string, SourceBlock>): boolean {
  const block = blocks.get(span.blockId);
  return Boolean(block && span.startLine >= block!.startLine && span.endLine <= block!.endLine && span.startLine <= span.endLine);
}

function spansValid(spans: SourceSpan[] | undefined, blocks: Map<string, SourceBlock>): spans is SourceSpan[] {
  return Array.isArray(spans) && spans.length > 0 && spans.every((span) => validSpan(span, blocks));
}

function sanitizeScoped(values: ScopedText[] | undefined, blocks: Map<string, SourceBlock>, reject: Set<string>): ScopedText[] {
  if (!Array.isArray(values)) return [];
  const out: ScopedText[] = [];
  for (const value of values) {
    if (typeof value?.text !== "string" || !normalizeText(value.text) || !spansValid(value.spans, blocks)) {
      for (const span of value?.spans ?? []) if (blocks.has(span.blockId)) reject.add(span.blockId);
      continue;
    }
    out.push({ text: value.text.trim(), spans: value.spans });
  }
  return out;
}

function sanitizeScopes(values: ScopeUnit[] | undefined, blocks: Map<string, SourceBlock>, reject: Set<string>): ScopeUnit[] {
  const out: ScopeUnit[] = [{ id: ROOT_SCOPE, parentId: null, sourceBlocks: [] }];
  if (!Array.isArray(values)) return out;
  const ids = new Set([ROOT_SCOPE]);
  for (const value of values) {
    if (!value || typeof value.id !== "string" || value.id === ROOT_SCOPE || ids.has(value.id)) continue;
    const sourceBlocks = Array.isArray(value.sourceBlocks) ? value.sourceBlocks.filter((id) => blocks.has(id)) : [];
    if (sourceBlocks.length === 0) continue;
    out.push({ id: value.id, parentId: typeof value.parentId === "string" ? value.parentId : ROOT_SCOPE, ...(value.guard ? { guard: value.guard } : {}), sourceBlocks });
    ids.add(value.id);
  }
  const retained = out.filter((scope) => scope.id === ROOT_SCOPE || (scope.parentId !== scope.id && ids.has(scope.parentId ?? ROOT_SCOPE)));
  for (const scope of out) if (!retained.includes(scope)) for (const id of scope.sourceBlocks) reject.add(id);
  return retained;
}

function sanitizeWorkflow(
  values: WorkflowUnit[] | undefined,
  blocks: Map<string, SourceBlock>,
  scopes: Set<string>,
  knownTools: Map<string, Set<string>>,
  reject: Set<string>,
): WorkflowUnit[] {
  if (!Array.isArray(values)) return [];
  const prelim: WorkflowUnit[] = [];
  for (const value of values) {
    const cited = Array.isArray(value?.spans) ? value.spans.map((span) => span.blockId).filter((id) => blocks.has(id)) : [];
    const toolArgs = value?.tool ? knownTools.get(value.tool) : undefined;
    const validArgs = !value?.tool || (toolArgs !== undefined && value.requiredArgs.every((arg) => toolArgs.has(arg)));
    if (
      !value ||
      typeof value.id !== "string" ||
      typeof value.action !== "string" ||
      !normalizeText(value.action) ||
      !["action", "decision", "loop", "fallback", "stop"].includes(value.kind) ||
      !scopes.has(value.scopeId) ||
      !spansValid(value.spans, blocks) ||
      typeof value.confidence !== "number" ||
      value.confidence < MIN_CONFIDENCE ||
      !Array.isArray(value.requiredArgs) ||
      !Array.isArray(value.next) ||
      !validArgs
    ) {
      cited.forEach((id) => reject.add(id));
      continue;
    }
    prelim.push({ ...value, action: value.action.trim(), requiredArgs: [...new Set(value.requiredArgs)], next: [...new Set(value.next)] });
  }
  const duplicateIds = new Set<string>();
  const seenIds = new Set<string>();
  for (const unit of prelim) {
    if (seenIds.has(unit.id)) duplicateIds.add(unit.id);
    seenIds.add(unit.id);
  }
  const ids = new Set(prelim.filter((unit) => !duplicateIds.has(unit.id)).map((unit) => unit.id));
  return prelim.filter((unit) => {
    const ok = !duplicateIds.has(unit.id) && unit.next.every((id) => ids.has(id));
    if (!ok) unit.spans.forEach((span) => reject.add(span.blockId));
    return ok;
  });
}

function sanitizeRules(values: RuleUnit[] | undefined, blocks: Map<string, SourceBlock>, scopes: Set<string>, reject: Set<string>): RuleUnit[] {
  if (!Array.isArray(values)) return [];
  const out: RuleUnit[] = [];
  const seenIds = new Set<string>();
  for (const value of values) {
    const cited = Array.isArray(value?.spans) ? value.spans.map((span) => span.blockId).filter((id) => blocks.has(id)) : [];
    if (
      !value ||
      typeof value.id !== "string" ||
      seenIds.has(value.id) ||
      typeof value.predicate !== "string" ||
      !normalizeText(value.predicate) ||
      !["must", "must_not", "prefer"].includes(value.modality) ||
      !scopes.has(value.scopeId) ||
      !spansValid(value.spans, blocks) ||
      typeof value.confidence !== "number" ||
      value.confidence < MIN_CONFIDENCE
    ) {
      cited.forEach((id) => reject.add(id));
      continue;
    }
    seenIds.add(value.id);
    out.push({ ...value, predicate: value.predicate.trim(), locked: value.locked === true });
  }
  return out;
}

function sanitizeFields(values: OutputField[] | undefined, blocks: Map<string, SourceBlock>, reject: Set<string>): OutputField[] {
  if (!Array.isArray(values)) return [];
  const out: OutputField[] = [];
  for (const value of values) {
    if (typeof value?.name !== "string" || !normalizeText(value.name) || typeof value.required !== "boolean" || !spansValid(value.spans, blocks)) {
      for (const span of value?.spans ?? []) if (blocks.has(span.blockId)) reject.add(span.blockId);
      continue;
    }
    out.push({ name: value.name.trim(), required: value.required, ...(value.validation ? { validation: value.validation.trim() } : {}), spans: value.spans });
  }
  return out;
}

function sanitizeEvidence(values: EvidenceUnit[] | undefined, blocks: Map<string, SourceBlock>, knownUnits: Set<string>, reject: Set<string>): EvidenceUnit[] {
  if (!Array.isArray(values)) return [];
  const out: EvidenceUnit[] = [];
  for (const value of values) {
    const sourceBlocks = Array.isArray(value?.sourceBlocks) ? value.sourceBlocks.filter((id) => blocks.has(id)) : [];
    if (!value || !["example", "template", "rationale"].includes(value.kind) || sourceBlocks.length === 0) continue;
    const supports = Array.isArray(value.supports) ? value.supports.filter((id) => knownUnits.has(id)) : [];
    if (value.addsUniqueUnit && supports.length === 0) sourceBlocks.forEach((id) => reject.add(id));
    out.push({ id: value.id || unitId("e", sourceBlocks.join("/")), kind: value.kind, supports, addsUniqueUnit: value.addsUniqueUnit === true, sourceBlocks });
  }
  return out;
}

function residualFor(blockId: string, reason: ResidualUnit["reason"]): ResidualUnit {
  return { sourceBlock: blockId, reason, locked: true };
}

function markCoverage(contract: SkillContract): CoverageRecord[] {
  const coverage: CoverageRecord[] = [];
  const add = (unitIdValue: string, kind: CoverageRecord["kind"], spans: SourceSpan[], renderedBy = unitIdValue): void => {
    coverage.push({ unitId: unitIdValue, kind, renderedBy, sourceBlocks: [...new Set(spans.map((span) => span.blockId))] });
  };
  for (let i = 0; i < contract.interface.triggers.length; i++) add(`trigger_${i}`, "interface", contract.interface.triggers[i].spans);
  for (let i = 0; i < contract.interface.exclusions.length; i++) add(`exclusion_${i}`, "interface", contract.interface.exclusions[i].spans);
  contract.workflow.forEach((unit) => add(unit.id, "workflow", unit.spans));
  contract.rules.forEach((unit) => add(unit.id, "rule", unit.spans));
  contract.output.fields.forEach((field, i) => add(`output_${i}_${unitId("f", field.name)}`, "output", field.spans));
  contract.output.termination.forEach((term, i) => add(`termination_${i}`, "output", term.spans));
  contract.evidence.filter((item) => item.addsUniqueUnit).forEach((item) => coverage.push({ unitId: item.id, kind: "evidence", renderedBy: item.id, sourceBlocks: item.sourceBlocks }));
  contract.residual.forEach((item) => coverage.push({ unitId: `residual_${item.sourceBlock}`, kind: "residual", renderedBy: `residual_${item.sourceBlock}`, sourceBlocks: [item.sourceBlock] }));
  return coverage;
}

export function fallbackContract(name: string, source: string, blocks: SourceBlock[], now = new Date().toISOString()): SkillContract {
  const heading = blocks.find((block) => block.kind === "heading")?.text.replace(/^#+\s*/, "").trim();
  const residual = blocks.filter((block) => block.kind !== "heading").map((block) => residualFor(block.id, "AMBIGUOUS"));
  const contract: SkillContract = {
    version: 1,
    source: { name, sha256: sourceHash(source), bytes: Buffer.byteLength(source), createdAt: now, updatedAt: now },
    blocks,
    interface: { name, purpose: heading || `Reusable procedure ${name}`, triggers: [], exclusions: [] },
    scopes: [{ id: ROOT_SCOPE, parentId: null, sourceBlocks: [] }],
    workflow: [],
    rules: [],
    output: { fields: [], termination: [] },
    evidence: [],
    residual,
    sharedProcedures: [],
    candidates: [],
    coverage: [],
    updates: [{ at: now, operation: "CREATE", absorbed: 0, extended: residual.length }],
  };
  contract.coverage = markCoverage(contract);
  return contract;
}

export interface ValidationOptions {
  name: string;
  source: string;
  blocks: SourceBlock[];
  knownTools?: Map<string, Set<string>>;
  previousCreatedAt?: string;
  operation?: "CREATE" | "EXTEND" | "COMPRESS";
  now?: string;
}

/** Converts untrusted model output into a host-validated, fully covered contract. */
export function validateExtraction(extracted: ExtractedContract, options: ValidationOptions): ValidationResult {
  const now = options.now ?? new Date().toISOString();
  const blockMap = new Map(options.blocks.map((block) => [block.id, block]));
  const rejected = new Set<string>();
  const warnings: string[] = [];
  const scopes = sanitizeScopes(extracted.scopes, blockMap, rejected);
  const scopeIds = new Set(scopes.map((scope) => scope.id));
  const knownTools = options.knownTools ?? new Map<string, Set<string>>();
  const workflow = sanitizeWorkflow(extracted.workflow, blockMap, scopeIds, knownTools, rejected);
  const rules = sanitizeRules(extracted.rules, blockMap, scopeIds, rejected);
  const interfaceValue: SkillInterface = {
    name: typeof extracted.interface?.name === "string" && extracted.interface.name.trim() ? extracted.interface.name.trim() : options.name,
    purpose: typeof extracted.interface?.purpose === "string" && extracted.interface.purpose.trim() ? extracted.interface.purpose.trim() : `Reusable procedure ${options.name}`,
    triggers: sanitizeScoped(extracted.interface?.triggers, blockMap, rejected),
    exclusions: sanitizeScoped(extracted.interface?.exclusions, blockMap, rejected),
  };
  const output: OutputContract = {
    ...(typeof extracted.output?.type === "string" && extracted.output.type.trim() ? { type: extracted.output.type.trim() } : {}),
    fields: sanitizeFields(extracted.output?.fields, blockMap, rejected),
    termination: sanitizeScoped(extracted.output?.termination, blockMap, rejected),
  };
  const knownUnits = new Set([...workflow.map((unit) => unit.id), ...rules.map((unit) => unit.id)]);
  const evidence = sanitizeEvidence(extracted.evidence, blockMap, knownUnits, rejected);
  for (const blockId of extracted.residualBlocks ?? []) if (blockMap.has(blockId)) rejected.add(blockId);

  const cited = new Set<string>(options.blocks.filter((block) => block.kind === "heading").map((block) => block.id));
  for (const value of [...interfaceValue.triggers, ...interfaceValue.exclusions, ...output.termination]) value.spans.forEach((span) => cited.add(span.blockId));
  workflow.forEach((unit) => unit.spans.forEach((span) => cited.add(span.blockId)));
  rules.forEach((unit) => unit.spans.forEach((span) => cited.add(span.blockId)));
  output.fields.forEach((field) => field.spans.forEach((span) => cited.add(span.blockId)));
  evidence.forEach((unit) => unit.sourceBlocks.forEach((id) => cited.add(id)));

  // A block not explained by a validated unit is never deleted: preserve it verbatim.
  for (const block of options.blocks) if (!cited.has(block.id)) rejected.add(block.id);
  if (rejected.size) warnings.push(`${rejected.size} source block(s) preserved as locked residual`);

  const contract: SkillContract = {
    version: 1,
    source: {
      name: options.name,
      sha256: sourceHash(options.source),
      bytes: Buffer.byteLength(options.source),
      createdAt: options.previousCreatedAt ?? now,
      updatedAt: now,
    },
    blocks: options.blocks,
    interface: interfaceValue,
    scopes,
    workflow,
    rules,
    output,
    evidence,
    residual: [...rejected].map((id) => residualFor(id, "INVALID_EXTRACTION")),
    sharedProcedures: [],
    candidates: [],
    coverage: [],
    updates: [{ at: now, operation: options.operation ?? "CREATE", absorbed: 0, extended: workflow.length + rules.length + output.fields.length }],
  };
  contract.coverage = markCoverage(contract);
  return { contract, rejectedBlocks: [...rejected], warnings };
}

export function rebuildCoverage(contract: SkillContract): void {
  contract.coverage = markCoverage(contract);
}
