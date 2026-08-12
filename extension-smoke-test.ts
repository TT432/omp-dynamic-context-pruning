import { z } from "@oh-my-pi/omptype/zod";
import dcpExtension from "./index";
import type { ExtensionAPI, ToolDefinition } from "./src/omp";
import { SKILLZIP_GUIDANCE } from "./src/skillzip/hooks";

let failures = 0;
function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    failures++;
    console.error("FAIL:", message);
  } else console.log("ok:", message);
}

const handlers = new Map<string, Array<(...args: unknown[]) => unknown>>();
const tools: ToolDefinition[] = [];
const commands: string[] = [];
const pi = {
  zod: z,
  logger: {},
  setLabel() {},
  on(event: string, handler: (...args: unknown[]) => unknown) {
    const list = handlers.get(event) ?? [];
    list.push(handler);
    handlers.set(event, list);
  },
  registerTool(tool: ToolDefinition) { tools.push(tool); },
  registerCommand(name: string) { commands.push(name); },
  appendEntry() {},
  getAllTools() { return []; },
  pi: {},
} as unknown as ExtensionAPI;

dcpExtension(pi);
assert(tools.some((tool) => tool.name === "add_anchor"), "extension still registers add_anchor");
assert(tools.some((tool) => tool.name === "compress"), "extension still registers compress");
const skillzip = tools.find((tool) => tool.name === "skillzip");
assert(skillzip?.loadMode === "essential" && skillzip.strict === true, "extension registers SkillZip as an essential strict tool with real OMP Zod");
assert(commands.includes("skillzip"), "extension registers /skillzip status command");
for (const event of ["resources_discover", "before_agent_start", "tool_execution_end", "session_stop"]) assert(handlers.has(event), `extension registers ${event} independently of AGENTS.md`);
const before = handlers.get("before_agent_start")?.[0];
assert(before, "before_agent_start handler is callable");
const prompt = await Promise.resolve(before({ type: "before_agent_start", prompt: "x", systemPrompt: ["base"] }, {}));
assert(Boolean(prompt && typeof prompt === "object" && "systemPrompt" in prompt && Array.isArray(prompt.systemPrompt) && prompt.systemPrompt.includes(SKILLZIP_GUIDANCE)), "extension-owned evolution guidance is injected without project rules");

if (failures) process.exit(1);
console.log("\nExtension registration smoke test passed.");
