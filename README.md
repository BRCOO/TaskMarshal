# TaskMarshal

**Codex-led task dispatch and review for local CLI coding agents.**

TaskMarshal lets Codex act like a technical lead: it decides when delegation is worth it, writes a bounded task spec, sends work to a local CLI agent, gates permissions, observes progress, and reviews the result before accepting it.

The first provider is [DeepSeek-Reasonix](https://github.com/esengine/DeepSeek-Reasonix). The provider layer is intentionally generic so future adapters can target Gemini CLI, Claude Code CLI, Codex CLI, or other local coding agents.

```text
User
  -> Codex
    -> TaskMarshal skill
      -> taskmarshal-mcp
        -> provider adapter
          -> Reasonix / Gemini CLI / Claude Code CLI / ...
```

## Why

Most coding agents are good at execution, but they should not automatically own architecture decisions. TaskMarshal separates the roles:

- **Codex** plans, scopes, delegates, approves, reviews, and reports.
- **Worker agents** execute bounded tasks inside a controlled session.
- **MCP tools** provide a structured control surface instead of fragile terminal scraping.

For small tasks, Codex should just do the work. For complex tasks, TaskMarshal gives Codex a repeatable way to bring in a worker without giving up control.

## Current Status

- Provider-neutral MCP tools: `worker_*`
- Reasonix compatibility tools: `reasonix_*`
- Persistent Reasonix ACP sessions
- Manual approval gate for worker permissions
- Event observation through JSONL session logs
- Codex Skill for autonomous delegation decisions
- No secrets committed or required in this repository

## Requirements

- Node.js `>=22`
- Codex CLI or Codex desktop with MCP support
- Reasonix for the first provider:

```bash
npm install -g reasonix
reasonix setup
reasonix doctor
```

Reasonix stores its DeepSeek API key in your local user config, not in this repository:

```text
~/.reasonix/config.json
```

Do not commit `~/.reasonix`, `~/.reasonixctl`, `.env`, transcripts, or local config files.

## Install

Clone and install dependencies:

```bash
git clone https://github.com/BRCOO/TaskMarshal.git
cd TaskMarshal
npm install
npm run check
```

Register the MCP server with Codex:

```bash
codex mcp add taskmarshal-mcp -- node C:\\path\\to\\TaskMarshal\\mcp-server.js
codex mcp list
```

On macOS/Linux, use your absolute clone path:

```bash
codex mcp add taskmarshal-mcp -- node /path/to/TaskMarshal/mcp-server.js
```

## Install The Skill

Copy the skill into your Codex skills directory:

```powershell
Copy-Item -Recurse .\skills\taskmarshal "$env:USERPROFILE\.codex\skills\taskmarshal" -Force
```

On macOS/Linux:

```bash
mkdir -p ~/.codex/skills
cp -R skills/taskmarshal ~/.codex/skills/taskmarshal
```

The skill is a routing policy. It may decide **not** to start a worker when the task is simple.

## MCP Tools

Provider-neutral tools:

- `worker_list_providers`
- `worker_doctor`
- `worker_ask`
- `worker_start_session`
- `worker_list_sessions`
- `worker_status`
- `worker_send_task`
- `worker_observe`
- `worker_approve`
- `worker_deny`
- `worker_cancel`
- `worker_stop`

Reasonix compatibility aliases are also exposed:

- `reasonix_doctor`
- `reasonix_ask`
- `reasonix_start_session`
- `reasonix_list_sessions`
- `reasonix_status`
- `reasonix_send_task`
- `reasonix_observe`
- `reasonix_approve`
- `reasonix_deny`
- `reasonix_cancel`
- `reasonix_stop`

## Direct CLI Usage

You can use the Reasonix control CLI directly without MCP:

```bash
node reasonixctl.js doctor
node reasonixctl.js smoke
node reasonixctl.js ask "Summarize this repository. Do not edit files." --approve cancel
```

Persistent session:

```bash
node reasonixctl.js start --id architect --dir C:\\path\\to\\repo --approve manual
node reasonixctl.js send architect "Analyze the repo. Do not edit files."
node reasonixctl.js observe architect --tail 80
node reasonixctl.js approve architect
node reasonixctl.js deny architect
node reasonixctl.js stop architect
```

Use `--approve manual` when Codex should gate worker permissions. Use `--approve cancel` for read-only one-shot analysis.

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

The Codex skill uses a small scoring rule to choose between:

- **Local Mode:** Codex works directly.
- **Light Mode:** One bounded worker prompt.
- **Full Marshal Mode:** Codex plans, dispatches, observes, approves, reviews, and verifies.

## Security Notes

This repository should never contain API keys or private transcripts.

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

Before publishing, run:

```bash
git status --short
npm run check
```

Then scan for accidental secrets with your preferred scanner. A basic local grep is also useful:

```bash
git grep -n -E "sk-[A-Za-z0-9_-]{20,}|api[_-]?key|token|secret|password" -- .
```

The grep may match documentation text. Review matches before committing.

## Roadmap

- Provider adapter interface
- Gemini CLI provider
- Claude Code CLI provider
- Provider capability scoring
- Task spec persistence
- Better transcript summarization
- Packaged Codex plugin

## License

MIT
