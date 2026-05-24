# Contributing

Thanks for improving TaskMarshal.

## Development

```bash
npm install
npm run check
npm run mcp:smoke
```

Reasonix-specific integration checks require a local Reasonix installation and a DeepSeek API key in your own `~/.reasonix/config.json`. Do not commit local provider config, transcripts, sessions, or keys.

## Pull Requests

- Keep provider adapters scoped and provider-neutral tools stable.
- Prefer adding new `worker_*` behavior before provider-specific aliases.
- Add or update smoke tests for new MCP tool behavior.
- Keep README examples secret-free and copy-pasteable.
- Do not include private transcripts, `.env`, `.reasonix/`, or `.reasonixctl/`.

## Commit Hygiene

Before pushing:

```bash
npm run check
npm run mcp:smoke
git status --short
git grep -n -E "sk-[A-Za-z0-9_-]{20,}|api[_-]?key|token|secret|password" -- .
```

The grep can match documentation and source identifiers. Review the output rather than treating every match as a leak.
