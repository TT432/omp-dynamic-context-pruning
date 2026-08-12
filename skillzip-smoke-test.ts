import {
  createBeforeAgentStartHandler,
  createEvolutionState,
  createSessionStopHandler,
  createToolExecutionEndHandler,
  SKILLZIP_GUIDANCE,
} from "./src/skillzip/hooks";
import { scanMarkdown } from "./src/skillzip/scanner";
import { validateExtraction, fallbackContract } from "./src/skillzip/validate";
import { normalizeNullableFields } from "./src/skillzip/extractor";
import { optimizeContract } from "./src/skillzip/optimizer";
import { auditRendered, renderContract, repairAudit } from "./src/skillzip/render";
import { mergePatch } from "./src/skillzip/tool";
import { commitSkill, loadSkill, pathsFor, validateSkillName } from "./src/skillzip/store";
import type { ExtractedContract, RuleUnit, SkillContract, SourceBlock, WorkflowUnit } from "./src/skillzip/types";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

let failures = 0;
function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    failures++;
    console.error("FAIL:", message);
  } else console.log("ok:", message);
}

async function throws(work: () => Promise<unknown>, pattern: RegExp, message: string): Promise<void> {
  try {
    await work();
    assert(false, `${message} — should throw`);
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    assert(pattern.test(text), `${message} — got ${text}`);
  }
}

function span(block: SourceBlock) {
  return [{ blockId: block.id, startLine: block.startLine, endLine: block.endLine }];
}

function rule(id: string, block: SourceBlock, scopeId = "root", modality: RuleUnit["modality"] = "must", predicate = block.text): RuleUnit {
  return { id, scopeId, modality, predicate, spans: span(block), locked: false, confidence: 1 };
}

function workflow(id: string, block: SourceBlock, action: string, next: string[] = []): WorkflowUnit {
  return { id, scopeId: "root", kind: "action", action, requiredArgs: [], next, spans: span(block), confidence: 1 };
}

function extraction(blocks: SourceBlock[]): ExtractedContract {
  return {
    interface: { name: "demo-skill", purpose: "Demo procedure", triggers: [], exclusions: [] },
    scopes: [],
    workflow: [],
    rules: blocks.map((block, index) => rule(`r${index}`, block)),
    output: { fields: [], termination: [] },
    evidence: [],
    residualBlocks: [],
  };
}

function contractFor(source: string, value?: ExtractedContract): SkillContract {
  const blocks = scanMarkdown(source);
  return validateExtraction(value ?? extraction(blocks), { name: "demo-skill", source, blocks }).contract;
}

// Scanner: stable IDs and atomic blocks.
{
  const source = `---\nname: demo\n---\n# Demo\n\nParagraph.\n\n\`\`\`ts\nconst x = 1;\n\`\`\`\n\n| A | B |\n|---|---|\n| 1 | 2 |\n`;
  const first = scanMarkdown(source);
  const second = scanMarkdown(source.replace(/\r?\n/g, "\r\n"));
  assert(first.map((block) => block.id).join() === second.map((block) => block.id).join(), "scanner IDs are stable across line endings");
  assert(first.filter((block) => block.kind === "fence").length === 1 && first.find((block) => block.kind === "fence")?.text.includes("const x"), "scanner keeps a fenced block atomic");
  assert(first.filter((block) => block.kind === "table").length === 1 && first.find((block) => block.kind === "table")?.endLine! - first.find((block) => block.kind === "table")?.startLine! === 2, "scanner keeps a Markdown table atomic");
}

// Host validation: bad citations, unknown tools/args, and dangling edges become residual.
{
  const source = "# Demo\n\nNever delete source files.\n\nCall read with path.\n";
  const blocks = scanMarkdown(source);
  const bad: ExtractedContract = {
    interface: { name: "demo-skill", purpose: "Demo", triggers: [], exclusions: [] },
    scopes: [],
    workflow: [
      { ...workflow("w1", blocks[2], "Read a file", ["missing"]), tool: "read", requiredArgs: ["wrong"] },
      { ...workflow("w2", blocks[2], "Bad citation"), spans: [{ blockId: "missing", startLine: 1, endLine: 1 }] },
    ],
    rules: [rule("rare", blocks[1])],
    output: { fields: [], termination: [] }, evidence: [], residualBlocks: [],
  };
  const validated = validateExtraction(bad, { name: "demo-skill", source, blocks, knownTools: new Map([["read", new Set(["path"]) ]]) });
  assert(validated.contract.workflow.length === 0, "validator rejects unknown args, dangling edges, and bad citations");
  assert(validated.contract.residual.some((item) => item.sourceBlock === blocks[2].id), "validator locks rejected workflow source");
  assert(validated.contract.rules.some((item) => item.id === "rare"), "validator preserves a unique rare rule independent of frequency");
}

