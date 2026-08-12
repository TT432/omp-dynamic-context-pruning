import { completeSimple, type AssistantMessage, type Model, type Tool } from "@oh-my-pi/pi-ai";
import { z } from "@oh-my-pi/omptype/zod";
import type { ExtensionContext } from "../omp";
import type { ExtractedContract, SourceBlock } from "./types";

const spanSchema = z.object({ blockId: z.string(), startLine: z.number(), endLine: z.number() });
const scopedTextSchema = z.object({ text: z.string(), spans: z.array(spanSchema) });
const nullableString = z.string().nullable().optional();
const nullableStrings = z.array(z.string()).nullable().optional();
const nullableScopedTexts = z.array(scopedTextSchema).nullable().optional();
const scopeSchema = z.object({ id: z.string(), parentId: z.string().nullable(), guard: nullableString, sourceBlocks: z.array(z.string()) });
const workflowSchema = z.object({
  id: z.string(),
  scopeId: z.string(),
  kind: z.enum(["action", "decision", "loop", "fallback", "stop"]),
  action: z.string(),
  tool: nullableString,
  requiredArgs: nullableStrings,
  next: nullableStrings,
  spans: z.array(spanSchema),
  confidence: z.number().optional(),
});
const ruleSchema = z.object({
  id: z.string(),
  scopeId: z.string(),
  modality: z.enum(["must", "must_not", "prefer"]),
  predicate: z.string(),
  guard: nullableString,
  namespace: nullableString,
  spans: z.array(spanSchema),
  locked: z.boolean().optional(),
  confidence: z.number().optional(),
});
const outputFieldSchema = z.object({ name: z.string(), required: z.boolean(), validation: nullableString, spans: z.array(spanSchema) });
const evidenceSchema = z.object({
  id: z.string(),
  kind: z.enum(["example", "template", "rationale"]),
  supports: z.array(z.string()),
  addsUniqueUnit: z.boolean(),
  sourceBlocks: z.array(z.string()),
});
const extractionSchema = z.object({
  interface: z.object({ name: z.string(), purpose: z.string(), triggers: nullableScopedTexts, exclusions: nullableScopedTexts }).optional(),
  scopes: z.array(scopeSchema).nullable().optional(),
  workflow: z.array(workflowSchema).nullable().optional(),
  rules: z.array(ruleSchema).nullable().optional(),
  output: z.object({ type: nullableString, fields: z.array(outputFieldSchema).nullable().optional(), termination: nullableScopedTexts }).optional(),
  evidence: z.array(evidenceSchema).nullable().optional(),
  residualBlocks: nullableStrings,
});

const EXTRACT_TOOL = "submit_skill_contract";
const SYSTEM_PROMPT = `You extract a typed operational contract from one reusable agent skill.
Return exactly one submit_skill_contract tool call. Never rewrite or summarize the skill.
Every trigger, exclusion, workflow node and edge, tool name and required argument, scoped MUST/MUST NOT/SHOULD rule, output field, validation, and stop condition needs source citation(s).
Use only supplied block IDs and line ranges. If meaning is ambiguous, unique evidence, code, a table, frontmatter, or cannot be represented exactly, put that block ID in residualBlocks.
Do not merge conflicting modalities or guards. Confidence below 0.7 is not useful. root is the global scope. Tool names and arguments must match the supplied catalog.`;

export interface Extractor {
  extract(name: string, blocks: SourceBlock[], ctx: ExtensionContext, signal?: AbortSignal, knownTools?: Map<string, Set<string>>): Promise<ExtractedContract>;
}
function toolCalls(message: AssistantMessage): Array<{ name: string; arguments: Record<string, unknown> }> {
  return message.content.filter((block): block is Extract<AssistantMessage["content"][number], { type: "toolCall" }> => block.type === "toolCall");
}

function sessionId(ctx: ExtensionContext): string | undefined {
  try {
    return ctx.sessionManager.getSessionId?.() ?? ctx.sessionManager.getSessionFile?.();
  } catch {
    return undefined;
  }
}

function modelFor(ctx: ExtensionContext): Model | undefined {
  const modelQuery = ctx.models;
  return modelQuery?.resolve?.("@smol") ?? modelQuery?.current?.() ?? ctx.model;
}
export class LlmExtractor implements Extractor {
  async extract(
    name: string,
    blocks: SourceBlock[],
    ctx: ExtensionContext,
    signal?: AbortSignal,
    knownTools = new Map<string, Set<string>>(),
  ): Promise<ExtractedContract> {
    const model = modelFor(ctx);
    if (!model || !ctx.modelRegistry?.resolver) throw new Error("No authenticated model is available for SkillZip extraction");
    const catalog = knownTools;
    const payload = {
      skillName: name,
      blocks: blocks.map((block) => ({ id: block.id, kind: block.kind, headingPath: block.headingPath, startLine: block.startLine, endLine: block.endLine, text: block.text })),
      tools: [...catalog].map(([toolName, args]) => ({ name: toolName, args })),
    };
    const extractionTool: Tool = { name: EXTRACT_TOOL, description: "Submit the complete cited SkillZip typed contract", parameters: extractionSchema, strict: true };
    const timeout = AbortSignal.timeout(25_000);
    const combinedSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const response = await completeSimple(
      model,
      {
        systemPrompt: [SYSTEM_PROMPT],
        messages: [{ role: "user", content: JSON.stringify(payload), timestamp: Date.now() }],
        tools: [extractionTool],
      },
      {
        apiKey: ctx.modelRegistry.resolver(model, sessionId(ctx)),
        maxTokens: 12_000,
        temperature: 0,
        disableReasoning: true,
        hideThinkingSummary: true,
        toolChoice: { type: "function", name: EXTRACT_TOOL },
        signal: combinedSignal,
        cwd: ctx.cwd,
        initiatorOverride: "agent",
      },
    );
    const calls = toolCalls(response);
    if (calls.length !== 1 || calls[0].name !== EXTRACT_TOOL) throw new Error("Extractor did not return exactly one structured contract call");
    const parsed = extractionSchema.safeParse(calls[0].arguments);
    if (!parsed.success) throw new Error(`Extractor contract failed schema validation: ${parsed.error.message}`);
    return normalizeNullableFields(parsed.data) as ExtractedContract;
  }
}

function optional(value: string | null | undefined): string | undefined {
  return value ?? undefined;
}

export function normalizeNullableFields(value: typeof extractionSchema.infer): ExtractedContract {
  return {
    interface: value.interface ? {
      ...value.interface,
      triggers: value.interface.triggers ?? [],
      exclusions: value.interface.exclusions ?? [],
    } : undefined,
    scopes: (value.scopes ?? []).map((scope) => ({ ...scope, guard: optional(scope.guard) })),
    workflow: (value.workflow ?? []).map((unit) => ({
      ...unit,
      tool: optional(unit.tool),
      requiredArgs: unit.requiredArgs ?? [],
      next: unit.next ?? [],
      confidence: unit.confidence ?? 0,
    })),
    rules: (value.rules ?? []).map((rule) => ({
      ...rule,
      guard: optional(rule.guard),
      namespace: optional(rule.namespace),
      locked: rule.locked ?? false,
      confidence: rule.confidence ?? 0,
    })),
    output: value.output ? {
      ...value.output,
      type: optional(value.output.type),
      fields: (value.output.fields ?? []).map((field) => ({ ...field, validation: optional(field.validation) })),
      termination: value.output.termination ?? [],
    } : { fields: [], termination: [] },
    evidence: value.evidence ?? [],
    residualBlocks: value.residualBlocks ?? [],
  };
}
