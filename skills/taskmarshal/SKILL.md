---
name: taskmarshal
description: >
  TaskMarshal routing preflight for Codex technical work. Use to decide whether
  Codex should work locally or delegate a bounded task to local CLI agent
  workers. Trigger for coding, repository changes, debugging, reviews,
  architecture, refactors, tests, technical research, product or tool
  evaluation, software/vendor comparison, engineering due diligence, task
  planning, implementation plus verification, or any mention of TaskMarshal,
  Reasonix, DeepSeek, Gemini CLI, Claude Code, local AI workers, agent
  delegation, subagents, multi-agent coding, planner/executor, or
  architect/implementer/reviewer workflows. After loading, score the task and
  choose Local, Light, or Full Marshal mode; loading this skill does not mean a
  worker must be started.
---

# TaskMarshal

TaskMarshal lets Codex act as planner, dispatcher, permission gate, and final
reviewer while local CLI agents execute bounded work.

Keep this skill lean. Detailed packets and operating docs live in:

- `examples/task-spec.yaml`
- `examples/worker-yield-summary.md`
- `examples/worker-self-review.md`
- `docs/ORCHESTRATION_GUIDE.md`

## Routing Check

Before starting a worker, decide whether delegation is worth the overhead.

Do not delegate by default for quick Q&A, simple terminal checks, formatting,
routine docs, short lookups, or a tiny one-file patch Codex can verify directly.

Keep local to Codex when work depends on user-specific machine state:
`~/.codex`, `~/.agents`, installed skills, MCP config, API-key config, shell
profiles, home-directory files, `.reasonixctl`, `.taskmarshal`, session logs,
metrics logs, task ledgers, or worker logs. Workers may have different
permissions. Do not ask workers to inspect those paths unless the user
explicitly approves that scope.

Use TaskMarshal when at least one is true:

- user explicitly asks for TaskMarshal, Reasonix, DeepSeek, Claude Code,
  workers, subagents, planner/executor, or architect/reviewer flow
- task spans three or more files, packages, modules, or architecture layers
- task needs long exploration, reproduction, debugging, or independent review
- task is technical research, product comparison, tool selection, or
  engineering due diligence where a second pass reduces risk
- Codex should keep architecture decisions while a worker executes bounded work

## Delegation Score

- `+2` explicit worker/TaskMarshal/provider/planner-executor request
- `+2` three or more files/packages/layers
- `+2` long repo exploration, reproduction, debugging, technical research, or
  multi-candidate tool/product comparison
- `+1` independent implementation or verification would reduce risk
- `+1` worker can run in parallel with local Codex work
- `-2` quick answer, simple command, obvious local edit, short lookup, or tiny
  one-file patch
- `-3` local Codex/skill/MCP config, user home directories, or private machine
  state may not be readable by the worker
- `-1` worker would need broad permissions before Codex scopes the work

Decision: score `<= 0` means Local Mode; score `1-2` means Light Mode only if a
second pass is genuinely useful; score `>= 3` means Full Marshal Mode. Do not
show the numeric score unless it clarifies a decision.

## Modes

- **Local Mode:** Codex handles the task directly.
- **Light Mode:** one bounded worker prompt, then Codex reviews.
- **Full Marshal Mode:** Codex plans, dispatches, observes, approves, reviews,
  verifies, and accepts or rejects.
- **Async Audit Mode:** for long read-only audits or broad research. Start a
  persistent session, send the task, observe opportunistically, and continue
  local work.

If an async audit hits a permission boundary, stop or ignore that turn, state
the limitation, and continue from local evidence. Do not promise to merge
findings from files the worker cannot inspect.

## Provider Choice

- Default to `reasonix` when external permission gating and event observation
  matter.
- Reasonix `flash`: exploration, routine implementation, low-cost long
  sessions, first pass.
- Reasonix `pro`: architecture, tricky debugging, final review,
  security-sensitive or higher-risk verification.
- `claude-code`: one-shot or resumable Claude Code analysis when external
  approval callbacks are not required.

Use `worker_plan_pro_review` before spending a Reasonix `pro` pass. Reserve
`pro` for architecture, tricky debugging, security-sensitive work, uncertain
`flash` results, and final review.

## Dispatch Rules

Codex owns architecture, task design, provider choice, permissions, final
review, and user communication. Workers execute bounded tasks; treat worker
output as a proposed patch, not accepted work.

Send compact task specs, not chat transcripts. Use `examples/task-spec.yaml`
for Full Marshal tasks. Require a short worker plan before edits unless the
task is read-only or Codex gave exact edits. Ask workers to return
`examples/worker-yield-summary.md` and run `examples/worker-self-review.md`.

Worker final output is capped by default. Expect only `changedFiles`,
`commands`, `verification`, `risks`, and `next`. Default cap is 1200 chars. Use
`--output-max-chars N` only when Codex truly needs a larger handoff, and
`--no-output-contract` only for diagnostics.

Approve only scoped, expected, non-destructive worker requests. Deny requests
that exceed scope, touch secrets, run destructive git commands, install
unrelated dependencies, or change unrelated files.

## MCP Use

Prefer provider-neutral `worker_*` tools. For long audits or broad repo work,
avoid `worker_ask` / `reasonix_ask`; use persistent sessions:

```text
worker_start_session(provider: "reasonix", id: "audit", approve: "manual", model: "flash")
worker_send_task(provider: "reasonix", id: "audit", taskId: "task", prompt: "<bounded task spec>")
worker_observe(provider: "reasonix", id: "audit", mode: "summary", maxChars: 4000)
worker_observe(provider: "reasonix", id: "audit", mode: "summary", since: 120, maxChars: 4000)
worker_summarize_session(provider: "reasonix", id: "audit", maxChars: 6000)
worker_metrics_report(provider: "reasonix", limit: 20, compact: true)
```

`worker_observe` defaults to summary. Use `summary`, `final`, or `permission`
with `maxChars`; use `events` only when compact state is insufficient. Every
observation returns a cursor; pass `since` next time to avoid re-reading old
event tails.

Use `worker_metrics_report(compact: true)` when deciding whether routing is
saving tokens or worker turns are verbose, slow, or weakly verified. When
editing token controls, run `npm run eval:tokens`.

For delegated work, prefer the merged token-firewall gate:

```text
worker_task_gate(action: "route", goal: "...", scope: "...", risk: "medium")
worker_task_gate(action: "create", goal: "...", scope: "...", risk: "medium")
worker_task_gate(action: "checkpoint", id: "task", step: "s1")
worker_task_gate(action: "verify", id: "task", status: "pass", session: "audit", turnId: "TURN_ID")
worker_task_gate(action: "finalize", id: "task")
worker_task_gate(action: "close-readonly", id: "task", status: "pass")
worker_task_gate(action: "tasks")
```

Use `worker_task_gate(batch: [...])` when checkpoint, verify, and finalize can
run in one ordered call. Use `worker_task_gate(action: "tasks")` before reading
task ledgers or worker logs for closeout hygiene. For read-only audits with
sufficient evidence, use `worker_task_gate(action: "close-readonly")` to mark
remaining steps done, record verification, finalize, and return a taskKey in one
compact packet.

If merged gate is unavailable, use equivalent individual tools:
`worker_route_decision`, `worker_create_task`, `worker_checkpoint_step`,
`worker_record_verification`, and `worker_finalize_task`.
