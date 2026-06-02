# Orchestration Guide

TaskMarshal is optimized for a lead/worker split:

- Codex owns planning, scope, permission decisions, final review, and user
  communication.
- Local workers such as Reasonix or Claude Code execute bounded tasks and
  return compact evidence.

The main token-saving rule is simple: do not use Codex as a transcript carrier.
Codex should send a compact `TaskSpec`, observe compact session state, and read
full logs only when debugging the worker itself.

## Token Firewall

Codex should exchange short control packets, not long task specs. Use:

```text
worker_task_gate(action: "route", goal: "...", scope: "...", risk: "medium")
worker_task_gate(action: "create", goal: "...", scope: "...", risk: "medium", route: "flash")
worker_task_gate(action: "checkpoint", id: "task", step: "s1")
worker_task_gate(action: "verify", id: "task", status: "pass", command: "npm test")
worker_task_gate(action: "finalize", id: "task")
```

The task ledger is written under local `.taskmarshal/tasks/` and is ignored by
git. Codex should normally read only the returned control packet and final
taskKey.

The individual gate tools remain available in the standard MCP profile for
compatibility, but `worker_task_gate` is the preferred low-token path.
Use `worker_task_gate(batch: [...])` when Codex already knows several gate
operations can run in order, such as checkpointing all completed steps, recording
verification, and finalizing.

## MCP Token Controls

For token-sensitive installations, launch the MCP server with:

```bash
TASKMARSHAL_TOOL_PROFILE=minimal
TASKMARSHAL_COMPACT_TOOL_TEXT=1
```

`TASKMARSHAL_TOOL_PROFILE=minimal` exposes only the core provider controls and
the merged task gate, and hides legacy Reasonix aliases automatically.
`TASKMARSHAL_COMPACT_TOOL_TEXT=1` keeps full MCP `structuredContent` while
making the visible text response a one-line summary.

## Delegation Packet

Use `examples/task-spec.yaml` as the default worker packet. It keeps the worker
focused on:

- goal
- workdir
- allowed files and commands
- forbidden actions
- acceptance criteria
- verification commands
- output format
- time and observation budget

Do not paste full chat history into worker prompts. Summarize known context and
point the worker to specific files instead.

## Plan Gate

For Full Marshal tasks, require a short worker plan before edits. Codex should
approve, narrow, or reject the plan before any file changes. This catches wrong
direction early, when the cost is still low.

Skip the plan gate only for read-only audits, tiny explicit patches, or tasks
where Codex already provided exact edits.

## Observation Modes

Use compact observation for routine supervision:

```text
worker_observe(provider: "reasonix", id: "audit", mode: "summary", maxChars: 4000)
worker_observe(provider: "reasonix", id: "audit", mode: "summary", since: 120, maxChars: 4000)
worker_observe(provider: "reasonix", id: "audit", mode: "permission", maxChars: 2000)
worker_observe(provider: "reasonix", id: "audit", mode: "final", maxChars: 6000)
worker_summarize_session(provider: "reasonix", id: "audit", maxChars: 6000)
worker_metrics_report(provider: "reasonix", limit: 20, compact: true)
```

Use full event observation only when compact state is not enough:

```text
worker_observe(provider: "reasonix", id: "audit", mode: "events", tail: 80)
```

Every observation returns a numeric `cursor.cursor`. Pass that value as `since`
on the next observation to get only new events. This keeps long worker sessions
from replaying the same event tail into Codex context.

## Yield Protocol

Workers should return `examples/worker-yield-summary.md`, not long prose. Codex
can then decide whether to inspect diffs, ask for a narrow redo, run tests, or
finish locally.

## Session Metrics

Use `worker_summarize_session` after a worker turn or before final review. The
summary returns a compact digest plus lightweight metrics:

- provider and model
- elapsed time
- turn count
- permission requests, approvals, denials, and auto-permissions
- prompt and assistant character counts
- error count
- verification and changed-file placeholders

Reasonix writes `session-summary.json` when summarized or stopped. New
persistent Reasonix turns also append `metrics.jsonl` in the session directory.
These records are intentionally small and secret-free, and can later drive
Local / flash / pro routing decisions.

Use `worker_metrics_report` for cross-session routing evidence. It reads compact
metrics records and session metadata, not large transcripts or event logs. The
report includes recent turns, model/provider aggregates, average assistant
output size, permission counts, verification coverage, and routing guidance.
Task-gate verification records are included in the same report so Codex can
see recent pass/fail/skip outcomes without loading task ledgers.
Use `compact: true` for normal routing checks; it returns aggregates, routing
hints, and at most three recent records. Compact mode reads recent metric tails
per session and omits long task-verification detail lists.

## Pro Second Pass

Use Reasonix `flash` for exploration, routine implementation, low-risk long
sessions, and first-pass work. Use Reasonix `pro` only when the extra reasoning
cost is justified:

- architecture or interface-boundary decisions
- tricky debugging or uncertain root cause
- security-sensitive, migration, auth, data-loss, or release-facing changes
- final review after a worker patch
- a `flash` result that is incomplete, contradictory, or high impact

Prefer `worker_plan_pro_review` before starting a `pro` session. It returns a
bounded read-only reviewer prompt and recommended session settings, while Codex
keeps final acceptance authority.

## Provider Capabilities

| Provider | Persistent sessions | Observe | Manual approval | Cancel | Model selection | Cost info |
|---|---:|---:|---:|---:|---:|---:|
| Reasonix / DeepSeek | Yes | Yes | Yes | Yes | Yes (`flash`/`pro`) | No |
| Claude Code | Logical session | Yes | No | No | Yes | Yes, when Claude CLI reports it |

Set `TASKMARSHAL_HIDE_LEGACY_REASONIX_TOOLS=1` before launching the MCP server
to hide `reasonix_*` compatibility aliases and reduce MCP tool-list tokens.
Use `TASKMARSHAL_TOOL_PROFILE=minimal` when you also want to hide nonessential
worker tools and route all task-gate operations through `worker_task_gate`.

## Model Policy

- Use `flash` for exploration, routine implementation, long low-cost sessions,
  and first-pass work.
- Use `pro` for architecture review, tricky debugging, security-sensitive
  changes, final review, or when a `flash` result is uncertain.
- If metrics show large average assistant output or repeated unknown
  verification, tighten worker yield budgets before adding more worker passes.

The economical default is Codex plans, `flash` executes or audits, and `pro`
reviews only when risk justifies it.
