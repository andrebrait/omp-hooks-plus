# omp-hooks-plus

Install-once Claude Code command-hook compatibility for [OMP](https://github.com/can1357/oh-my-pi).

OMP already discovers Claude skills, commands, MCP configuration, extensions, and settings. `omp-hooks-plus` fills the remaining gap by executing supported command hooks from the existing Claude settings hierarchy. It also supports cross-vendor repositories that keep their canonical hook configuration under `.agents/`.

## Install

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

## Current limits

The compatibility layer intentionally does not load:

- organization-managed Claude policy hooks
- hook declarations embedded in installed Claude plugins
- non-command handlers such as `http`, `prompt`, `agent`, and `mcp_tool`

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
