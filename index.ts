/**
 * DCP for omp — anchor-based conversation compression.
 *
 * Default-exported factory; omp loads this module and calls it with the live
 * `ExtensionAPI`. Three tools are registered:
 *   - add_anchor: place a named anchor at the call site;
 *   - compress:   replace the span from an anchor up to the compress call
 *                 itself with a model-authored summary (start anchor consumed;
 *                 absorbed blocks stay recallable in the block chain);
 *   - expand:     pull back the full text of a block that is currently only an
 *                 index line under a newer summary.
 * The context handler applies compression blocks to the outgoing message copy
 * on every LLM request. Session storage is never modified.
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
import { createAddAnchorTool, createCompressTool, createExpandTool } from "./src/tools";
import { parseRemindPolicy } from "./src/remind";

export default function dcpExtension(pi: ExtensionAPI): void {
  const debugEnv = typeof process !== "undefined" ? (process.env.DCP_DEBUG ?? "") : "";
  const logger = new Logger(debugEnv !== "" && debugEnv !== "0" && debugEnv !== "false");

  // DCP_REMIND_THRESHOLD: (0,1) = fraction of the context window (default 0.4),
  // >=1 = absolute tokens, <=0 disables the token trigger.
  const remind = parseRemindPolicy(typeof process !== "undefined" ? process.env : {});

  const state = createSessionState();
  const deps = { state, logger, pi, remind };

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

  pi.registerTool(createExpandTool({ state, logger, zod: pi.zod }));

  logger.info("DCP initialized (anchor mode)");
}
