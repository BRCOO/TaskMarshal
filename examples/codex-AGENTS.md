# Global Codex Instructions

## TaskMarshal Routing

For every user request, first perform a silent routing check for TaskMarshal.
The check decides whether Codex should handle the work locally or delegate a
bounded task to a local CLI worker such as Reasonix.

Use TaskMarshal/Reasonix when the request involves any of the following:

- multi-file implementation, refactoring, or repository-wide changes
- architecture design, migration planning, or interface boundary decisions
- long debugging, reproduction, or root-cause analysis
- independent verification, review, or a second implementation pass
- explicit planner/executor/reviewer, worker, Reasonix, DeepSeek, or TaskMarshal language

Do not start a worker for quick answers, simple shell checks, tiny obvious
patches, formatting-only edits, or routine documentation edits unless the user
explicitly asks for a worker.

When using Reasonix:

- Prefer `model: "flash"` for exploration, routine implementation, low-cost
  long sessions, and first-pass work.
- Use `model: "pro"` for architecture, tricky debugging, final review,
  higher-stakes verification, security-sensitive changes, or when a `flash`
  result is uncertain.

Keep this routing check silent unless delegation is chosen or the user asks how
the decision was made.
