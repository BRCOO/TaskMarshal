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
worker_route_decision(goal: "...", scope: "...", risk: "medium")
worker_create_task(goal: "...", scope: "...", risk: "medium", route: "flash")
worker_checkpoint_step(id: "task", step: "s1")
worker_record_verification(id: "task", status: "pass", command: "npm test")
worker_finalize_task(id: "task")
```

The task ledger is written under local `.taskmarshal/tasks/` and is ignored by
git. Codex should normally read only the returned control packet and final
taskKey.

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
worker_observe(provider: "reasonix", id: "audit", mode: "permission", maxChars: 2000)
worker_observe(provider: "reasonix", id: "audit", mode: "final", maxChars: 6000)
worker_summarize_session(provider: "reasonix", id: "audit", maxChars: 6000)
worker_metrics_report(provider: "reasonix", limit: 20)
```

Use full event observation only when compact state is not enough:

```text
worker_observe(provider: "reasonix", id: "audit", mode: "events", tail: 80)
```

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

## Model Policy

- Use `flash` for exploration, routine implementation, long low-cost sessions,
  and first-pass work.
- Use `pro` for architecture review, tricky debugging, security-sensitive
  changes, final review, or when a `flash` result is uncertain.
- If metrics show large average assistant output or repeated unknown
  verification, tighten worker yield budgets before adding more worker passes.

The economical default is Codex plans, `flash` executes or audits, and `pro`
reviews only when risk justifies it.
