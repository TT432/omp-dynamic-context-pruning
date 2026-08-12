export type BlockKind = "frontmatter" | "heading" | "paragraph" | "list" | "fence" | "table";

export interface SourceBlock {
  id: string;
  kind: BlockKind;
  text: string;
  normalized: string;
  headingPath: string[];
  startLine: number;
  endLine: number;
}

export interface SourceSpan {
  blockId: string;
  startLine: number;
  endLine: number;
}

export interface ScopedText {
  text: string;
  spans: SourceSpan[];
}

export interface SkillInterface {
  name: string;
  purpose: string;
  triggers: ScopedText[];
  exclusions: ScopedText[];
}

export interface ScopeUnit {
  id: string;
  parentId: string | null;
  guard?: string;
  sourceBlocks: string[];
}

export type WorkflowKind = "action" | "decision" | "loop" | "fallback" | "stop";
export interface WorkflowUnit {
  id: string;
  scopeId: string;
  kind: WorkflowKind;
  action: string;
  tool?: string;
  requiredArgs: string[];
  next: string[];
  spans: SourceSpan[];
  confidence: number;
}

export type RuleModality = "must" | "must_not" | "prefer";
export interface RuleUnit {
  id: string;
  scopeId: string;
  modality: RuleModality;
  predicate: string;
  guard?: string;
  namespace?: string;
  spans: SourceSpan[];
  locked: boolean;
  confidence: number;
  liftedFrom?: string[];
}

export interface OutputField {
  name: string;
  required: boolean;
  validation?: string;
  spans: SourceSpan[];
}

export interface OutputContract {
  type?: string;
  fields: OutputField[];
  termination: ScopedText[];
}

export interface EvidenceUnit {
  id: string;
  kind: "example" | "template" | "rationale";
  supports: string[];
  addsUniqueUnit: boolean;
  sourceBlocks: string[];
}

export type ResidualReason =
  | "AMBIGUOUS"
  | "UNIQUE_EVIDENCE"
  | "USER_LOCKED"
  | "INVALID_EXTRACTION"
  | "AUDIT_RECOVERY";
export interface ResidualUnit {
  sourceBlock: string;
  reason: ResidualReason;
  locked: true;
}

export interface SharedProcedure {
  id: string;
  actionSignatures: string[];
  occurrences: string[][];
  savingTokens: number;
}

export interface CandidateLog {
  kind: "DEDUP" | "SCOPE_LIFT" | "WORKFLOW";
  accepted: boolean;
  beforeTokens: number;
  afterTokens: number;
  savingTokens: number;
  covered: string[];
  reason: string;
}

export interface CoverageRecord {
  unitId: string;
  kind: "interface" | "workflow" | "rule" | "output" | "evidence" | "residual";
  renderedBy: string;
  sourceBlocks: string[];
}

export interface UpdateLog {
  at: string;
  operation: "CREATE" | "ABSORB" | "EXTEND" | "COMPRESS" | "AUDIT_REPAIR";
  patchHash?: string;
  absorbed: number;
  extended: number;
}

export interface SkillSource {
  name: string;
  sha256: string;
  bytes: number;
  createdAt: string;
  updatedAt: string;
  /** Hash of the deployed SKILL.md; used for optimistic concurrency checks. */
  artifactSha256?: string;
}

export interface SkillContract {
  version: 1;
  source: SkillSource;
  blocks: SourceBlock[];
  interface: SkillInterface;
  scopes: ScopeUnit[];
  workflow: WorkflowUnit[];
  rules: RuleUnit[];
  output: OutputContract;
  evidence: EvidenceUnit[];
  residual: ResidualUnit[];
  sharedProcedures: SharedProcedure[];
  candidates: CandidateLog[];
  coverage: CoverageRecord[];
  updates: UpdateLog[];
}

export interface ExtractedContract {
  interface?: Partial<SkillInterface>;
  scopes?: ScopeUnit[];
  workflow?: WorkflowUnit[];
  rules?: RuleUnit[];
  output?: Partial<OutputContract>;
  evidence?: EvidenceUnit[];
  residualBlocks?: string[];
}

export interface ValidationResult {
  contract: SkillContract;
  rejectedBlocks: string[];
  warnings: string[];
}

export interface RenderResult {
  text: string;
  coveredUnitIds: Set<string>;
}

export interface AuditResult {
  ok: boolean;
  missingUnitIds: string[];
  recoveredBlocks: string[];
}

export interface OperationDetails {
  action: string;
  skill?: string;
  operation?: string;
  sourceTokens?: number;
  renderedTokens?: number;
  savingTokens?: number;
  coverage?: { required: number; covered: number };
  absorbed?: number;
  extended?: number;
  repairedBlocks?: string[];
  path?: string;
  sidecarPath?: string;
  warnings?: string[];
  skills?: Array<{ name: string; bytes: number; updatedAt: string }>;
}
