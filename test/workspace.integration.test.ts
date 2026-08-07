import assert from "node:assert/strict";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import test from "node:test";
import { loadManifest } from "../src/core/manifest.js";
import { coordinatorManifestSchema } from "../src/core/schema.js";
import { runDoctor } from "../src/doctor/check.js";
import {
  installMachineGitRuntime,
  installWorkspaceGitIntegration,
  invokeGitRuntime,
} from "../src/git/install.js";
import { initializeWorkspace } from "../src/workspace/initialize.js";
import { synchronizeWorkspace } from "../src/workspace/sync.js";
import { migrateLegacyWorkspace } from "../src/workspace/migrate.js";
import {
  createChildRemote,
  createNestedAgentRemote,
  git,
  temporaryDirectory,
} from "./helpers.js";

interface SkillLockEntryV2 {
  linkTarget: string;
  materialization: "relative-symlink";
  name: string;
  repository: string;
  source: string;
  sourceCommit: string;
  treeOid: string;
}

interface SkillLockV2 {
  generatedBy: "agent-coordinator";
  generatorVersion: string;
  schemaVersion: 2;
  skills: SkillLockEntryV2[];
}

function expectedSkillLinkTarget(sourceWorkspacePath: string): string {
  return path.posix.relative(
    ".agents/skills",
    sourceWorkspacePath.split(path.sep).join("/"),
  );
}

function assertRelativeSkillLink(
  root: string,
  name: string,
  sourceWorkspacePath: string,
): string {
  const destination = path.join(root, ".agents", "skills", name);
  assert.equal(lstatSync(destination).isSymbolicLink(), true);
  const linkTarget = readlinkSync(destination);
  assert.equal(path.isAbsolute(linkTarget), false);
  assert.equal(linkTarget, expectedSkillLinkTarget(sourceWorkspacePath));
  assert.equal(
    path.resolve(path.dirname(destination), linkTarget),
    path.resolve(root, sourceWorkspacePath),
  );
  return linkTarget;
}

function readSkillLock(root: string): SkillLockV2 {
  const lock = JSON.parse(
    readFileSync(path.join(root, ".coordinator", "agents.lock.json"), "utf8"),
  ) as SkillLockV2;
  assert.equal(lock.schemaVersion, 2);
  assert.equal(lock.generatedBy, "agent-coordinator");
  for (const skill of lock.skills) {
    assert.equal(skill.materialization, "relative-symlink");
    assert.equal(path.isAbsolute(skill.linkTarget), false);
    assert.match(skill.sourceCommit, /^[0-9a-f]{40,64}$/);
    assert.match(skill.treeOid, /^[0-9a-f]{40,64}$/);
  }
  return lock;
}

