<h1 align="center">TaskMarshal</h1>

<p align="center">
  <strong>Codex-led task dispatch and review for local CLI coding agents.</strong>
</p>

<p align="center">
  <a href="https://github.com/BRCOO/TaskMarshal/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/BRCOO/TaskMarshal/actions/workflows/ci.yml/badge.svg"></a>
  <a href="https://github.com/BRCOO/TaskMarshal/blob/main/LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-blue.svg"></a>
  <img alt="Node >=22" src="https://img.shields.io/badge/node-%3E%3D22-339933.svg">
  <img alt="MCP" src="https://img.shields.io/badge/MCP-stdio-111827.svg">
  <img alt="Providers: Reasonix + Claude Code" src="https://img.shields.io/badge/providers-Reasonix%20%2B%20Claude%20Code-4B5563.svg">
</p>

<p align="center">
  <a href="#quickstart">Quickstart</a>
  |
  <a href="#how-it-works">How It Works</a>
  |
  <a href="#mcp-tools">MCP Tools</a>
  |
  <a href="#security-model">Security</a>
  |
  <a href="#roadmap">Roadmap</a>
</p>

TaskMarshal turns Codex into a technical lead for local AI coding agents. Codex decides when delegation is worth it, writes a bounded task spec, sends work to a worker, observes progress, gates permissions, and reviews the result before accepting it.

