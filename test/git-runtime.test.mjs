import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parse, stringify } from "yaml";

const REAL_GIT =
  process.env.GIT_COORDINATOR_REAL_GIT ||
  process.env.COORDINATED_GIT_REAL ||
  "/usr/bin/git";
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const coordinatedGit = path.resolve(
  scriptDirectory,
  "../src/git/runtime/git-wrapper.mjs",
);
const coordinatorCli = path.resolve(scriptDirectory, "../dist/cli.js");
const configuredInstalledWrapper =
  process.env.AGENT_COORDINATOR_GIT_RUNTIME_UNDER_TEST ||
  process.env.GIT_COORDINATOR_UNDER_TEST ||
  process.env.COORDINATED_GIT_UNDER_TEST;
const installedWrapper = configuredInstalledWrapper
  ? path.resolve(configuredInstalledWrapper)
  : null;

function wrapperInvocation(argumentsList) {
  return installedWrapper
    ? { command: installedWrapper, argumentsList }
    : { command: process.execPath, argumentsList: [coordinatedGit, ...argumentsList] };
}

function run(command, argumentsList, options = {}) {
  const result = spawnSync(command, argumentsList, {
    cwd: options.cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_ALLOW_PROTOCOL: "file",
      ...options.env,
    },
    stdio: options.inherit ? "inherit" : ["ignore", "pipe", "pipe"],
  });

  if (result.error) throw result.error;
  if (result.status !== 0 && !options.allowFailure) {
    assert.fail(
      `${command} ${argumentsList.join(" ")} failed (${result.status})\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  }
  return result;
}

function git(repository, ...argumentsList) {
  return run(REAL_GIT, ["-C", repository, ...argumentsList]);
}

function gitText(repository, ...argumentsList) {
  return git(repository, ...argumentsList).stdout.trim();
}

function configureIdentity(repository) {
  git(repository, "config", "user.name", "Coordinated Git Test");
  git(repository, "config", "user.email", "coordinated-git@example.test");
}

function write(repository, relativePath, contents) {
  const destination = path.join(repository, relativePath);
  mkdirSync(path.dirname(destination), { recursive: true });
  writeFileSync(destination, contents);
}

function createChildRemote(rootDirectory, name) {
  const remote = path.join(rootDirectory, `${name}.git`);
  const seed = path.join(rootDirectory, `${name}-seed`);
  run(REAL_GIT, ["init", "--bare", "--quiet", remote]);
  run(REAL_GIT, ["init", "--quiet", "-b", "main", seed]);
  configureIdentity(seed);
  write(seed, "README.md", `${name}\n`);
  git(seed, "add", ".");
  git(seed, "commit", "--quiet", "-m", "initial");
  git(seed, "remote", "add", "origin", remote);
  git(seed, "push", "--quiet", "-u", "origin", "main");
  return remote;
}

function createFixture(configuration = null, options = {}) {
  const temporaryDirectory = mkdtempSync(
    path.join(os.tmpdir(), "git-coordinator-"),
  );
  const backendRemote = createChildRemote(temporaryDirectory, "backend");
  const frontendRemote = createChildRemote(temporaryDirectory, "frontend");
  const coordinatorRemote = path.join(temporaryDirectory, "coordinator.git");
  const coordinator = path.join(temporaryDirectory, "coordinator");
  const agentCoordinatorHome = path.join(
    temporaryDirectory,
    "agent-coordinator-home",
  );
  const gitBinDirectory = path.join(temporaryDirectory, "bin");
  mkdirSync(gitBinDirectory);
  const runtimeEnvironment = {
    AGENT_COORDINATOR_HOME: agentCoordinatorHome,
    AGENT_COORDINATOR_GIT_BIN_DIR: gitBinDirectory,
    GIT_COORDINATOR_REAL_GIT: REAL_GIT,
    PATH: `${gitBinDirectory}${path.delimiter}/usr/bin${path.delimiter}/bin`,
  };

  run(REAL_GIT, ["init", "--bare", "--quiet", coordinatorRemote]);
  run(REAL_GIT, ["init", "--quiet", "-b", "main", coordinator]);
  configureIdentity(coordinator);

  const effectiveConfiguration =
    configuration ?? {
        schemaVersion: 1,
        remote: "origin",
        repositories: [
          { id: "backend", path: "apps/backend" },
          { id: "frontend", path: "apps/frontend" },
        ],
      };
  if (options.format === "yaml") {
    write(
      coordinator,
      "coordinator.yaml",
      `# Project-owned coordinator manifest.\n${stringify(effectiveConfiguration)}`,
    );
  } else {
    write(
      coordinator,
      ".git-coordinator.json",
      `${JSON.stringify(effectiveConfiguration, null, 2)}\n`,
    );
  }
  if (configuration?.workspaceManifest) {
    write(
      coordinator,
      configuration.workspaceManifest.path,
      `${JSON.stringify(
        {
          schemaVersion: 1,
          baseBranch: "main",
          repositories: {
            backend: {
              path: "apps/backend",
              branch: "main",
              mode: "active",
            },
            frontend: {
              path: "apps/frontend",
              branch: "main",
              mode: "active",
            },
          },
        },
        null,
        2,
      )}\n`,
    );
  }

  git(
    coordinator,
    "-c",
    "protocol.file.allow=always",
    "submodule",
    "add",
    "--quiet",
    "-b",
    "main",
    backendRemote,
    "apps/backend",
  );
  git(
    coordinator,
    "-c",
    "protocol.file.allow=always",
    "submodule",
    "add",
    "--quiet",
    "-b",
    "main",
    frontendRemote,
    "apps/frontend",
  );
  configureIdentity(path.join(coordinator, "apps/backend"));
  configureIdentity(path.join(coordinator, "apps/frontend"));
  git(coordinator, "add", ".");
  git(coordinator, "commit", "--quiet", "-m", "initial");
  git(coordinator, "remote", "add", "origin", coordinatorRemote);
  git(coordinator, "push", "--quiet", "-u", "origin", "main");

  return {
    backend: path.join(coordinator, "apps/backend"),
    backendRemote,
    coordinator,
    coordinatorRemote,
    frontend: path.join(coordinator, "apps/frontend"),
    frontendRemote,
    gitBinDirectory,
    runtimeEnvironment,
    temporaryDirectory,
  };
}

function advanceRemote(fixture, remote, branchName, label) {
  const clone = path.join(fixture.temporaryDirectory, `${label}-external`);
  run(REAL_GIT, [
    "clone",
    "--quiet",
    "--branch",
    branchName,
    remote,
    clone,
  ]);
  configureIdentity(clone);
  write(clone, `${label}.txt`, `${label}\n`);
  git(clone, "add", ".");
  git(clone, "commit", "--quiet", "-m", `advance ${label}`);
  git(clone, "push", "--quiet", "origin", branchName);
  return revision(clone);
}

function coordinated(repository, ...argumentsList) {
  const invocation = wrapperInvocation(argumentsList);
  return run(invocation.command, invocation.argumentsList, {
    cwd: repository,
  });
}

function coordinatedWithEnvironment(repository, env, ...argumentsList) {
  const invocation = wrapperInvocation(argumentsList);
  return run(invocation.command, invocation.argumentsList, {
    cwd: repository,
    env,
  });
}

function coordinatedAllowFailure(repository, ...argumentsList) {
  const invocation = wrapperInvocation(argumentsList);
  return run(invocation.command, invocation.argumentsList, {
    allowFailure: true,
    cwd: repository,
  });
}

