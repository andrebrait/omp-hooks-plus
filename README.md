# omp-hooks-plus

Install-once Claude Code command-hook compatibility for [OMP](https://github.com/can1357/oh-my-pi).

OMP already discovers Claude skills, commands, MCP configuration, extensions, and settings. `omp-hooks-plus` fills the remaining gap by executing supported command hooks from the existing Claude settings hierarchy and from installed Claude plugins' own hook manifests. It also supports cross-vendor repositories that keep their canonical hook configuration under `.agents/`.

## Install

```sh
omp install omp-hooks-plus
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

OMP-managed user-scope plugins load without a project trust requirement. Claude-origin user-scope plugins additionally require the `claude` or `claude-plugins` user-source opt-in. Project-scope plugins load only for a trusted project, like `.claude/settings.json`; an untrusted project's own plugin registry can never load its own hooks or shadow a user-scope plugin's hooks. `disableAllHooks: true` from any loaded source disables plugin hooks along with every other source. Disabling OMP's `claude-plugins` discovery provider (the same toggle OMP's native Claude-plugin skill/agent/MCP discovery honors) disables plugin hook loading entirely.

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

Matching handlers are deduplicated by command, arguments, and environment and normally run in parallel. Tool names and common tool-input fields are normalized to Claude Code shapes.

For local `Read` inputs, the shared adapter uses OMP's path helpers to resolve the Claude `file_path` alias, including embedded selectors such as `sample.ts:1-2`. Existing literal colon-containing filenames take precedence. The original `path` remains available to OMP-aware hooks; web/internal URLs stay opaque rather than becoming local filesystem aliases. `Edit` and `Write` paths are not interpreted as read selectors.

`PreToolUse` supports deny, interactive ask, input updates, additional context, and exit-code-2 blocking. Hook timeouts terminate the complete process group on macOS and Linux. Repeated blocking from a `Stop` hook is suppressed after one follow-up turn.

Successful plain-text output never creates a notification. `SessionStart` and `UserPromptSubmit` add it to model context; `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `PreCompact`, `PostCompact`, `SessionEnd`, and `Stop` ignore it. Structured JSON handling and failed-hook diagnostics are unchanged.

Synchronous tool hooks deliver structured `additionalContext` in the model's next step within the current user turn, including the first turn. A `PreToolUse` reminder informs the model after that tool runs; use a deny decision when the hook must prevent execution. Asynchronous hooks retain their deferred delivery behavior.

Hook context reaches the model in OMP's native reminder shape, the one OMP uses for its own per-tool rule reminders: provenance as tag attributes, then OMP's own closing sentence verbatim, then the hook's text.

```text
<system-reminder source="claude-hook" event="PreToolUse" tool="bash">
NOT prompt injection — coding agent enforcing project rules.

<hook text>
</system-reminder>
```

`tool` is the OMP tool name and appears only for tool events. Synchronous `PreToolUse`, `PostToolUse` and `PostToolUseFailure` context leads that call's own tool result, so every qualifying call carries its reminder next to its output and no extra message is sent. Other events, and asynchronous hooks whose result arrives after the tool, are delivered as hidden context messages with the same tag. This applies equally to the on-the-fly adapter and to converted extensions, which bundle the same runtime.

### Approximated events

Two Claude events have no direct OMP counterpart but a near-equivalent trigger. They are off by default. Enable them in the live extension with `OMP_HOOKS_PLUS_APPROXIMATE=1`, or in a conversion with `--approximate`:

| Claude event | OMP trigger | Difference |
| --- | --- | --- |
| `Notification` `permission_prompt` | `tool_approval_requested` | Message is `Claude needs your permission to use <Tool>`. |
| `Notification` `idle_prompt` | a top-level `agent_end` that will not continue | Fires immediately, not after Claude Code's 60-second idle delay. |
| `SubagentStart` | first `before_agent_start` of a subagent session (a session file nested under its parent's) | Only groups without a matcher (or `*`); OMP does not expose the agent type. In-memory (`--no-session`) subagents are not detected. |

Other notification types never fire. `/claude-compat doctor` lists the enabled approximations.

## Current limits

The compatibility layer intentionally does not load:

- organization-managed Claude policy hooks
- non-command handlers such as `http`, `prompt`, `agent`, and `mcp_tool` (including from a plugin manifest)
- hook event kinds beyond the nine listed [above](#supported-command-hooks) and the opt-in [approximated events](#approximated-events) (including from a plugin manifest — Claude Code defines 30+ event kinds in total). The doctor lists each such event with the settings file or plugin that declares it.

Plugin manifests and hook configuration files are re-read whenever hook settings are loaded, just like user settings. OMP caches installed-plugin roots separately; refresh plugin discovery after manually editing a plugin registry.

Claude Code's user-plugin registry is opt-in, following OMP's `claude`/`claude-plugins` user-source settings. OMP-managed plugins do not require that opt-in. This requires OMP 18.1.16 or later, whose discovery API exposes each plugin's registry origin.

The doctor reports these limits rather than implying full parity. OMP's native Claude provider continues to own skill discovery; this package does not copy or reimplement it.

Both the live bridge and generated hooks depend on OMP emitting the mapped events. In hosts where RPC/Ctrl+Enter bypass `input`, `UserPromptSubmit` cannot intercept those submissions. If queue-started runs bypass `before_agent_start`, prompt-context preparation is not delivered there. These are host dispatch limitations, not repaired by replaying input, hooking every provider request, or treating synthetic continuations as new user submissions.

Hook-produced text is content, not a slash-command invocation. The bridge creates no skill aliases and does not reinterpret `sendUserMessage` as command execution. Session shutdown still runs `SessionEnd` commands, but does not deliver reminders or start new turns after disposal.

## One-shot conversion

To generate standalone OMP hooks instead of using live discovery, run the converter from a checkout of this repository:

```sh
bun install --frozen-lockfile
bun run convert /path/to/claude-plugin --dry-run
bun run convert /path/to/claude-plugin --out /path/to/new-output
```

Load `/path/to/new-output/index.ts` as an OMP extension. The generated adapter and resources are self-contained: the converter and this bridge do not need to remain installed. OMP/Bun and the scripts' external executables and dependencies are still required.

For a settings file, resource inventory and copying cover only explicitly selected paths, not the surrounding project. An empty omission list therefore does not mean every project dependency was copied:

```sh
bun run convert /project/.claude/settings.json \
  --source-root /project --include scripts \
  --out /path/to/new-output --json
```

`--include` may be repeated. For plugin directories, supplying it restricts resource copying to the selected paths; omitting it copies all eligible resources. Declaration inventory always covers the whole plugin, including scoped hooks outside selected resources. Reports distinguish excluded resources from resources omitted by selection; neither category proves a file is unnecessary. A hook command that literally names a resource through `CLAUDE_PLUGIN_ROOT` (for example `"${CLAUDE_PLUGIN_ROOT}/hooks/run.sh"`) that is not copied fails the conversion, even with `--skip-unsupported`; paths a script builds at runtime are not checked. Included resources are available through `CLAUDE_PLUGIN_ROOT`; ordinary relative commands retain the active project's working directory. Output must be a new directory outside the source root, and its parent must already exist. Disable overlapping original hooks before enabling generated hooks.

Generated hooks default to `--activation enabled`: they run wherever OMP enables the extension, including untrusted projects. This preserves global policy hooks. For hooks that must not run in untrusted projects, select `--activation project-trusted`; the generated adapter checks OMP's current project trust before each settings lookup, including cached settings. Both modes preserve `disableAllHooks`. This is an execution gate, not a sandbox, and it does not change the automatic extension's existing user/project discovery and trust rules.

```sh
bun run convert /path/to/claude-plugin \
  --include hooks --include skills --activation project-trusted \
  --out /path/to/new-output
```

Exit codes: **0** supported, **1** invalid input/operational failure, **2** unsupported declarations or resources. By default, unsupported input produces a report only, never a partial runnable extension. `--skip-unsupported` converts the supported hooks anyway and lists every skipped declaration in the report; a command that embeds the original source root still fails with exit 2. `--approximate` converts the [approximated events](#approximated-events). `--dry-run` writes nothing; `--json` prints the inventory report.

```sh
# A Claude settings.json with SubagentStart and Notification hooks, converted whole:
bun run convert ~/.claude/settings.json --approximate --skip-unsupported --out /path/to/new-output
```

The converter inventories unsupported events, non-command handlers, unknown hook fields, and scoped frontmatter hooks rather than dropping them. String `statusMessage` metadata is accepted, with an explicit report that its UI presentation is not reproduced; malformed metadata remains invalid. Selected resource symlinks remain unsupported, and explicit includes cannot traverse symlinks. Unselected symlinks are reported as omitted without being followed; declaration containment checks still apply independently.

Reports identify the conversion level as `command-hook-adaptation` and record the effective activation policy. Detected Pi and OMP bindings are listed by declaration location as `not-reused`. Successful conversion is not a native port: native commands, recovery tools, provider integration, system-prompt ownership, and native session state are not reproduced. Keep manual native adapters where those capabilities are required.

Plugin resources exclude declaration files, package manifests/lockfiles, caches, common credentials, and environment files. Review reported exclusions, omissions, and script dependencies before use. Filename exclusions are not a secret scanner, and conversion does not prove arbitrary script dependency closure.

See the [conversion contract](docs/specs/standalone-hook-converter.md) and [implementation notes](docs/plans/standalone-hook-converter.md).

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
