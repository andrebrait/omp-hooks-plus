import { describe, expect, test } from "bun:test";
import { formatDoctorReport } from "../src/doctor";
import type { LoadedSettings } from "../src/config";

describe("compatibility doctor", () => {
  test("reports source mode, effective hooks, unsupported sources, and duplicates", () => {
    const loaded: LoadedSettings = {
      projectRoot: "/work/project",
      projectTrusted: true,
      mode: "cross-vendor",
      sources: [
        { scope: "user", path: "/home/me/.claude/settings.json" },
        { scope: "agents", path: "/work/project/.agents/hooks.json" },
      ],
      sourcePaths: [
        "/home/me/.claude/settings.json",
        "/work/project/.agents/hooks.json",
      ],
      settings: {
        hooks: {
          PreToolUse: [
            {
              hooks: [
                { type: "command", command: "guard" },
                { type: "command", command: "guard" },
              ],
            },
          ],
        },
      },
      warnings: [],
      unsupported: ["Claude plugin hooks are not loaded"],
    };

    const report = formatDoctorReport(loaded);

    expect(report).toContain("Mode: cross-vendor");
    expect(report).toContain("Trust: approved");
    expect(report).toContain("PreToolUse: 1");
    expect(report).toContain("Claude plugin hooks are not loaded");
    expect(report).toContain("Duplicates suppressed: 1");
  });
});
