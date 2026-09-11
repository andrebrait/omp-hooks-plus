import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { registerHooks } from "./adapter";
import { loadSettings } from "./config";
import { formatDoctorReport } from "./doctor";

// ============================================================================
// Extension main entry point
// ============================================================================

export default function (pi: ExtensionAPI) {
  registerHooks(pi, async (ctx) => {
    const loaded = await loadSettings(ctx.cwd, {
      projectTrusted: ctx.isProjectTrusted(),
    });
    return loaded.settings;
  });
  pi.registerCommand("claude-compat", {
    description: "Show effective Claude hook compatibility settings",
    handler: async (args, ctx) => {
      if (args.trim() && args.trim() !== "doctor") {
        ctx.ui.notify("Usage: /claude-compat doctor", "warning");
        return;
      }
      const loaded = await loadSettings(ctx.cwd, {
        projectTrusted: ctx.isProjectTrusted(),
      });
      ctx.ui.notify(formatDoctorReport(loaded), "info");
    },
  });
}
