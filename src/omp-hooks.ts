import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { loadSettings } from "./config";
import { formatDoctorReport } from "./doctor";
import { createHookContext } from "./hook-context";
import { registerCompactHooks } from "./hooks/compact-hooks";
import { registerPromptHooks } from "./hooks/prompt-hooks";
import { registerSessionHooks } from "./hooks/session-hooks";
import { registerStopHooks } from "./hooks/stop-hooks";
import { registerToolHooks } from "./hooks/tool-hooks";

// ============================================================================
// Extension main entry point
// ============================================================================

export default function (pi: ExtensionAPI) {
  const shared = createHookContext(pi);
  pi.registerCommand("claude-compat", {
    description: "Show effective Claude hook compatibility settings",
    handler: async (args, ctx) => {
      if (args.trim() && args.trim() !== "doctor") {
        ctx.ui.notify("Usage: /claude-compat doctor", "warning");
        return;
      }
      const loaded = loadSettings(ctx.cwd, {
        projectTrusted: ctx.isProjectTrusted(),
      });
      ctx.ui.notify(formatDoctorReport(loaded), "info");
    },
  });


  registerSessionHooks(pi, shared);
  registerCompactHooks(pi, shared);
  registerPromptHooks(pi, shared);
  registerStopHooks(pi, shared);
  registerToolHooks(pi, shared);
}
