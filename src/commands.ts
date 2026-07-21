/**
 * Slash commands:
 *   /dcp                  — overview / help
 *   /dcp-compress [focus] — ask the model to run one compression pass
 *   /dcp stats            — pruning stats
 *   /dcp context          — current context token estimate
 *   /dcp manual on|off    — toggle manual mode (disables autonomous pruning)
 */

import type { ExtensionAPI, ExtensionCommandContext } from "./omp";
import type { PluginConfig } from "./config";
import type { Logger } from "./logger";
import type { SessionState } from "./state/types";
import { estimateMessagesTokens } from "./token-utils";
import { saveSessionState } from "./state/persistence";

export interface CommandDeps {
  state: SessionState;
  logger: Logger;
  config: PluginConfig;
  pi: ExtensionAPI;
}

function notify(ctx: ExtensionCommandContext, message: string): void {
  try {
    ctx.ui.notify(message);
  } catch {
    /* no UI available */
  }
}

export function registerCommands(deps: CommandDeps): void {
  const { state, config, pi } = deps;

  if (!config.commands.enabled) return;

  pi.registerCommand("dcp", {
    description: "Dynamic Context Pruning: overview, stats, and manual controls",
    handler: async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
      const sub = (args || "").trim().split(/\s+/)[0]?.toLowerCase() ?? "";

      if (sub === "stats") {
        const tokens = state.lastContextMessages ? estimateMessagesTokens(state.lastContextMessages) : 0;
        const activeBlocks = state.prune.messages.activeBlockIds.size;
        const totalBlocks = state.prune.messages.blocksById.size;
        notify(ctx, `DCP stats — saved tokens: ${state.stats.totalPruneTokens.toLocaleString()} | context est: ${tokens.toLocaleString()} | active compressions: ${activeBlocks}/${totalBlocks} | pruned tools: ${state.prune.tools.size}`);
        return;
      }

      if (sub === "context") {
        const tokens = state.lastContextMessages ? estimateMessagesTokens(state.lastContextMessages) : 0;
        const limit = state.modelContextLimit ?? 0;
        notify(ctx, `DCP context — est ${tokens.toLocaleString()} tokens${limit ? ` / ${limit.toLocaleString()} window (${Math.round((tokens / limit) * 100)}%)` : ""}`);
        return;
      }

      if (sub === "manual") {
        const arg = (args || "").trim().split(/\s+/)[1]?.toLowerCase();
        if (arg === "on") {
          state.manualMode = "active";
          state.dirty = true;
          saveSessionState(pi, state);
          notify(ctx, "DCP manual mode ON — autonomous pruning paused; use /dcp-compress to trigger.");
        } else {
          state.manualMode = false;
          state.dirty = true;
          saveSessionState(pi, state);
          notify(ctx, "DCP manual mode OFF — autonomous pruning resumed.");
        }
        return;
      }

      notify(ctx, "DCP commands: /dcp-compress [focus], /dcp stats, /dcp context, /dcp manual on|off");
    },
  });

  if (config.compress.permission !== "deny") {
    pi.registerCommand("dcp-compress", {
      description: "Ask the model to run one DCP compression pass. Optional focus text directs what to compress.",
      handler: async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
        const focus = (args || "").trim();
        const prompt = focus
          ? `Run the compress tool to summarize completed, no-longer-needed conversation spans. Focus: ${focus}`
          : `Run the compress tool to summarize completed, no-longer-needed conversation spans, reclaiming context.`;
        try {
          await pi.sendCustomMessage?.(
            { customType: "dcp-manual-trigger", content: prompt, display: true, attribution: "user" },
            { deliverAs: "followUp", triggerTurn: true },
          );
          notify(ctx, "DCP: requested a compression pass.");
        } catch (e) {
          notify(ctx, `DCP: could not trigger compression (${String(e)})`);
        }
      },
    });
  }
}
