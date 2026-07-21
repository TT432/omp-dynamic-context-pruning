/**
 * DCP for omp — extension entry point.
 *
 * Default-exported factory; omp loads this module and calls it with the live
 * `ExtensionAPI`. Registration (on/registerTool/registerCommand) is valid during
 * load; runtime actions fire later from the registered handlers.
 *
 * The `ExtensionAPI` type is imported from the local `src/omp` contract
 * declaration (a faithful subset of the omp surface). At runtime omp injects
 * its host-bundled API and types are erased.
 */

import type { ExtensionAPI } from "./src/omp";
import { loadConfig } from "./src/config";
import { Logger } from "./src/logger";
import { createSessionState } from "./src/state/state";
import { saveSessionState } from "./src/state/persistence";
import {
  createContextHandler,
  createSessionStartHandler,
  createSessionSwitchHandler,
  createSessionBeforeSwitchHandler,
  createSessionShutdownHandler,
  createSessionCompactHandler,
  createTurnEndHandler,
} from "./src/hooks";
import { createCompressRangeTool } from "./src/compress/range";
import { registerCommands } from "./src/commands";

export default function dcpExtension(pi: ExtensionAPI): void {
  const cwd = (typeof process !== "undefined" && process.cwd) ? process.cwd() : ".";
  const { config, diagnostics, loadedFrom } = loadConfig(cwd);

  if (!config.enabled) return;

  const logger = new Logger(config.debug);
  if (loadedFrom) logger.info("DCP config loaded", { from: loadedFrom, diagnostics });
  for (const d of diagnostics) logger.warn("Config diagnostic", d);

  const state = createSessionState();
  const deps = {
    state,
    logger,
    config,
    pi,
    counters: { contextFetch: 0 },
    systemInjectedFor: null as string | null,
  };

  // Core pipeline
  pi.on("context", createContextHandler(deps));

  // Session lifecycle — bind / flush / compact
  pi.on("session_start", createSessionStartHandler(deps));
  pi.on("session_before_switch", createSessionBeforeSwitchHandler(deps));
  pi.on("session_switch", createSessionSwitchHandler(deps));
  pi.on("session_compact", createSessionCompactHandler(deps));
  pi.on("session_shutdown", createSessionShutdownHandler(deps));
  pi.on("turn_end", createTurnEndHandler(deps));

  // Compress tool (range mode) — model-authored summaries
  if (config.compress.permission !== "deny") {
    const persist = (): void => {
      saveSessionState(pi, state);
    };
    pi.registerTool(createCompressRangeTool({ state, logger, config, zod: pi.zod, persist }));
  }

  registerCommands({ state, logger, config, pi });

  logger.info("DCP initialized", {
    mode: config.compress.mode,
    permission: config.compress.permission,
    strategies: {
      deduplication: config.strategies.deduplication.enabled,
      purgeErrors: config.strategies.purgeErrors.enabled,
    },
    maxContextLimit: config.compress.maxContextLimit,
    minContextLimit: config.compress.minContextLimit,
  });
}
