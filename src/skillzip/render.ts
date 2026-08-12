import type { AuditResult, CoverageRecord, RenderResult, SkillContract, SourceBlock, WorkflowUnit } from "./types";
import { approxTokens, normalizeText } from "./scanner";

function unitMarker(id: string): string {
  return `<!-- skillzip:unit:${id} -->`;
}

function markersByRepresentation(contract: SkillContract): Map<string, string[]> {
  const result = new Map<string, string[]>();
  for (const record of contract.coverage) {
    const ids = result.get(record.renderedBy) ?? [];
    ids.push(record.unitId);
    result.set(record.renderedBy, ids);
  }
  return result;
}

function pushMarkers(lines: string[], ids: readonly string[]): void {
  for (const id of ids) lines.push(unitMarker(id));
}

function workflowLine(unit: WorkflowUnit, nodes: Map<string, WorkflowUnit>): string {
  const tool = unit.tool ? ` — tool \`${unit.tool}\`${unit.requiredArgs.length ? `(${unit.requiredArgs.join(", ")})` : ""}` : "";
  const next = unit.next.length ? ` Next: ${unit.next.map((id) => nodes.get(id)?.action ?? id).join(" | ")}.` : "";
  return `- **${unit.kind}**: ${unit.action}${tool}.${next}`.replace("..", ".");
}

function sourceBlocks(contract: SkillContract): Map<string, SourceBlock> {
  return new Map(contract.blocks.map((block) => [block.id, block]));
}

/** Renders an ordinary portable SKILL.md; sidecar-only provenance stays in HTML markers. */
export function renderContract(contract: SkillContract): RenderResult {
  const lines: string[] = [];
  const markerMap = markersByRepresentation(contract);
  const covered = new Set<string>();
  const mark = (representation: string): void => {
    const ids = markerMap.get(representation) ?? [representation];
    pushMarkers(lines, ids);
    ids.forEach((id) => covered.add(id));
  };

  const description = contract.interface.purpose.replace(/\s+/g, " ").trim().slice(0, 512) || `Reusable procedure ${contract.interface.name}`;
  lines.push("---", `name: ${contract.source.name}`, `description: ${JSON.stringify(description)}`, "---", "", `# ${contract.interface.name}`, "", contract.interface.purpose.trim());

  if (contract.interface.triggers.length) {
    lines.push("", "## Use when", "");
    contract.interface.triggers.forEach((entry, index) => {
      mark(`trigger_${index}`);
      lines.push(`- ${entry.text}`);
    });
  }
  if (contract.interface.exclusions.length) {
    lines.push("", "## Do not use when", "");
    contract.interface.exclusions.forEach((entry, index) => {
      mark(`exclusion_${index}`);
      lines.push(`- ${entry.text}`);
    });
  }

  const scopeById = new Map(contract.scopes.map((scope) => [scope.id, scope]));
  const rulesByScope = new Map<string, typeof contract.rules>();
  for (const rule of contract.rules) {
    const group = rulesByScope.get(rule.scopeId) ?? [];
    group.push(rule);
    rulesByScope.set(rule.scopeId, group);
  }
  if (contract.rules.length) {
    lines.push("", "## Rules");
    for (const [scopeId, rules] of rulesByScope) {
      const scope = scopeById.get(scopeId);
      if (scopeId !== "root") lines.push("", `### ${scope?.guard ? `When ${scope.guard}` : scopeId}`);
      lines.push("");
      for (const rule of rules) {
        mark(rule.id);
        const modal: Record<typeof rule.modality, string> = { must: "MUST", must_not: "MUST NOT", prefer: "SHOULD" };
        lines.push(`- **${modal[rule.modality]}** ${rule.predicate}${rule.guard ? ` (when ${rule.guard})` : ""}`);
      }
    }
  }

  const nodes = new Map(contract.workflow.map((node) => [node.id, node]));
  const occurrenceByStart = new Map<string, { procedureId: string; ids: string[] }>();
  const hiddenByProcedure = new Set<string>();
  for (const procedure of contract.sharedProcedures) {
    for (const occurrence of procedure.occurrences) {
      if (!occurrence.length) continue;
      occurrenceByStart.set(occurrence[0], { procedureId: procedure.id, ids: occurrence });
      occurrence.forEach((id) => hiddenByProcedure.add(id));
    }
  }
  if (contract.workflow.length) {
    lines.push("", "## Workflow", "");
    for (const node of contract.workflow) {
      const occurrence = occurrenceByStart.get(node.id);
      if (occurrence) {
        for (const id of occurrence.ids) mark(id);
        lines.push(`- Run shared procedure **${occurrence.procedureId}**.`);
        continue;
      }
      if (hiddenByProcedure.has(node.id)) continue;
      mark(node.id);
      lines.push(workflowLine(node, nodes));
    }
  }
  if (contract.sharedProcedures.length) {
    lines.push("", "## Shared procedures");
    for (const procedure of contract.sharedProcedures) {
      lines.push("", `### ${procedure.id}`, "");
      const first = procedure.occurrences[0] ?? [];
      first.forEach((id, index) => {
        const node = nodes.get(id);
        if (node) lines.push(`${index + 1}. ${node.action}${node.tool ? ` — \`${node.tool}\`${node.requiredArgs.length ? `(${node.requiredArgs.join(", ")})` : ""}` : ""}`);
      });
    }
  }

  if (contract.output.type || contract.output.fields.length || contract.output.termination.length) {
    lines.push("", "## Output contract", "");
    if (contract.output.type) lines.push(`Type: ${contract.output.type}`, "");
    contract.output.fields.forEach((field, index) => {
      const record = contract.coverage.find((item) => item.kind === "output" && item.renderedBy.startsWith(`output_${index}_`));
      mark(record?.renderedBy ?? `output_${index}`);
      lines.push(`- \`${field.name}\`${field.required ? " (required)" : " (optional)"}${field.validation ? `: ${field.validation}` : ""}`);
    });
    contract.output.termination.forEach((entry, index) => {
      mark(`termination_${index}`);
      lines.push(`- Complete only when ${entry.text}`);
    });
  }

  const blocks = sourceBlocks(contract);
  const uniqueEvidence = contract.evidence.filter((evidence) => evidence.addsUniqueUnit);
  if (uniqueEvidence.length) {
    lines.push("", "## Required evidence");
    for (const evidence of uniqueEvidence) {
      mark(evidence.id);
      for (const blockId of evidence.sourceBlocks) {
        const block = blocks.get(blockId);
        if (block) lines.push("", block.text);
      }
    }
  }
  if (contract.residual.length) {
    lines.push("", "## Locked source");
    const seen = new Set<string>();
    for (const residual of contract.residual) {
      if (seen.has(residual.sourceBlock)) continue;
      seen.add(residual.sourceBlock);
      mark(`residual_${residual.sourceBlock}`);
      const block = blocks.get(residual.sourceBlock);
      if (block) lines.push("", block.text);
    }
  }

  return { text: `${lines.join("\n").trim()}\n`, coveredUnitIds: covered };
}

