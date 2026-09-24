import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { registerHooks } from "./adapter";
import { loadSettings } from "./config";
import { formatDoctorReport } from "./doctor";

// ============================================================================
// Extension main entry point
// ============================================================================

export default function (pi: ExtensionAPI) {
  // Opt-in, like the converter's --approximate: near-equivalents for Claude events OMP lacks.
  const approximate = process.env.OMP_HOOKS_PLUS_APPROXIMATE === "1";
  registerHooks(pi, async (ctx) => {
    const loaded = await loadSettings(ctx.cwd, {
      projectTrusted: ctx.isProjectTrusted(),
      approximate,
    });
    return loaded.settings;
  }, { approximations: approximate });
  pi.registerCommand("claude-compat", {
    description: "Show effective Claude hook compatibility settings",
    handler: async (args, ctx) => {
      if (args.trim() && args.trim() !== "doctor") {
        ctx.ui.notify("Usage: /claude-compat doctor", "warning");
        return;
      }
      const loaded = await loadSettings(ctx.cwd, {
        projectTrusted: ctx.isProjectTrusted(),
        approximate,
      });
      ctx.ui.notify(formatDoctorReport(loaded), "info");
    },
  });
}