The first worker providers are [DeepSeek-Reasonix](https://github.com/esengine/DeepSeek-Reasonix) and Claude Code. The provider layer is intentionally generic so future adapters can target Gemini CLI, Codex CLI, or other local coding agents.

```text
User -> Codex -> TaskMarshal Skill -> taskmarshal-mcp -> Provider Adapter -> CLI Worker
```

## Why TaskMarshal

Coding agents are useful executors, but architecture ownership should stay with the lead agent. TaskMarshal keeps that boundary explicit.

| Problem | TaskMarshal's answer |
|---|---|
| "Should I delegate this?" | A Codex Skill scores the task and skips workers for simple work. |
| "How do I control another CLI agent?" | An MCP server exposes structured worker tools instead of TUI scraping. |
| "Who approves risky actions?" | Codex keeps the permission gate and can approve, deny, or cancel worker turns. |
| "How do I review worker output?" | Codex treats worker results as proposed patches and verifies them locally. |
| "Can this support more than Reasonix?" | Providers are named explicitly; `reasonix` is the first adapter, not the whole system. |

## Current Status

- Provider-neutral MCP tools: `worker_*`
- Optional Reasonix compatibility tools: `reasonix_*`
- Provider-neutral CLI: `taskmarshalctl.js`; `reasonixctl.js` is a shim
- Persistent Reasonix ACP sessions
- DeepSeek v4 `flash` / `pro` selection for Reasonix
- Claude Code one-shot and resumable logical sessions
- Manual approval gate for worker permissions
- Event observation through JSONL session logs
- Compact observation modes for token-sensitive supervision
- Session summaries with lightweight task metrics
- Cross-session metrics reports for routing and token-efficiency tuning
- Token-firewall task gates with short control packets and task keys
- Merged `worker_task_gate` for route/create/checkpoint/verify/finalize control
- Batch task gate calls for fewer MCP round trips
- Minimal MCP tool profile and compact tool text mode for lower Codex context use
- Incremental observation cursors and compact metrics reports
- Tail-limited metrics scans for lower filesystem and context overhead
- Default worker output contract with 1200-character final-output cap
- Pro second-pass review planning for higher-risk verification
- Codex Skill for autonomous delegation decisions
- TaskSpec and worker yield templates for bounded delegation
- Secret-free repository: no API keys, transcripts, or local state

## Quickstart

### 1. Install a worker provider

Reasonix:

```bash
npm install -g reasonix
reasonix setup
reasonix doctor
```

Reasonix stores its DeepSeek API key in your local user config:

```text
~/.reasonix/config.json
```

TaskMarshal does not need this key in the repository.

Claude Code:

```bash
claude --version
claude auth
```

### 2. Install TaskMarshal

```bash
git clone https://github.com/BRCOO/TaskMarshal.git
cd TaskMarshal
npm install
npm run check
npm run mcp:smoke
npm run eval
npm run eval:tokens
```

### 3. Register the MCP server with Codex

Recommended token-saving config:

```bash
node taskmarshalctl.js install-codex-config --write-user
codex mcp list
```

This writes a `taskmarshal-mcp` server entry to `~/.codex/config.toml` with
`TASKMARSHAL_TOOL_PROFILE=minimal` and
`TASKMARSHAL_COMPACT_TOOL_TEXT=1`. It also enables the default worker output
contract with `TASKMARSHAL_WORKER_OUTPUT_CONTRACT=1` and
`TASKMARSHAL_WORKER_OUTPUT_MAX_CHARS=1200`. Restart Codex after changing MCP
config.

Manual registration is also supported.

Windows:

```bash
codex mcp add taskmarshal-mcp -- node C:\\path\\to\\TaskMarshal\\mcp-server.js
codex mcp list
```

macOS/Linux:

```bash
codex mcp add taskmarshal-mcp -- node /path/to/TaskMarshal/mcp-server.js
codex mcp list
```

### 4. Install the Codex Skill

Windows PowerShell:

```powershell
Copy-Item -Recurse .\skills\taskmarshal "$env:USERPROFILE\.codex\skills\taskmarshal" -Force
```

macOS/Linux:

```bash
mkdir -p ~/.codex/skills
cp -R skills/taskmarshal ~/.codex/skills/taskmarshal
```

Restart Codex or open a fresh Codex thread if newly registered MCP tools or skills do not appear immediately.

### 5. Optional: make routing habitual

Codex Skills are recalled by metadata, not as guaranteed global hooks. If you want Codex to consider TaskMarshal on every request, copy the global instruction template into your Codex home:

Windows PowerShell:

```powershell
Copy-Item .\examples\codex-AGENTS.md "$env:USERPROFILE\.codex\AGENTS.md" -Force
```

macOS/Linux:

```bash
cp examples/codex-AGENTS.md ~/.codex/AGENTS.md
```

This does not force every task into Reasonix. It only makes Codex run a silent routing check first, then choose Local Mode, Light Mode, or Full Marshal Mode.

## How It Works

```text
User
  |
  v
Codex  -- decides whether delegation is worth it --> Local Mode
  |
  | uses TaskMarshal Skill
  v
taskmarshal-mcp
  |
  | worker_* tools
  v
taskmarshalctl adapter  -- current provider --> Reasonix / DeepSeek
  |
  | ACP JSON-RPC
  v
session events/logs  --> Codex observes, approves, denies, and reviews
```

The TaskMarshal Skill chooses between:

- **Local Mode:** Codex handles simple work directly.
- **Light Mode:** one bounded worker prompt.
- **Full Marshal Mode:** Codex plans, dispatches, observes, approves, reviews, and verifies.

## Token-Efficient Worker Output

TaskMarshal keeps worker handoffs small by default. Reasonix and Claude Code
prompts receive a short output contract, and final worker text is capped before
it is persisted for later `observe final` or summary reads.

Default final labels:

```text
changedFiles / commands / verification / risks / next
```

Default cap: `1200` characters. Full event/transcript logs remain local for
debugging, but Codex should not read them during normal supervision.

Controls:

```bash
TASKMARSHAL_WORKER_OUTPUT_CONTRACT=0
TASKMARSHAL_WORKER_OUTPUT_MAX_CHARS=2000
node taskmarshalctl.js send SESSION --output-max-chars 2000 "task"
node taskmarshalctl.js send SESSION --no-output-contract "task"
```

To quantify token-saving regressions, run:

```bash
npm run eval:tokens
```

The benchmark compares standard vs minimal MCP tool-list size, event observation
vs summary/final observation size, and normal vs compact metrics output. It
reports exact character counts plus an approximate token estimate, and fails if
compact paths exceed fixed budgets.

## Provider Matrix

| Provider | Status | Persistent sessions | Observe | Manual approval | Cancel | Model selection | Cost info | Notes |
|---|---:|---:|---:|---:|---:|---:|---:|---|
| Reasonix / DeepSeek | Implemented | Yes | Yes | Yes | Yes | Yes (`flash`/`pro`) | No | Uses `reasonix acp` through `taskmarshalctl`; supports DeepSeek v4 `flash` and `pro`. |
| Claude Code | Implemented | Logical session | Yes | No | No | Yes | Yes, when Claude CLI reports it | Uses `claude -p --output-format json`; permissions stay inside Claude Code. |
| Gemini CLI | Planned | TBD | TBD | TBD | TBD | TBD | TBD | Future adapter. |
| Codex CLI | Planned | TBD | TBD | TBD | TBD | TBD | TBD | Future adapter. |

## MCP Tools

Provider-neutral tools:

| Tool | Purpose |
|---|---|
| `worker_list_providers` | List available worker providers. |
| `worker_doctor` | Check provider installation/configuration. |
| `worker_ask` | Run one prompt with a worker. |
| `worker_start_session` | Start a persistent worker session. |
| `worker_list_sessions` | List known worker sessions. |
| `worker_status` | Inspect one worker session. |
| `worker_send_task` | Send a bounded task to a session. |
| `worker_observe` | Read compact worker state by default; pass `mode: "events"` only for raw event tails. |
| `worker_summarize_session` | Return a compact session digest and lightweight metrics. |
| `worker_metrics_report` | Return a compact cross-session metrics report for routing and token-efficiency decisions. |
| `worker_task_gate` | Merged token-firewall gate for route, create, checkpoint, verify, finalize, and ordered batches. |
| `worker_route_decision` | Return a short deterministic Local/flash/pro routing decision. |
| `worker_create_task` | Create a local token-firewall task ledger and return a short control packet. |
| `worker_checkpoint_step` | Mark one task step done. |
| `worker_record_verification` | Record pass/fail/skip verification. |
| `worker_finalize_task` | Return a taskKey proof when gates pass. |
| `worker_plan_pro_review` | Build a bounded DeepSeek v4 pro second-pass review task. |
| `worker_approve` | Approve a pending permission request. |
| `worker_deny` | Deny a pending permission request. |
| `worker_cancel` | Cancel the current worker turn. |
| `worker_stop` | Stop a worker session. |

For Reasonix, `worker_ask` and `worker_start_session` accept:

| Option | Values | Notes |
|---|---|---|
| `model` | `flash`, `pro`, `deepseek-v4-flash`, `deepseek-v4-pro` | `flash` maps to `deepseek-v4-flash`; `pro` maps to `deepseek-v4-pro`. |
| `preset` | `auto`, `flash`, `pro` | Passed through to Reasonix preset selection. |

Use `flash` for quick exploration, routine implementation, and low-cost long sessions. Use `pro` for hard architecture, tricky debugging, final review, or higher-stakes verification.

For broad audits or slow investigations, avoid `worker_ask` / `reasonix_ask`. Those one-shot tools block until the worker finishes and can hit the host MCP timeout. Use persistent sessions instead:

```text
worker_start_session(provider: "reasonix", id: "audit", approve: "manual", model: "flash")
worker_send_task(provider: "reasonix", id: "audit", taskId: "task", prompt: "Read-only audit ...")
worker_observe(provider: "reasonix", id: "audit", mode: "summary", maxChars: 4000)
```

Codex should continue local work while the worker runs and treat the result as a later second pass.

Observation modes:

| Mode | Purpose |
|---|---|
| `summary` | Compact session state, last turn, pending permission, and recent event types. |
| `final` | Final assistant text or latest assistant preview. |
| `permission` | Pending permission state only. |
| `events` | Full recent event tail for debugging worker behavior. |

`worker_observe` defaults to `summary` mode. Use `maxChars` to cap large text
fields before they enter Codex context.
Use the returned `cursor.cursor` as `since` on the next `worker_observe` call
to read only new events.

Reasonix compatibility aliases are also available:

```text
reasonix_doctor
reasonix_ask
reasonix_start_session
reasonix_list_sessions
reasonix_status
reasonix_send_task
reasonix_observe
reasonix_summarize_session
reasonix_metrics_report
reasonix_approve
reasonix_deny
reasonix_cancel
reasonix_stop
```

Set `TASKMARSHAL_HIDE_LEGACY_REASONIX_TOOLS=1` before launching
`taskmarshal-mcp` to hide the `reasonix_*` compatibility tools and reduce the
MCP tool list. The provider-neutral `worker_*` tools remain available.

For the smallest Codex tool-list and tool-result footprint, launch the MCP
server with:

```bash
TASKMARSHAL_TOOL_PROFILE=minimal
TASKMARSHAL_COMPACT_TOOL_TEXT=1
```

`minimal` exposes the core provider tools plus `worker_task_gate` and hides
legacy Reasonix aliases automatically. `TASKMARSHAL_COMPACT_TOOL_TEXT=1` keeps
full `structuredContent` for clients, but reduces the visible text result to a
one-line control summary.

To install that setup into Codex user config:

```bash
node taskmarshalctl.js install-codex-config --write-user
```

By default, `install-codex-config` only prints the TOML snippet. With
`--write-user`, it updates `~/.codex/config.toml` and writes a timestamped
backup before changing an existing file.

## Direct CLI Usage

Use the Reasonix adapter without MCP:

```bash
node taskmarshalctl.js doctor
node taskmarshalctl.js models
node taskmarshalctl.js smoke
node taskmarshalctl.js metrics --limit 10 --compact
node taskmarshalctl.js ask "Summarize this repository. Do not edit files." --approve cancel
node taskmarshalctl.js ask "Review this design for risks." --approve cancel --model pro
```

Persistent session:

```bash
node taskmarshalctl.js start --id architect --dir C:\\path\\to\\repo --approve manual
node taskmarshalctl.js start --id reviewer --dir C:\\path\\to\\repo --approve manual --model pro
node taskmarshalctl.js send architect "Analyze the repo. Do not edit files."
node taskmarshalctl.js observe architect --mode summary --max-chars 4000
node taskmarshalctl.js observe architect --mode summary --since 120 --max-chars 4000
node taskmarshalctl.js summarize architect --max-chars 6000
node taskmarshalctl.js approve architect
node taskmarshalctl.js deny architect
node taskmarshalctl.js stop architect
```

Use `--approve manual` when Codex should gate worker permissions. Use
`--approve cancel` for read-only one-shot analysis. `reasonixctl.js` remains as
a compatibility shim for older scripts.

Claude Code provider through MCP:

```text
worker_ask(provider: "claude-code", prompt: "Analyze this repo in plan mode", approve: "cancel")
worker_start_session(provider: "claude-code", id: "claude-review", approve: "cancel")
worker_send_task(provider: "claude-code", id: "claude-review", taskId: "task", prompt: "Review these files")
worker_observe(provider: "claude-code", id: "claude-review", mode: "summary", tail: 20)
```

Claude Code does not expose an external permission callback to TaskMarshal. `worker_approve`, `worker_deny`, and `worker_cancel` return unsupported for `claude-code`; use Claude Code permission modes for safety.

## Token-Efficient Delegation

The economical TaskMarshal loop is:

1. Codex calls `worker_task_gate(action: "route")` for a short Local/flash/pro decision.
2. Codex calls `worker_task_gate(action: "create")` with only short fields.
3. Worker returns a short plan before edits for Full Marshal tasks.
4. Codex observes with `mode: "summary"` or `mode: "permission"`.
5. Codex asks `worker_summarize_session` for a compact digest and metrics when
   the worker finishes.
6. Codex checks `worker_metrics_report` when routing quality or token cost
   needs evidence.
7. Codex records verification with `worker_task_gate(action: "verify")`.
8. Codex finalizes with `worker_task_gate(action: "finalize")` and accepts only with a taskKey.

When several gate operations are ready at once, Codex can use
`worker_task_gate(batch: [...])` to reduce MCP round trips. For long worker
sessions, Codex should observe once, store the returned cursor, then pass it as
`since` on the next observation to avoid re-reading old event tails.

Task ledgers are written under local `.taskmarshal/tasks/` and are gitignored.
MCP tools return short control packets by default; large task artifacts stay on
disk unless explicitly inspected.

Use `flash` for exploration, routine implementation, and low-risk long
sessions. Use `pro` only for architecture decisions, tricky debugging,
security-sensitive changes, uncertain `flash` results, or final verification
where a stronger second pass is worth the cost. `worker_plan_pro_review` returns
a bounded read-only review prompt and recommended `pro` session settings.

Reasonix session summaries are also written to
`~/.reasonixctl/sessions/<id>/session-summary.json`. New persistent Reasonix
turns append lightweight metrics to `metrics.jsonl`, including model, elapsed
time, prompt/assistant character counts, permission counts, errors, and
verification placeholders for future routing feedback.

Use `worker_metrics_report(compact: true)` or
`taskmarshalctl metrics --limit 20 --compact` to inspect
recent turns without loading raw `events.jsonl` or transcripts into Codex
context. Verification records from task gates are included in the metrics
report, so routing quality can be judged from local pass/fail/skip evidence.
Compact metrics reads only recent metric tails per session and omits long task
verification detail lists.

`taskmarshalctl route` uses compact metrics evidence when available. It keeps
small tasks local, tightens worker output budgets when recent worker output is
large, and can upgrade a `flash` route to `pro` when recent verification or
failure history shows that the cheaper path is not reliable enough.

When dispatching a token-firewall task to a worker, pass the task id to
`worker_send_task` or `taskmarshalctl send --task-id TASK_ID`. The worker turn
metric keeps that task id, and `worker_metrics_report` automatically merges the
later task-gate verification by task id.

If a worker turn was sent without a task id, pass both `--session SESSION_ID`
and `--turn-id TURN_ID` when recording verification to patch the matching metric
directly:

```bash
taskmarshalctl send audit --task-id TASK_ID "implement the bounded task"
taskmarshalctl verify --id TASK_ID --status pass --command "npm test" --session audit --turn-id TURN_ID
```

Templates:

| Template | Purpose |
|---|---|
| `examples/task-spec.yaml` | Structured delegation packet. |
| `examples/worker-yield-summary.md` | Compact worker handoff format. |
| `examples/worker-self-review.md` | Worker pre-handoff checklist. |
| `docs/ORCHESTRATION_GUIDE.md` | Detailed lead/worker operating model. |

## Delegation Policy

TaskMarshal is not meant to run for every coding request.

Good fits:

- multi-file implementation
- broad repository investigation
- long-running debugging
- independent verification
- planner/executor/reviewer workflows

Poor fits:

- quick Q&A
- simple terminal checks
- tiny one-file patches
- formatting or typo fixes
- routine documentation edits

The Skill's scoring rule is intentionally simple. It loads for tasks that look delegation-worthy, then may still choose Local Mode if the overhead is not justified.

## Security Model

TaskMarshal should never contain your provider API keys or private transcripts.

Ignored by default:

- `.env`
- `.reasonix/`
- `.reasonixctl/`
- `runs/`
- `sessions/`
- `transcripts/`
- `events/`
- `*.jsonl`
- private key formats such as `*.pem`, `*.key`, `*.p12`, `*.pfx`

Recommended pre-push checks:

```bash
git status --short
npm run check
npm run mcp:smoke
npm run eval
git grep -n -E "sk-[A-Za-z0-9_-]{20,}|api[_-]?key|token|secret|password" -- .
```

The grep may match documentation or source identifiers. Review matches before committing.

## Project Layout

```text
.
├── mcp-server.js                 # TaskMarshal MCP server
├── taskmarshalctl.js             # Provider-neutral TaskMarshal CLI
├── reasonixctl.js                # Compatibility shim
├── lib/acp-client.js             # ACP JSON-RPC client
├── skills/taskmarshal/           # Codex Skill
├── scripts/mcp-smoke.js          # MCP smoke test
├── scripts/taskmarshal-eval.js   # Local routing and task-gate evals
└── examples/                     # Example config and worker prompt
```

## Roadmap

- Provider adapter interface
- Gemini CLI provider
- Claude Code CLI provider
- Provider capability scoring
- Task spec persistence
- Better transcript summarization and metrics-based routing
- Packaged Codex plugin

## Contributing

Issues and pull requests are welcome. Keep provider adapters scoped, keep secrets out of fixtures, and add a smoke test path whenever a provider exposes new MCP tools.

## License

MIT
