# OMP-native session lifecycle and session context

## Intent

Claude plugins whose upstreams will not ship an OMP extension (caveman, ponytail, i-have-adhd, understand-anything) reach OMP only through this bridge. Fire their session hooks at the OMP events a native extension would use, and deliver session-scoped context the way a native extension does: held by the extension and added to every provider request, not written once into the transcript.

The live bridge and converter output share `src/adapter.ts`, so both change together.

## Goals

- SessionStart and SessionEnd fire on the OMP event that matches each Claude `source`/`reason`, with the new session's identity.
- SessionStart and SubagentStart context survives compaction, branching and tree navigation without re-running the hook.
- The request prefix stays byte-stable between turns for provider prompt caching.

## Non-goals

- Per-turn context (UserPromptSubmit, PreToolUse, PostToolUse, Stop, PreCompact, PostCompact, SessionEnd) keeps today's hidden-message delivery. Its text changes per turn; Claude Code also persists it in the transcript.
- Plugin-internal state (for example a mode flag file) does not become branch-aware.
- No proxy, recovery tool or tool-output compression.

## Approaches

- **A. Lifecycle fixes only, hidden-message delivery.** Re-firing SessionStart on tree/branch repeats hook side effects. Rejected.
- **B. Lifecycle fixes plus extension-held session context.** Chosen.
- **C. All hook context in the system prompt.** Per-turn text would invalidate the cached prefix every turn and drop out of history. Rejected.

Within B, session context goes into a **context-head message** (the `context` event; the pattern of the Superpowers OMP extension), not the system prompt. That keeps Claude Code's placement and authority: plugin text arrives as a user-side reminder, never as system policy.

## Lifecycle mapping

| OMP event | Claude hooks fired |
|---|---|
| `session_start`, new session | SessionStart `startup` |
| `session_start`, session already holds an assistant message (`--resume`, `--continue`) | SessionStart `resume` |
| `session_switch` `new` | SessionEnd `clear` (previous session), then SessionStart `clear` |
| `session_switch` `resume` | SessionEnd `resume` (previous session), then SessionStart `resume` |
| `session_switch` `fork`, `session_branch` | SessionStart `fork` |
| `session_tree` | none; held context stays |
| `session_compact` | SessionStart `compact` (as today) |
| `session_shutdown` | SessionEnd `other` (as today) |

SessionEnd for a switch uses the previous session's id and transcript, captured before the switch. SessionStart no longer fires from `session_before_switch`, where `ctx` still describes the old session. Subagents keep today's rules: no SessionStart except `compact`, no SessionEnd.

## Session context store

- One store per extension instance (OMP binds one per session, so one per subagent too), keyed by hook source.
- SessionStart (any source) and SubagentStart results replace the store.
- SessionStart `compact` replaces only the entries of sources that returned context; other sources keep their startup context.
- A session switch clears the store before the new SessionStart runs. Shutdown clears it.
- The `context` handler inserts one message after leading compaction and branch summaries. The host passes a fresh copy of the persisted messages, which never contain it. The text uses today's `hookReminders` format. The message is never persisted.

## Left to the builder

- Exact detection of a resumed session at `session_start`.
- Test layout, following the existing per-area test files.
- README and converter documentation updates.
