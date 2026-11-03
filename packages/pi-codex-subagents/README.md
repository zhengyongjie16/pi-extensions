# pi-codex-subagents

Codex-shaped, session-scoped subagents for [Pi](https://github.com/earendil-works/pi). Run fresh-context SDK sessions inside the parent Pi process, receive their final responses automatically, steer active work, and inspect sessions in the existing live overlay. No separate Pi agent engine or child TUI is started.

Requires **Pi 1.5.0** and Node.js 22.19 or newer. The supported Pi version is pinned because task acceptance uses `PromptOptions.preflightResult`, an exported but **internal** SDK hook verified against 1.5.0. Later versions require contract checks before widening support. Pi supplies the SDK and UI packages; this package does not bundle another SDK copy.

## Install

```bash
pi install npm:@ogulcancelik/pi-codex-subagents
```

For local development:

```bash
pi install /absolute/path/to/pi-extensions/packages/pi-codex-subagents
```

## Tools

| Tool | Purpose |
|---|---|
| `spawn_agent` | Start a fresh-context SDK session and return after task acceptance |
| `wait_agent` | Block for one completion and return its final text |
| `wait_all_agents` | Block until every selected agent finishes |
| `list_agents` | List current-session agents, or explicitly include historical sessions |
| `read_agent_response` | Read an agent's latest final raw text response |
| `send_message` | Steer a running agent or start another turn when settled |
| `interrupt_agent` | Request cooperative cancellation while preserving session history |

Agent names are unique within their parent session. The same task name can exist safely in different Pi sessions. Read and control tools are always scoped to the current parent session; only `list_agents(include_all: true)` crosses session boundaries, and that view is read-only.

## Agent templates

Templates are user-defined Markdown files in:

```text
~/.pi/agent/pi-codex-subagents/agents/*.md
```

No templates are installed automatically. Example:

```md
---
name: reviewer
description: Focused read-only code review agent
provider: openai-codex
model: gpt-5.6-sol
thinking: high
tools: read,bash,grep,find,ls
skills: web-investigate
extensions: @scope/pi-extra-tools, ~/.pi/agent/extensions/local-helper.ts
hint: Give this reviewer exact file paths and a narrow scope.
---
You are a focused review subagent. Return concise findings with file paths.
```

A template may set `model` without `provider` to use the current parent's provider at spawn time:

```md
---
name: quick-reviewer
model: gpt-5.6-sol
---
Review the requested files concisely.
```

Model routing priority is:

1. A caller-requested `model` (a complete provider/model pair).
2. The template's `model`, using its `provider` when present, otherwise the current parent's provider.
3. The current parent's provider and model.

Blank or whitespace-only template `provider`/`model` values count as omitted. A template without a model, including a provider-only template, still inherits **both** parent values; a provider alone does not reroute. `thinking` is independent and otherwise inherits the parent. Template `tools` override inherited tool names.

`skills` may contain skill names or paths. `extensions` may contain local files/directories or npm package names already installed by Pi. Package names are resolved from project-local packages first and then Pi's global npm directory. Missing packages are never installed automatically.

When a template loads extensions but omits `tools`, the child uses Pi's normal tool activation so tools registered by those extensions are available. Set template `tools` when you want an explicit allowlist. Without configured extensions, omitted template tools inherit the parent's active tool names as before.

## Resource loading and trust

New agents inherit neither the parent conversation nor its system prompt. Each child has its own `ModelRuntime`, settings, resource loader, and session history. The resource policy remains **disable default discovery, load explicit selections**:

- Replace Pi's default prompt with `~/.pi/agent/pi-codex-subagents/SYSTEM.md`, passed to the loader as its original file path. The extension creates a minimal prompt when first used; edit that file directly.
- Do not automatically append `APPEND_SYSTEM.md` or discover global, project, or ancestor `SYSTEM.md`, `AGENTS.md`, `AGENTS.override.md`, or `CLAUDE.md` instructions.
- Disable default/configured discovery of skills, extensions, prompt templates, and themes. Load the skills/extensions explicitly selected through templates, this extension's defaults, or the tool call. Template body text still enters the first user message.
- Omitted template tools keep the activation rules described above. An explicit nonempty `tools` list selects those names; an empty `tools` value disables built-in tools but still permits extension tools.

Explicit extension packages and `resources_discover` hooks may contribute attached skills, prompts, or themes; trusted extension code may also modify prompts. These switches are discovery controls, not a security boundary. The SDK can still add working-directory/tool/skill metadata, and a model or extension can actively read instruction files. Resuming history does not remove instructions already in that history. The SDK does not automatically load the CLI's codemode, tool-search, or MCP extensions.

For the same working directory, each creation/resume reads the parent's **current effective** `ctx.isProjectTrusted()` result, including temporary decisions. A different directory does not inherit that authorization: native Pi trust-store and headless policy apply, with unknown protected project resources skipped under `ask`/`never`. Trust is explicitly supplied to child settings; it is not saved as a permanent grant in agent metadata. Settings, credentials, and model configuration still follow native Pi rules; disabling instruction discovery does not disable all configuration reads.

If the selected model comes from an extension-registered provider, explicitly load that provider extension through the template's `extensions` or configured defaults. Parent provider registrations and custom tool implementations are not copied. Inherited tool **names** are resolved by the child.

## Configuration

Optional configuration lives at:

```text
~/.pi/agent/pi-codex-subagents/config.json
```

```json
{
  "storageDir": "~/.local/state/pi-codex-subagents/runs",
  "retentionDays": 7,
  "modelResponseTimeoutMs": 600000,
  "models": ["openai-codex/gpt-5.6-sol", "anthropic/claude-opus-4-6"],
  "modelsFromEnabledModels": true,
  "defaults": {
    "skills": ["web-investigate"],
    "extensions": ["@scope/pi-extra-tools"]
  }
}
```

`storageDir` accepts an absolute path, `~/...`, or a path relative to the package configuration directory. By default runs are stored in `~/.pi/agent/pi-codex-subagents/runs`. `retentionDays` defaults to `7`; expired runs and oversized tool outputs are pruned when the agent manager initializes. Set it to `0` to disable automatic cleanup. Observer sockets remain in the operating system temporary directory and are removed on actual session cleanup. They retain live read-only observation across Pi hosts; they are not an agent-engine RPC channel.

JSONL history, info, and log files keep their existing per-parent storage layout. The default dedicated directory is outside Pi's native session list, so child sessions do not appear in the main `/resume` browser. **Do not overlap `storageDir` with Pi's native session directory** (normally `~/.pi/agent/sessions`, or a custom host session directory): native scans can then expose child sessions. The extension reports overlap with the normal native directory or the current parent's custom session directory; keep any other custom scan directories separate too. An explicitly supplied JSONL path can still be opened.

`modelResponseTimeoutMs` limits one model response, from assistant message start to completion, and defaults to 10 minutes. It does not limit tool execution or the agent's total runtime. An overlong response is marked failed and cooperative SDK abort is requested. This ends the business wait, not necessarily the underlying work; cancellation and timers depend on cooperation and a responsive shared event loop. Set it to `0` to disable this guard. Initialization/acceptance and cleanup have separate internal bounded waits, not a new total-task timeout.

`shortcut` optionally binds a key to the subagent browser, for example `"shortcut": "ctrl+shift+a"`. No shortcut is assigned by default; omit it or set it to `""` to leave it unbound. Run `/reload` after changing it.

Configuration is read when agents spawn, while retention cleanup runs when the manager initializes. Restart Pi after changing `storageDir` or `retentionDays` so storage lookup and cleanup use the same configuration throughout the process.

Template skills and extensions override configured defaults. Skills explicitly requested by the parent are added to configured template/default skills. Tool selection belongs to the template or is inherited from the parent. A `model` and `thinking` level requested by the parent override the template and the inherited values, so one task can run on another model without a template.

## Model routing

An allowlist in `config.json` decides whether a parent may request a `model` and a `thinking` level per spawn, and which models it may pick. Both arguments appear together or not at all: an installation that configures nothing keeps routing in templates and inheritance. Two sources may be combined:

- `models` lists exact `provider/model-id` pairs approved for this extension alone, independent of any Pi setting.
- `modelsFromEnabledModels: true` adds the models Pi already scoped for the session, resolved from the `enabledModels` setting and `--models`. Models approved for the installation need no second approval here, and Pi has already expanded globs, preferred aliases over dated versions, and dropped unavailable entries. When Pi has no model scoping configured, this source adds nothing.

The arguments are offered only when at least one allowed model is available, and `model` enumerates exactly those pairs:

| Configuration | Allowed and available | `model` and `thinking` on the tool |
|---|---|---|
| neither key set | — | absent, routing belongs to templates |
| `"modelsFromEnabledModels": true`, Pi scoping unset | — | absent |
| `"modelsFromEnabledModels": true`, Pi scoping set | 2 models | present, `model` lists those 2 pairs |
| `"models": ["typo/xyz"]` | nothing available | absent, entry reported as a notification |
| both keys set | the union, deduplicated | present, `model` lists the union |

The list is resolved when a session starts: `models` entries are filtered to what is currently available, unavailable entries are reported as a warning notification, and the scoped models are merged in. Editing the configuration or the Pi setting takes effect when the next session starts, matching the `storageDir` and `retentionDays` behavior above. If a provider drops out mid-session, `spawn_agent` refuses that model at spawn time instead of serving a stale route.

Every route must use exact registered provider/model IDs, including any slashes in the model ID. A complete registered ID ending in `:high`, `:low`, or another thinking-level suffix takes precedence over suffix parsing. For compatibility, a trailing thinking suffix in `models` is ignored only when the complete ID is unavailable and the unsuffixed ID is an exact available match. Fuzzy names and unregistered custom IDs are not accepted. Before any task prompt, the child must advertise the exact resolved pair in its available model registry and report that exact selected model. Missing or mismatched models fail startup and clean up the child session; there is no fallback or provider search. Validation uses the child's registry, not the parent's, so explicitly loaded provider extensions can register models there.

The resolved provider/model pair is saved at spawn. `send_message` resumptions reuse and revalidate that saved pair, even if the parent model or template has since changed. These are local SDK availability/selection checks, not model-request probes; selection does not change the parent's configured default model. Registration cannot guarantee that a remote backend actually serves an advertised model; backend rejection still occurs at the first request.

A thinking level written into an `enabledModels` pattern, such as `anthropic/claude-opus-4-6:high`, is ignored here. `thinking` stays a separate argument, and the child clamps it to what its model supports.

## Completion delivery

A child completion or failure is delivered automatically to its parent session after the child reaches final status. If the parent is active, the result joins the current run; if the parent is idle, it starts a continuation turn. Continue independent work instead of waiting. Use `wait_agent` or `wait_all_agents` only when the next action depends on those responses and no useful work remains meanwhile; an active wait receives the result directly without a duplicate automatic message. Cancelling a wait only cancels that wait, not the agent. `read_agent_response` is read-only and does not consume a pending completion notification.

## Commands and TUI

While agents are starting or running, a compact one-line indicator appears above the editor. It shows the task name for one active agent or a count for multiple agents and points to `/subagents`. The indicator disappears when no agents are active.

`/subagents` opens the agent browser for the current session. Each row shows the task name, status, elapsed time, model, and thinking level, with the task preview underneath. Long names are shortened to fit the terminal. Press Tab to switch to the read-only all-sessions view, then Enter to open an agent.

The overlay uses the child working directory for tool rendering and synchronizes in-progress output when opened midway through a run. Use Left/Right to switch between agents in the current browser scope.

Tools always use Pi’s native **collapsed preview**, independently of the parent’s expanded-tools setting. Shell commands retain their native display; only results use the native preview limits. Codemode keeps its native code preview, nested-call statuses, output preview, timing, and full-output path hints. Other tools without a built-in renderer use Pi’s generic collapsed preview; third-party child renderers are not copied into the parent overlay. Image display and output padding follow the parent’s settings when the overlay opens.

Tools cannot be expanded here by clicking or pressing Ctrl+O. Native “to expand” hints may still appear, but apply only to Pi’s main transcript. Previews do not truncate stored results, session files, or completion messages. Unknown tools with very long single-line output can still occupy many visual lines, following Pi’s generic logical-line preview.

Historical and sync-final results follow native transcript replay without live-only argument-completion hooks. In particular, old edits are not previewed again against today’s filesystem; live and running-sync calls still use the native execution hooks.

## Runtime lifecycle and limits

After a turn completes, fails, or is interrupted, the extension releases the SDK session once initialization and submitted work have actually exited, explicitly sends child `session_shutdown`, and disposes the session. `send_message` then opens that agent's original JSONL in a new SDK session. Its saved route/resource selections and history are retained; prompt files and ordinary settings are reread. Messages during startup are rejected rather than buffered. While cleanup is still pending, reopening the same JSONL is refused if the bounded cleanup wait expires. A timeout is reported, not treated as successful resource release.

A steering acceptance timeout fails the current run and requests cancellation instead of leaving the timed-out input running silently. The session file stays owned until that input and the run exit; late input clears still-pending native messages after cancellation, without rewriting the transcript. Ordinary rejected steering input does not cancel the run, and an already completed/interrupted result is not replaced by a later timeout. Cancellation does not undo extension side effects or input already consumed by the SDK.

`interrupt_agent` and response timeouts use **cooperative cancellation**. There is no independent force-kill, process isolation, or security sandbox. Non-cooperative initialization, input hooks, tools, or extension code may keep running or retain resources after a business timeout. A blocked event loop can also stall parent TUI updates and timers; a child's crash, OOM, `process.exit()`, or global module mutation can affect the whole Pi host. Sessions in the same cwd share the worktree, normal credentials, and filesystem access; no worktree or OS isolation is added. External processes started by tools/extensions still need their normal cleanup.

Child extensions bind in headless `print` mode (`hasUI: false`), without a parent UI bridge. Prompt/steer input keeps the `rpc` source label only as compatible input metadata, not as an execution backend. Extensions that require RPC-mode dialogs, assume `process.cwd()` is the child directory, use global state, or end the process are not guaranteed equivalent. The parent widget, browser, and peek overlay remain interactive and unchanged.

A new loader is not a fresh module environment: Pi 1.5.0 caches extension factories by cwd/path. Repeated resumptions can reuse module code and module-level state. After changing extension code, use the host's `/reload` or restart; this package does not clear private SDK caches or promise module isolation. Use only extensions you trust and validate their headless behavior.

## Upgrading from the RPC version

**Stop all old tasks and confirm their Pi child processes have exited before updating/reloading into this SDK version.** Live mixed-backend upgrades are not supported. There is no legacy process takeover or automatic process-tree recovery in the new version. `PI_SUBAGENT_PI_BIN` is no longer supported: there is no child Pi executable to override. Old standard Pi JSONL histories remain readable and resumable without conversion; inactive records are normalized, not automatically rerun.

Before rollback, stop SDK tasks and wait for actual cleanup as well. Do not let the old version reopen a JSONL while a non-cooperative closing operation still owns it. Controlling the same agent from multiple Pi hosts concurrently is not a supported coordination mechanism; activity markers are not a distributed lock.

## Output limits

Automatic completions, wait tools, and response tools follow Pi's standard 50 KB / 2,000-line output limit. Oversized output is truncated and the complete text is written beside the runtime data; the returned notice includes a path that can be read with Pi's `read` tool.

## Development checks

The root development dependencies and lockfile pin the Pi packages to 1.5.0. The isolated SDK contract suite asserts that version to catch stale development installs. After installing them from the repository root, run from this package directory (the tarball smoke test also needs `npm` and `tar` on PATH):

```bash
bun test ./tests/core.test.ts ./tests/runtime.test.ts ./tests/peek.test.ts ./tests/host-integration.test.ts --timeout 60000
node --test ./tests/runtime.test.ts
```

Automated checks cover controlled SDK behavior, storage/observer contracts, native-renderer comparisons, and host integration. `host-integration.test.ts` checks the seven public schemas, dynamic trust/error forwarding, lifecycle shutdown reporting, the real Pi extension file loader, and a packed-tarball loader smoke test. On Bun and Node, a controlled provider issues a real parent tool call that invokes the seven tools through native nested-tool validation/hooks while independent parent work remains active. The test checks persisted nested-call records and repeated child session disposal, subscriptions, observed timers, sockets, and activity markers. Tests use temporary agent directories and controlled responses rather than external model requests.

These checks do not replace real-terminal visual/keyboard acceptance, real extension/provider compatibility checks, active-host session-switch/reload acceptance, repeated-use resource measurements, or RPC-versus-SDK startup/resume/RSS/TUI-response benchmarks. No performance improvement factor is claimed. Activate or roll back only in the stopped-task maintenance window described above.

## License

MIT
