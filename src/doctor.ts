import { getHookGroups, type LoadedSettings } from "./config";
import type { HookEventName } from "./types";

const EVENTS: HookEventName[] = [
  "SessionStart",
  "SessionEnd",
  "PreCompact",
  "PostCompact",
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "UserPromptSubmit",
  "Stop",
];

export function formatDoctorReport(loaded: LoadedSettings): string {
  const hookLines: string[] = [];
  let duplicatesSuppressed = 0;

  for (const event of EVENTS) {
    const seen = new Set<string>();
    let count = 0;
    for (const group of getHookGroups(loaded.settings, event)) {
      for (const hook of group.hooks ?? []) {
        if (hook.type !== "command" || !hook.command) continue;
        const key = hook.args
          ? `${hook.command}\0${JSON.stringify(hook.args)}`
          : hook.command;
        if (seen.has(key)) {
          duplicatesSuppressed++;
          continue;
        }
        seen.add(key);
        count++;
      }
    }
    if (count > 0) hookLines.push(`  ${event}: ${count}`);
  }

  const sourceLines = loaded.sources.length > 0
    ? loaded.sources.map((source) => `  ${source.scope.padEnd(7)} ${source.path}`)
    : ["  none"];

  return [
    `Repository: ${loaded.projectRoot}`,
    `Mode: ${loaded.mode}`,
    `Trust: ${loaded.projectTrusted ? "approved" : "project hooks disabled"}`,
    "",
    "Skills:",
    "  handled by OMP native Claude and shared skill discovery",
    "",
    "Hook sources:",
    ...sourceLines,
    "",
    "Effective hooks:",
    ...(hookLines.length > 0 ? hookLines : ["  none"]),
    ...(loaded.warnings.length > 0
      ? ["", "Warnings:", ...loaded.warnings.map((item) => `  ${item}`)]
      : []),
    "",
    "Unsupported:",
    ...loaded.unsupported.map((item) => `  ${item}`),
    "",
    `Duplicates suppressed: ${duplicatesSuppressed}`,
  ].join("\n");
}
