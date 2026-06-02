# TaskMarshal TODO

This file tracks the token-efficiency and orchestration-quality work for
TaskMarshal. The goal is to spend fewer Codex tokens while making local worker
delegation more controlled, verifiable, and reusable.

## Current Focus

- [x] Record the token-efficiency roadmap in the repository.
- [x] Move large delegation instructions out of the Codex Skill and into
  reusable docs/examples.
- [x] Add structured task-spec and worker-yield templates.
- [x] Add compact worker observation modes so Codex does not ingest full event
  logs by default.
- [x] Add a minimal MCP tool profile and compact tool-result text mode.
- [x] Add a merged task gate for route/create/checkpoint/verify/finalize.
- [x] Add incremental observe cursors, compact metrics, and batch gate calls.
- [x] Add a local eval suite for routing and task-gate behavior.
- [x] Update README/docs to explain the lean Codex + structured worker protocol.
- [x] Sync the installed local TaskMarshal skill after repo changes.
- [x] Run local verification.
- [x] Push verified changes to GitHub.

## P0 - Token-Saving Protocol

- [x] Add token-firewall task gates.
  - Acceptance: Codex can create, checkpoint, verify, and finalize a task using
    short control packets instead of long task specs or transcripts.
- [x] Keep `skills/taskmarshal/SKILL.md` as a small routing policy instead of a
  full operating manual.
  - Acceptance: the skill still chooses Local / Light / Full Marshal, but large
    templates live in docs or examples.
- [x] Add `examples/task-spec.yaml`.
  - Acceptance: a worker task can be described with goal, scope, allowed files,
    forbidden actions, acceptance criteria, verification, output format, and
    budget.
- [x] Add `examples/worker-yield-summary.md`.
  - Acceptance: worker output is short, diff-oriented, and easy for Codex to
    review without reading the full transcript.
- [x] Add `examples/worker-self-review.md`.
  - Acceptance: worker can run a final checklist before handing work back.

## P1 - MCP Token Controls

- [x] Extend `worker_observe` / `reasonix_observe` with compact modes.
  - Suggested modes: `events`, `summary`, `final`, `permission`.
  - Acceptance: default behavior remains compatible, but Codex can request a
    much smaller observation payload.
- [x] Add `maxChars` to observation tools.
  - Acceptance: long assistant text and large event tails are capped before
    entering Codex context.
- [x] Consider `worker_summarize_session`.
  - Acceptance: Codex can request an explicit compact session state without
    parsing JSONL event history.
- [x] Add `TASKMARSHAL_TOOL_PROFILE=minimal`.
  - Acceptance: token-sensitive installations can expose only core provider
    controls and the merged task gate.
- [x] Add `TASKMARSHAL_COMPACT_TOOL_TEXT=1`.
  - Acceptance: MCP `structuredContent` remains full while visible tool text is
    reduced to a one-line summary.
- [x] Add merged `worker_task_gate`.
  - Acceptance: Codex can route, create, checkpoint, verify, and finalize a
    task through one MCP tool in minimal profile.
- [x] Add incremental observation cursors.
  - Acceptance: `worker_observe` returns a cursor and accepts `since` to avoid
    replaying old event tails.
- [x] Add compact metrics mode.
  - Acceptance: `worker_metrics_report(compact: true)` returns aggregates,
    routing hints, and at most three recent records.
- [x] Add batch gate calls.
  - Acceptance: Codex can run ordered gate operations through one
    `worker_task_gate(batch: [...])` call.

## P2 - Worker Quality Gates

- [x] Add a plan-before-edit rule to the task spec.
  - Acceptance: for Full Marshal tasks, workers return a short plan before
    making file changes unless Codex explicitly skips the gate.
- [x] Add a diff-based yield protocol.
  - Acceptance: every worker handoff names changed files, commands run, test
    results, risks, and next action.
- [x] Add a second-pass review path using `pro`.
  - Acceptance: `flash` can implement or explore; `pro` can audit tricky final
    changes when risk justifies the extra cost.

## P3 - Provider-Neutral Cleanup

- [x] Make `worker_*` the primary documented API.
  - Acceptance: Reasonix compatibility aliases remain available, but examples
    prefer provider-neutral tools.
- [x] Add a provider capability summary in docs.
  - Acceptance: users can see which providers support persistent sessions,
    observation, manual approval, cancellation, and model selection.
- [x] Consider a config flag to hide compatibility aliases in future.
  - Acceptance: token-sensitive installations can reduce the exposed MCP tool
    list.
- [x] Rename `reasonixctl.js` to a provider-neutral CLI with a compatibility
  shim.
  - Suggested path: add `taskmarshalctl.js`, keep `reasonixctl.js` as a shim,
    then migrate docs and state dirs in a later release.

## P4 - Metrics And Feedback

- [x] Track lightweight task metrics.
  - Suggested fields: provider, model, mode, elapsed time, approval count,
    files changed, verification result, redo count.
- [x] Record task-gate verification into metrics.
  - Acceptance: `worker_metrics_report` shows recent pass/fail/skip task-gate
    evidence without reading task ledgers or transcripts.
- [ ] Use metrics to tune routing.
  - Acceptance: future routing can prefer Local, `flash`, or `pro` based on
    measured outcomes rather than only static rules.
- [x] Add a compact cross-session metrics report.
  - Acceptance: Codex can inspect recent turn cost and quality signals without
    loading raw event logs or transcripts.
- [x] Add a local eval suite.
  - Acceptance: `npm run eval` verifies representative local/flash/pro routing
    and task-gate finalization.
