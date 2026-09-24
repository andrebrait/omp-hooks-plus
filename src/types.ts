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
  /** Provenance named in the model-facing reminder: the plugin's name, else omp-hooks-plus. */
  source?: string;
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
  // Approximated events: only generated extensions converted with --approximate run these.
  Notification?: HookGroup[];
  SubagentStart?: HookGroup[];
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
  | "Stop"
  | "Notification"
  | "SubagentStart";

export type HookMatcherValue<T extends HookEventName> =
  T extends "SessionStart" ? SessionStartMatcher
    : T extends "SessionEnd" ? SessionEndReason
      : T extends "PreCompact" | "PostCompact" ? CompactTrigger
        : string;

/** Provenance of delivered hook context; names the hook in the model-facing reminder. */
export type HookContextDetails = {
  hookEventName: HookEventName;
  toolName?: string;
  source?: string;
} & Record<string, unknown>;

/** Additional context from one source, kept apart so each reminder names its origin. */
export type HookContextEntry = { source: string; text: string };

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
  // PreToolUse/PostToolUse/PostToolUseFailure fields
  toolName?: string;
  toolInput?: Record<string, unknown>;
  toolUseId?: string;
  toolResponse?: Record<string, unknown>;
  error?: string;
  isInterrupt?: boolean;
  // Notification fields (approximated)
  notificationType?: string;
  message?: string;
  // SubagentStart fields (approximated)
  agentId?: string;
  // Async command hooks can deliver additionalContext after the foreground event.
  asyncContextSink?: (
    content: string,
    details: HookContextDetails,
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

export type HookRunResult = {
  contexts?: HookContextEntry[];
};

export type UserPromptSubmitResult = {
  blocked: boolean;
  reason?: string;
  contexts?: HookContextEntry[];
};

export type StopResult = {
  blocked: boolean;
  reason?: string;
  contexts?: HookContextEntry[];
};

export type PreToolUseResult = {
  blocked: boolean;
  reason?: string;
  updatedInput?: Record<string, unknown>;
  contexts?: HookContextEntry[];
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
  contexts?: HookContextEntry[];
  stopProcessing?: boolean;
  stopReason?: string;
};
