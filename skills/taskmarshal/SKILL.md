---
name: taskmarshal
description: >
  Autonomous routing policy for deciding whether Codex should delegate coding
  work to local CLI agent workers through TaskMarshal. Use whenever the user
  mentions TaskMarshal, Reasonix, DeepSeek, Gemini CLI, Claude Code, local AI
  workers, agent delegation, subagents, multi-agent coding, planner/executor,
  architect/implementer/reviewer workflows, or asks Codex to design, assign,
  supervise, or validate work done by another CLI agent. Also use for coding
  tasks that appear to span multiple files, modules, packages, architectural
  layers, long-running debugging, repo exploration, implementation plus review,
  or independent verification. After loading, score the task and choose Local,
  Light, or Full Marshal mode; loading this skill does not mean a worker must be
  started.
---

# TaskMarshal

TaskMarshal lets Codex act as planner, dispatcher, permission gate, and final reviewer while local CLI agents act as bounded execution workers.

Current provider:

- `reasonix`: DeepSeek/Reasonix through `reasonixctl` and `taskmarshal-mcp`.
- `claude-code`: Claude Code through `claude -p --output-format json`.

Future providers may include Gemini CLI, Codex CLI, or other local agents. Keep workflow rules provider-neutral.

## Activation Gate

Before starting any worker, decide whether delegation is worth the overhead.

Do not delegate by default for:

- quick Q&A or explanation
- simple terminal checks
- small one-file edits
- formatting, renaming, typo fixes, or routine docs
- bugs where Codex can inspect, patch, and verify faster locally

Use TaskMarshal when at least one is true:

- the user explicitly asks for TaskMarshal, Reasonix, DeepSeek, Gemini CLI, Claude Code, worker mode, or planner/executor flow
- the task spans several files, modules, packages, or architectural layers
- the task needs independent implementation after Codex designs the approach
- the task benefits from a second pass, long-running exploration, reproduction, or separate verification
- Codex needs to keep architecture decisions while another agent does bounded execution

If unsure, load this routing policy and make an explicit Local, Light, or Full
Marshal choice. Delegation should buy real leverage, but a short read-only
worker pass is acceptable when independent exploration or verification could
reduce risk.

## Delegation Score

When this skill is loaded, score the task before starting a worker:

- `+2` user explicitly asks for TaskMarshal, a named provider, worker mode, planner/executor, or architect/reviewer flow
- `+2` task spans three or more files, packages, or architectural layers
- `+2` task needs long repo exploration, reproduction, or debugging
- `+1` independent implementation or verification would reduce risk
- `+1` task can run in parallel while Codex inspects or designs non-overlapping work
- `-2` task is a quick answer, simple command, or obvious local edit
- `-2` task is a tiny one-file patch with clear implementation
- `-1` the worker would need broad permissions before Codex has scoped the work

Decision:

- score `<= 0`: Local Mode. Do not start a worker.
- score `1-2`: Light Mode if the user asked for a worker, the task mentions delegation patterns, or a second pass is genuinely useful.
- score `>= 3`: Full Marshal Mode is appropriate.

Never tell the user about the numeric score unless it helps explain a routing decision.

## Roles

- Codex owns architecture, task design, provider choice, scope control, safety decisions, final review, and user communication.
- Workers execute bounded tasks. They may analyze, edit, run commands, and report results only within Codex's task spec.
- Do not let workers make final product, architecture, security, payment, auth, migration, or release decisions.

## Workflow Modes

Choose the smallest mode that fits.

**Local Mode:** Codex handles simple work directly. Do not start a worker.

**Light Mode:** For explicit user requests to use a worker on a small task. Send one concise bounded prompt, observe once or twice, then review locally.

**Full Marshal Mode:** For complex tasks. Codex inspects first, writes a task spec, dispatches a worker, gates permissions, reviews diffs, runs tests, and accepts or rejects the work.

## Provider Choice

- Default to `reasonix` for supervised execution with external permission gating.
- Use `claude-code` for Claude Code one-shot analysis or resumable logical sessions when external permission approval is not required.
- Prefer providers based on explicit user request first, then task fit.
- If a requested provider is not implemented, say so briefly and use the best available provider only if it still fits the user's goal.

## Dispatch Loop

1. Inspect the repository enough to understand the task and current user changes.
2. Create a short task spec for the worker:
   - goal
   - provider
   - working directory
   - allowed files or modules
   - forbidden actions
   - expected deliverables
   - acceptance criteria
   - verification commands
3. Start or reuse a worker session with manual approval when possible.
4. Send one bounded task at a time. Prefer read-only analysis first for unknown code.
5. Observe until the worker finishes, gets stuck, or asks for permission.
6. Approve only commands or edits that match the task spec and are safe for the repo state.
7. Deny or cancel requests that exceed scope, touch secrets, perform destructive git commands, install unrelated dependencies, or change unrelated files.
8. Review the resulting diff yourself. Run appropriate tests or checks locally.
9. Accept, request a narrow redo, or finish the work yourself.

## Task Prompt Template

```text
You are the execution worker. Codex is the architect and final reviewer.

Goal:
<one concrete outcome>

Scope:
- Workdir: <absolute path>
- Allowed files/modules: <list>
- Do not touch: <list>

Rules:
- Keep changes minimal and consistent with existing patterns.
- Do not make architecture decisions beyond this task.
- Do not run destructive git commands.
- Ask before installing dependencies or changing configuration.
- Report exactly what changed and how you verified it.

Acceptance criteria:
- <testable condition>
- <testable condition>

Verification:
- Run: <commands, or say read-only if none>
```

## Review Rules

- Treat worker output as a proposed patch, not as accepted work.
- Read changed files before finalizing.
- Prefer focused verification over broad, slow checks unless risk justifies it.
- If a worker made unrelated changes, preserve user changes but revert or repair only the worker's unrelated edits when clearly attributable and safe.
- Summarize the final outcome to the user in Codex's voice, including tests run and any residual risk.

## MCP Tool Use

If `taskmarshal-mcp` tools are available, prefer:

- `worker_list_providers` to inspect available providers.
- `worker_doctor` before first use in a session.
- `worker_start_session` with `provider: "reasonix"` and `approve: "manual"` for persistent work.
- `worker_start_session` with `provider: "claude-code"` and `approve: "cancel"` for Claude Code plan-mode sessions.
- `worker_send_task` for bounded prompts.
- `worker_observe` while work is running.
- `worker_approve` only for expected, scoped permission requests.
- `worker_deny` or `worker_cancel` for unsafe or out-of-scope requests.
- `worker_stop` when the worker session is no longer needed.
