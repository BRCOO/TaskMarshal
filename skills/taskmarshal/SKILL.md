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
reviewer while local CLI agents act as bounded execution workers.

Keep this skill as a lean routing policy. Detailed task specs, yield summaries,
and orchestration guidance live in the repository examples/docs:

- `examples/task-spec.yaml`
- `examples/worker-yield-summary.md`
- `examples/worker-self-review.md`
- `docs/ORCHESTRATION_GUIDE.md`

## Routing Check

Before starting a worker, decide whether delegation is worth the overhead.

Do not delegate by default for quick Q&A, simple terminal checks, tiny
one-file patches, formatting-only edits, routine docs, or short lookups Codex
can verify directly.

Use TaskMarshal when at least one is true:

- user explicitly asks for TaskMarshal, Reasonix, DeepSeek, Claude Code,
  workers, subagents, or planner/executor/reviewer flow
- task spans multiple files, modules, packages, or architecture layers
- task needs long exploration, reproduction, debugging, or independent review
- task is technical research, tool selection, product comparison, or
  engineering due diligence where a second pass reduces risk
- Codex should keep architecture decisions while a worker performs bounded
  execution

## Delegation Score

Score the task before starting a worker:

- `+2` explicit worker/TaskMarshal/provider/planner-executor request
- `+2` three or more files, packages, or architecture layers
- `+2` long repo exploration, reproduction, or debugging
- `+2` technical research or tool/product comparison with multiple candidates
- `+1` independent implementation or verification would reduce risk
- `+1` worker can run in parallel with local Codex work
- `-2` quick answer, simple command, or obvious local edit
- `-2` simple lookup or short research answer Codex can verify directly
- `-2` tiny one-file patch with clear implementation
- `-1` worker would need broad permissions before Codex scopes the work

Decision:

- score `<= 0`: Local Mode. Do not start a worker.
- score `1-2`: Light Mode if a second pass is genuinely useful.
- score `>= 3`: Full Marshal Mode.

Do not show the numeric score unless it helps explain a decision.

## Modes

- **Local Mode:** Codex handles the task directly.
- **Light Mode:** one bounded worker prompt, then Codex reviews.
- **Full Marshal Mode:** Codex inspects, writes a compact task spec, dispatches
  a worker, gates permissions, reviews diffs, verifies, and accepts or rejects.
- **Async Audit Mode:** for long read-only audits or broad research. Start a
  persistent session, send the task, observe opportunistically, and keep local
  work moving.

## Provider Choice

- Default to `reasonix` when external permission gating and event observation
  matter.
- Reasonix `flash`: exploration, routine implementation, low-cost long
  sessions, first pass.
- Reasonix `pro`: architecture, tricky debugging, final review,
  security-sensitive or higher-risk verification.
- `claude-code`: one-shot or resumable Claude Code analysis when external
  approval callbacks are not required.

## Dispatch Rules

- Codex owns architecture, task design, provider choice, permissions, final
  review, and user communication.
- Workers execute bounded tasks. Treat worker output as a proposed patch, not
  accepted work.
- Send compact task specs instead of chat transcripts. Use
  `examples/task-spec.yaml` for Full Marshal tasks.
- Require a short worker plan before edits on Full Marshal tasks unless the
  task is read-only or Codex gave exact edits.
- Ask workers to return `examples/worker-yield-summary.md` and run
  `examples/worker-self-review.md` before handoff.

## MCP Use

Prefer provider-neutral tools:

- `worker_list_providers`
- `worker_doctor`
- `worker_start_session`
- `worker_send_task`
- `worker_observe`
- `worker_approve`
- `worker_deny`
- `worker_cancel`
- `worker_stop`

For long audits or broad repo work, avoid `worker_ask` / `reasonix_ask`.
Use persistent sessions:

```text
worker_start_session(provider: "reasonix", id: "audit", approve: "manual", model: "flash")
worker_send_task(provider: "reasonix", id: "audit", prompt: "<bounded task spec>")
worker_observe(provider: "reasonix", id: "audit", mode: "summary", maxChars: 4000)
```

Use `worker_observe(mode: "events")` only when compact summary/final/permission
views are not enough.

Approve only scoped, expected, non-destructive worker requests. Deny or cancel
requests that exceed scope, touch secrets, perform destructive git commands,
install unrelated dependencies, or change unrelated files.
