import type { ExtensionAPI, ExtensionContext, ToolDefinition, ToolResult } from "../omp";
import type { Extractor } from "./extractor";
import { LlmExtractor } from "./extractor";
import { scanMarkdown, approxTokens, normalizeText, sourceHash } from "./scanner";
import { fallbackContract, rebuildCoverage, validateExtraction } from "./validate";
import { contractUnitKey, optimizeContract } from "./optimizer";
import { auditRendered, renderContract, repairAudit } from "./render";
import { commitSkill, listSkills, loadSkill, managedRoot, MAX_SKILL_BYTES, validateSkillName } from "./store";
import type { ExtractedContract, OperationDetails, SkillContract, SourceBlock } from "./types";
import type { Logger } from "../logger";

export const SKILLZIP_TOOL = "skillzip";

function textResult(text: string, details: OperationDetails): ToolResult {
  return { content: [{ type: "text", text }], details: { ...details } };
}

function knownTools(pi: ExtensionAPI): Map<string, Set<string>> {
  const result = new Map<string, Set<string>>();
  const tools = pi.getAllTools?.() ?? [];
  for (const tool of tools) {
    const json = typeof (tool.parameters as { toJsonSchema?: () => Record<string, unknown> })?.toJsonSchema === "function"
      ? (tool.parameters as { toJsonSchema: () => Record<string, unknown> }).toJsonSchema()
      : tool.parameters as Record<string, unknown>;
    const properties = json && typeof json === "object" && "properties" in json && json.properties && typeof json.properties === "object"
      ? Object.keys(json.properties as Record<string, unknown>)
      : [];
    result.set(tool.name, new Set(properties));
  }
  return result;
}

async function extractConservatively(
  extractor: Extractor,
  name: string,
  source: string,
  blocks: SourceBlock[],
  ctx: ExtensionContext,
  tools: Map<string, Set<string>>,
  signal?: AbortSignal,
  previousCreatedAt?: string,
  operation: "CREATE" | "EXTEND" | "COMPRESS" = "CREATE",
): Promise<{ contract: SkillContract; warnings: string[] }> {
  try {
    const raw = await extractor.extract(name, blocks, ctx, signal, tools);
    const validated = validateExtraction(raw, { name, source, blocks, knownTools: tools, previousCreatedAt, operation });
    return { contract: validated.contract, warnings: validated.warnings };
  } catch (error) {
    const warning = `Structured extraction unavailable; preserved every source block: ${error instanceof Error ? error.message : String(error)}`;
    const contract = fallbackContract(name, source, blocks);
    if (previousCreatedAt) contract.source.createdAt = previousCreatedAt;
    contract.updates[0].operation = operation;
    return { contract, warnings: [warning] };
  }
}

function finalize(contract: SkillContract): { contract: SkillContract; text: string; repaired: string[] } {
  const optimized = optimizeContract(contract);
  const rendered = renderContract(optimized);
  const audit = auditRendered(optimized, rendered.text);
  if (audit.ok) return { contract: optimized, text: rendered.text, repaired: [] };
  const repaired = repairAudit(optimized, rendered.text);
  if (!repaired.audit.ok) throw new Error(`Coverage audit failed after recovery: ${repaired.audit.missingUnitIds.join(", ")}`);
  repaired.contract.updates.push({ at: new Date().toISOString(), operation: "AUDIT_REPAIR", absorbed: 0, extended: repaired.audit.recoveredBlocks.length });
  return { contract: repaired.contract, text: repaired.render.text, repaired: repaired.audit.recoveredBlocks };
}