function coordinatedAllowFailureWithEnvironment(
  repository,
  env,
  ...argumentsList
) {
  const invocation = wrapperInvocation(argumentsList);
  return run(invocation.command, invocation.argumentsList, {
    allowFailure: true,
    cwd: repository,
    env,
  });
}

function branch(repository) {
  return gitText(repository, "branch", "--show-current");
}

function revision(repository) {
  return gitText(repository, "rev-parse", "HEAD");
}

function installWorkspaceHooks(fixture) {
  run(process.execPath, [coordinatorCli, "git", "install"], {
    cwd: fixture.coordinator,
    env: fixture.runtimeEnvironment,
  });
}

function hookMode(repository) {
  return gitText(
    repository,
    "config",
    "--local",
    "--get",
    "gitCoordinator.hookMode",
  );
}

function mixedPolicyConfiguration(backendBranch = { mode: "mirror" }) {
  return {
    schemaVersion: 2,
    remote: "origin",
    repositories: [
      {
        id: "backend",
        path: "apps/backend",
        branch: backendBranch,
      },
      {
        id: "frontend",
        path: "apps/frontend",
        branch: {
          mode: "fixed",
          name: "main",
        },
      },
    ],
  };
}

function manifestPolicyConfiguration() {
  return {
    schemaVersion: 2,
    remote: "origin",
    workspaceManifest: {
      path: "workspace.json",
      coordinatorToken: "$coordinator",
      mirrorActiveInLinkedWorktrees: true,
    },
    repositories: [
      {
        id: "backend",
        path: "apps/backend",
        branch: {
          mode: "mirror",
        },
      },
      {
        id: "frontend",
        path: "apps/frontend",
        branch: {
          mode: "fixed",
          name: "main",
        },
      },
    ],
  };
}

function inlineWorkspaceConfiguration() {
  return {
    schemaVersion: 2,
    name: "test-coordinator",
    remote: "origin",
    repositories: [
      {
        id: "backend",
        path: "apps/backend",
        branch: { mode: "mirror", readOnly: false },
      },
      {
        id: "frontend",
        path: "apps/frontend",
        branch: { mode: "fixed", name: "main", readOnly: true },
      },
    ],
    workspace: {
      baseBranch: "main",
      coordinatorToken: "$coordinator",
      mirrorActiveInLinkedWorktrees: true,
      selection: {
        backend: { branch: "$coordinator", mode: "active" },
        frontend: { branch: "$coordinator", mode: "active" },
      },
    },
    local: {
      compose: {
        projectDirectory: "apps/backend",
        files: ["apps/backend/docker-compose.yml"],
        override: "services:\n  app:\n    ports: !override\n      - '4100:3000'\n",
      },
    },
  };
}

function readCoordinatorYaml(fixture) {
  return parse(
    readFileSync(path.join(fixture.coordinator, "coordinator.yaml"), "utf8"),
  );
}

function writeCoordinatorYaml(fixture, manifest) {
  writeFileSync(
    path.join(fixture.coordinator, "coordinator.yaml"),
    stringify(manifest),
  );
}

function createStaleLinkedSnapshot(fixture) {
  const manifestPath = path.join(fixture.coordinator, "workspace.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.repositories.frontend.mode = "pinned";
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  git(fixture.coordinator, "add", "workspace.json");
  git(fixture.coordinator, "commit", "--quiet", "-m", "pin frontend");
  git(fixture.coordinator, "push", "--quiet", "origin", "main");

  const staleRevision = revision(fixture.coordinator);
  const worktree = path.join(fixture.temporaryDirectory, "codex-stale");
  run(REAL_GIT, [
    "-C",
    fixture.coordinator,
    "worktree",
    "add",
    "--quiet",
    "--detach",
    worktree,
    staleRevision,
  ]);
  run(REAL_GIT, [
    "-C",
    worktree,
    "-c",
    "protocol.file.allow=always",
    "submodule",
    "update",
    "--init",
    "--recursive",
  ]);
  const staleBranch = "codex/stale-origin-main";
  git(worktree, "switch", "--quiet", "-c", staleBranch);
  git(
    path.join(worktree, "apps/backend"),
    "switch",
    "--quiet",
    "-c",
    staleBranch,
  );

  write(fixture.backend, "target-backend.txt", "target backend\n");
  git(fixture.backend, "add", "target-backend.txt");
  git(fixture.backend, "commit", "--quiet", "-m", "advance backend");
  git(fixture.backend, "push", "--quiet", "origin", "main");
  write(fixture.frontend, "target-frontend.txt", "target frontend\n");
  git(fixture.frontend, "add", "target-frontend.txt");
  git(fixture.frontend, "commit", "--quiet", "-m", "advance frontend");
  git(fixture.frontend, "push", "--quiet", "origin", "main");
  git(path.join(worktree, "apps/backend"), "fetch", "--quiet", "origin");
  git(path.join(worktree, "apps/frontend"), "fetch", "--quiet", "origin");
  git(fixture.coordinator, "add", "apps/backend", "apps/frontend");
  git(
    fixture.coordinator,
    "commit",
    "--quiet",
    "-m",
    "advance coordinated snapshot",
  );
  git(fixture.coordinator, "push", "--quiet", "origin", "main");
  git(fixture.coordinator, "fetch", "--quiet", "origin");

  return {
    backend: path.join(worktree, "apps/backend"),
    frontend: path.join(worktree, "apps/frontend"),
    mainRevision: gitText(fixture.coordinator, "rev-parse", "refs/heads/main"),
    staleBranch,
    staleRevision,
    worktree,
  };
}

function localBranchExists(repository, name) {
  return (
    run(
      REAL_GIT,
      [
        "-C",
        repository,
        "show-ref",
        "--verify",
        "--quiet",
        `refs/heads/${name}`,
      ],
      { allowFailure: true },
    ).status === 0
  );
}

function worktreePaths(repository) {
  return gitText(repository, "worktree", "list", "--porcelain")
    .split(/\n\n+/)
    .map((record) =>
      record
        .split("\n")
        .find((line) => line.startsWith("worktree ")),
    )
    .filter(Boolean)
    .map((line) => line.slice("worktree ".length));
}

test("delegates to ordinary Git outside a configured coordinator", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "ordinary-git-"));
  const invocation = wrapperInvocation(["--version"]);
  const result = run(invocation.command, invocation.argumentsList, {
    cwd: directory,
  });
  assert.match(result.stdout, /^git version /);
});

test("git add and git commit create child commits before the coordinator commit", () => {
  const fixture = createFixture();
  write(fixture.backend, "backend.txt", "backend change\n");
  write(fixture.frontend, "frontend.txt", "frontend change\n");
  write(fixture.coordinator, "coordinator.txt", "coordinator change\n");

  coordinated(fixture.coordinator, "add", ".");
  assert.equal(gitText(fixture.backend, "diff", "--cached", "--name-only"), "backend.txt");
  assert.equal(
    gitText(fixture.frontend, "diff", "--cached", "--name-only"),
    "frontend.txt",
  );
  assert.equal(
    gitText(fixture.coordinator, "diff", "--cached", "--name-only"),
    "coordinator.txt",
  );

  coordinated(fixture.coordinator, "commit", "-m", "coordinated change");

  assert.equal(gitText(fixture.backend, "log", "-1", "--format=%s"), "coordinated change");
  assert.equal(gitText(fixture.frontend, "log", "-1", "--format=%s"), "coordinated change");
  assert.equal(
    gitText(fixture.coordinator, "log", "-1", "--format=%s"),
    "coordinated change",
  );
  assert.equal(
    gitText(fixture.coordinator, "rev-parse", ":apps/backend"),
    revision(fixture.backend),
  );
  assert.equal(
    gitText(fixture.coordinator, "rev-parse", ":apps/frontend"),
    revision(fixture.frontend),
  );
});

