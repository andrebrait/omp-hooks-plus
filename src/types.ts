// ============================================================================
// Type definitions
// ============================================================================

export type HookType = "command";

export type SessionStartMatcher = "startup" | "resume" | "compact";
export type SessionEndReason = "other";
export type CompactTrigger = "manual" | "auto";

export type Hook = {
  type: "command";
  command: string;
  args?: string[];
  if?: string;
  timeout?: number;
  shell?: "bash" | "powershell";
  async?: boolean;
  asyncRewake?: boolean;
  /**
   * Environment variables merged over process.env at spawn time. Populated only
   * for plugin-sourced hooks (CLAUDE_PLUGIN_ROOT/CLAUDE_PLUGIN_DATA/CLAUDE_PROJECT_DIR);
   * undefined for settings.json/.agents-sourced hooks (zero behavior change).
   * Also folded into the dedup key so two plugins referencing the same relative
   * command text still both execute.
   */
  env?: Record<string, string>;
};

export type HookGroup = {
  matcher?: string;
  hooks?: Hook[];
};

export type HooksConfig = {
  SessionStart?: HookGroup[];
  SessionEnd?: HookGroup[];
  PreCompact?: HookGroup[];
  PostCompact?: HookGroup[];
  PreToolUse?: HookGroup[];
  PostToolUse?: HookGroup[];
  PostToolUseFailure?: HookGroup[];
  UserPromptSubmit?: HookGroup[];
  Stop?: HookGroup[];
  // Support lowercase aliases
  session_start?: HookGroup[];
  session_end?: HookGroup[];
  pre_compact?: HookGroup[];
  post_compact?: HookGroup[];
  pre_tool_use?: HookGroup[];
  post_tool_use?: HookGroup[];
  post_tool_use_failure?: HookGroup[];
  user_prompt_submit?: HookGroup[];
  stop?: HookGroup[];
};

export type SettingsFile = {
  hooks?: HooksConfig;
  disableAllHooks?: boolean;
};

export type HookEventName =
  | "SessionStart"
  | "SessionEnd"
  | "PreCompact"
  | "PostCompact"
  | "PreToolUse"
  | "PostToolUse"
  | "PostToolUseFailure"
  | "UserPromptSubmit"
  | "Stop";

export type HookMatcherValue<T extends HookEventName> =
  T extends "SessionStart" ? SessionStartMatcher
    : T extends "SessionEnd" ? SessionEndReason
      : T extends "PreCompact" | "PostCompact" ? CompactTrigger
        : string;

export interface HookExecutionContext {
  sessionId: string;
  cwd: string;
  hookEventName: HookEventName;
  source?: SessionStartMatcher;
  model?: string;
  reason?: SessionEndReason;
  // PreCompact/PostCompact fields
  trigger?: CompactTrigger;
  customInstructions?: string;
  compactSummary?: string;
  transcriptPath?: string;
  // UserPromptSubmit fields
  prompt?: string;
  // Stop fields
  stopHookActive?: boolean;
  lastAssistantMessage?: string;
  /**
   * Host signal for the pass that is running these hooks. Aborting it (turn
   * abort, session switch, host handler budget) cancels the owned hook process
   * groups and voids their verdicts.
   */
  abortSignal?: AbortSignal;
  // PreToolUse/PostToolUse/PostToolUseFailure fields
  toolName?: string;
  toolInput?: Record<string, unknown>;
  toolUseId?: string;
  toolResponse?: Record<string, unknown>;
  error?: string;
  isInterrupt?: boolean;
  // Async command hooks can deliver additionalContext after the foreground event.
  asyncContextSink?: (
    content: string,
    details: Record<string, unknown>,
    triggerTurn?: boolean,
  ) => void;
}

// ============================================================================
// Hook result types
// ============================================================================

export type NotifyFn = (
  message: string,
  type: "info" | "error" | "warning",
) => void;

/** Outcome of running one command hook process. */
export type HookCommandResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
  /**
   * Set when the pass that owned this hook was cancelled. The process group is
   * already terminated, so the output is not a hook verdict and must not be
   * reported as a block or as a hook failure.
   */
  aborted?: boolean;
};

export type HookRunResult = {
  additionalContext?: string;
};

export type UserPromptSubmitResult = {
  blocked: boolean;
  reason?: string;
  additionalContext?: string;
};

export type StopResult = {
  blocked: boolean;
  reason?: string;
  additionalContext?: string;
};

export type PreToolUseResult = {
  blocked: boolean;
  reason?: string;
  updatedInput?: Record<string, unknown>;
  additionalContext?: string;
  confirmationReason?: string;
  stopProcessing?: boolean;
  stopReason?: string;
};

export type ToolResultPatch = {
  content?: unknown;
  details?: unknown;
  isError?: boolean;
};

export type PostToolUseResult = ToolResultPatch & {
  additionalContext?: string;
  stopProcessing?: boolean;
  stopReason?: string;
};