export function mergePatch(current: SkillContract, patch: SkillContract, patchSource: string): { contract: SkillContract; absorbed: number; extended: number } {
  const merged = structuredClone(current);
  const prefix = `p_${sourceHash(patchSource).slice(0, 10)}_`;
  const blockIds = new Map<string, string>();
  const existingBlocks = new Set(merged.blocks.map((block) => block.id));
  for (const original of patch.blocks) {
    let id = `${prefix}${original.id}`;
    let suffix = 2;
    while (existingBlocks.has(id)) id = `${prefix}${original.id}_${suffix++}`;
    blockIds.set(original.id, id);
    merged.blocks.push({ ...original, id });
    existingBlocks.add(id);
  }
  const remapSpans = (spans: Array<{ blockId: string; startLine: number; endLine: number }>) => spans.map((span) => ({ ...span, blockId: blockIds.get(span.blockId) ?? span.blockId }));
  const remapScoped = (entries: Array<{ text: string; spans: Array<{ blockId: string; startLine: number; endLine: number }> }>) => entries.map((entry) => ({ ...entry, spans: remapSpans(entry.spans) }));
  patch.interface.triggers = remapScoped(patch.interface.triggers);
  patch.interface.exclusions = remapScoped(patch.interface.exclusions);
  patch.output.termination = remapScoped(patch.output.termination);
  patch.rules.forEach((unit) => { unit.spans = remapSpans(unit.spans); });
  patch.workflow.forEach((unit) => { unit.spans = remapSpans(unit.spans); });
  patch.output.fields.forEach((field) => { field.spans = remapSpans(field.spans); });
  patch.evidence.forEach((item) => { item.sourceBlocks = item.sourceBlocks.map((id) => blockIds.get(id) ?? id); });
  patch.residual.forEach((item) => { item.sourceBlock = blockIds.get(item.sourceBlock) ?? item.sourceBlock; });

  const existingRule = new Set(merged.rules.map(contractUnitKey));
  const existingWorkflow = new Set(merged.workflow.map(contractUnitKey));
  let absorbed = 0;
  let extended = 0;
  for (const rule of patch.rules) {
    const key = contractUnitKey(rule);
    if (existingRule.has(key)) absorbed++;
    else { merged.rules.push(rule); existingRule.add(key); extended++; }
  }
  for (const unit of patch.workflow) {
    const key = contractUnitKey(unit);
    if (existingWorkflow.has(key)) absorbed++;
    else { merged.workflow.push(unit); existingWorkflow.add(key); extended++; }
  }
  const triggerSet = new Set(merged.interface.triggers.map((entry) => normalizeText(entry.text)));
  for (const entry of patch.interface.triggers) {
    if (triggerSet.has(normalizeText(entry.text))) absorbed++;
    else { merged.interface.triggers.push(entry); triggerSet.add(normalizeText(entry.text)); extended++; }
  }
  const exclusionSet = new Set(merged.interface.exclusions.map((entry) => normalizeText(entry.text)));
  for (const entry of patch.interface.exclusions) {
    if (exclusionSet.has(normalizeText(entry.text))) absorbed++;
    else { merged.interface.exclusions.push(entry); exclusionSet.add(normalizeText(entry.text)); extended++; }
  }
  const fieldSet = new Set(merged.output.fields.map((field) => `${normalizeText(field.name)}\0${field.required}\0${normalizeText(field.validation ?? "")}`));
  for (const field of patch.output.fields) {
    const key = `${normalizeText(field.name)}\0${field.required}\0${normalizeText(field.validation ?? "")}`;
    if (fieldSet.has(key)) absorbed++;
    else { merged.output.fields.push(field); fieldSet.add(key); extended++; }
  }
  const residualSet = new Set(merged.residual.map((item) => item.sourceBlock));
  for (const residual of patch.residual) if (!residualSet.has(residual.sourceBlock)) { merged.residual.push(residual); residualSet.add(residual.sourceBlock); }
  const evidenceSet = new Set(merged.evidence.map((item) => item.id));
  for (const evidence of patch.evidence) if (!evidenceSet.has(evidence.id)) { merged.evidence.push(evidence); evidenceSet.add(evidence.id); }
  merged.source.updatedAt = new Date().toISOString();
  merged.source.sha256 = sourceHash(`${current.source.sha256}\n${patchSource}`);
  merged.source.bytes += Buffer.byteLength(patchSource);
  merged.updates.push({ at: merged.source.updatedAt, operation: extended === 0 ? "ABSORB" : "EXTEND", patchHash: sourceHash(patchSource), absorbed, extended });
  rebuildCoverage(merged);
  return { contract: merged, absorbed, extended };
}