test("git checkout -b and git checkout switch all coordinated repositories", () => {
  const fixture = createFixture();

  coordinated(fixture.coordinator, "checkout", "-b", "feature/coordinated");
  assert.equal(branch(fixture.coordinator), "feature/coordinated");
  assert.equal(branch(fixture.backend), "feature/coordinated");
  assert.equal(branch(fixture.frontend), "feature/coordinated");

  coordinated(fixture.coordinator, "checkout", "main");
  assert.equal(branch(fixture.coordinator), "main");
  assert.equal(branch(fixture.backend), "main");
  assert.equal(branch(fixture.frontend), "main");
});

test("checkout -b and switch -c create coordinated branches from origin/main in stale linked worktrees", () => {
  for (const [command, createFlag] of [
    ["checkout", "-b"],
    ["switch", "-c"],
  ]) {
    const fixture = createFixture(manifestPolicyConfiguration());
    const stale = createStaleLinkedSnapshot(fixture);
    const branchName = `hotfix/${command}-origin-main`;
    const worktreesBefore = worktreePaths(stale.worktree);
    const targetRevision = gitText(stale.worktree, "rev-parse", "origin/main");
    const backendGitlink = gitText(
      stale.worktree,
      "rev-parse",
      "origin/main:apps/backend",
    );
    const frontendGitlink = gitText(
      stale.worktree,
      "rev-parse",
      "origin/main:apps/frontend",
    );

    coordinated(
      stale.worktree,
      command,
      createFlag,
      branchName,
      "origin/main",
    );

    assert.equal(branch(stale.worktree), branchName);
    assert.equal(revision(stale.worktree), targetRevision);
    assert.equal(branch(stale.backend), branchName);
    assert.equal(revision(stale.backend), backendGitlink);
    assert.equal(branch(stale.frontend), "");
    assert.equal(revision(stale.frontend), frontendGitlink);
    assert.equal(
      gitText(fixture.coordinator, "rev-parse", "refs/heads/main"),
      stale.mainRevision,
    );
    assert.deepEqual(worktreePaths(stale.worktree), worktreesBefore);
  }
});

test("start-point branch creation rejects invalid revisions and dirty worktrees before writing", () => {
  const invalidFixture = createFixture();
  const invalidRootRevision = revision(invalidFixture.coordinator);
  const invalid = coordinatedAllowFailure(
    invalidFixture.coordinator,
    "switch",
    "-c",
    "hotfix/invalid-start-point",
    "origin/not-a-branch",
  );
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /does not resolve to a commit/i);
  assert.equal(revision(invalidFixture.coordinator), invalidRootRevision);
  assert.equal(localBranchExists(invalidFixture.coordinator, "hotfix/invalid-start-point"), false);
  assert.equal(branch(invalidFixture.backend), "main");
  assert.equal(branch(invalidFixture.frontend), "main");

  const configurationFixture = createFixture();
  git(
    configurationFixture.coordinator,
    "checkout",
    "--quiet",
    "-b",
    "legacy/no-coordinator",
  );
  git(
    configurationFixture.coordinator,
    "rm",
    "--quiet",
    ".git-coordinator.json",
  );
  git(
    configurationFixture.coordinator,
    "commit",
    "--quiet",
    "-m",
    "remove coordinator configuration",
  );
  git(configurationFixture.coordinator, "checkout", "--quiet", "main");
  const configurationRootRevision = revision(configurationFixture.coordinator);
  const configuration = coordinatedAllowFailure(
    configurationFixture.coordinator,
    "checkout",
    "-b",
    "hotfix/uninterpretable-start-point",
    "legacy/no-coordinator",
  );
  assert.notEqual(configuration.status, 0);
  assert.match(configuration.stderr, /does not contain an interpretable coordinator configuration/i);
  assert.equal(revision(configurationFixture.coordinator), configurationRootRevision);
  assert.equal(
    localBranchExists(
      configurationFixture.coordinator,
      "hotfix/uninterpretable-start-point",
    ),
    false,
  );

  const dirtyFixture = createFixture();
  const dirtyRootRevision = revision(dirtyFixture.coordinator);
  write(dirtyFixture.backend, "dirty.txt", "dirty\n");
  const dirty = coordinatedAllowFailure(
    dirtyFixture.coordinator,
    "checkout",
    "-b",
    "hotfix/dirty-start-point",
    "origin/main",
  );
  assert.notEqual(dirty.status, 0);
  assert.match(dirty.stderr, /requires clean worktrees: .*backend/i);
  assert.equal(revision(dirtyFixture.coordinator), dirtyRootRevision);
  assert.equal(localBranchExists(dirtyFixture.coordinator, "hotfix/dirty-start-point"), false);
  assert.equal(branch(dirtyFixture.backend), "main");
});

test("start-point branch creation preflights child collisions and rolls back child checkout failures", () => {
  const collisionFixture = createFixture(manifestPolicyConfiguration());
  const collision = createStaleLinkedSnapshot(collisionFixture);
  const collisionBranch = "hotfix/child-collision";
  const collisionRootRevision = revision(collision.worktree);
  git(collision.backend, "branch", collisionBranch);

  const collisionResult = coordinatedAllowFailure(
    collision.worktree,
    "switch",
    "-c",
    collisionBranch,
    "origin/main",
  );
  assert.notEqual(collisionResult.status, 0);
  assert.match(collisionResult.stderr, /expected gitlink/i);
  assert.equal(revision(collision.worktree), collisionRootRevision);
  assert.equal(branch(collision.worktree), collision.staleBranch);
  assert.equal(localBranchExists(collision.worktree, collisionBranch), false);
  assert.equal(localBranchExists(collision.backend, collisionBranch), true);

  const failureFixture = createFixture(manifestPolicyConfiguration());
  const failure = createStaleLinkedSnapshot(failureFixture);
  const failureBranch = "hotfix/child-checkout-failure";
  const originalRootRevision = revision(failure.worktree);
  const originalBackendRevision = revision(failure.backend);
  const originalFrontendRevision = revision(failure.frontend);
  const hooks = path.join(failureFixture.temporaryDirectory, "reject-checkout");
  mkdirSync(hooks);
  writeFileSync(path.join(hooks, "post-checkout"), "#!/bin/sh\nexit 1\n", {
    mode: 0o755,
  });
  git(failure.frontend, "config", "core.hooksPath", hooks);

  const failureResult = coordinatedAllowFailure(
    failure.worktree,
    "checkout",
    "-b",
    failureBranch,
    "origin/main",
  );
  assert.notEqual(failureResult.status, 0);
  assert.equal(revision(failure.worktree), originalRootRevision);
  assert.equal(branch(failure.worktree), failure.staleBranch);
  assert.equal(revision(failure.backend), originalBackendRevision);
  assert.equal(branch(failure.backend), failure.staleBranch);
  assert.equal(revision(failure.frontend), originalFrontendRevision);
  assert.equal(branch(failure.frontend), "");
  assert.equal(localBranchExists(failure.worktree, failureBranch), false);
  assert.equal(localBranchExists(failure.backend, failureBranch), false);
});

