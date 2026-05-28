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
- Reasonix compatibility tools: `reasonix_*`
- Persistent Reasonix ACP sessions
- DeepSeek v4 `flash` / `pro` selection for Reasonix
- Claude Code one-shot and resumable logical sessions
- Manual approval gate for worker permissions
- Event observation through JSONL session logs
- Codex Skill for autonomous delegation decisions
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
```

### 3. Register the MCP server with Codex

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
reasonixctl adapter  -- current provider --> Reasonix / DeepSeek
  |
  | ACP JSON-RPC
  v
session events/logs  --> Codex observes, approves, denies, and reviews
```

The TaskMarshal Skill chooses between:

- **Local Mode:** Codex handles simple work directly.
- **Light Mode:** one bounded worker prompt.
- **Full Marshal Mode:** Codex plans, dispatches, observes, approves, reviews, and verifies.

## Provider Matrix

| Provider | Status | Session control | Observe events | Manual approval | Notes |
|---|---:|---:|---:|---:|---|
| Reasonix / DeepSeek | Implemented | Yes | Yes | Yes | Uses `reasonix acp` through `reasonixctl`; supports DeepSeek v4 `flash` and `pro`. |
| Claude Code | Implemented | Logical session | Yes | No | Uses `claude -p --output-format json`; permissions stay inside Claude Code. |
| Gemini CLI | Planned | TBD | TBD | TBD | Future adapter. |
| Codex CLI | Planned | TBD | TBD | TBD | Future adapter. |

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
| `worker_observe` | Read recent worker events. |
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

Reasonix compatibility aliases are also available:

```text
reasonix_doctor
reasonix_ask
reasonix_start_session
reasonix_list_sessions
reasonix_status
reasonix_send_task
reasonix_observe
reasonix_approve
reasonix_deny
reasonix_cancel
reasonix_stop
```

## Direct CLI Usage

Use the Reasonix adapter without MCP:

```bash
node reasonixctl.js doctor
node reasonixctl.js models
node reasonixctl.js smoke
node reasonixctl.js ask "Summarize this repository. Do not edit files." --approve cancel
node reasonixctl.js ask "Review this design for risks." --approve cancel --model pro
```

Persistent session:

```bash
node reasonixctl.js start --id architect --dir C:\\path\\to\\repo --approve manual
node reasonixctl.js start --id reviewer --dir C:\\path\\to\\repo --approve manual --model pro
node reasonixctl.js send architect "Analyze the repo. Do not edit files."
node reasonixctl.js observe architect --tail 80
node reasonixctl.js approve architect
node reasonixctl.js deny architect
node reasonixctl.js stop architect
```

Use `--approve manual` when Codex should gate worker permissions. Use `--approve cancel` for read-only one-shot analysis.

Claude Code provider through MCP:

```text
worker_ask(provider: "claude-code", prompt: "Analyze this repo in plan mode", approve: "cancel")
worker_start_session(provider: "claude-code", id: "claude-review", approve: "cancel")
worker_send_task(provider: "claude-code", id: "claude-review", prompt: "Review these files")
worker_observe(provider: "claude-code", id: "claude-review", tail: 20)
```

Claude Code does not expose an external permission callback to TaskMarshal. `worker_approve`, `worker_deny`, and `worker_cancel` return unsupported for `claude-code`; use Claude Code permission modes for safety.

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
git grep -n -E "sk-[A-Za-z0-9_-]{20,}|api[_-]?key|token|secret|password" -- .
```

The grep may match documentation or source identifiers. Review matches before committing.

## Project Layout

```text
.
├── mcp-server.js                 # TaskMarshal MCP server
├── reasonixctl.js                # Reasonix provider control CLI
├── lib/acp-client.js             # ACP JSON-RPC client
├── skills/taskmarshal/           # Codex Skill
├── scripts/mcp-smoke.js          # MCP smoke test
└── examples/                     # Example config and worker prompt
```

## Roadmap

- Provider adapter interface
- Gemini CLI provider
- Claude Code CLI provider
- Provider capability scoring
- Task spec persistence
- Better transcript summarization
- Packaged Codex plugin

## Contributing

Issues and pull requests are welcome. Keep provider adapters scoped, keep secrets out of fixtures, and add a smoke test path whenever a provider exposes new MCP tools.

## License

MIT