function expectedTextByRepresentation(contract: SkillContract): Map<string, string> {
  const expected = new Map<string, string>();
  contract.interface.triggers.forEach((entry, index) => expected.set(`trigger_${index}`, entry.text));
  contract.interface.exclusions.forEach((entry, index) => expected.set(`exclusion_${index}`, entry.text));
  contract.workflow.forEach((unit) => expected.set(unit.id, unit.action));
  contract.rules.forEach((unit) => expected.set(unit.id, unit.predicate));
  contract.output.fields.forEach((field, index) => {
    const record = contract.coverage.find((item) => item.renderedBy.startsWith(`output_${index}_`));
    if (record) expected.set(record.renderedBy, `${field.name} ${field.validation ?? ""}`);
  });
  contract.output.termination.forEach((entry, index) => expected.set(`termination_${index}`, entry.text));
  return expected;
}

/** Re-parses the rendered artifact without consulting source ordering. */
export function auditRendered(contract: SkillContract, rendered: string): AuditResult {
  const markerIds = new Set<string>();
  const expression = /<!--\s*skillzip:unit:([^\s>]+)\s*-->/g;
  for (let match = expression.exec(rendered); match; match = expression.exec(rendered)) markerIds.add(match[1]);
  const normalizedRendered = normalizeText(rendered);
  const blocks = sourceBlocks(contract);
  const expected = expectedTextByRepresentation(contract);
  const missing: string[] = [];

  for (const record of contract.coverage) {
    const sourcePresent = record.sourceBlocks.some((id) => {
      const block = blocks.get(id);
      return block ? rendered.includes(block.text) : false;
    });
    if (record.kind === "residual" || record.kind === "evidence") {
      if (!sourcePresent) missing.push(record.unitId);
      continue;
    }
    const semanticText = expected.get(record.renderedBy);
    const semanticPresent = semanticText ? normalizedRendered.includes(normalizeText(semanticText)) : false;
    if (!(sourcePresent || (markerIds.has(record.unitId) && semanticPresent))) missing.push(record.unitId);
  }
  return { ok: missing.length === 0, missingUnitIds: missing, recoveredBlocks: [] };
}

/** Restores the shortest cited source block for each missing unit, then re-renders. */
export function repairAudit(contract: SkillContract, rendered: string): { contract: SkillContract; render: RenderResult; audit: AuditResult } {
  const initial = auditRendered(contract, rendered);
  if (initial.ok) return { contract, render: { text: rendered, coveredUnitIds: new Set(contract.coverage.map((item) => item.unitId)) }, audit: initial };
  const repaired = structuredClone(contract);
  const blockMap = sourceBlocks(repaired);
  const existing = new Set(repaired.residual.map((item) => item.sourceBlock));
  const recovered: string[] = [];
  for (const unitId of initial.missingUnitIds) {
    const record = repaired.coverage.find((item) => item.unitId === unitId);
    const candidate = record?.sourceBlocks
      .map((id) => blockMap.get(id))
      .filter((block): block is SourceBlock => Boolean(block))
      .sort((left, right) => approxTokens(left.text) - approxTokens(right.text))[0];
    if (!candidate || existing.has(candidate.id)) continue;
    repaired.residual.push({ sourceBlock: candidate.id, reason: "AUDIT_RECOVERY", locked: true });
    repaired.coverage.push({ unitId: `residual_${candidate.id}`, kind: "residual", renderedBy: `residual_${candidate.id}`, sourceBlocks: [candidate.id] });
    existing.add(candidate.id);
    recovered.push(candidate.id);
  }
  const next = renderContract(repaired);
  const audit = auditRendered(repaired, next.text);
  audit.recoveredBlocks = recovered;
  return { contract: repaired, render: next, audit };
}
