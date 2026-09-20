# brave-cli-control implementation plan

## 1. Foundation

- Create Python 3.12 package layout, `pyproject.toml`, CLI entry point, typed errors, config TOML/env/CLI precedence, masked logging, exit codes.
- Acceptance: installable package exposes `brave-cli`; unit tests cover configuration, masking, and exit mapping.

## 2. Brave/CDP control

- Detect Brave on Windows, start persistent profile with CDP, connect to an existing CDP endpoint, list/open/navigate tabs, click/fill/screenshot/evaluate.
- Acceptance: local fake CDP tests pass; real Brave smoke test uses an isolated persistent profile and does not print secrets.

## 3. Safety policy

- Add domain allowlist, dry-run, risky-action confirmation, unsafe-JavaScript confirmation, and secret/cookie/token redaction.
- Acceptance: risky actions fail closed without confirmation; disallowed domains and unsafe scripts are blocked; logs contain no sensitive values.

## 4. Workflows and scripts

- Implement YAML workflows with bounded supported actions, PowerShell helpers, validation, and safe failure behavior.
- Acceptance: workflow unit/integration tests cover success, dry-run, policy denial, and malformed YAML.

## 5. Documentation and verification

- Add complete README, examples, unit/integration/local E2E tests, Ruff, mypy/pyright, and CI configuration.
- Acceptance: tests, lint, type-check, package build, and real Brave local smoke test produce recorded evidence.

## Security constraints

- Never capture or display passwords, cookies, tokens, or raw page secrets.
- Confirmation required for send, publish, purchase, delete, upload, dangerous download, account changes, and unsafe JavaScript.
- Preserve user Brave sessions through persistent profile paths; never overwrite existing profiles by default.
