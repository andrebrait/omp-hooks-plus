import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { createHookContext } from "./hook-context";
import { registerCompactHooks } from "./hooks/compact-hooks";
import { registerPromptHooks } from "./hooks/prompt-hooks";
import { registerSessionHooks } from "./hooks/session-hooks";
import { registerStopHooks } from "./hooks/stop-hooks";
import { registerToolHooks } from "./hooks/tool-hooks";
import type { SettingsFile } from "./types";
export { findProjectRoot } from "./helpers";

export function registerHooks(
  pi: ExtensionAPI,
  settingsFor: (ctx: ExtensionContext) => Promise<SettingsFile | undefined>,
): void {
  const shared = createHookContext(pi, settingsFor);
  registerSessionHooks(pi, shared);
  registerCompactHooks(pi, shared);
  registerPromptHooks(pi, shared);
  registerStopHooks(pi, shared);
  registerToolHooks(pi, shared);
}