test("v2 mirror and fixed policies coordinate different branches", () => {
  const fixture = createFixture(mixedPolicyConfiguration());
  const frontendRevision = revision(fixture.frontend);

  coordinated(fixture.coordinator, "checkout", "-b", "feature/mixed");
  assert.equal(branch(fixture.coordinator), "feature/mixed");
  assert.equal(branch(fixture.backend), "feature/mixed");
  assert.equal(branch(fixture.frontend), "main");
  assert.match(
    coordinated(fixture.coordinator, "--check").stdout,
    /backend=feature\/mixed, frontend=main \(read-only\)/,
  );

  write(fixture.backend, "mixed.txt", "backend only\n");
  coordinated(fixture.coordinator, "add", ".");
  coordinated(fixture.coordinator, "commit", "-m", "mixed policy");
  assert.equal(revision(fixture.frontend), frontendRevision);

  coordinated(fixture.coordinator, "push");
  assert.equal(
    gitText(fixture.backendRemote, "rev-parse", "refs/heads/feature/mixed"),
    revision(fixture.backend),
  );
  assert.equal(
    run(
      REAL_GIT,
      [
        "-C",
        fixture.frontendRemote,
        "show-ref",
        "--verify",
        "--quiet",
        "refs/heads/feature/mixed",
      ],
      { allowFailure: true },
    ).status,
    1,
  );

  coordinated(fixture.coordinator, "checkout", "main");
  assert.equal(branch(fixture.coordinator), "main");
  assert.equal(branch(fixture.backend), "main");
  assert.equal(branch(fixture.frontend), "main");
});

function historicalPinnedFixture() {
  const configuration = inlineWorkspaceConfiguration();
  configuration.workspace.selection.frontend = {
    branch: "main",
    mode: "pinned",
  };
  const fixture = createFixture(configuration, { format: "yaml" });
  const pinnedRevision = revision(fixture.frontend);

  write(fixture.frontend, "new-main.txt", "new main revision\n");
  git(fixture.frontend, "add", ".");
  git(fixture.frontend, "commit", "--quiet", "-m", "advance frontend main");
  const branchRevision = revision(fixture.frontend);
  git(fixture.frontend, "switch", "--detach", pinnedRevision);
  return { branchRevision, fixture, pinnedRevision };
}

test("v2 fixed read-only divergence requires an explicit noninteractive resolution", () => {
  const { fixture, pinnedRevision } = historicalPinnedFixture();

  const result = coordinatedAllowFailure(
    fixture.coordinator,
    "checkout",
    "-b",
    "feature/unresolved-pin",
  );

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /rerun interactively/i);
  assert.equal(branch(fixture.coordinator), "main");
  assert.equal(branch(fixture.backend), "main");
  assert.equal(branch(fixture.frontend), "");
  assert.equal(revision(fixture.frontend), pinnedRevision);
  assert.equal(
    localBranchExists(fixture.coordinator, "feature/unresolved-pin"),
    false,
  );
  assert.equal(
    localBranchExists(fixture.backend, "feature/unresolved-pin"),
    false,
  );
});

test("v2 fixed read-only policies can keep historical gitlinks detached", () => {
  const { fixture, pinnedRevision } = historicalPinnedFixture();

  coordinatedWithEnvironment(
    fixture.coordinator,
    { AGENT_COORDINATOR_PINNED_RESOLUTION: "detach" },
    "checkout",
    "-b",
    "feature/historical-pin",
  );
  assert.equal(branch(fixture.coordinator), "feature/historical-pin");
  assert.equal(branch(fixture.backend), "feature/historical-pin");
  assert.equal(branch(fixture.frontend), "");
  assert.equal(revision(fixture.frontend), pinnedRevision);
});

test("v2 fixed read-only policies can advance and stage the new branch gitlink", () => {
  const { branchRevision, fixture } = historicalPinnedFixture();

  coordinatedWithEnvironment(
    fixture.coordinator,
    { AGENT_COORDINATOR_PINNED_RESOLUTION: "advance" },
    "checkout",
    "-b",
    "feature/advanced-pin",
  );

  assert.equal(branch(fixture.coordinator), "feature/advanced-pin");
  assert.equal(branch(fixture.backend), "feature/advanced-pin");
  assert.equal(branch(fixture.frontend), "main");
  assert.equal(revision(fixture.frontend), branchRevision);
  assert.equal(
    gitText(fixture.coordinator, "rev-parse", ":apps/frontend"),
    branchRevision,
  );
  assert.equal(
    gitText(fixture.coordinator, "diff", "--cached", "--name-only"),
    "apps/frontend",
  );
  assert.match(
    coordinated(fixture.coordinator, "--check").stdout,
    /frontend=main \(read-only\)/,
  );
});

test("v2 fixed read-only branch creation can be cancelled without mutations", () => {
  const { fixture, pinnedRevision } = historicalPinnedFixture();
  const result = coordinatedAllowFailureWithEnvironment(
    fixture.coordinator,
    { AGENT_COORDINATOR_PINNED_RESOLUTION: "cancel" },
    "checkout",
    "-b",
    "feature/cancelled-pin",
  );

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /cancelled/i);
  assert.equal(branch(fixture.coordinator), "main");
  assert.equal(branch(fixture.backend), "main");
  assert.equal(branch(fixture.frontend), "");
  assert.equal(revision(fixture.frontend), pinnedRevision);
  assert.equal(
    localBranchExists(fixture.coordinator, "feature/cancelled-pin"),
    false,
  );
  assert.equal(
    localBranchExists(fixture.backend, "feature/cancelled-pin"),
    false,
  );
});

test("v2 read-only repositories reject local changes", () => {
  const fixture = createFixture(mixedPolicyConfiguration());
  coordinated(fixture.coordinator, "checkout", "-b", "feature/read-only");
  write(fixture.frontend, "README.md", "changed read-only frontend\n");

  const result = coordinatedAllowFailure(fixture.coordinator, "add", ".");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /read-only repositories have changes/i);
  assert.equal(
    gitText(fixture.frontend, "diff", "--cached", "--name-only"),
    "",
  );
});

test("v2 map policies translate coordinator branches and use a fallback", () => {
  const fixture = createFixture(
    mixedPolicyConfiguration({
      mode: "map",
      branches: {
        main: "main",
        "feature/coordinator": "feature/backend-api",
      },
      fallback: {
        mode: "mirror",
      },
    }),
  );

  coordinated(
    fixture.coordinator,
    "checkout",
    "-b",
    "feature/coordinator",
  );
  assert.equal(branch(fixture.coordinator), "feature/coordinator");
  assert.equal(branch(fixture.backend), "feature/backend-api");
  assert.equal(branch(fixture.frontend), "main");

  write(fixture.backend, "mapped.txt", "mapped backend\n");
  coordinated(fixture.coordinator, "add", ".");
  coordinated(fixture.coordinator, "commit", "-m", "mapped policy");
  coordinated(fixture.coordinator, "push");
  assert.equal(
    gitText(
      fixture.backendRemote,
      "rev-parse",
      "refs/heads/feature/backend-api",
    ),
    revision(fixture.backend),
  );
  assert.equal(
    run(
      REAL_GIT,
      [
        "-C",
        fixture.backendRemote,
        "show-ref",
        "--verify",
        "--quiet",
        "refs/heads/feature/coordinator",
      ],
      { allowFailure: true },
    ).status,
    1,
  );

  coordinated(fixture.coordinator, "checkout", "main");
  coordinated(fixture.coordinator, "checkout", "feature/coordinator");
  assert.equal(branch(fixture.backend), "feature/backend-api");
  coordinated(fixture.coordinator, "checkout", "main");
  coordinated(fixture.coordinator, "checkout", "-b", "feature/fallback");
  assert.equal(branch(fixture.coordinator), "feature/fallback");
  assert.equal(branch(fixture.backend), "feature/fallback");
  assert.equal(branch(fixture.frontend), "main");
});