function withEnvironment<T>(
  values: Record<string, string | undefined>,
  operation: () => T,
): T {
  const previous = new Map(
    Object.keys(values).map((key) => [key, process.env[key]]),
  );
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return operation();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("init creates a Git-compatible workspace and links committed skills", (context) => {
  const temporary = temporaryDirectory();
  context.after(() => rmSync(temporary, { recursive: true }));
  const backend = createChildRemote(temporary, "backend", "api-testing");
  const frontend = createChildRemote(temporary, "frontend", "ui-testing");
  const root = path.join(temporary, "product-coordinator");

  const result = initializeWorkspace(
    root,
    {
      schemaVersion: 2,
      name: "product",
      remote: "origin",
      repositories: [
        {
          id: "backend",
          path: "backend",
          url: backend.remote,
          branch: { mode: "mirror", readOnly: false },
          agent: { instructions: [], verify: ["npm test"], skills: [] },
        },
        {
          id: "frontend",
          path: "frontend",
          url: frontend.remote,
          branch: { mode: "mirror", readOnly: false },
          agent: { instructions: [], verify: [], skills: [] },
        },
      ],
      agents: {
        tools: ["codex", "claude", "cursor", "opencode"],
        maxParallel: 2,
        skillCollision: "namespace",
      },
    },
    "0.1.0",
    { discoverSkills: true, installHooks: false },
  );

  assert.deepEqual(result.submodules, ["backend", "frontend"]);
  assert.equal(existsSync(path.join(root, ".git-coordinator.json")), false);
  assert.ok(existsSync(path.join(root, "coordinator.yaml")));
  assert.ok(existsSync(path.join(root, ".codex", "agents", "backend.toml")));
  assert.ok(existsSync(path.join(root, ".claude", "agents", "frontend.md")));
  assert.ok(existsSync(path.join(root, ".agents", "skills", "api-testing", "SKILL.md")));
  assert.ok(existsSync(path.join(root, ".agents", "skills", "ui-testing", "SKILL.md")));
  const apiLinkTarget = assertRelativeSkillLink(
    root,
    "api-testing",
    "backend/.agents/skills/api-testing",
  );
  const uiLinkTarget = assertRelativeSkillLink(
    root,
    "ui-testing",
    "frontend/.agents/skills/ui-testing",
  );
  const lock = readSkillLock(root);
  assert.deepEqual(
    lock.skills.map(({ linkTarget, materialization, name, repository, source }) => ({
      linkTarget,
      materialization,
      name,
      repository,
      source,
    })),
    [
      {
        linkTarget: apiLinkTarget,
        materialization: "relative-symlink",
        name: "api-testing",
        repository: "backend",
        source: ".agents/skills/api-testing",
      },
      {
        linkTarget: uiLinkTarget,
        materialization: "relative-symlink",
        name: "ui-testing",
        repository: "frontend",
        source: ".agents/skills/ui-testing",
      },
    ],
  );
  const loaded = loadManifest(root);
  assert.equal(loaded.manifest.repositories[0]!.agent.skills.length, 1);
  const check = synchronizeWorkspace(root, loaded.manifest, "0.1.0", { check: true });
  assert.equal(check.changed, false);
  const skillPath = path.join(root, ".agents", "skills", "api-testing");
  const skillInode = lstatSync(skillPath).ino;
  assert.equal(synchronizeWorkspace(root, loaded.manifest, "0.1.0").changed, false);
  assert.equal(lstatSync(skillPath).ino, skillInode);
  assert.equal(readlinkSync(skillPath), apiLinkTarget);

  git(root, "add", ".");
  git(root, "commit", "-m", "Initialize coordinated workspace");
  assert.match(git(root, "submodule", "status"), /^[0-9a-f]{40} backend/m);

  const runtimeHome = path.join(temporary, "agent-coordinator-home");
  const runtimeBin = path.join(temporary, "bin");
  mkdirSync(runtimeBin);
  withEnvironment(
    {
      AGENT_COORDINATOR_HOME: runtimeHome,
      AGENT_COORDINATOR_GIT_BIN_DIR: runtimeBin,
    },
    () => {
      installMachineGitRuntime({ stdio: "pipe" });
      installWorkspaceGitIntegration(root, { stdio: "pipe" });
      const invariant = invokeGitRuntime("check", root, { stdio: "pipe" });
      assert.match(invariant.stdout, /invariant OK/);
    },
  );
});

test("init recursively materializes nested agent runtimes using the Market Intel preset", (context) => {
  const temporary = temporaryDirectory("agent-coordinator-nested-init-");
  context.after(() => rmSync(temporary, { recursive: true }));
  const backend = createNestedAgentRemote(temporary, "backend");
  const frontend = createNestedAgentRemote(temporary, "frontend");
  const root = path.join(temporary, "test-space");
  const input = coordinatorManifestSchema.parse({
    schemaVersion: 2,
    name: "test-space",
    remote: "origin",
    repositories: [
      {
        id: "backend",
        path: "market-intel-back-end",
        url: backend.remote,
        branch: { mode: "mirror", readOnly: false },
        agent: { instructions: [], verify: [], skills: [] },
      },
      {
        id: "frontend",
        path: "market-intel-front-end",
        url: frontend.remote,
        branch: { mode: "mirror", readOnly: false },
        agent: { instructions: [], verify: [], skills: [] },
      },
    ],
    agents: {
      tools: ["codex"],
      maxParallel: 2,
      skillCollision: "namespace",
    },
  });

  initializeWorkspace(root, input, "0.3.0", {
    discoverSkills: true,
    installHooks: false,
  });

  const recursiveStatus = git(root, "submodule", "status", "--recursive");
  assert.doesNotMatch(recursiveStatus, /^-/m);
  assert.equal(
    git(path.join(root, "market-intel-back-end"), "branch", "--show-current"),
    "main",
  );
  assert.equal(
    git(path.join(root, "market-intel-front-end"), "branch", "--show-current"),
    "main",
  );
  assert.match(
    readFileSync(path.join(root, "market-intel-back-end", "AGENTS.md"), "utf8"),
    /backend runtime/,
  );
  assert.match(
    readFileSync(path.join(root, "market-intel-front-end", "AGENTS.md"), "utf8"),
    /frontend runtime/,
  );

  const loaded = loadManifest(root);
  assert.deepEqual(
    loaded.manifest.repositories.map((repository) => repository.agent.skills),
    [backend, frontend].map((fixture) => [
      {
        kind: "flow",
        source: `${fixture.runtimePath}/.agents/flows/${fixture.flowName}`,
      },
      {
        kind: "skill",
        source: `${fixture.runtimePath}/.agents/skills/${fixture.skillName}`,
      },
      {
        kind: "flow",
        source: `${fixture.runtimePath}/${fixture.vendorPath}/flows/${fixture.aliasFlowName}`,
      },
      {
        kind: "skill",
        source: `${fixture.runtimePath}/${fixture.vendorPath}/skills/${fixture.aliasName}`,
      },
    ]),
  );
  const linkedSkills = [backend, frontend].flatMap((fixture, index) => {
    const repositoryPath = loaded.manifest.repositories[index]!.path;
    return [
      {
        name: fixture.flowName,
        source: `${repositoryPath}/${fixture.runtimePath}/.agents/flows/${fixture.flowName}`,
      },
      {
        name: fixture.skillName,
        source: `${repositoryPath}/${fixture.runtimePath}/.agents/skills/${fixture.skillName}`,
      },
      {
        name: fixture.aliasFlowName,
        source: `${repositoryPath}/${fixture.runtimePath}/${fixture.vendorPath}/flows/${fixture.aliasFlowName}`,
      },
      {
        name: fixture.aliasName,
        source: `${repositoryPath}/${fixture.runtimePath}/${fixture.vendorPath}/skills/${fixture.aliasName}`,
      },
    ];
  });
  const expectedTargets = new Map<string, string>();
  for (const skill of linkedSkills) {
    assert.ok(
      existsSync(path.join(root, ".agents", "skills", skill.name, "SKILL.md")),
    );
    expectedTargets.set(
      skill.name,
      assertRelativeSkillLink(root, skill.name, skill.source),
    );
  }
  const nestedLock = readSkillLock(root);
  assert.deepEqual(
    nestedLock.skills.map((skill) => skill.name),
    [...expectedTargets.keys()].sort(),
  );
  for (const skill of nestedLock.skills) {
    assert.equal(skill.linkTarget, expectedTargets.get(skill.name));
  }
  assert.equal(
    synchronizeWorkspace(root, loaded.manifest, "0.3.0", { check: true }).changed,
    false,
  );

  git(root, "add", ".");
  git(root, "commit", "-m", "Initialize nested coordinator");
  const doctor = runDoctor(root, loaded.manifest, "0.3.0");
  assert.equal(
    doctor.checks.find((item) => item.label === "Gitlinks")?.status,
    "pass",
  );
  assert.equal(
    doctor.checks.find((item) => item.label === "Generated outputs")?.status,
    "pass",
  );
});

test("init repairs adopted repositories whose nested runtimes are uninitialized", (context) => {
  const temporary = temporaryDirectory("agent-coordinator-nested-recovery-");
  context.after(() => rmSync(temporary, { recursive: true }));
  const backend = createNestedAgentRemote(temporary, "backend");
  const root = path.join(temporary, "test-space");
  mkdirSync(root, { recursive: true });
  git(root, "init", "--initial-branch=main");
  git(
    root,
    "submodule",
    "add",
    "--name",
    "backend",
    backend.remote,
    "market-intel-back-end",
  );
  assert.match(
    git(root, "submodule", "status", "--recursive"),
    /^-[0-9a-f]+ market-intel-back-end\/.agent-runtime\/backend-agent/m,
  );

  const input = coordinatorManifestSchema.parse({
    schemaVersion: 2,
    name: "test-space",
    remote: "origin",
    repositories: [
      {
        id: "backend",
        path: "market-intel-back-end",
        url: backend.remote,
        branch: { mode: "mirror", readOnly: false },
        agent: { instructions: [], verify: [], skills: [] },
      },
    ],
    agents: {
      tools: ["codex"],
      maxParallel: 1,
      skillCollision: "namespace",
    },
  });
  initializeWorkspace(root, input, "0.3.0", {
    discoverSkills: true,
    installHooks: false,
  });

  assert.doesNotMatch(git(root, "submodule", "status", "--recursive"), /^-/m);
  assert.match(
    readFileSync(path.join(root, "market-intel-back-end", "AGENTS.md"), "utf8"),
    /backend runtime/,
  );
  const loaded = loadManifest(root);
  assert.equal(loaded.manifest.repositories[0]!.agent.skills.length, 4);
  assert.ok(
    existsSync(
      path.join(root, ".agents", "skills", backend.aliasName, "SKILL.md"),
    ),
  );
});

test("reinitialization never moves an existing nested checkout", (context) => {
  const temporary = temporaryDirectory("agent-coordinator-nested-preserve-");
  context.after(() => rmSync(temporary, { recursive: true }));
  const backend = createNestedAgentRemote(temporary, "backend");
  const root = path.join(temporary, "test-space");
  const input = coordinatorManifestSchema.parse({
    schemaVersion: 2,
    name: "test-space",
    repositories: [
      {
        id: "backend",
        path: "market-intel-back-end",
        url: backend.remote,
        agent: { instructions: [], verify: [], skills: [] },
      },
    ],
    agents: {
      tools: ["codex"],
      maxParallel: 1,
      skillCollision: "namespace",
    },
  });
  initializeWorkspace(root, input, "0.3.0", {
    discoverSkills: true,
    installHooks: false,
  });
  const loaded = loadManifest(root);
  const runtime = path.join(
    root,
    "market-intel-back-end",
    backend.runtimePath,
  );
  git(runtime, "switch", "-c", "work");
  writeFileSync(path.join(runtime, "local-work.txt"), "preserve me\n");
  git(runtime, "add", ".");
  git(runtime, "commit", "-m", "Local runtime work");
  const localCommit = git(runtime, "rev-parse", "HEAD");

  assert.throws(
    () =>
      initializeWorkspace(root, loaded.manifest, "0.3.0", {
        discoverSkills: true,
        installHooks: false,
      }),
    (error: unknown) => {
      assert.ok(error instanceof Error && "code" in error);
      assert.equal(error.code, "NESTED_SUBMODULE_GITLINK_MISMATCH");
      assert.match(error.message, /will not move an existing checkout/);
      return true;
    },
  );
  assert.equal(git(runtime, "branch", "--show-current"), "work");
  assert.equal(git(runtime, "rev-parse", "HEAD"), localCommit);
});

test("reinitialization rejects a nested checkout symlink outside its parent", (context) => {
  const temporary = temporaryDirectory("agent-coordinator-nested-escape-");
  context.after(() => rmSync(temporary, { recursive: true }));
  const backend = createNestedAgentRemote(temporary, "backend");
  const root = path.join(temporary, "test-space");
  const input = coordinatorManifestSchema.parse({
    schemaVersion: 2,
    name: "test-space",
    repositories: [
      {
        id: "backend",
        path: "market-intel-back-end",
        url: backend.remote,
        agent: { instructions: [], verify: [], skills: [] },
      },
    ],
    agents: {
      tools: ["codex"],
      maxParallel: 1,
      skillCollision: "namespace",
    },
  });
  initializeWorkspace(root, input, "0.3.0", {
    discoverSkills: true,
    installHooks: false,
  });
  const loaded = loadManifest(root);
  const runtime = path.join(
    root,
    "market-intel-back-end",
    backend.runtimePath,
  );
  const external = path.join(temporary, "external-runtime");
  git(temporary, "clone", backend.runtimeRemote, external);
  const externalStatus = git(external, "submodule", "status", "--recursive");
  assert.match(externalStatus, /^-/m);
  rmSync(runtime, { recursive: true });
  symlinkSync(external, runtime, "dir");

  assert.throws(
    () =>
      initializeWorkspace(root, loaded.manifest, "0.3.0", {
        discoverSkills: true,
        installHooks: false,
      }),
    (error: unknown) => {
      assert.ok(error instanceof Error && "code" in error);
      assert.equal(error.code, "NESTED_SUBMODULE_PATH_INVALID");
      assert.match(error.message, /crosses symbolic link/);
      return true;
    },
  );
  assert.equal(
    git(external, "submodule", "status", "--recursive"),
    externalStatus,
  );
});

test("init rejects a direct repository symlink without touching its target", (context) => {
  const temporary = temporaryDirectory("agent-coordinator-direct-escape-");
  context.after(() => rmSync(temporary, { recursive: true }));
  const backend = createNestedAgentRemote(temporary, "backend");
  const root = path.join(temporary, "test-space");
  mkdirSync(root, { recursive: true });
  git(root, "init", "--initial-branch=main");
  const repositoryPath = "market-intel-back-end";
  git(
    root,
    "submodule",
    "add",
    "--name",
    "backend",
    backend.remote,
    repositoryPath,
  );
  const checkout = path.join(root, repositoryPath);
  const external = path.join(temporary, "external-backend");
  git(temporary, "clone", backend.remote, external);
  const externalStatus = git(external, "submodule", "status", "--recursive");
  assert.match(externalStatus, /^-/m);
  rmSync(checkout, { recursive: true });
  symlinkSync(external, checkout, "dir");
  const input = coordinatorManifestSchema.parse({
    schemaVersion: 2,
    name: "test-space",
    repositories: [
      {
        id: "backend",
        path: repositoryPath,
        url: backend.remote,
        agent: { instructions: [], verify: [], skills: [] },
      },
    ],
    agents: {
      tools: ["codex"],
      maxParallel: 1,
      skillCollision: "namespace",
    },
  });
  const previousDirectory = process.cwd();
  try {
    process.chdir(root);
    assert.throws(
      () =>
        initializeWorkspace(root, input, "0.3.0", {
          discoverSkills: true,
          installHooks: false,
        }),
      (error: unknown) => {
        assert.ok(error instanceof Error && "code" in error);
        assert.equal(error.code, "EXISTING_PATH_NOT_DECLARED_SUBMODULE");
        assert.match(error.message, /crosses symbolic link/);
        return true;
      },
    );
  } finally {
    process.chdir(previousDirectory);
  }
  assert.equal(
    git(external, "submodule", "status", "--recursive"),
    externalStatus,
  );
  assert.equal(existsSync(path.join(root, "coordinator.yaml")), false);
});

test("init reports a nested checkout failure before generating an empty skill set", (context) => {
  const temporary = temporaryDirectory("agent-coordinator-nested-failure-");
  context.after(() => rmSync(temporary, { recursive: true }));
  const backend = createNestedAgentRemote(temporary, "backend");
  const completeRuntime = `${backend.runtimeRemote}.complete`;
  renameSync(backend.runtimeRemote, completeRuntime);
  const incompleteSource = path.join(temporary, "incomplete-runtime-source");
  mkdirSync(incompleteSource, { recursive: true });
  git(incompleteSource, "init", "--initial-branch=main");
  writeFileSync(path.join(incompleteSource, "README.md"), "# Incomplete runtime\n");
  git(incompleteSource, "add", ".");
  git(incompleteSource, "commit", "-m", "Incomplete runtime");
  git(temporary, "clone", "--bare", incompleteSource, backend.runtimeRemote);
  const root = path.join(temporary, "test-space");
  const input = coordinatorManifestSchema.parse({
    schemaVersion: 2,
    name: "test-space",
    repositories: [
      {
        id: "backend",
        path: "market-intel-back-end",
        url: backend.remote,
        agent: { instructions: [], verify: [], skills: [] },
      },
    ],
    agents: {
      tools: ["codex"],
      maxParallel: 1,
      skillCollision: "namespace",
    },
  });

  assert.throws(
    () =>
      initializeWorkspace(root, input, "0.3.0", {
        discoverSkills: true,
        installHooks: false,
      }),
    (error: unknown) => {
      assert.ok(error instanceof Error && "code" in error);
      assert.equal(error.code, "NESTED_SUBMODULE_REPAIR_REQUIRED");
      assert.match(
        error.message,
        /backend.*nested checkout was deinitialized.*local repair/is,
      );
      return true;
    },
  );
  assert.equal(existsSync(path.join(root, ".coordinator", "agents.lock.json")), false);
  assert.match(git(root, "submodule", "status", "--recursive"), /^-/m);

  renameSync(backend.runtimeRemote, `${backend.runtimeRemote}.incomplete`);
  renameSync(completeRuntime, backend.runtimeRemote);
  initializeWorkspace(root, input, "0.3.0", {
    discoverSkills: true,
    installHooks: false,
  });
  assert.equal(loadManifest(root).manifest.repositories[0]!.agent.skills.length, 4);
});

test("legacy Git Coordinator configuration migrates without changing it", (context) => {
  const temporary = temporaryDirectory();
  context.after(() => rmSync(temporary, { recursive: true }));
  const child = createChildRemote(temporary, "api");
  const root = path.join(temporary, "legacy-product");
  initializeWorkspace(
    root,
    {
      schemaVersion: 1,
      name: "legacy-product",
      remote: "origin",
      repositories: [
        {
          id: "backend",
          path: "api",
          url: child.remote,
          branch: { mode: "mirror", readOnly: false },
          agent: { instructions: [], verify: [], skills: [] },
        },
      ],
      agents: { tools: ["codex"], maxParallel: 1, skillCollision: "namespace" },
    },
    "0.1.0",
    { installHooks: false },
  );
  const configurationPath = path.join(root, ".git-coordinator.json");
  writeFileSync(
    configurationPath,
    `${JSON.stringify({
      schemaVersion: 2,
      remote: "origin",
      repositories: [
        {
          id: "backend",
          path: "api",
          branch: { mode: "mirror", readOnly: false },
        },
      ],
    }, null, 2)}\n`,
  );
  const before = readFileSync(configurationPath, "utf8");
  const migrated = migrateLegacyWorkspace(root);
  assert.equal(migrated.repositories[0]!.id, "backend");
  assert.equal(migrated.repositories[0]!.url, child.remote);
  assert.equal(readFileSync(configurationPath, "utf8"), before);
});

test("agent sync removes stale generated adapters but preserves manual files", (context) => {
  const temporary = temporaryDirectory();
  context.after(() => rmSync(temporary, { recursive: true }));
  const child = createChildRemote(temporary, "api");
  const root = path.join(temporary, "agent-cleanup");
  const manifest = coordinatorManifestSchema.parse({
    schemaVersion: 1,
    name: "agent-cleanup",
    repositories: [{ id: "backend", path: "api", url: child.remote }],
    agents: {
      tools: ["codex", "claude", "cursor", "opencode"],
      maxParallel: 1,
      skillCollision: "namespace",
    },
  });
  initializeWorkspace(root, manifest, "0.1.0", { installHooks: false });
  const manualAgent = path.join(root, ".cursor/agents/manual.md");
  mkdirSync(path.dirname(manualAgent), { recursive: true });
  writeFileSync(manualAgent, "# Keep me\n");

  const codexOnly = coordinatorManifestSchema.parse({
    ...manifest,
    agents: { ...manifest.agents, tools: ["codex"] },
  });
  const result = synchronizeWorkspace(root, codexOnly, "0.1.0");
  assert.equal(result.changed, true);
  assert.equal(existsSync(path.join(root, ".claude/CLAUDE.md")), false);
  assert.equal(existsSync(path.join(root, ".cursor/agents/backend.md")), false);
  assert.equal(existsSync(path.join(root, ".opencode/agents/backend.md")), false);
  assert.equal(existsSync(manualAgent), true);
  assert.equal(
    synchronizeWorkspace(root, codexOnly, "0.1.0", { check: true }).changed,
    false,
  );
});

test("workspace sync preflights unmanaged files before writing other outputs", (context) => {
  const root = temporaryDirectory();
  context.after(() => rmSync(root, { recursive: true }));
  writeFileSync(path.join(root, "AGENTS.md"), "# User-owned guide\n");
  const manifest = coordinatorManifestSchema.parse({
    schemaVersion: 1,
    name: "preflight",
    repositories: [{ id: "backend", path: "api", url: "org/api" }],
  });

  assert.throws(
    () => synchronizeWorkspace(root, manifest, "0.1.0"),
    /Refusing to overwrite unmanaged file 'AGENTS\.md'/,
  );
  assert.equal(existsSync(path.join(root, ".git-coordinator.json")), false);
});

test("workspace sync removes only an owned legacy Git adapter", (context) => {
  const root = temporaryDirectory("agent-coordinator-native-git-");
  context.after(() => rmSync(root, { recursive: true }));
  git(root, "init", "--initial-branch=main");
  const manifest = coordinatorManifestSchema.parse({
    schemaVersion: 2,
    name: "native-git",
    repositories: [{ id: "backend", path: "api", url: "org/api" }],
    agents: {
      manage: false,
      tools: ["codex"],
      maxParallel: 1,
      skillCollision: "namespace",
    },
  });
  const adapter = path.join(root, ".git-coordinator.json");
  writeFileSync(
    adapter,
    `${JSON.stringify({ generatedBy: "agent-coordinator" })}\n`,
  );

  const beforeRuntime = synchronizeWorkspace(root, manifest, "0.2.0", {
    check: true,
  });
  assert.equal(beforeRuntime.changed, false);
  assert.equal(beforeRuntime.git.action, "unchanged");
  assert.equal(existsSync(adapter), true);

  git(root, "config", "--local", "gitCoordinator.manifest", "coordinator.yaml");
  const preview = synchronizeWorkspace(root, manifest, "0.2.0", {
    check: true,
  });
  assert.equal(preview.changed, true);
  assert.equal(preview.git.action, "delete");
  synchronizeWorkspace(root, manifest, "0.2.0");
  assert.equal(existsSync(adapter), false);

  writeFileSync(adapter, '{"schemaVersion":2}\n');
  const unmanaged = synchronizeWorkspace(root, manifest, "0.2.0");
  assert.equal(unmanaged.git.action, "unchanged");
  assert.equal(existsSync(adapter), true);
});
