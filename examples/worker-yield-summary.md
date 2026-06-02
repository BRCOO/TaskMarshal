# Worker Yield Summary

Use this format when handing work back to Codex. Keep final output under 1200
characters unless Codex explicitly asks for more.

changedFiles:
- path/to/file: short note

commands:
- command: pass | fail | skipped

verification:
- result: pass | fail | partial | not-run

risks:
- short residual risk or "none"

next:
- one recommended Codex action