test("v2 map policies reject unmapped branches without a fallback", () => {
  const fixture = createFixture(
    mixedPolicyConfiguration({
      mode: "map",
      branches: {
        main: "main",
      },
    }),
  );

  const result = coordinatedAllowFailure(
    fixture.coordinator,
    "checkout",
    "-b",
    "feature/unmapped",
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /no branch mapping/i);
  assert.equal(branch(fixture.coordinator), "main");
  assert.equal(branch(fixture.backend), "main");
  assert.equal(branch(fixture.frontend), "main");
});

test("workspace manifests version active and pinned repository policies", () => {
  const fixture = createFixture(manifestPolicyConfiguration());
  const frontendRevision = revision(fixture.frontend);

  coordinated(fixture.coordinator, "checkout", "-b", "feature/manifest");
  assert.equal(branch(fixture.coordinator), "feature/manifest");
  assert.equal(branch(fixture.backend), "feature/manifest");
  assert.equal(branch(fixture.frontend), "main");

  const manifest = JSON.parse(
    readFileSync(path.join(fixture.coordinator, "workspace.json"), "utf8"),
  );
  assert.deepEqual(manifest.repositories.backend, {
    path: "apps/backend",
    branch: "$coordinator",
    mode: "active",
  });
  assert.deepEqual(manifest.repositories.frontend, {
    path: "apps/frontend",
    branch: "main",
    mode: "pinned",
  });

  write(fixture.backend, "manifest.txt", "backend only\n");
  coordinated(fixture.coordinator, "add", ".");
  coordinated(fixture.coordinator, "commit", "-m", "manifest policy");
  coordinated(fixture.coordinator, "push");
  assert.equal(revision(fixture.frontend), frontendRevision);
  assert.match(
    coordinated(fixture.coordinator, "--check").stdout,
    /backend=feature\/manifest, frontend=main \(read-only\)/,
  );

  coordinated(fixture.coordinator, "checkout", "main");
  assert.equal(branch(fixture.backend), "main");
  assert.equal(branch(fixture.frontend), "main");
});

test("git add applies an edited workspace selection before staging", () => {
  const fixture = createFixture(manifestPolicyConfiguration());
  coordinated(fixture.coordinator, "checkout", "-b", "feature/frontend-only");

  const manifestPath = path.join(fixture.coordinator, "workspace.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.repositories.backend = {
    path: "apps/backend",
    branch: "main",
    mode: "pinned",
  };
  manifest.repositories.frontend = {
    path: "apps/frontend",
    branch: "$coordinator",
    mode: "active",
  };
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  coordinated(fixture.coordinator, "add", ".");
  assert.equal(branch(fixture.backend), "");
  assert.equal(branch(fixture.frontend), "feature/frontend-only");
  assert.equal(
    gitText(fixture.coordinator, "diff", "--cached", "--name-only"),
    "workspace.json",
  );
});

test("pinned manifest repositories detach at historical gitlinks", () => {
  const fixture = createFixture(manifestPolicyConfiguration());
  const pinnedRevision = revision(fixture.frontend);

  coordinated(fixture.coordinator, "checkout", "-b", "feature/historical");
  coordinated(fixture.coordinator, "add", ".");
  coordinated(fixture.coordinator, "commit", "-m", "pin historical frontend");
  coordinated(fixture.coordinator, "checkout", "main");

  write(fixture.frontend, "new-main.txt", "new main revision\n");
  git(fixture.frontend, "add", ".");
  git(fixture.frontend, "commit", "--quiet", "-m", "advance frontend main");
  git(fixture.coordinator, "add", "apps/frontend");
  git(fixture.coordinator, "commit", "--quiet", "-m", "advance main gitlink");

  coordinated(fixture.coordinator, "checkout", "feature/historical");
  assert.equal(branch(fixture.frontend), "");
  assert.equal(revision(fixture.frontend), pinnedRevision);
  coordinated(fixture.coordinator, "checkout", "main");
  assert.equal(branch(fixture.frontend), "main");
});