// Exact compatible dedup only; conflicting modality remains explicit.
{
  const source = "# Demo\n\nKeep backups.\n\nKeep backups.\n\nDo not keep backups.\n";
  const blocks = scanMarkdown(source);
  const value = extraction(blocks);
  value.rules = [rule("a", blocks[1]), rule("b", blocks[2]), rule("c", blocks[3], "root", "must_not", "Keep backups.")];
  const optimized = optimizeContract(validateExtraction(value, { name: "demo-skill", source, blocks }).contract);
  assert(optimized.rules.length === 2, "optimizer deduplicates exact compatible rules but keeps conflicting modality");
  assert(optimized.coverage.some((item) => item.unitId === "b" && item.renderedBy === "a"), "dedup retains hard coverage alias for removed unit");
}

// Scope lift requires all direct children.
{
  const source = "# Demo\n\nValidate output.\n\nValidate output.\n";
  const blocks = scanMarkdown(source);
  const value = extraction(blocks);
  value.scopes = [
    { id: "left", parentId: "root", sourceBlocks: [blocks[1].id] },
    { id: "right", parentId: "root", sourceBlocks: [blocks[2].id] },
  ];
  value.rules = [rule("left-rule", blocks[1], "left"), rule("right-rule", blocks[2], "right")];
  const lifted = optimizeContract(validateExtraction(value, { name: "demo-skill", source, blocks }).contract);
  assert(lifted.rules.length === 1 && lifted.rules[0].scopeId === "root", "scope lift occurs only when every direct child has the rule");
  value.rules = [rule("left-only", blocks[1], "left")];
  const notLifted = optimizeContract(validateExtraction(value, { name: "demo-skill", source, blocks }).contract);
  assert(notLifted.rules[0].scopeId === "left", "scope lift does not occur for partial child coverage");
}

// Workflow extraction honors positive savings.
{
  const longA = "Collect the complete diagnostic payload from every relevant subsystem before editing any persistent artifact.";
  const longB = "Validate the payload against the declared schema and retain every unique exception verbatim before committing.";
  const source = `# Demo\n\n${longA}\n\n${longB}\n\n${longA}\n\n${longB}\n`;
  const blocks = scanMarkdown(source);
  const value = extraction(blocks);
  value.rules = [];
  value.workflow = [workflow("a1", blocks[1], longA, ["b1"]), workflow("b1", blocks[2], longB), workflow("a2", blocks[3], longA, ["b2"]), workflow("b2", blocks[4], longB)];
  const optimized = optimizeContract(validateExtraction(value, { name: "demo-skill", source, blocks }).contract);
  assert(optimized.sharedProcedures.length === 1 && optimized.sharedProcedures[0].savingTokens > 0, "workflow extraction requires repeated non-overlap and positive token savings");
  const shortSource = "# Demo\n\nA\n\nB\n\nA\n\nB\n";
  const shortBlocks = scanMarkdown(shortSource);
  const shortValue = extraction(shortBlocks); shortValue.rules = [];
  shortValue.workflow = [workflow("s1", shortBlocks[1], "A", ["s2"]), workflow("s2", shortBlocks[2], "B"), workflow("s3", shortBlocks[3], "A", ["s4"]), workflow("s4", shortBlocks[4], "B")];
  assert(optimizeContract(validateExtraction(shortValue, { name: "demo-skill", source: shortSource, blocks: shortBlocks }).contract).sharedProcedures.length === 0, "workflow extraction rejects non-profitable definitions");
}

// Fallback is safe without a model.
{
  const source = "# Rare\n\nNever overwrite the source file.\n";
  const blocks = scanMarkdown(source);
  const contract = fallbackContract("demo-skill", source, blocks);
  const rendered = renderContract(contract);

  assert(contract.residual.length === blocks.filter((block) => block.kind !== "heading").length && rendered.text.includes("Never overwrite the source file."), "fallback locks and renders every non-structural source block verbatim");
  assert(auditRendered(contract, rendered.text).ok, "fallback rendering passes hard coverage audit");
}

// Structured providers commonly materialize absent optional fields as null.
{
  const normalized = normalizeNullableFields({
    interface: { name: "demo-skill", purpose: "Demo", triggers: [], exclusions: [] },
    scopes: [{ id: "root", parentId: null, guard: null, sourceBlocks: [] }],
    workflow: [{ id: "w", scopeId: "root", kind: "stop", action: "Stop", tool: null, requiredArgs: [], next: [], spans: [], confidence: 1 }],
    rules: [{ id: "r", scopeId: "root", modality: "must", predicate: "Keep output", guard: null, namespace: null, spans: [], locked: false, confidence: 1 }],
    output: { type: null, fields: [{ name: "result", required: true, validation: null, spans: [] }], termination: [] },
    evidence: [],
    residualBlocks: [],
  });
  assert(normalized.scopes?.[0].guard === undefined && normalized.workflow?.[0].tool === undefined && normalized.output?.fields?.[0].validation === undefined, "extractor accepts provider nulls for optional contract fields");
}

