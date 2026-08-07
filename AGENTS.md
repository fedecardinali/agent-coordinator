# Agent Coordinator Development Guide

## Scope

This repository owns the declarative workspace model, terminal interface,
agent/skill adapters, CI/CD generators, and the embedded transparent Git
runtime installed by Agent Coordinator.

## Architecture

- Keep core planning and rendering independent from terminal prompts.
- Interactive commands use Clack only at the application boundary.
- Every mutating operation must support a preview or check mode.
- Generated files must identify Agent Coordinator as their owner.
- Tool-specific agent files are renderings of one neutral repository role.
- The transparent Git wrapper is an internal runtime of the same package and
  release; it must remain lightweight and delegate uncoordinated commands to
  the real Git executable.

## Safety

- Never test repository creation, commits, pushes, or worktrees against a real
  project. Use temporary repositories and local bare remotes.
- Never overwrite an unmanaged file silently.
- Publish skills only as relative links to clean, gitlink-pinned source trees;
  never copy working-tree skill files or follow a source link outside the
  coordinator workspace.
- Preserve schema-1 skill locks long enough to migrate intact managed copies;
  modified or unmanaged registry entries require an explicit forced preview
  and sync.
- Never store tokens or secret values in the workspace manifest or lockfile.
- Machine installation may replace only recognized Agent Coordinator or legacy
  Git Coordinator wrappers, and workspace reinstall must preserve unrelated
  pre-existing hooks.
- Preserve `.git-coordinator.json` schema 1 and 2 migration compatibility.

## Verification

Run `npm run check`. Integration tests must use isolated temporary homes,
repositories, and executable directories.