test("manifest policies mirror active repositories in Codex worktrees", () => {
  const fixture = createFixture(manifestPolicyConfiguration());
  const manifestPath = path.join(fixture.coordinator, "workspace.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.repositories.frontend.mode = "pinned";
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  git(fixture.coordinator, "add", "workspace.json");
  git(fixture.coordinator, "commit", "--quiet", "-m", "pin frontend");

  const worktree = path.join(fixture.temporaryDirectory, "codex-manifest");
  installWorkspaceHooks(fixture);
  run(
    REAL_GIT,
    [
      "-C",
      fixture.coordinator,
      "worktree",
      "add",
      "--quiet",
      "--detach",
      worktree,
    ],
    { env: { HUSKY: "0" } },
  );

  assert.equal(branch(worktree), "codex/codex-manifest");
  assert.equal(
    branch(path.join(worktree, "apps/backend")),
    "codex/codex-manifest",
  );
  assert.equal(branch(path.join(worktree, "apps/frontend")), "");
});

test("coordinator.yaml versions branch selection without generated JSON", () => {
  const fixture = createFixture(inlineWorkspaceConfiguration(), {
    format: "yaml",
  });
  const frontendRevision = revision(fixture.frontend);

  coordinated(fixture.coordinator, "checkout", "-b", "feature/yaml");
  assert.equal(branch(fixture.backend), "feature/yaml");
  assert.equal(branch(fixture.frontend), "main");

  const manifest = readCoordinatorYaml(fixture);
  assert.deepEqual(manifest.workspace.selection.backend, {
    branch: "$coordinator",
    mode: "active",
  });
  assert.deepEqual(manifest.workspace.selection.frontend, {
    branch: "main",
    mode: "pinned",
  });
  assert.equal(
    manifest.local.compose.override,
    "services:\n  app:\n    ports: !override\n      - '4100:3000'\n",
  );
  assert.equal(
    existsSync(path.join(fixture.coordinator, ".git-coordinator.json")),
    false,
  );

  write(fixture.backend, "yaml.txt", "yaml branch\n");
  coordinated(fixture.coordinator, "add", ".");
  coordinated(fixture.coordinator, "commit", "-m", "inline yaml policy");
  coordinated(fixture.coordinator, "push");
  assert.equal(revision(fixture.frontend), frontendRevision);
  assert.match(
    coordinated(fixture.coordinator, "--check").stdout,
    /backend=feature\/yaml, frontend=main \(read-only\)/,
  );

  coordinated(fixture.coordinator, "checkout", "main");
  assert.equal(branch(fixture.backend), "main");
  assert.equal(branch(fixture.frontend), "main");
});

test("git add applies an edited inline YAML selection before staging", () => {
  const fixture = createFixture(inlineWorkspaceConfiguration(), {
    format: "yaml",
  });
  coordinated(fixture.coordinator, "checkout", "-b", "feature/yaml-scope");

  const manifest = readCoordinatorYaml(fixture);
  manifest.workspace.selection.backend = { branch: "main", mode: "pinned" };
  manifest.workspace.selection.frontend = {
    branch: "$coordinator",
    mode: "active",
  };
  writeCoordinatorYaml(fixture, manifest);

  coordinated(fixture.coordinator, "add", ".");
  assert.equal(branch(fixture.backend), "");
  assert.equal(branch(fixture.frontend), "feature/yaml-scope");
  assert.equal(
    gitText(fixture.coordinator, "diff", "--cached", "--name-only"),
    "coordinator.yaml",
  );
});

test("commit reads inline YAML selection from the index", () => {
  const fixture = createFixture(inlineWorkspaceConfiguration(), {
    format: "yaml",
  });
  coordinated(fixture.coordinator, "checkout", "-b", "feature/yaml-index");

  const staged = readCoordinatorYaml(fixture);
  staged.workspace.selection.backend = { branch: "main", mode: "pinned" };
  staged.workspace.selection.frontend = {
    branch: "$coordinator",
    mode: "active",
  };
  writeCoordinatorYaml(fixture, staged);
  coordinated(fixture.coordinator, "add", ".");

  const unstaged = readCoordinatorYaml(fixture);
  delete unstaged.workspace;
  unstaged.repositories = unstaged.repositories.filter(
    (repository) => repository.id === "frontend",
  );
  writeCoordinatorYaml(fixture, unstaged);

  coordinated(fixture.coordinator, "commit", "-m", "commit staged selection");
  const committed = parse(
    gitText(fixture.coordinator, "show", "HEAD:coordinator.yaml"),
  );
  assert.deepEqual(committed.workspace.selection, staged.workspace.selection);
  assert.equal(branch(fixture.backend), "");
  assert.equal(branch(fixture.frontend), "feature/yaml-index");
});

test("push reads inline YAML selection from HEAD, not an unstaged edit", () => {
  const fixture = createFixture(inlineWorkspaceConfiguration(), {
    format: "yaml",
  });
  coordinated(fixture.coordinator, "checkout", "-b", "feature/yaml-head");
  write(fixture.backend, "unpublished.txt", "must publish child first\n");
  coordinated(fixture.coordinator, "add", ".");
  coordinated(fixture.coordinator, "commit", "-m", "record yaml selection");

  const manifest = readCoordinatorYaml(fixture);
  delete manifest.workspace;
  manifest.repositories = manifest.repositories.filter(
    (repository) => repository.id === "frontend",
  );
  writeCoordinatorYaml(fixture, manifest);

  coordinated(fixture.coordinator, "push");
  assert.equal(branch(fixture.frontend), "main");
  assert.equal(
    gitText(
      fixture.backendRemote,
      "rev-parse",
      "refs/heads/feature/yaml-head",
    ),
    revision(fixture.backend),
  );
  assert.notEqual(
    run(
      REAL_GIT,
      [
        "-C",
        fixture.frontendRemote,
        "show-ref",
        "--verify",
        "--quiet",
        "refs/heads/feature/yaml-head",
      ],
      { allowFailure: true },
    ).status,
    0,
  );
});

test("inline YAML policies bootstrap detached Codex worktrees", () => {
  const fixture = createFixture(inlineWorkspaceConfiguration(), {
    format: "yaml",
  });
  const manifest = readCoordinatorYaml(fixture);
  manifest.workspace.selection.frontend = { branch: "main", mode: "pinned" };
  writeCoordinatorYaml(fixture, manifest);
  git(fixture.coordinator, "add", "coordinator.yaml");
  git(fixture.coordinator, "commit", "--quiet", "-m", "pin frontend inline");

  const worktree = path.join(fixture.temporaryDirectory, "codex-inline");
  installWorkspaceHooks(fixture);
  run(
    REAL_GIT,
    [
      "-C",
      fixture.coordinator,
      "worktree",
      "add",
      "--quiet",
      "--detach",
      worktree,
    ],
    { env: { HUSKY: "0" } },
  );

  assert.equal(branch(worktree), "codex/codex-inline");
  assert.equal(branch(path.join(worktree, "apps/backend")), "codex/codex-inline");
  assert.equal(branch(path.join(worktree, "apps/frontend")), "");
});

test("installed YAML workspaces fail closed when the manifest is missing", () => {
  const fixture = createFixture(inlineWorkspaceConfiguration(), {
    format: "yaml",
  });
  installWorkspaceHooks(fixture);
  git(fixture.coordinator, "rm", "--quiet", "coordinator.yaml");

  const result = coordinatedAllowFailure(
    fixture.coordinator,
    "commit",
    "-m",
    "must not bypass coordination",
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /coordinator\.yaml is required/i);
  assert.equal(gitText(fixture.coordinator, "log", "-1", "--format=%s"), "initial");
});

test("checkout rejects a target branch that does not contain coordinator.yaml", () => {
  const fixture = createFixture(inlineWorkspaceConfiguration(), {
    format: "yaml",
  });
  git(fixture.coordinator, "checkout", "--quiet", "-b", "legacy/no-yaml");
  git(fixture.coordinator, "rm", "--quiet", "coordinator.yaml");
  git(fixture.coordinator, "commit", "--quiet", "-m", "legacy branch");
  git(fixture.coordinator, "checkout", "--quiet", "main");
  installWorkspaceHooks(fixture);

  const result = coordinatedAllowFailure(
    fixture.coordinator,
    "checkout",
    "legacy/no-yaml",
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /legacy\/no-yaml:coordinator\.yaml is required/i);
  assert.equal(branch(fixture.coordinator), "main");
  assert.equal(branch(fixture.backend), "main");
  assert.equal(branch(fixture.frontend), "main");
});

test("a failed coordinator commit rolls child commits back and preserves staging", () => {
  const fixture = createFixture();
  const backendRevision = revision(fixture.backend);
  const frontendRevision = revision(fixture.frontend);
  const coordinatorRevision = revision(fixture.coordinator);
  write(fixture.backend, "rollback.txt", "backend\n");
  write(fixture.frontend, "rollback.txt", "frontend\n");
  coordinated(fixture.coordinator, "add", ".");

  const hooks = path.join(fixture.temporaryDirectory, "rejecting-hooks");
  mkdirSync(hooks);
  const preCommit = path.join(hooks, "pre-commit");
  writeFileSync(preCommit, "#!/bin/sh\nexit 1\n");
  chmodSync(preCommit, 0o755);
  git(fixture.coordinator, "config", "core.hooksPath", hooks);

  const result = coordinatedAllowFailure(
    fixture.coordinator,
    "commit",
    "-m",
    "must roll back",
  );
  assert.notEqual(result.status, 0);
  assert.equal(revision(fixture.backend), backendRevision);
  assert.equal(revision(fixture.frontend), frontendRevision);
  assert.equal(revision(fixture.coordinator), coordinatorRevision);
  assert.equal(
    gitText(fixture.backend, "diff", "--cached", "--name-only"),
    "rollback.txt",
  );
  assert.equal(
    gitText(fixture.frontend, "diff", "--cached", "--name-only"),
    "rollback.txt",
  );
});

test("git pull fast-forwards active repositories and records their gitlinks", () => {
  const fixture = createFixture();
  const frontendRevision = revision(fixture.frontend);
  const remoteBackendRevision = advanceRemote(
    fixture,
    fixture.backendRemote,
    "main",
    "backend-pull",
  );

  const result = coordinated(
    fixture.coordinator,
    "-c",
    "core.hooksPath=/dev/null",
    "-c",
    "core.fsmonitor=",
    "pull",
    "--ff-only",
    "origin",
  );

  assert.equal(revision(fixture.backend), remoteBackendRevision);
  assert.equal(revision(fixture.frontend), frontendRevision);
  assert.equal(
    gitText(fixture.coordinator, "rev-parse", "HEAD:apps/backend"),
    remoteBackendRevision,
  );
  assert.equal(
    gitText(fixture.coordinator, "log", "-1", "--format=%s"),
    "Sync coordinated repositories",
  );
  assert.equal(gitText(fixture.coordinator, "status", "--porcelain"), "");
  assert.match(result.stderr, /fast-forwarding backend\/main/);
});

test("git pull preflights every repository before rejecting divergence", () => {
  const fixture = createFixture();
  const external = path.join(fixture.temporaryDirectory, "backend-diverged");
  run(REAL_GIT, [
    "clone",
    "--quiet",
    "--branch",
    "main",
    fixture.backendRemote,
    external,
  ]);
  configureIdentity(external);

  write(fixture.backend, "local.txt", "local\n");
  coordinated(fixture.coordinator, "add", ".");
  coordinated(fixture.coordinator, "commit", "-m", "local backend change");
  const localBackendRevision = revision(fixture.backend);
  const localCoordinatorRevision = revision(fixture.coordinator);

  write(external, "remote.txt", "remote\n");
  git(external, "add", ".");
  git(external, "commit", "--quiet", "-m", "remote backend change");
  git(external, "push", "--quiet", "origin", "main");

  const result = coordinatedAllowFailure(
    fixture.coordinator,
    "pull",
    "--ff-only",
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /cannot fast-forward: backend\/main/i);
  assert.equal(revision(fixture.backend), localBackendRevision);
  assert.equal(revision(fixture.coordinator), localCoordinatorRevision);
  assert.equal(gitText(fixture.coordinator, "status", "--porcelain"), "");
});

test("git pull follows mapped branches and leaves read-only repositories pinned", () => {
  const fixture = createFixture(
    mixedPolicyConfiguration({
      mode: "map",
      branches: {
        main: "main",
        "feature/coordinator": "feature/backend-api",
      },
    }),
  );
  coordinated(
    fixture.coordinator,
    "checkout",
    "-b",
    "feature/coordinator",
  );
  coordinated(fixture.coordinator, "push");
  const pinnedFrontendRevision = revision(fixture.frontend);
  const remoteBackendRevision = advanceRemote(
    fixture,
    fixture.backendRemote,
    "feature/backend-api",
    "mapped-pull",
  );
  advanceRemote(
    fixture,
    fixture.frontendRemote,
    "main",
    "pinned-frontend",
  );

  coordinated(
    fixture.coordinator,
    "pull",
    "--ff-only",
    "origin",
    "feature/coordinator",
  );

  assert.equal(branch(fixture.backend), "feature/backend-api");
  assert.equal(revision(fixture.backend), remoteBackendRevision);
  assert.equal(revision(fixture.frontend), pinnedFrontendRevision);
  assert.equal(
    gitText(fixture.coordinator, "rev-parse", "HEAD:apps/backend"),
    remoteBackendRevision,
  );
  assert.equal(
    gitText(fixture.coordinator, "rev-parse", "HEAD:apps/frontend"),
    pinnedFrontendRevision,
  );
});

test("git push publishes child branches before the coordinator branch", () => {
  const fixture = createFixture();
  coordinated(fixture.coordinator, "checkout", "-b", "feature/push");
  write(fixture.backend, "push.txt", "backend\n");
  write(fixture.frontend, "push.txt", "frontend\n");
  coordinated(fixture.coordinator, "add", ".");
  coordinated(fixture.coordinator, "commit", "-m", "push fixture");

  coordinated(fixture.coordinator, "push");

  assert.equal(
    gitText(fixture.backendRemote, "rev-parse", "refs/heads/feature/push"),
    revision(fixture.backend),
  );
  assert.equal(
    gitText(fixture.frontendRemote, "rev-parse", "refs/heads/feature/push"),
    revision(fixture.frontend),
  );
  assert.equal(
    gitText(fixture.coordinatorRemote, "rev-parse", "refs/heads/feature/push"),
    revision(fixture.coordinator),
  );
  assert.equal(
    gitText(fixture.coordinator, "rev-parse", "--abbrev-ref", "@{upstream}"),
    "origin/feature/push",
  );
});

test("direct application push coordinates children through pre-push", () => {
  const fixture = createFixture();
  coordinated(fixture.coordinator, "checkout", "-b", "feature/application-push");
  coordinated(fixture.coordinator, "push");
  installWorkspaceHooks(fixture);

  write(fixture.backend, "application.txt", "backend\n");
  write(fixture.frontend, "application.txt", "frontend\n");
  coordinated(fixture.coordinator, "add", ".");
  coordinated(fixture.coordinator, "commit", "-m", "application push");

  const result = run(
    REAL_GIT,
    [
      "-c",
      "core.hooksPath=/dev/null",
      "-C",
      fixture.coordinator,
      "push",
      "--porcelain",
      "origin",
    ],
    { env: { HUSKY: "0" } },
  );

  assert.match(result.stderr, /coordinating direct application push/);
  assert.equal(
    gitText(
      fixture.backendRemote,
      "rev-parse",
      "refs/heads/feature/application-push",
    ),
    revision(fixture.backend),
  );
  assert.equal(
    gitText(
      fixture.frontendRemote,
      "rev-parse",
      "refs/heads/feature/application-push",
    ),
    revision(fixture.frontend),
  );
  assert.equal(
    gitText(
      fixture.coordinatorRemote,
      "rev-parse",
      "refs/heads/feature/application-push",
    ),
    revision(fixture.coordinator),
  );
});

test("direct pre-push reads the complete coordinator.yaml from HEAD", () => {
  const fixture = createFixture(inlineWorkspaceConfiguration(), {
    format: "yaml",
  });
  coordinated(fixture.coordinator, "checkout", "-b", "feature/direct-yaml");
  coordinated(fixture.coordinator, "add", ".");
  coordinated(fixture.coordinator, "commit", "-m", "record direct yaml branch");
  coordinated(fixture.coordinator, "push");
  installWorkspaceHooks(fixture);

  write(fixture.backend, "direct-yaml.txt", "publish from HEAD policy\n");
  coordinated(fixture.coordinator, "add", ".");
  coordinated(fixture.coordinator, "commit", "-m", "direct yaml child");
  const manifest = readCoordinatorYaml(fixture);
  delete manifest.workspace;
  manifest.repositories = manifest.repositories.filter(
    (repository) => repository.id === "frontend",
  );
  writeCoordinatorYaml(fixture, manifest);

  const result = run(
    REAL_GIT,
    [
      "-c",
      "core.hooksPath=/dev/null",
      "-C",
      fixture.coordinator,
      "push",
      "--porcelain",
      "origin",
    ],
    { env: { HUSKY: "0" } },
  );

  assert.match(result.stderr, /coordinating direct application push/);
  assert.equal(
    gitText(
      fixture.backendRemote,
      "rev-parse",
      "refs/heads/feature/direct-yaml",
    ),
    revision(fixture.backend),
  );
  assert.equal(
    gitText(
      fixture.coordinatorRemote,
      "rev-parse",
      "refs/heads/feature/direct-yaml",
    ),
    revision(fixture.coordinator),
  );
});

test("git worktree add initializes independent child worktrees and branches", () => {
  const fixture = createFixture();
  const worktree = path.join(fixture.temporaryDirectory, "codex-wrapper");

  coordinated(
    fixture.coordinator,
    "worktree",
    "add",
    "-b",
    "codex/wrapper",
    worktree,
  );

  const worktreeBackend = path.join(worktree, "apps/backend");
  const worktreeFrontend = path.join(worktree, "apps/frontend");
  assert.equal(branch(worktree), "codex/wrapper");
  assert.equal(branch(worktreeBackend), "codex/wrapper");
  assert.equal(branch(worktreeFrontend), "codex/wrapper");
  assert.notEqual(
    realpathSync(gitText(fixture.backend, "rev-parse", "--git-dir")),
    realpathSync(gitText(worktreeBackend, "rev-parse", "--git-dir")),
  );
  assert.notEqual(
    realpathSync(gitText(fixture.frontend, "rev-parse", "--git-dir")),
    realpathSync(gitText(worktreeFrontend, "rev-parse", "--git-dir")),
  );

  coordinated(fixture.coordinator, "worktree", "remove", worktree);
  assert.equal(existsSync(worktree), false);
  assert.equal(
    gitText(fixture.coordinator, "submodule", "status")
      .split("\n")
      .every((line) => !line.startsWith("-")),
    true,
  );
});

test("direct checkout -b coordinates branches even when Husky is disabled", () => {
  const fixture = createFixture();
  installWorkspaceHooks(fixture);
  assert.equal(hookMode(fixture.coordinator), "configured");

  run(
    REAL_GIT,
    ["-C", fixture.coordinator, "checkout", "-b", "feature/codex-direct"],
    { env: { HUSKY: "0" } },
  );

  assert.equal(branch(fixture.coordinator), "feature/codex-direct");
  assert.equal(branch(fixture.backend), "feature/codex-direct");
  assert.equal(branch(fixture.frontend), "feature/codex-direct");
});

test("shared hooks bootstrap detached Codex-style worktrees with Husky disabled", () => {
  const fixture = createFixture();
  const worktree = path.join(fixture.temporaryDirectory, "codex-direct");
  installWorkspaceHooks(fixture);
  assert.equal(hookMode(fixture.coordinator), "configured");

  run(
    REAL_GIT,
    [
      "-C",
      fixture.coordinator,
      "worktree",
      "add",
      "--quiet",
      "--detach",
      worktree,
    ],
    { env: { HUSKY: "0" } },
  );

  assert.equal(branch(worktree), "codex/codex-direct");
  assert.equal(
    branch(path.join(worktree, "apps/backend")),
    "codex/codex-direct",
  );
  assert.equal(
    branch(path.join(worktree, "apps/frontend")),
    "codex/codex-direct",
  );
});

test("v2 policies apply inside detached Codex-style worktrees", () => {
  const fixture = createFixture(mixedPolicyConfiguration());
  const worktree = path.join(fixture.temporaryDirectory, "codex-mixed");
  installWorkspaceHooks(fixture);

  run(
    REAL_GIT,
    [
      "-C",
      fixture.coordinator,
      "worktree",
      "add",
      "--quiet",
      "--detach",
      worktree,
    ],
    { env: { HUSKY: "0" } },
  );

  assert.equal(branch(worktree), "codex/codex-mixed");
  assert.equal(
    branch(path.join(worktree, "apps/backend")),
    "codex/codex-mixed",
  );
  assert.equal(branch(path.join(worktree, "apps/frontend")), "main");
});

test("workspace install disables existing hooks and uninstall restores them", () => {
  const fixture = createFixture();
  const originalHooks = path.join(fixture.temporaryDirectory, "original-hooks");
  const marker = path.join(fixture.temporaryDirectory, "original-hook-ran");
  mkdirSync(originalHooks);
  writeFileSync(
    path.join(originalHooks, "post-checkout"),
    `#!/bin/sh\nprintf ran > "${marker}"\n`,
    { mode: 0o755 },
  );
  git(fixture.coordinator, "config", "core.hooksPath", originalHooks);

  installWorkspaceHooks(fixture);
  assert.equal(hookMode(fixture.coordinator), "configured");
  const managedHooks = gitText(
    fixture.coordinator,
    "config",
    "--local",
    "--get",
    "core.hooksPath",
  );
  assert.deepEqual(readdirSync(managedHooks), [".agent-coordinator-owned"]);
  run(
    REAL_GIT,
    ["-C", fixture.coordinator, "checkout", "-b", "feature/coordinator-only"],
    { env: { HUSKY: "0" } },
  );
  assert.equal(existsSync(marker), false);

  run(process.execPath, [coordinatorCli, "git", "uninstall"], {
    cwd: fixture.coordinator,
    env: fixture.runtimeEnvironment,
  });
  assert.equal(
    realpathSync(
      gitText(fixture.coordinator, "config", "--get", "core.hooksPath"),
    ),
    realpathSync(originalHooks),
  );
  assert.equal(
    run(
      REAL_GIT,
      [
        "-C",
        fixture.coordinator,
        "config",
        "--local",
        "--get",
        "hook.git-coordinator-post-checkout.command",
      ],
      { allowFailure: true },
    ).status,
    1,
  );
  assert.equal(
    run(
      REAL_GIT,
      [
        "-C",
        fixture.coordinator,
        "config",
        "--local",
        "--get",
        "hook.agent-coordinator-post-checkout.command",
      ],
      { allowFailure: true },
    ).status,
    1,
  );
});

test("global installer creates and removes stable managed executables", () => {
  const temporaryDirectory = mkdtempSync(
    path.join(os.tmpdir(), "agent-coordinator-git-global-"),
  );
  const agentCoordinatorHome = path.join(temporaryDirectory, "share");
  const binDirectory = path.join(temporaryDirectory, "bin");
  mkdirSync(binDirectory);
  const environment = {
    AGENT_COORDINATOR_GIT_BIN_DIR: binDirectory,
    AGENT_COORDINATOR_HOME: agentCoordinatorHome,
    GIT_COORDINATOR_REAL_GIT: REAL_GIT,
    PATH: `${binDirectory}${path.delimiter}/usr/bin${path.delimiter}/bin`,
  };

  run(process.execPath, [coordinatorCli, "install"], {
    env: environment,
  });
  const gitExecutable = path.join(binDirectory, "git");
  const cliExecutable = path.join(binDirectory, "git-coordinator");
  assert.equal(existsSync(gitExecutable), true);
  assert.equal(existsSync(cliExecutable), false);
  const installedRuntime = realpathSync(
    path.resolve(binDirectory, readlinkSync(gitExecutable)),
  );
  assert.equal(
    installedRuntime.startsWith(`${realpathSync(agentCoordinatorHome)}${path.sep}`),
    true,
  );
  assert.match(
    readFileSync(installedRuntime, "utf8"),
    /agent-coordinator-git-wrapper-v1|git-coordinator-wrapper-v1/,
  );
  assert.match(
    run(gitExecutable, ["--version"], { cwd: temporaryDirectory }).stdout,
    /^git version /,
  );
  run(process.execPath, [coordinatorCli, "install"], {
    env: environment,
  });
  assert.match(
    run(gitExecutable, ["--version"], { cwd: temporaryDirectory }).stdout,
    /^git version /,
  );

  run(process.execPath, [coordinatorCli, "uninstall"], {
    env: environment,
  });
  assert.equal(existsSync(gitExecutable), false);
  assert.equal(existsSync(cliExecutable), false);
  assert.equal(existsSync(installedRuntime), false);
});
