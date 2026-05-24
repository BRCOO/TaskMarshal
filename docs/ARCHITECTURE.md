# Architecture

TaskMarshal has three layers:

1. **Codex Skill**: routing policy and planner/reviewer workflow.
2. **MCP server**: provider-neutral control tools exposed to Codex.
3. **Provider adapters**: local CLI integrations such as Reasonix.

```text
Codex
  -> skills/taskmarshal
  -> mcp-server.js
  -> reasonixctl.js
  -> reasonix acp
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
worker_start_session
worker_send_task
worker_observe
worker_approve
worker_deny
worker_cancel
worker_stop
```

Reasonix aliases are kept for compatibility but should not be the primary API for new providers.

## Reasonix Adapter

`reasonixctl.js` runs `reasonix acp`, speaks NDJSON JSON-RPC through `lib/acp-client.js`, and keeps persistent session daemons under the user's home directory.

No provider API keys are stored in this repository. Reasonix reads its own local config from `~/.reasonix/config.json`.
