/**
 * DCP for omp: anchor-based conversation compression plus SkillZip persistent
 * skill evolution. Anchor transforms never modify history; SkillZip writes
 * only through its managed, audited transaction.
 */

import type { ExtensionAPI } from "./src/omp";
import { Logger } from "./src/logger";
import { createSessionState, saveSessionState } from "./src/state";
import {
  createContextHandler,
  createSessionBeforeSwitchHandler,
  createSessionCompactHandler,
  createSessionShutdownHandler,
  createSessionStartHandler,
  createSessionSwitchHandler,
} from "./src/hooks";
import { createAddAnchorTool, createCompressTool } from "./src/tools";
import { createSkillZipTool } from "./src/skillzip/tool";
import { registerSkillZipLifecycle } from "./src/skillzip/hooks";
import { listSkills, managedRoot } from "./src/skillzip/store";

export default function dcpExtension(pi: ExtensionAPI): void {
  const debugEnv = typeof process !== "undefined" ? (process.env.DCP_DEBUG ?? "") : "";
  const logger = new Logger(debugEnv !== "" && debugEnv !== "0" && debugEnv !== "false");

  const state = createSessionState();
  const deps = { state, logger, pi };

  // Core pipeline: apply compression blocks to the outgoing message copy.
  pi.on("context", createContextHandler(deps));

  // Session lifecycle — bind / flush / compact.
  pi.on("session_start", createSessionStartHandler(deps));
  pi.on("session_before_switch", createSessionBeforeSwitchHandler(deps));
  pi.on("session_switch", createSessionSwitchHandler(deps));
  pi.on("session_compact", createSessionCompactHandler(deps));
  pi.on("session_shutdown", createSessionShutdownHandler(deps));

  // Tools.
  pi.registerTool(createAddAnchorTool({ logger, zod: pi.zod }));
  pi.registerTool(
    createCompressTool({
      state,
      logger,
      zod: pi.zod,
      persist: (): void => {
        saveSessionState(pi, state);
      },
    }),
  );

  // Self-contained persistent evolution; does not depend on AGENTS.md.
  const skillRoot = managedRoot();
  pi.registerTool(createSkillZipTool({ pi, logger }));
  registerSkillZipLifecycle(pi, skillRoot);
  pi.registerCommand("skillzip", {
    description: "Show SkillZip managed-skill status",
    async handler(_args, ctx): Promise<void> {
      const skills = await listSkills();
      ctx.ui.notify(skills.length ? `${skills.length} SkillZip skill(s): ${skills.map((skill) => skill.name).join(", ")}` : `No SkillZip skills under ${skillRoot}`, "info");
    },
  });

  logger.info("DCP initialized (anchor + SkillZip modes)");
}