// Incomplete model output stays parseable; host validation rejects low-confidence units and locks their source.
{
  const normalized = normalizeNullableFields({
    rules: [{ id: "incomplete", scopeId: "root", modality: "must", predicate: "Keep output", spans: [], guard: null, namespace: null }],
  });
  assert(normalized.rules?.[0].confidence === 0 && normalized.output?.fields?.length === 0 && normalized.evidence?.length === 0, "extractor defaults omitted containers and marks omitted confidence untrusted");
}
// Zip-on-Write distinguishes ABSORB from EXTEND and namespaces patch spans.
{
  const baseSource = "# Demo\n\nKeep backups.\n";
  const patchSource = "# Patch\n\nKeep backups.\n\nValidate checksums.\n";
  const base = contractFor(baseSource);
  const patchBlocks = scanMarkdown(patchSource);
  const patchValue = extraction(patchBlocks);
  patchValue.rules = [rule("same", patchBlocks[1], "root", "must", "Keep backups."), rule("new", patchBlocks[2], "root", "must", "Validate checksums.")];
  const patch = validateExtraction(patchValue, { name: "demo-skill", source: patchSource, blocks: patchBlocks }).contract;
  const merged = mergePatch(base, patch, patchSource);
  assert(merged.absorbed === 1 && merged.extended === 1, "Zip-on-Write classifies exact duplicate as ABSORB and new contract as EXTEND");
  assert(merged.contract.rules.some((item) => item.predicate === "Validate checksums." && item.spans.every((itemSpan) => itemSpan.blockId.startsWith("p_"))), "Zip-on-Write namespaces patch provenance to prevent stable-ID collisions");
}

// Audit independently detects missing semantics and restores the shortest cited block.
{
  const source = "# Demo\n\nAlways verify the checksum before replacing output.\n";
  const contract = optimizeContract(contractFor(source));
  const rendered = renderContract(contract).text;
  const damaged = rendered.replace("Always verify the checksum before replacing output.", "Removed semantic content");
  assert(!auditRendered(contract, damaged).ok, "audit rejects markers without the represented semantic text");
  const repaired = repairAudit(contract, damaged);
  assert(repaired.audit.ok && repaired.render.text.includes("Always verify the checksum before replacing output."), "audit recovery restores cited source and re-verifies coverage");
}

// Lifecycle works without any AGENTS prompt.
{
  const prompt = createBeforeAgentStartHandler()({ type: "before_agent_start", prompt: "x", systemPrompt: ["base"] });
  assert(prompt.systemPrompt.includes(SKILLZIP_GUIDANCE) && prompt.systemPrompt.length === 2, "before_agent_start injects independent evolution contract");
  const state = createEvolutionState();
  const record = createToolExecutionEndHandler(state);
  for (let i = 0; i < 5; i++) record({ type: "tool_execution_end", toolCallId: String(i), toolName: "read", result: {}, isError: false });
  const stop = createSessionStopHandler(state);
  const event = { type: "session_stop" as const, messages: [], turn_id: 1, session_id: "s", stop_hook_active: false, signal: new AbortController().signal };
  assert(stop(event)?.continue === true, "session_stop requests one capture continuation after five successful tools");
  assert(stop(event) === undefined, "capture continuation cannot recursively trigger itself");
}

// Store path policy, atomic rollback, and recovery-visible state.
const root = await mkdtemp(join(tmpdir(), "skillzip-test-"));
try {
  assert(validateSkillName("safe-name") === "safe-name", "managed skill accepts lowercase kebab-case names");
  await throws(async () => { validateSkillName("../escape"); }, /lowercase/, "managed skill rejects path traversal names");
  const source = "# Demo\n\nAlways validate output.\n";
  const contract = optimizeContract(contractFor(source));
  const rendered = renderContract(contract).text;
  await commitSkill("demo-skill", rendered, contract, {}, root);
  const before = await loadSkill("demo-skill", root);
  await throws(() => commitSkill("demo-skill", rendered.replace("validate", "inspect"), structuredClone(contract), { overwrite: true, expectedArtifactHash: contract.source.artifactSha256, failpoint: "after-skill" }, root), /Injected/, "transaction reports injected mid-install failure");
  const after = await loadSkill("demo-skill", root);
  assert(after.text === before.text, "failed two-file transaction rolls back SKILL.md and sidecar pair");
  await writeFile(after.paths.skill, `${after.text}\nexternal edit`, "utf8");
  await throws(() => loadSkill("demo-skill", root), /outside SkillZip/, "optimistic hash detects external artifact edits");
  await rm(pathsFor("demo-skill", root).dir, { recursive: true, force: true });
  await mkdir(root, { recursive: true });
  const external = await mkdtemp(join(tmpdir(), "skillzip-link-target-"));
  try {
    await symlink(external, pathsFor("linked-skill", root).dir, "junction");
    await throws(() => commitSkill("linked-skill", rendered, structuredClone(contract), {}, root), /symbolic link/, "store refuses a symlinked skill directory");
  } finally { await rm(external, { recursive: true, force: true }); }
} finally {
  await rm(root, { recursive: true, force: true });
}

if (failures) {
  console.error(`\n${failures} SkillZip smoke test(s) failed.`);
  process.exit(1);
}
console.log("\nAll SkillZip smoke tests passed.");
