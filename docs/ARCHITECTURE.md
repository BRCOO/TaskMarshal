# Architecture

TaskMarshal has three layers:

1. **Codex Skill**: routing policy and planner/reviewer workflow.
2. **MCP server**: provider-neutral control tools exposed to Codex.
3. **Provider adapters**: local CLI integrations such as Reasonix.

```text
Codex
  -> skills/taskmarshal
  -> mcp-server.js
  -> provider adapter
  -> reasonix acp / claude -p
```

## Skill

The skill answers one question before doing anything expensive:

```text
Is delegation worth it?
```

It chooses between Local Mode, Light Mode, and Full Marshal Mode.

## MCP Server

`mcp-server.js` exposes provider-neutral tools:

```text
worker_list_providers
worker_doctor
worker_ask
worker_start_session
worker_send_task
worker_observe
worker_approve
worker_deny
worker_cancel
worker_stop
```

Reasonix aliases are kept for compatibility but should not be the primary API for new providers.

`worker_observe` supports compact modes so Codex can supervise workers without
loading full event logs:

- `summary`: session state, last turn, pending permission, recent event types.
- `final`: final assistant text or latest assistant preview.
- `permission`: pending permission state only.
- `events`: recent raw events for debugging.

Use `summary` as the default during long worker runs and reserve `events` for
debugging TaskMarshal or provider adapters.

## Provider Adapters

`taskmarshalctl.js` runs `reasonix acp`, speaks NDJSON JSON-RPC through
`lib/acp-client.js`, and keeps persistent Reasonix session daemons under the
user's home directory. `reasonixctl.js` remains as a compatibility shim.

The Claude Code provider uses `claude -p --output-format json` and records logical sessions under `~/.taskmarshal/providers/claude-code/sessions`. Claude Code permissions stay inside Claude Code; TaskMarshal cannot externally approve or deny Claude Code permission prompts.

No provider API keys are stored in this repository. Reasonix reads its own local config from `~/.reasonix/config.json`; Claude Code uses its own local authentication.

## Token-Efficient Protocol

TaskMarshal should keep Codex context small:

1. The Skill performs only routing and points to reusable templates.
2. Codex sends `examples/task-spec.yaml` instead of a chat transcript.
3. Workers return `examples/worker-yield-summary.md`.
4. Workers run `examples/worker-self-review.md` before handoff.
5. Codex uses compact observe modes unless full event history is required.
