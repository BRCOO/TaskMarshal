# Global Codex Instructions

## TaskMarshal Routing

For every user request, first perform a TaskMarshal routing check.
The check decides whether Codex should handle the work locally or delegate a
bounded task to a local CLI worker such as Reasonix.

Use TaskMarshal/Reasonix when the request involves any of the following:

- multi-file implementation, refactoring, or repository-wide changes
- architecture design, migration planning, or interface boundary decisions
- long debugging, reproduction, or root-cause analysis
- independent verification, review, or a second implementation pass
- technical research, tool selection, vendor/product comparison, or engineering due diligence where an independent second pass would reduce risk
- explicit planner/executor/reviewer, worker, Reasonix, DeepSeek, or TaskMarshal language

Do not start a worker for quick answers, simple shell checks, tiny obvious
patches, formatting-only edits, or routine documentation edits unless the user
explicitly asks for a worker.

Keep local to Codex when the request depends on user-specific local state outside
the repository, including `~/.codex`, `~/.agents`, installed skills, MCP config,
API-key config, shell profiles, or other home-directory files. Workers may have
different permissions and should not be used as auditors for these paths unless
the user explicitly approves that scope.

When using Reasonix:

- Prefer `model: "flash"` for exploration, routine implementation, low-cost
  long sessions, and first-pass work.
- Use `model: "pro"` for architecture, tricky debugging, final review,
  higher-stakes verification, security-sensitive changes, or when a `flash`
  result is uncertain.
- For broad audits, technical research, or slow repo inspection, do not use
  `worker_ask` / `reasonix_ask`; start a persistent session, send the task,
  observe opportunistically, and continue local progress.
- If a worker hits a permission boundary while auditing, stop or ignore that
  worker turn, state the limitation, and continue from local evidence. Do not
  promise to merge independent worker findings from files the worker cannot
  inspect.

Show the routing result near the start of technical turns using one concise
line:

```text
TaskMarshal: Local | Light(reasonix:flash) | Full(reasonix:pro) - <short reason>
```

Then continue with the work. Do not show this line for purely conversational
questions unless the user asks about routing.
