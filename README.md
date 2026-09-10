# omp-hooks-plus

Install-once Claude Code command-hook compatibility for [OMP](https://github.com/can1357/oh-my-pi).

OMP already discovers Claude skills, commands, MCP configuration, extensions, and settings. `omp-hooks-plus` fills the remaining gap by executing supported command hooks from the existing Claude settings hierarchy and from installed Claude plugins' own hook manifests. It also supports cross-vendor repositories that keep their canonical hook configuration under `.agents/`.

## Install

```sh
omp install npm:omp-hooks-plus
```

For an unreleased branch or commit:

```sh
omp install git:github.com/andrebrait/omp-hooks-plus
```

Restart OMP or run `/reload`. Existing Claude-native repositories require no changes.

## Configuration discovery

The extension always loads user hooks from:

```text
~/.claude/settings.json
```

For a trusted project, it then selects one project authority:

```text
if <repo>/.agents/hooks.json exists:
    load .agents/hooks.json
    skip project .claude hook arrays
else:
    load .claude/settings.json
    load .claude/settings.local.json
```

This prevents a cross-vendor repository's thin `.claude` adapter from executing alongside its canonical `.agents` hooks. User hooks remain active in both modes. `CLAUDE_CONFIG_DIR` is honored for the user settings location.

Untrusted projects cannot contribute commands; only user-owned hooks are loaded. `disableAllHooks: true` in any loaded settings source disables the effective hook set.

## Plugin manifest hooks

Installed Claude plugins (discovered through OMP's own plugin registries) contribute `command` hooks too. For each installed plugin, the extension resolves `.claude-plugin/plugin.json`'s `hooks` field the same way Claude Code does:

```text
hooks is an object:  inline hook config, used as-is
hooks is a string:   a single custom hook-config file, resolved against the plugin root
hooks is an array:   multiple custom hook-config files, merged together
hooks is absent:     hooks/hooks.json under the plugin root, if present
```

A custom hook-config file uses the standard `{ "hooks": { ... } }` wrapper. Only the nine event kinds this extension already supports are read from a plugin manifest ([see below](#supported-command-hooks)); other event kinds and non-`command` hook types (`http`, `prompt`, `agent`, `mcp_tool`) are reported under `/claude-compat doctor`'s unsupported list instead of silently dropped, and a malformed manifest or hook-config file is reported as a warning instead of silently ignored.

A plugin-scope hooks declaration cannot point outside its own plugin directory; a path that lexically escapes the root, or that resolves outside it through a symlink, is rejected with a warning and not loaded.

Every plugin-sourced hook process receives `CLAUDE_PLUGIN_ROOT`, `CLAUDE_PLUGIN_DATA` (a persistent per-plugin data directory under the Claude config dir), and `CLAUDE_PROJECT_DIR` as real environment variables — never by rewriting the command string — so a shell-form `command` referencing `$CLAUDE_PLUGIN_ROOT` or `${CLAUDE_PLUGIN_ROOT}` resolves correctly even when the plugin's install path contains spaces or shell metacharacters, and two plugins that happen to author the identical relative command text both still run (their differing `CLAUDE_PLUGIN_ROOT` keeps them distinct for hook deduplication).

User-scope plugins load unconditionally, like `~/.claude/settings.json`. Project-scope plugins load only for a trusted project, like `.claude/settings.json`; an untrusted project's own plugin registry can never load its own hooks or shadow a user-scope plugin's hooks. `disableAllHooks: true` from any loaded source disables plugin hooks along with every other source. Disabling OMP's `claude-plugins` discovery provider (the same toggle OMP's native Claude-plugin skill/agent/MCP discovery honors) disables plugin hook loading entirely.

## Diagnostics

Run:

```text
/claude-compat doctor
```

The report shows the repository root, selected mode, trust state, loaded settings files, effective hook counts, duplicate suppression, parse warnings, and unsupported hook sources.

## Supported command hooks

The extension supports Claude-style `command` handlers with:

- `command`
- `args` for direct execution without a shell
- `timeout` in seconds
- `shell` (`bash` or `powershell`)
- `async`
- `asyncRewake`
- tool-event `if` matchers

Supported event mappings include:

- `SessionStart` and `SessionEnd`
- `PreCompact` and `PostCompact`
- `PreToolUse`
- `PostToolUse` and `PostToolUseFailure`
- `UserPromptSubmit`
- `Stop`

Matching handlers are deduplicated by command and arguments and normally run in parallel. Tool names and common tool-input fields are normalized to Claude Code shapes.

`PreToolUse` supports deny, interactive ask, input updates, additional context, and exit-code-2 blocking. Hook timeouts terminate the complete process group on macOS and Linux. Repeated blocking from a `Stop` hook is suppressed after one follow-up turn.

Successful plain-text output never creates a notification. `SessionStart` and `UserPromptSubmit` add it to model context; `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `PreCompact`, `PostCompact`, `SessionEnd`, and `Stop` ignore it. Structured JSON handling and failed-hook diagnostics are unchanged.

## Current limits

The compatibility layer intentionally does not load:

- organization-managed Claude policy hooks
- non-command handlers such as `http`, `prompt`, `agent`, and `mcp_tool` (including from a plugin manifest)
- hook event kinds beyond the nine listed [above](#supported-command-hooks) (including from a plugin manifest — Claude Code defines 30+ event kinds in total)

Plugin manifests and hook configuration files are re-read whenever hook settings are loaded, just like user settings. OMP caches installed-plugin roots separately; refresh plugin discovery after manually editing a plugin registry.

Claude Code's user-plugin registry is opt-in, following OMP's `claude`/`claude-plugins` user-source settings. OMP-managed plugins do not require that opt-in. This requires OMP 18.1.16 or later, whose discovery API exposes each plugin's registry origin.

The doctor reports these limits rather than implying full parity. OMP's native Claude provider continues to own skill discovery; this package does not copy or reimplement it.

## Development

```sh
bun install
bun test
bun run typecheck
bun run build
```

OMP loads the TypeScript source entry directly from `src/omp-hooks.ts`.

## Upstream

This repository is based on [`ZeR020/omp-hooks`](https://github.com/ZeR020/omp-hooks) and retains its MIT license. The `upstream` Git remote tracks that project.
