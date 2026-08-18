<p align="center">
  <img
    src="./docs/assets/coordinator-hero.png"
    alt="Multiple Git repositories flowing through one coordinator into agent tooling and delivery workflows"
    width="100%"
  />
</p>

<h1 align="center">Agent Coordinator</h1>

<p align="center">
  <strong>One declarative workspace for multi-repository Git, coding agents, portable skills, and GitHub Actions delivery.</strong>
</p>

<p align="center">
  <a href="#quick-start">Quick start</a> ·
  <a href="#one-manifest-many-outputs">Manifest</a> ·
  <a href="#transparent-multi-repository-git">Git</a> ·
  <a href="#repository-scoped-agents-and-portable-skills">Agents</a> ·
  <a href="#coordinated-cicd">CI/CD</a> ·
  <a href="#command-reference">Commands</a>
</p>

Agent Coordinator turns a coordinator repository and its Git submodules into one
intentional workspace. Describe each repository once in `coordinator.yaml`, then
let Agent Coordinator preserve ordinary Git across every selected repository
while rendering the project agents expected by your coding tools, committed
skills, and coordinated GitHub Actions workflows.

> One manifest in. Tool-specific configuration out. Ordinary Git stays
> ordinary.

Agent Coordinator is currently an early-stage open-source CLI. Its core is
terminal-first: commands remain scriptable, while interactive setup and status
use a styled terminal interface built with
[Clack](https://bomb.sh/docs/clack/basics/getting-started/).

<p align="center">
  <img
    src="./docs/assets/terminal-demo.svg"
    alt="Agent Coordinator status dashboard showing repositories, agent tools, skills, Git runtime, and delivery routes"
    width="100%"
  />
</p>

## Why it exists

A product split across backend, frontend, infrastructure, and test repositories
usually accumulates several independent coordination layers:

- Git branches and gitlinks must agree.
- Coding tools need repository-specific agents and instructions.
- Skills need to be available without duplicating divergent copies.
- A delivery coordinator needs the exact child revisions represented by the
  root commit.

Agent Coordinator gives those layers one source of truth:

```text
coordinator.yaml
├── native Git + branch selection      → transparent multi-repository Git
├── optional local Compose             → one-file development orchestration
├── AGENTS.md + tool-specific agents   → repository ownership and delegation
├── .agents/skills + lockfile          → relative source links + pinned expectations
└── GitHub Actions workflows           → gitlink-aware deployment dispatch
```

Gitlinks remain the authoritative version lock. Agent Coordinator does not
flatten repositories or erase their independent histories.

## Quick start

### Requirements

- Node.js 20.12 or newer
- Git
- [GitHub CLI](https://cli.github.com/) authenticated with `gh auth login` for
  the GitHub repository picker and release updates
- For the Bitbucket Cloud picker, an Atlassian account email and
  [scoped API token](https://support.atlassian.com/bitbucket-cloud/docs/using-api-tokens/),
  supplied interactively or as `BITBUCKET_EMAIL` and
  `BITBUCKET_API_TOKEN`; the token needs `read:repository:bitbucket`, and the
  credentials are used only for discovery and are not written to the workspace

Agent Coordinator owns the complete contract, including the transparent Git
runtime. One package, one version, and one `coordinator` executable install and
update the workspace model, generated adapters, and ordinary-Git integration.
The system Git binary is never modified.

### Install from the current checkout

The current development distribution is installed from source:

```sh
cd ~/Developer/agent-coordinator
npm install
npm run check
npm link
```

Verify the executable:

```sh
command -v coordinator
coordinator --version
```

With GitHub CLI configured as Git's credential helper, a direct global
installation from the public repository is also supported:

```sh
gh auth setup-git
npm install --global \
  git+https://github.com/fedecardinali/agent-coordinator.git#v0.4.6
```

### Install the transparent Git runtime

Install or refresh Agent Coordinator's embedded Git runtime:

```sh
coordinator install
```

The release already contains a self-contained runtime. Installation copies it
to a stable path under `~/.local/share/agent-coordinator` and adds one managed
`git` shim ahead of the system Git on `PATH`. Outside a coordinator workspace,
that shim delegates directly to the real Git executable. Installation replaces
only a recognized Agent Coordinator shim (or its legacy predecessor); an
unmanaged executable is left untouched and reported as an error.

### Initialize a workspace

Create an empty coordinator directory and launch the interactive flow:

```sh
mkdir -p ~/Developer/acme-coordinator
cd ~/Developer/acme-coordinator
coordinator init
```

The wizard:

1. Selects one or both hosting providers, then existing repositories from a
   GitHub owner and/or Bitbucket Cloud workspace.
2. Assigns a stable role id and branch policy to each repository.
3. Selects the coding tools that should receive project agents.
4. Optionally discovers committed skills from the selected repositories.
5. Initializes the root Git repository, adds each repository and all of its
   nested submodules, writes the manifest, and synchronizes generated files.
6. Installs the embedded Git runtime and workspace integration, attaches
   policy-resolved child branches, and verifies the Git invariant, unless
   `--no-hooks` is selected.

Then inspect the workspace and commit the generated contract:

```sh
coordinator doctor
git add .
git commit -m "Initialize coordinated workspace"
```

`--no-hooks` is a configuration-only mode: it writes and validates the
manifest and submodules without installing the runtime or hooks, attaching
branches, or running the runtime check.

If a nested gitlink pins a commit that its remote no longer exposes, interactive
initialization stops before generating skills or hooks and offers only verified
repair candidates: the nearest previous reachable pin and the remote default
branch HEAD. Before applying anything, the wizard previews the exact SHA change.
With explicit approval it creates one local commit in the clean writable parent
repository, updates the coordinator gitlink, and retries initialization. It
never chooses a fallback silently and the repair operation itself never pushes.
A later ordinary coordinated `git push` can publish that local repair commit.

Resume an interrupted initialization without selecting the repositories again:

```sh
coordinator init . --resume
```

In a non-interactive terminal, add `--discover-skills` when that work should be
part of the resumed initialization. Automatic repair remains interactive
because creating a commit always requires explicit approval.

For automation or a non-interactive terminal, declare repositories explicitly:

```sh
coordinator init ~/Developer/acme-coordinator \
  --name acme \
  --repo backend=acme/api,services/api \
  --repo frontend=bitbucket:acme/web,apps/web \
  --tools codex,claude \
  --discover-skills
```

The legacy `owner/repository` shorthand remains GitHub-compatible. Use
`bitbucket:workspace/repository` for Bitbucket Cloud, or pass a complete SSH or
credential-free HTTPS clone URL for either host. Embedded URL credentials,
query parameters, and fragments are rejected; configure Git credentials
separately. A single manifest may contain repositories from both hosts;
coordinated CI/CD remains GitHub Actions-only, so deployment components must
reference GitHub repositories.

Preview the initialization contract without writing anything:

```sh
coordinator init ~/Developer/acme-coordinator \
  --name acme \
  --repo backend=acme/api \
  --dry-run
```

## One manifest, many outputs

`coordinator.yaml` is project-owned after initialization. Generated files point
back to it and should not be edited by hand.

```yaml
schemaVersion: 2
name: market-intel
remote: origin

repositories:
  - id: backend
    path: services/backend
    url: git@github.com:acme/market-intel-api.git
    branch:
      mode: mirror
      readOnly: false
    agent:
      description: Owns the Market Intel API and its contracts.
      instructions:
        - Keep database migrations backward compatible.
      verify:
        - npm test
      skills:
        - source: .agents/skills/api-contracts

  - id: frontend
    path: apps/frontend
    url: git@github.com:acme/market-intel-web.git
    branch:
      mode: mirror
      readOnly: false
    agent:
      verify:
        - npm run check

  - id: infra
    path: infrastructure
    url: git@github.com:acme/market-intel-infra.git
    branch:
      mode: fixed
      name: main
      readOnly: true

workspace:
  baseBranch: main
  mirrorActiveInLinkedWorktrees: true
  selection:
    backend:
      branch: $coordinator
      mode: active
    frontend:
      branch: $coordinator
      mode: active
    infra:
      branch: main
      mode: pinned

local:
  compose:
    projectDirectory: services/backend
    files:
      - services/backend/compose.yaml
    override: |
      services:
        app:
          ports: !override
            - '${BACKEND_PORT:-4000}:3000'

agents:
  tools:
    - codex
    - claude
    - cursor
    - opencode
  maxParallel: 4
  skillCollision: error

deployments:
  tokenSecret: SUBREPO_ACTIONS_TOKEN
  environments:
    staging:
      githubEnvironment: staging
      allowedBranches:
        - main
        - "feature/*"
      components:
        backend:
          repository: backend
          workflow: deploy-staging.yml
          state:
            provider: workflow-runs
          dispatchInputs:
            environment: staging
        frontend:
          repository: frontend
          workflow: deploy-staging.yml
          state:
            provider: github-deployment
            environment: staging
          dispatchInputs:
            environment: staging
```

Run one command after changing the manifest:

```sh
coordinator sync
```

Or verify generated state without changing files:

```sh
coordinator sync --check
```

### Generated contract

| Area | Generated output |
|---|---|
| Shared agent guidance | `AGENTS.md` |
| Codex | `.codex/config.toml`, `.codex/agents/*.toml` |
| Claude Code | `.claude/CLAUDE.md`, `.claude/agents/*.md`, `.claude/commands/<workspace>/*.md` |
| Cursor | `.cursor/agents/*.md` |
| OpenCode | `.opencode/agents/*.md` |
| Portable skills | `.agents/skills/*` relative links, `.coordinator/agents.lock.json` v2 |
| Delivery | `.coordinator/runtime/deployment-plan.mjs`, `.github/workflows/coordinator-deploy-*.yml` |

Delivery files are generated only when the manifest declares `deployments`.
The planner embeds the normalized deployment configuration derived from
`coordinator.yaml`; no second deployment manifest is generated or edited.
Synchronization removes the obsolete `.coordinator/deployments.json` only
when its ownership marker proves that Agent Coordinator generated it, and
preserves an unmanaged file at that path.
Tool-specific files are generated only for tools listed under `agents.tools`
and while `agents.manage` is not `false`.

Git configuration is not generated: schema version 2 is consumed directly from
`coordinator.yaml`. Synchronization removes an obsolete `.git-coordinator.json`
only when its ownership marker proves that Agent Coordinator generated it and
the workspace is already attached to the YAML-native runtime; unmanaged legacy
files are preserved.

Agent Coordinator marks every managed destination. It refuses to overwrite an
unmanaged file unless it is explicitly adopted with `--force`.

## Transparent multi-repository Git

Agent Coordinator's embedded runtime reads `coordinator.yaml` directly. Once
the machine runtime and workspace integration are installed, commands from the
coordinator root remain familiar:

```sh
git add .
git commit -m "Implement feature"
git pull
git push
git checkout main
git checkout -b feature/new-work
git checkout -b hotfix/urgent origin/main
git switch -c hotfix/urgent origin/main
git worktree add ../new-worktree
```

Agent Coordinator applies the operation to writable children according to
their branch policies, updates root gitlinks, and delegates unrelated Git
commands to the real Git executable. Outside a configured workspace, Git
behaves normally.

Coordinated branch creation accepts `git checkout -b <branch> [<start-point>]`
and `git switch -c <branch> [<start-point>]`. When a start-point is supplied,
the wrapper resolves it to a commit before changing anything, reads the
configuration and workspace selection from that revision, and creates each
child branch (or pinned detached checkout) at that revision's gitlink. The
workspace must be clean; `-B` and `-C` remain intentionally blocked.

### Branch policies

| Policy | Behavior |
|---|---|
| `mirror` | The child uses the same branch name as the coordinator. Writable by default. |
| `fixed` | The child always uses one named branch. Read-only by default. |
| `map` | Exact coordinator branches map to different child branches, with an optional `mirror` or `fixed` fallback. |
| `readOnly: true` | The child must remain clean and at the configured revision; coordinated add, commit, and push skip it. |

A mapped repository can be declared directly in the manifest:

```yaml
branch:
  mode: map
  branches:
    main: main
    feature/payments: feature/api-payments
  fallback:
    mode: mirror
  readOnly: false
```

When `workspace` is present, its `selection` contains exactly one entry for
every repository. That selection is versioned with each coordinator branch:
`active` repositories participate in coordinated writes, while `pinned`
repositories stay read-only at their gitlink. `$coordinator` resolves to the
current coordinator branch. Legacy schema version 1 manifests with an external
`workspaceManifest` remain readable during migration.

A pinned branch name describes the allowed local branch lineage; the gitlink
still records one exact commit. When interactive `git checkout -b` finds that a
pinned repository's local branch has advanced beyond its gitlink, it asks
whether to use the current local branch tip, fetch and pin the latest remote
branch, keep the historical gitlink detached, or cancel without changes. Local
advance never fetches: it switches the child to the existing local branch.
Latest fetches the configured remote, leaves the local branch untouched, and
detaches the child at the exact fetched commit. Both update choices stage the
gitlink for the next coordinator commit. For explicit noninteractive
automation, apply one choice to every divergent pin:

```sh
AGENT_COORDINATOR_PINNED_RESOLUTION=advance git checkout -b feature/example
AGENT_COORDINATOR_PINNED_RESOLUTION=latest git checkout -b feature/latest
AGENT_COORDINATOR_PINNED_RESOLUTION=detach git checkout -b feature/historical
```

Useful runtime commands are deliberately explicit:

```sh
coordinator git install   # refresh the embedded runtime and install workspace integration
coordinator git attach    # resolve and attach child branches
coordinator git check     # validate the Git invariant
coordinator git uninstall # remove only this workspace's integration
```

`coordinator install` and `coordinator uninstall` manage only the machine
integration. Cross-repository pushes cannot be atomic: Agent Coordinator
publishes writable children before the root coordinator and reports partial
progress if a later remote rejects its push.

## Local Docker Compose

An optional `local.compose` block keeps the coordinator-specific Compose
override in the same manifest. Base files and the project directory are safe
workspace-relative paths; the override is a literal Compose document, so tags
such as `!override` and environment interpolation remain untouched.

Forward any Compose arguments after the command name:

```sh
coordinator compose config
coordinator compose up -d --build
coordinator compose logs -f app
coordinator compose down
```

The CLI writes the override to a private temporary file, invokes Docker with
the declared base files in order, and removes the temporary file even when
Docker fails. No standalone Compose override is generated or tracked.

## Repository-scoped agents and portable skills

Agent Coordinator prepares coding tools; it does not execute or schedule their
agents.

For each repository, the generated agent:

- Has an explicit repository path and role.
- Is instructed not to edit siblings or the coordinator root.
- Reads root guidance and the child repository's closer `AGENTS.md` when one
  exists.
- Receives repository-specific instructions and verification commands from the
  manifest.
- Cannot create nested agents in the generated contract.

The selected tool remains responsible for deciding when and how to use those
agents.

### Source-direct skills

The canonical `.agents/skills/<name>` registry contains relative symbolic links
to skill directories inside the selected repositories or their initialized
nested submodules. Agent Coordinator resolves each source through the exact
commits pinned by the coordinator and nested gitlinks, verifies that the
checkout is clean and at those commits, and publishes a link only when its
target remains inside the workspace. Moving the complete workspace or creating
a coordinated worktree therefore does not turn the links into machine-specific
absolute paths.

`.coordinator/agents.lock.json` uses schema version 2. Each entry records the
canonical skill name, owning repository, repository-relative source, pinned
source commit, Git tree object, `relative-symlink` materialization mode, and the
expected relative link target. The lock is the auditable expected state; it is
not a copied snapshot of the source directory.

Interactive discovery recognizes committed skills under:

```text
.agents/skills/<skill-name>/SKILL.md
.agents/flows/<flow-name>/SKILL.md
```

Repositories may expose those directories through symbolic links into an
initialized nested submodule. Discovery follows only links that remain inside
the repository, stores the canonical committed source, and records whether the
logical export is a `skill` or a `flow`.

Every linked `SKILL.md` must declare a globally unique canonical kebab-case
`name` in its frontmatter. That name is also the registry directory name.
Source-direct links cannot rewrite frontmatter, so an explicit manifest `name`
is accepted only when it equals the canonical source name. Flows follow the
same rule and are not automatically prefixed with the repository id. If two
exports declare the same name, synchronization fails and one source must be
renamed. The legacy `skillCollision: namespace` value remains parseable for
manifest compatibility, but it cannot resolve a collision in source-direct
mode.

Because the registry points directly at the child checkout, edits made through
either path are immediately visible through the other. Those edits belong to
the child repository; the root symlink and lockfile do not change merely
because linked content became dirty. `coordinator agents check` and
`coordinator doctor` reject a dirty source, a checkout that moved away from its
gitlink, a changed link target, or a stale lock. Commit the source change in its
own repository, update the coordinated gitlink, and synchronize again to record
the new expected commit and tree.

Synchronize only agent and skill outputs:

```sh
coordinator agents sync
```

Verify them without writing:

```sh
coordinator agents check
```

The check output previews link creation, replacement, removal, adoption, and
copy migration without writing the workspace. A normal sync automatically
migrates an intact Agent Coordinator-managed schema-1 copy to a relative source
link and rewrites the lock as schema 2:

```sh
coordinator agents check
coordinator agents sync
```

If a managed copy was modified or replaced, or a desired registry destination
is unmanaged, synchronization preserves it and stops. Review the explicit
adoption preview before allowing replacement:

```sh
coordinator agents check --force
coordinator agents sync --force
```

`--force` authorizes only the previewed registry destination and lockfile
adoption. It does not bypass canonical-name, committed-tree, workspace-boundary,
dirty-source, or gitlink validation. Link publication uses atomic symlink
creation; managed-copy migration and generated-file publication retain
same-filesystem backups. A failed agent synchronization rolls links, lockfile,
and dependent agent files back before reporting the error.

## Coordinated CI/CD

Agent Coordinator generates root GitHub Actions workflows that use coordinator
gitlinks as the desired child revisions. It does not replace the deployment
workflow owned by each child repository.

For each configured environment, the generated planner:

1. Uses the deployment contract embedded from `coordinator.yaml`.
2. Reads the exact child SHA from the coordinator commit's gitlink.
3. Observes the latest child state from either workflow runs or GitHub
   Deployments.
4. Skips a revision that is already successfully deployed.
5. Avoids duplicating an active run for the desired revision and blocks when a
   different revision is active.
6. Dispatches the configured child workflow when a new run is required.
7. Verifies that GitHub started the child run at the exact desired SHA.

Generate or verify delivery files with:

```sh
coordinator ci sync
coordinator ci check
```

The generated root workflow is manually dispatched with `workflow_dispatch`.
It requires:

- A repository secret whose name matches `deployments.tokenSecret` and whose
  token can inspect and dispatch the child repositories.
- A dispatchable workflow in every referenced child repository.
- The desired child commit to be the head of the branch resolved by that
  repository's `mirror`, `fixed`, or `map` policy.
- GitHub Environments matching the declared root and optional child deployment
  state.

Branch allow-list patterns use path-aware globs: `*` matches one branch-name
segment and `**` may span `/` separators.

The coordinator validates and triggers child runs; it does not wait for their
eventual completion, provision secrets, or deploy directly to a cloud provider.

## Status and health

Run the dashboard at any point:

```sh
coordinator
coordinator status
```

Without a subcommand, an interactive terminal also offers refresh, sync, and
doctor actions. In a non-interactive terminal it prints status and exits.

`coordinator doctor` validates the complete local contract:

- Supported Node.js and available Git
- GitHub CLI installation and authentication status for repository discovery and updates
- Initialized child repositories
- Child revisions matching root gitlinks
- Native Git manifest compatibility and up-to-date agent, skill, and CI files
- Embedded Git runtime availability and invariants

```sh
coordinator doctor
```

GitHub CLI absence or missing authentication is reported as a warning. Bitbucket
credentials are intentionally not persisted or checked after interactive
discovery; cloning uses the user's configured SSH access. Broken repository,
generated-file, or Git-runtime invariants fail the command.

## Updates

Check the latest GitHub release:

```sh
coordinator update
```

Apply it explicitly:

```sh
coordinator update --apply
```

Updates require an authenticated GitHub CLI configured for Git credentials.
Applying an update also refreshes the managed machine Git runtime from that
same release; it does not rewrite workspace manifests or generated files. Run
`coordinator sync --check` afterward to see whether the new CLI would change
generated outputs.

If no release has been published yet, the command reports that no
release is available.

## Migrating an existing legacy workspace

Agent Coordinator understands `.git-coordinator.json` schema 1 and 2.
Migration is preview-first: without `--write`, the generated YAML is printed to
standard output.

```sh
cd ~/Developer/existing-coordinator
coordinator migrate
```

Write the manifest after reviewing it:

```sh
coordinator migrate --write
coordinator git install
coordinator migrate --write --adopt-git
coordinator sync
coordinator git attach
coordinator doctor
```

`--adopt-git` is deliberately granular: after the preview has been reviewed,
it removes the absorbed `.git-coordinator.json` and an external workspace
manifest only when that workspace selection was safely embedded. It never
grants permission to replace agent guides, skills, or CI files. Install the
YAML-native Git runtime after writing the YAML and before removing the legacy
adapter. A normal `coordinator sync` also preserves an owned adapter until that
runtime is active for the workspace.

Migration preserves the remote, repository paths, branch policies, and optional
versioned workspace selection. A valid schema version 1 workspace JSON is
embedded in schema version 2 YAML; an unreadable or incompatible pointer stays
as legacy schema version 1 instead of being discarded. Migration also detects
configured Codex, Claude, Cursor, and OpenCode directories when selecting
initial tools.

Migration does not infer deployment environments, agent instructions,
verification commands, skill exports, or custom mappings such as a
`qa-automation` role owning a `web-e2e` repository. It therefore writes
`agents.manage: false`: existing agent and skill files stay untouched while the
Git layer can be adopted safely.

After completing those mappings in `coordinator.yaml`, set
`agents.manage: true`, preview with `coordinator agents check --force` (exit 1
means generated changes are pending), and explicitly adopt only that surface
with `coordinator agents sync --force`. Future agent synchronizations no longer
need `--force`.

## Command reference

| Command | Purpose |
|---|---|
| `coordinator` | Initialize interactively when no manifest exists, or show status and interactive actions inside a workspace. |
| `coordinator init [directory]` | Initialize a workspace interactively or from `--repo` flags. Supports `--resume`, `--dry-run`, `--no-submodules`, `--no-hooks`, and `--force`. |
| `coordinator status` | Render the current workspace dashboard. |
| `coordinator doctor` | Validate tools, repositories, gitlinks, generated state, and Git runtime. |
| `coordinator sync` | Synchronize agents, skills, and optional CI/CD outputs; remove only an owned obsolete Git adapter. |
| `coordinator sync --check` | Exit non-zero when any generated output is stale. |
| `coordinator agents sync` | Synchronize tool-specific agents and relative source skill links; migrate intact managed copies. |
| `coordinator agents check` | Preview agent, skill-link, lockfile, and managed-copy migration changes without writing. |
| `coordinator ci sync` | Generate configured delivery files. |
| `coordinator ci check` | Check delivery files without writing. |
| `coordinator git install` | Refresh the embedded machine runtime, then install this workspace's Git integration. |
| `coordinator git uninstall` | Remove only this workspace's managed Git integration. |
| `coordinator git attach` | Attach policy-resolved repository branches. |
| `coordinator git check` | Run the coordinated Git invariant check. |
| `coordinator compose [args...]` | Run Docker Compose from `local.compose`, forwarding all remaining arguments. |
| `coordinator install` | Install or refresh the embedded machine-wide Git runtime. |
| `coordinator uninstall` | Remove only the managed machine-wide Git runtime. |
| `coordinator update [--apply]` | Check or explicitly apply the latest published release. |
| `coordinator migrate [directory] [--write] [--adopt-git]` | Preview or write a manifest from legacy Git configuration, optionally removing safely absorbed legacy files. |
| `coordinator demo` | Render deterministic sample status used by documentation assets. |

Global output flags work across commands:

```sh
coordinator --json status
coordinator --no-color doctor
```

`--json` is intended for scripts and CI. Errors use the same machine-readable
shape and a non-zero exit code.

## Safety model

Agent Coordinator is conservative around user-owned state:

- Mutating generators have a corresponding preview or check path.
- Unmanaged destinations are never silently overwritten.
- `--force` is an explicit adoption decision, not a default repair mechanism.
- Generated file paths and skill-registry ancestors reject workspace escapes
  and symbolic links; the managed skill entry itself is an expected relative
  symlink to a separately validated in-workspace source.
- Skill links are planned only from clean checkouts at coordinator-pinned Git
  trees. Later working-tree edits are visible immediately by design, while
  `agents check` and `doctor` report the source as dirty until it is committed
  and the gitlink and schema-2 lock are synchronized.
- Skill links use no-overwrite symlink creation; managed-copy migrations and
  generated files preserve same-filesystem backups for rollback and publish
  their ownership lock with the dependent agent files as one transaction.
- Secret values never belong in `coordinator.yaml` or its lockfiles; only the
  GitHub secret name is stored.
- Machine installation replaces or removes only recognized Agent Coordinator
  shims, including the legacy managed shim during migration.

## Non-goals

Agent Coordinator currently does **not**:

- Run agents, select models, schedule tasks, or maintain an agent queue.
- Create child GitHub or Bitbucket Cloud repositories; initialization selects existing ones.
- Replace child CI pipelines or deploy directly to Railway, ECS, Vercel, or
  another platform.
- Provision GitHub secrets or environment protection rules.
- Make independent Git remotes behave like an atomic transaction.
- Replace or modify the system Git binary.
- Provide a desktop or web GUI. The current interface is a scriptable CLI with
  interactive terminal prompts and a rendered status dashboard.
- Rewrite workspaces automatically when the CLI itself is updated.

These boundaries keep the coordinator portable across Git hosts, coding tools,
and deployment platforms while leaving execution to the system that already
owns it.

## Development

Install dependencies and run the complete verification contract:

```sh
npm install
npm run check
```

Useful development commands:

```sh
npm run dev -- --help
npm run dev -- demo
npm run typecheck
npm test
npm run compile
```

The CLI combines [Commander](https://github.com/tj/commander.js) for the
scriptable command surface, [Clack](https://github.com/bombshell-dev/clack) for
interactive prompts, [Zod](https://zod.dev/) for the manifest contract, and
[VHS](https://github.com/charmbracelet/vhs) for reproducible terminal demos.

Regenerate the deterministic SVG dashboard from the actual CLI output:

```sh
npm run demo:asset
```

The terminal recording source lives at `docs/demo.tape`. With
[VHS](https://github.com/charmbracelet/vhs) installed, it can render an animated
demo from the same stable command:

```sh
vhs docs/demo.tape
```

### Releasing

The package version and tag are one contract. After `npm run check`, create and
push `v<package-version>`. The tag workflow verifies the complete suite, builds
the installable archive, and creates or refreshes the public GitHub release.
`coordinator update` installs that exact validated tag rather than a moving
branch.

### Repository layout

```text
src/core/        manifest validation, file planning, errors, commands
src/workspace/   initialization, synchronization, legacy migration
src/git/         embedded transparent Git runtime and safe installer
src/agents/      project-agent renderers and relative source skill links
src/ci/          embedded deployment runtime and GitHub Actions generation
src/hosting/     Git hosting discovery adapters
src/status/      workspace inspection
src/doctor/      health checks
src/update/      published release checks and explicit updates
src/ui/          Clack prompts and deterministic dashboard rendering
templates/       generated deployment planner runtime
test/            current automated contracts
```

Keep core planning independent from terminal prompts. Tests that exercise Git,
repositories, remotes, or worktrees must use isolated temporary fixtures rather
than real projects.

## License

Agent Coordinator is available under the [Apache License 2.0](LICENSE).
The license permits use, modification, and distribution for commercial
purposes, including internal use by companies such as Salesforce, subject to
the license terms and required notices.