export interface SkillZipToolDeps {
  pi: ExtensionAPI;
  logger: Logger;
  extractor?: Extractor;
  root?: string;
}

export function createSkillZipTool(deps: SkillZipToolDeps): ToolDefinition {
  const { pi, logger } = deps;
  const extractor = deps.extractor ?? new LlmExtractor();
  const zod = pi.zod;
  const parameters = zod.object({
    action: zod.enum(["list", "status", "create", "update", "compress", "audit", "inspect"] as const),
    name: zod.string({ description: "Managed skill name (lowercase kebab-case)" }).optional(),
    content: zod.string({ description: "Full source for create, validated reusable patch for update" }).optional(),
  });

  return {
    name: SKILLZIP_TOOL,
    label: "SkillZip",
    description: "Maintain reusable OMP skills with SkillZip typed-contract compression and hard structural coverage. Actions: create/update/compress/audit/inspect/status/list. Only call create/update for procedures validated by completed work; unique and uncertain source is preserved verbatim.",
    parameters,
    loadMode: "essential",
    approval: "write",
    strict: true,
    async execute(_toolCallId, params, signal, _onUpdate, ctx): Promise<ToolResult> {
      const input = params as { action?: unknown; name?: unknown; content?: unknown };
      const action = input.action;
      if (typeof action !== "string") throw new Error("skillzip requires an action");
      if (action === "list" || action === "status") {
        const skills = await listSkills(deps.root);
        return textResult(`${skills.length} managed SkillZip skill(s) under ${managedRoot(deps.root)}${skills.length ? `:\n${skills.map((skill) => `- ${skill.name} (${skill.bytes} bytes)`).join("\n")}` : "."}`, { action, skills });
      }
      if (typeof input.name !== "string") throw new Error(`skillzip ${action} requires a name`);
      const name = validateSkillName(input.name);
      const catalog = knownTools(pi);

      if (action === "inspect") {
        const loaded = await loadSkill(name, deps.root);
        const required = loaded.contract.coverage.length;
        return textResult(JSON.stringify(loaded.contract, null, 2), { action, skill: name, coverage: { required, covered: required }, path: loaded.paths.skill, sidecarPath: loaded.paths.sidecar });
      }
      if (action === "audit") {
        const loaded = await loadSkill(name, deps.root);
        const audit = auditRendered(loaded.contract, loaded.text);
        if (audit.ok) return textResult(`Skill "${name}" passes structural coverage audit (${loaded.contract.coverage.length}/${loaded.contract.coverage.length}).`, { action, skill: name, coverage: { required: loaded.contract.coverage.length, covered: loaded.contract.coverage.length }, repairedBlocks: [] });
        const repaired = repairAudit(loaded.contract, loaded.text);
        if (!repaired.audit.ok) throw new Error(`Audit recovery failed: ${repaired.audit.missingUnitIds.join(", ")}`);
        repaired.contract.updates.push({ at: new Date().toISOString(), operation: "AUDIT_REPAIR", absorbed: 0, extended: repaired.audit.recoveredBlocks.length });
        await commitSkill(name, repaired.render.text, repaired.contract, { overwrite: true, expectedArtifactHash: sourceHash(loaded.text) }, deps.root);
        return textResult(`Skill "${name}" audit restored ${repaired.audit.recoveredBlocks.length} source block(s).`, { action, skill: name, coverage: { required: repaired.contract.coverage.length, covered: repaired.contract.coverage.length }, repairedBlocks: repaired.audit.recoveredBlocks, path: loaded.paths.skill, sidecarPath: loaded.paths.sidecar });
      }
      if (action === "compress") {
        const loaded = await loadSkill(name, deps.root);
        const rescanned = scanMarkdown(loaded.text);
        const extracted = await extractConservatively(extractor, name, loaded.text, rescanned, ctx, catalog, signal, loaded.contract.source.createdAt, "COMPRESS");
        const result = finalize(extracted.contract);
        const paths = await commitSkill(name, result.text, result.contract, { overwrite: true, expectedArtifactHash: sourceHash(loaded.text) }, deps.root);
        return textResult(`Compressed and audited managed skill "${name}".`, { action, skill: name, operation: "COMPRESS", sourceTokens: approxTokens(loaded.text), renderedTokens: approxTokens(result.text), savingTokens: approxTokens(loaded.text) - approxTokens(result.text), coverage: { required: result.contract.coverage.length, covered: result.contract.coverage.length }, repairedBlocks: result.repaired, path: paths.skill, sidecarPath: paths.sidecar, warnings: extracted.warnings });
      }
      if (typeof input.content !== "string" || !input.content.trim()) throw new Error(`skillzip ${action} requires non-empty content`);
      if (Buffer.byteLength(input.content) > MAX_SKILL_BYTES) throw new Error(`Skill source exceeds ${MAX_SKILL_BYTES} bytes`);

      if (action === "create") {
        const source = input.content.replace(/\r\n?/g, "\n").trim() + "\n";
        const blocks = scanMarkdown(source);
        const extracted = await extractConservatively(extractor, name, source, blocks, ctx, catalog, signal);
        const result = finalize(extracted.contract);
        const paths = await commitSkill(name, result.text, result.contract, {}, deps.root);
        logger.info("SkillZip skill created", { name, coverage: result.contract.coverage.length });
        if (typeof ctx.reload === "function") await ctx.reload();
        return textResult(`Created and audited managed skill "${name}".`, { action, skill: name, operation: "CREATE", sourceTokens: approxTokens(source), renderedTokens: approxTokens(result.text), savingTokens: approxTokens(source) - approxTokens(result.text), coverage: { required: result.contract.coverage.length, covered: result.contract.coverage.length }, repairedBlocks: result.repaired, path: paths.skill, sidecarPath: paths.sidecar, warnings: extracted.warnings });
      }
      if (action === "update") {
        const loaded = await loadSkill(name, deps.root);
        const patchSource = input.content.replace(/\r\n?/g, "\n").trim() + "\n";
        const patchBlocks = scanMarkdown(patchSource);
        const extracted = await extractConservatively(extractor, name, patchSource, patchBlocks, ctx, catalog, signal, loaded.contract.source.createdAt, "EXTEND");
        const merged = mergePatch(loaded.contract, extracted.contract, patchSource);
        const result = finalize(merged.contract);
        const paths = await commitSkill(name, result.text, result.contract, { overwrite: true, expectedArtifactHash: sourceHash(loaded.text) }, deps.root);
        logger.info("SkillZip skill updated", { name, absorbed: merged.absorbed, extended: merged.extended });
        if (typeof ctx.reload === "function") await ctx.reload();
        return textResult(`Updated managed skill "${name}": ${merged.absorbed} absorbed, ${merged.extended} extended.`, { action, skill: name, operation: merged.extended === 0 ? "ABSORB" : "EXTEND", sourceTokens: approxTokens(patchSource), renderedTokens: approxTokens(result.text), savingTokens: approxTokens(loaded.text) + approxTokens(patchSource) - approxTokens(result.text), coverage: { required: result.contract.coverage.length, covered: result.contract.coverage.length }, absorbed: merged.absorbed, extended: merged.extended, repairedBlocks: result.repaired, path: paths.skill, sidecarPath: paths.sidecar, warnings: extracted.warnings });
      }
      throw new Error(`Unsupported skillzip action: ${action}`);
    },
  };
}

export function extractionForTests(value: ExtractedContract): Extractor {
  return { async extract() { return structuredClone(value); } };
}
