# Orchestration Guide

TaskMarshal is optimized for a lead/worker split:

- Codex owns planning, scope, permission decisions, final review, and user
  communication.
- Local workers such as Reasonix or Claude Code execute bounded tasks and
  return compact evidence.

The main token-saving rule is simple: do not use Codex as a transcript carrier.
Codex should send a compact `TaskSpec`, observe compact session state, and read
full logs only when debugging the worker itself.

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
```

Use full event observation only when compact state is not enough:

```text
worker_observe(provider: "reasonix", id: "audit", mode: "events", tail: 80)
```

## Yield Protocol

Workers should return `examples/worker-yield-summary.md`, not long prose. Codex
can then decide whether to inspect diffs, ask for a narrow redo, run tests, or
finish locally.

## Model Policy

- Use `flash` for exploration, routine implementation, long low-cost sessions,
  and first-pass work.
- Use `pro` for architecture review, tricky debugging, security-sensitive
  changes, final review, or when a `flash` result is uncertain.

The economical default is Codex plans, `flash` executes or audits, and `pro`
reviews only when risk justifies it.

