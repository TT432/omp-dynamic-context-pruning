import type { BeforeAgentStartEvent, ExtensionAPI, SessionStopEvent, ToolExecutionEndEvent } from "../omp";

export const SKILLZIP_GUIDANCE = `<skillzip-evolution>
SkillZip is the persistent evolution mechanism; it does not depend on AGENTS.md.
After a procedure has been exercised and validated, use skillzip create/update to preserve only reusable operational knowledge. Do not persist guesses, task-specific facts, secrets, raw logs, or unverified advice. State triggers, exclusions, ordered workflow, tool arguments, failures, output fields, and stop conditions explicitly. Never edit ~/.omp/agent/skillzip directly: the skillzip tool enforces typed extraction, hard source coverage, structural audit, and an atomic transaction. Compression may explain repetition once but must retain every unique or uncertain requirement.
</skillzip-evolution>`;

const CAPTURE_CONTEXT = `This completed turn used enough successful tools to justify a SkillZip capture check. Before settling, inspect only evidence from this completed turn. If it established a reusable, validated procedure or corrected an existing one, call skillzip create/update with a concise self-contained patch including trigger, workflow, tool contract, failures, output contract, and completion condition. Do not save task-specific facts, credentials, speculation, or knowledge not verified in this turn. If nothing qualifies, reply briefly and stop without calling skillzip.`;
const MIN_SUCCESSFUL_TOOLS = 5;

export interface EvolutionState {
  successfulTools: number;
  captureRequested: boolean;
}

export function createEvolutionState(): EvolutionState {
  return { successfulTools: 0, captureRequested: false };
}

export function createBeforeAgentStartHandler() {
  return (event: BeforeAgentStartEvent): { systemPrompt: string[] } => {
    if (event.systemPrompt.includes(SKILLZIP_GUIDANCE)) return { systemPrompt: event.systemPrompt };
    return { systemPrompt: [...event.systemPrompt, SKILLZIP_GUIDANCE] };
  };
}

export function createToolExecutionEndHandler(state: EvolutionState) {
  return (event: ToolExecutionEndEvent): void => {
    if (!event.isError && event.toolName !== "skillzip" && !event.toolName.startsWith("add_anchor") && event.toolName !== "compress") state.successfulTools++;
  };
}

export function createSessionStopHandler(state: EvolutionState) {
  return (event: SessionStopEvent): { continue?: boolean; additionalContext?: string } | void => {
    const count = state.successfulTools;
    state.successfulTools = 0;
    if (event.signal.aborted || event.stop_hook_active || state.captureRequested) {
      state.captureRequested = false;
      return;
    }
    if (count < MIN_SUCCESSFUL_TOOLS) return;
    state.captureRequested = true;
    return { continue: true, additionalContext: CAPTURE_CONTEXT };
  };
}

export function registerSkillZipLifecycle(pi: ExtensionAPI, root: string): EvolutionState {
  const state = createEvolutionState();
  pi.on("resources_discover", () => ({ skillPaths: [root] }));
  pi.on("before_agent_start", createBeforeAgentStartHandler());
  pi.on("tool_execution_end", createToolExecutionEndHandler(state));
  pi.on("session_stop", createSessionStopHandler(state));
  return state;
}
