# Security Policy

TaskMarshal controls local CLI coding agents. Treat worker permissions and transcripts as sensitive.

## Supported Versions

The project is pre-1.0. Security fixes target the latest `main` branch unless a release branch exists.

## Reporting A Vulnerability

Please open a private GitHub security advisory or contact the maintainers through GitHub. Do not post working exploits, API keys, private transcripts, or local machine details in public issues.

## Secrets

TaskMarshal should never store provider API keys in the repository.

Expected local secret locations include provider-owned config files such as:

```text
~/.reasonix/config.json
```

Ignored local runtime paths include:

- `.env`
- `.reasonix/`
- `.reasonixctl/`
- `runs/`
- `sessions/`
- `transcripts/`
- `events/`
- `*.jsonl`

## Permission Gates

Use manual approval for worker sessions when Codex should review tool requests:

```bash
node reasonixctl.js start --id architect --dir /path/to/repo --approve manual
```

Approve only commands that match the task spec and are safe for the current repository state. Deny or cancel requests that touch secrets, alter git history, install unrelated dependencies, or exceed scope.
