# SkillOpt Integration

TaskMarshal uses [microsoft/SkillOpt](https://github.com/microsoft/SkillOpt) as
an offline optimization method for the Codex Skill, not as a runtime dependency.
The runtime path stays small: Codex loads `skills/taskmarshal/SKILL.md`, then
uses TaskMarshal MCP tools only when routing says delegation is worth it.

## Goal

Use SkillOpt-style candidate generation to improve the TaskMarshal routing
skill while preserving two constraints:

- reduce Codex input and output tokens
- keep or improve routing quality and worker verification discipline

The accepted artifact is still a compact `SKILL.md`. No SkillOpt package,
rollout transcript, API key, or training output is required by the MCP server.

## Operating Model

1. Collect representative routing and orchestration examples.
2. Let SkillOpt or a human propose a candidate `SKILL.md`.
3. Run `npm run eval:skillopt -- --candidate PATH`.
4. Run the normal TaskMarshal regressions.
5. Replace `skills/taskmarshal/SKILL.md` only if every gate passes.

The local gate is deterministic and does not call external models. It checks
that a candidate remains short enough, keeps required TaskMarshal policies, does
not contain secret-shaped text, and still preserves the expected route behavior
for the fixture cases in `examples/skillopt/taskmarshal-routing-cases.jsonl`.

## Candidate Gate

Default command:

```bash
npm run eval:skillopt
```

Evaluate a candidate produced by SkillOpt:

```bash
npm run eval:skillopt -- --candidate runs/skillopt/best_skill.md
```

Useful options:

```bash
node scripts/skillopt-gate.js \
  --candidate runs/skillopt/best_skill.md \
  --baseline skills/taskmarshal/SKILL.md \
  --cases examples/skillopt/taskmarshal-routing-cases.jsonl \
  --max-chars 9500 \
  --max-growth 0.05
```

The default character budget is intentionally close to the current skill size.
This prevents optimization runs from expanding the Skill and quietly increasing
Codex input tokens. Lower `--max-chars` after the Skill has been compressed.

## Acceptance Checklist

A candidate skill is acceptable only when all of these pass:

```bash
npm run eval:skillopt -- --candidate PATH
npm run check
npm run eval
npm run eval:tokens
npm run eval:quality
npm run eval:codex-ab
node scripts/mcp-smoke.js --profile=ultra-minimal --compact-text
```

For candidate-only experiments, keep generated files under `runs/skillopt/`.
That path is ignored by git. Do not commit rollout logs, transcripts, local
configs, or API keys.

## Data Format

Routing cases are JSONL:

```json
{
  "id": "logs-ledgers-local",
  "goal": "inspect .reasonixctl session logs and .taskmarshal task ledgers",
  "scope": ".reasonixctl,.taskmarshal",
  "risk": "low",
  "files": 3,
  "expectedRoute": "local",
  "mustContainInSkill": [
    "worker_task_gate(action: \"tasks\"",
    "worker_task_gate(action: \"close-readonly\""
  ]
}
```

`expectedRoute` is validated through `taskmarshalctl route`. `mustContainInSkill`
protects policies that are enforced by Codex's loaded skill rather than the CLI
router itself, such as not asking workers to inspect home-directory state.

## SkillOpt Usage

SkillOpt can be installed and run outside TaskMarshal according to its upstream
README. Keep its environment and model credentials local. A typical workflow is:

```bash
python -m venv .venv-skillopt
. .venv-skillopt/bin/activate
pip install skillopt
# Run SkillOpt experiments in runs/skillopt/ using local/private credentials.
npm run eval:skillopt -- --candidate runs/skillopt/best_skill.md
```

TaskMarshal does not wrap the upstream SkillOpt CLI because its public API and
benchmark layout can evolve. The stable integration point is the candidate gate:
any optimizer can emit a candidate skill file, and TaskMarshal decides whether
that file is safe to accept.

## What Not To Do

- Do not expose SkillOpt as an MCP runtime tool.
- Do not add SkillOpt rollout logs to Codex context.
- Do not commit `runs/skillopt/`, `.venv-skillopt/`, API keys, or transcripts.
- Do not accept a candidate that improves one benchmark by expanding the skill
  or dropping local-only boundaries.
