# Contributing to Agent Coordinator

Thanks for helping improve Agent Coordinator.

## Before opening an issue

Search existing issues first. For bugs, include the command, operating system,
Node.js and Git versions, a minimal reproduction, and the complete error
output with secrets removed. For feature requests, explain the user problem
and the smallest useful outcome.

## Development

Requirements are Node.js 20.12 or newer and Git.

```sh
npm install
npm run check
```

Keep core planning and rendering independent from terminal prompts. Every
mutating operation needs a preview or check mode. Tests involving Git,
repositories, remotes, or worktrees must use isolated temporary fixtures; do
not run them against a real project.

## Pull requests

- Keep changes focused and explain the user-visible effect.
- Add or update tests for behavior changes.
- Update the README when commands or safety guarantees change.
- Do not include credentials, private repository data, generated local state,
  or unrelated formatting changes.
- Ensure `npm run check` passes before requesting review.

By contributing, you agree that your contributions are provided under the
Apache License 2.0.
