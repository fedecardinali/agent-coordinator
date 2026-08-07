import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import test from "node:test";
import { CoordinatorError } from "../src/core/errors.js";
import {
  coordinatorManifestSchema,
  type CoordinatorManifest,
} from "../src/core/schema.js";
import {
  applyNestedSubmoduleRepair,
  NestedSubmoduleRepairRequiredError,
  planNestedSubmoduleRepair,
  redactNestedSubmoduleDiagnostic,
  type NestedSubmoduleRepairPlan,
} from "../src/workspace/nested-repair.js";
import { initializeWorkspace } from "../src/workspace/initialize.js";
import {
  git,
  REAL_GIT,
  temporaryDirectory,
} from "./helpers.js";

const nestedPath = ".agent-runtime/runtime";
const repositoryPath = "application";
const brokenRevision = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef";

interface RepairFixture {
  defaultRevision: string;
  manifest: CoordinatorManifest;
  nestedRemote: string;
  nestedSource: string;
  parentDirectory: string;
  parentRemote: string;
  previousRevision: string;
  repository: CoordinatorManifest["repositories"][number];
  root: string;
}

interface RepairFixtureOptions {
  nestedName?: string;
  relativeNestedUrl?: boolean;
  trackedParentRemote?: boolean;
}

function cloneBare(source: string, destination: string): void {
  execFileSync(REAL_GIT, ["clone", "--quiet", "--bare", source, destination]);
}

function writeAndCommit(
  directory: string,
  relativePath: string,
  content: string,
  message: string,
): string {
  writeFileSync(path.join(directory, relativePath), content);
  git(directory, "add", relativePath);
  git(directory, "commit", "-m", message);
  return git(directory, "rev-parse", "HEAD");
}

function failedNestedUpdate(parentDirectory: string): void {
  const result = spawnSync(
    REAL_GIT,
    [
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "protocol.file.allow=always",
      "-C",
      parentDirectory,
      "submodule",
      "update",
      "--init",
      "--recursive",
      "--checkout",
      "--",
      nestedPath,
    ],
    { encoding: "utf8" },
  );
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}${result.stderr}`, /not our ref|did not contain|Direct fetching/);
  git(parentDirectory, "submodule", "deinit", "-f", "--", nestedPath);
}

function createFixture(
  testContext: test.TestContext,
  options: RepairFixtureOptions = {},
): RepairFixture {
  const temporary = temporaryDirectory("agent-coordinator-nested-repair-");
  testContext.after(() => rmSync(temporary, { recursive: true }));

  const nestedSource = path.join(temporary, "runtime-source");
  const nestedRemote = path.join(temporary, "runtime.git");
  mkdirSync(nestedSource);
  git(nestedSource, "init", "--initial-branch=main");
  const previousRevision = writeAndCommit(
    nestedSource,
    "runtime.txt",
    "version one\n",
    "Add runtime version one",
  );
  cloneBare(nestedSource, nestedRemote);

  const parentSource = path.join(temporary, "parent-source");
  const parentRemote = path.join(temporary, "parent.git");
  mkdirSync(parentSource);
  git(parentSource, "init", "--initial-branch=main");
  const nestedName = options.nestedName ?? nestedPath;
  const submoduleArguments = ["submodule", "add"];
  if (options.nestedName) {
    submoduleArguments.push("--name", nestedName);
  }
  submoduleArguments.push(nestedRemote, nestedPath);
  git(parentSource, ...submoduleArguments);
  if (options.relativeNestedUrl) {
    git(
      parentSource,
      "config",
      "--file",
      ".gitmodules",
      `submodule.${nestedName}.url`,
      "../runtime.git",
    );
    git(parentSource, "add", ".gitmodules");
  }
  git(parentSource, "commit", "-m", "Pin runtime version one");

  const defaultRevision = writeAndCommit(
    nestedSource,
    "runtime.txt",
    "version two\n",
    "Add runtime version two",
  );
  git(nestedSource, "push", nestedRemote, "main");

  git(
    parentSource,
    "update-index",
    "--cacheinfo",
    "160000",
    brokenRevision,
    nestedPath,
  );
  git(parentSource, "commit", "-m", "Pin unavailable runtime revision");
  cloneBare(parentSource, parentRemote);

  const root = path.join(temporary, "workspace");
  mkdirSync(root);
  git(root, "init", "--initial-branch=main");
  git(
    root,
    "submodule",
    "add",
    "--name",
    "application",
    parentRemote,
    repositoryPath,
  );
  const parentDirectory = path.join(root, repositoryPath);
  if (options.trackedParentRemote) {
    git(parentDirectory, "remote", "rename", "origin", "upstream");
    git(
      parentDirectory,
      "remote",
      "add",
      "origin",
      path.join(temporary, "wrong-parent.git"),
    );
    git(parentDirectory, "config", "branch.main.remote", "upstream");
  }
  git(parentDirectory, "config", "user.name", "Agent Coordinator Test");
  git(
    parentDirectory,
    "config",
    "user.email",
    "agent-coordinator@example.test",
  );
  failedNestedUpdate(parentDirectory);

  const manifest = coordinatorManifestSchema.parse({
    schemaVersion: 2,
    name: "nested-repair-fixture",
    repositories: [
      {
        id: "application",
        path: repositoryPath,
        url: parentRemote,
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

  return {
    defaultRevision,
    manifest,
    nestedRemote,
    nestedSource,
    parentDirectory,
    parentRemote,
    previousRevision,
    repository: manifest.repositories[0]!,
    root,
  };
}

function rootGitlink(fixture: RepairFixture): string {
  return git(fixture.root, "rev-parse", `:${repositoryPath}`);
}

function nestedGitlink(fixture: RepairFixture): string {
  return git(fixture.parentDirectory, "rev-parse", `:${nestedPath}`);
}

function remoteRefs(remote: string): string {
  return git(remote, "show-ref");
}

function plan(fixture: RepairFixture): NestedSubmoduleRepairPlan {
  return planNestedSubmoduleRepair(
    fixture.root,
    fixture.repository,
    nestedPath,
  );
}

test("nested repair plan offers the prior reachable pin and current remote HEAD without mutating", (context) => {
  const fixture = createFixture(context);
  const parentBefore = git(fixture.parentDirectory, "rev-parse", "HEAD");
  const rootBefore = rootGitlink(fixture);
  const nestedBefore = nestedGitlink(fixture);
  const parentRemoteBefore = remoteRefs(fixture.parentRemote);
  const nestedRemoteBefore = remoteRefs(fixture.nestedRemote);

  const result = plan(fixture);

  assert.equal(result.baseline.parentRevision, parentBefore);
  assert.equal(result.baseline.rootGitlinkRevision, rootBefore);
  assert.equal(result.baseline.pinnedRevision, brokenRevision);
  assert.equal(result.effects.createsLocalCommit, true);
  assert.equal(result.effects.updatesCoordinatorGitlink, true);
  assert.equal(result.effects.pushes, false);
  assert.equal(result.effects.retriesInitialization, true);
  assert.match(result.fingerprint, /^[0-9a-f]{64}$/);
  assert.deepEqual(
    result.candidates.map(({ revision, sources }) => ({ revision, sources })),
    [
      {
        revision: fixture.previousRevision,
        sources: ["previous-reachable-pin"],
      },
      {
        revision: fixture.defaultRevision,
        sources: ["remote-default-head"],
      },
    ],
  );
  assert.equal(git(fixture.parentDirectory, "rev-parse", "HEAD"), parentBefore);
  assert.equal(rootGitlink(fixture), rootBefore);
  assert.equal(nestedGitlink(fixture), nestedBefore);
  assert.equal(git(fixture.parentDirectory, "status", "--porcelain"), "");
  assert.equal(remoteRefs(fixture.parentRemote), parentRemoteBefore);
  assert.equal(remoteRefs(fixture.nestedRemote), nestedRemoteBefore);

  const diagnostic = new NestedSubmoduleRepairRequiredError(
    result,
    "fatal: https://user:secret@github.com/acme/runtime.git did not contain the pin",
  );
  assert.doesNotMatch(diagnostic.message, /user|secret/);
  assert.match(diagnostic.message, /git@github\.com:acme\/runtime\.git/);
});

test("nested repair resolves a relative .gitmodules URL from the parent branch tracking remote", (context) => {
  const fixture = createFixture(context, {
    relativeNestedUrl: true,
    trackedParentRemote: true,
  });
  git(
    fixture.parentDirectory,
    "remote",
    "set-url",
    "upstream",
    "corp:acme/parent.git",
  );
  git(
    fixture.parentDirectory,
    "config",
    `url.${path.dirname(fixture.parentRemote)}/.insteadOf`,
    "corp:acme/",
  );

  const result = plan(fixture);

  assert.equal(result.remote.displayUrl, "corp:acme/runtime.git");
  assert.deepEqual(
    result.candidates.map(({ revision }) => revision),
    [fixture.previousRevision, fixture.defaultRevision],
  );
});

test("nested repair locates the failed clone cache by logical submodule name", (context) => {
  const fixture = createFixture(context, { nestedName: "runtime-cache" });

  const result = plan(fixture);

  assert.equal(result.baseline.pinnedRevision, brokenRevision);
  assert.equal(result.candidates[0]?.revision, fixture.previousRevision);
});

test("nested repair refuses a logical name whose cache escapes the parent modules directory", (context) => {
  const fixture = createFixture(context);
  const modulesFile = path.join(fixture.parentDirectory, ".gitmodules");
  const originalModules = readFileSync(modulesFile, "utf8");
  const unsafeModules = originalModules.replace(
    `[submodule "${nestedPath}"]`,
    `[submodule "../../outside-cache"]`,
  );
  assert.notEqual(unsafeModules, originalModules);
  writeFileSync(modulesFile, unsafeModules);
  git(fixture.parentDirectory, "add", ".gitmodules");
  git(fixture.parentDirectory, "commit", "-m", "Use unsafe logical name");
  const parentRevision = git(fixture.parentDirectory, "rev-parse", "HEAD");
  git(
    fixture.root,
    "update-index",
    "--cacheinfo",
    "160000",
    parentRevision,
    repositoryPath,
  );
  const modulesRoot = git(
    fixture.parentDirectory,
    "rev-parse",
    "--git-path",
    "modules",
  );
  mkdirSync(path.resolve(fixture.parentDirectory, modulesRoot, "../../outside-cache"), {
    recursive: true,
  });

  assert.throws(
    () => plan(fixture),
    (error: unknown) => {
      assert.ok(error instanceof CoordinatorError);
      assert.equal(error.code, "NESTED_SUBMODULE_REPAIR_UNAVAILABLE");
      assert.match(error.message, /outside the parent Git modules directory/);
      return true;
    },
  );
});

test("nested repair rejects terminal control characters in nested paths without echoing them", (context) => {
  const fixture = createFixture(context);
  const unsafePath = `${nestedPath}\u001b[31m`;

  assert.throws(
    () =>
      planNestedSubmoduleRepair(
        fixture.root,
        fixture.repository,
        unsafePath,
      ),
    (error: unknown) => {
      assert.ok(error instanceof CoordinatorError);
      assert.equal(error.code, "NESTED_SUBMODULE_REPAIR_UNAVAILABLE");
      assert.doesNotMatch(error.message, /\u001b/);
      return true;
    },
  );
});

test("nested repair diagnostics redact URL and SCP credentials on arbitrary hosts", () => {
  const safe = redactNestedSubmoduleDiagnostic(
    "fatal: https://alice:s3cret@git.example.test/acme/runtime.git?token=private, git://service:git-secret@git.transport.test/acme/runtime.git?key=value and oauth2:scp-secret@git.internal.example:acme/runtime.git",
  );

  assert.doesNotMatch(
    safe,
    /alice|s3cret|private|service|git-secret|key=value|oauth2|scp-secret/,
  );
  assert.match(safe, /https:\/\/git\.example\.test\/acme\/runtime\.git/);
  assert.match(safe, /git:\/\/git\.transport\.test\/acme\/runtime\.git/);
  assert.match(safe, /git@git\.internal\.example:acme\/runtime\.git/);
});

test("nested repair redacts a credentialed custom SCP remote in plans and lookup failures", (context) => {
  const fixture = createFixture(context);
  const credentialedRemote =
    "oauth2:custom-secret@git.internal.example:acme/runtime.git";
  const rewriteKey = `url.${fixture.nestedRemote}.insteadOf`;
  git(fixture.parentDirectory, "config", rewriteKey, credentialedRemote);
  git(
    fixture.parentDirectory,
    "config",
    `submodule.${nestedPath}.url`,
    credentialedRemote,
  );

  const result = plan(fixture);
  assert.equal(
    result.remote.displayUrl,
    "git@git.internal.example:acme/runtime.git",
  );
  assert.doesNotMatch(result.remote.displayUrl, /oauth2|custom-secret/);

  git(fixture.parentDirectory, "config", "--unset-all", rewriteKey);
  const missingRemote = path.join(fixture.root, "missing-runtime.git");
  git(
    fixture.parentDirectory,
    "config",
    `url.${missingRemote}.insteadOf`,
    credentialedRemote,
  );
  assert.throws(
    () => plan(fixture),
    (error: unknown) => {
      assert.ok(error instanceof CoordinatorError);
      assert.equal(error.code, "NESTED_SUBMODULE_REPAIR_UNAVAILABLE");
      assert.doesNotMatch(error.message, /oauth2|custom-secret/);
      assert.match(
        error.message,
        /git@git\.internal\.example:acme\/runtime\.git/,
      );
      return true;
    },
  );
});

test("nested repair creates one local commit, updates the root gitlink, never pushes, and permits init retry", (context) => {
  const fixture = createFixture(context);
  const repairPlan = plan(fixture);
  const parentBefore = repairPlan.baseline.parentRevision;
  const parentRemoteBefore = remoteRefs(fixture.parentRemote);
  const nestedRemoteBefore = remoteRefs(fixture.nestedRemote);

  const result = applyNestedSubmoduleRepair(repairPlan, {
    approveLocalCommit: true,
    candidateRevision: fixture.previousRevision,
    commitMessage: "fix: restore reachable runtime pin",
  });

  assert.equal(result.previousParentCommit, parentBefore);
  assert.equal(result.previousPinnedRevision, brokenRevision);
  assert.equal(result.candidateRevision, fixture.previousRevision);
  assert.equal(result.pushed, false);
  assert.equal(result.rootGitlinkUpdated, true);
  assert.equal(
    git(fixture.parentDirectory, "rev-list", "--count", `${parentBefore}..${result.parentCommit}`),
    "1",
  );
  assert.equal(
    git(
      fixture.parentDirectory,
      "diff-tree",
      "--no-commit-id",
      "--name-only",
      "-r",
      result.parentCommit,
    ),
    nestedPath,
  );
  assert.equal(nestedGitlink(fixture), fixture.previousRevision);
  assert.equal(rootGitlink(fixture), result.parentCommit);
  assert.equal(git(fixture.parentDirectory, "status", "--porcelain"), "");
  assert.equal(remoteRefs(fixture.parentRemote), parentRemoteBefore);
  assert.equal(remoteRefs(fixture.nestedRemote), nestedRemoteBefore);

  const initialized = initializeWorkspace(
    fixture.root,
    fixture.manifest,
    "0.3.0",
    { installHooks: false },
  );
  assert.equal(initialized.gitIntegration.mode, "configuration-only");
  assert.deepEqual(initialized.gitIntegration.missingSubmodules, []);
  assert.equal(
    git(path.join(fixture.parentDirectory, nestedPath), "rev-parse", "HEAD"),
    fixture.previousRevision,
  );
});

test("nested repair rejects missing approval, forged plans, and stale plans without local mutation", (context) => {
  const fixture = createFixture(context);
  const repairPlan = plan(fixture);
  const parentBefore = repairPlan.baseline.parentRevision;
  const rootBefore = rootGitlink(fixture);

  assert.throws(
    () =>
      applyNestedSubmoduleRepair(repairPlan, {
        approveLocalCommit: false,
        candidateRevision: fixture.previousRevision,
      } as unknown as Parameters<typeof applyNestedSubmoduleRepair>[1]),
    (error: unknown) => {
      assert.ok(error instanceof CoordinatorError);
      assert.equal(error.code, "NESTED_SUBMODULE_REPAIR_APPROVAL_REQUIRED");
      return true;
    },
  );

  assert.throws(
    () =>
      applyNestedSubmoduleRepair(structuredClone(repairPlan), {
        approveLocalCommit: true,
        candidateRevision: fixture.previousRevision,
      }),
    (error: unknown) => {
      assert.ok(error instanceof CoordinatorError);
      assert.equal(error.code, "NESTED_SUBMODULE_REPAIR_PLAN_INVALID");
      return true;
    },
  );

  writeAndCommit(
    fixture.nestedSource,
    "runtime.txt",
    "version three\n",
    "Add runtime version three",
  );
  git(fixture.nestedSource, "push", fixture.nestedRemote, "main");
  const nestedRemoteAfterExternalChange = remoteRefs(fixture.nestedRemote);

  assert.throws(
    () =>
      applyNestedSubmoduleRepair(repairPlan, {
        approveLocalCommit: true,
        candidateRevision: fixture.previousRevision,
      }),
    (error: unknown) => {
      assert.ok(error instanceof CoordinatorError);
      assert.equal(error.code, "NESTED_SUBMODULE_REPAIR_PLAN_STALE");
      return true;
    },
  );
  assert.equal(git(fixture.parentDirectory, "rev-parse", "HEAD"), parentBefore);
  assert.equal(rootGitlink(fixture), rootBefore);
  assert.equal(nestedGitlink(fixture), brokenRevision);
  assert.equal(git(fixture.parentDirectory, "status", "--porcelain"), "");
  assert.equal(remoteRefs(fixture.nestedRemote), nestedRemoteAfterExternalChange);
});

test("nested repair rejects a mutated public plan and applies from an immutable repository snapshot", (context) => {
  const fixture = createFixture(context);
  const repairPlan = plan(fixture);
  const originalParentDirectory = repairPlan.parentDirectory;
  repairPlan.parentDirectory = path.join(fixture.root, "forged-parent");

  assert.throws(
    () =>
      applyNestedSubmoduleRepair(repairPlan, {
        approveLocalCommit: true,
        candidateRevision: fixture.previousRevision,
      }),
    (error: unknown) => {
      assert.ok(error instanceof CoordinatorError);
      assert.equal(error.code, "NESTED_SUBMODULE_REPAIR_PLAN_INVALID");
      return true;
    },
  );
  assert.equal(nestedGitlink(fixture), brokenRevision);

  repairPlan.parentDirectory = originalParentDirectory;
  fixture.repository.path = "externally-mutated-path";
  fixture.repository.id = "externally-mutated-id";
  const result = applyNestedSubmoduleRepair(repairPlan, {
    approveLocalCommit: true,
    candidateRevision: fixture.previousRevision,
  });

  assert.equal(result.repositoryId, "application");
  assert.equal(result.candidateRevision, fixture.previousRevision);
  assert.equal(rootGitlink(fixture), result.parentCommit);
});

test("nested repair rolls back the parent commit and gitlink when the root index update fails", (context) => {
  const fixture = createFixture(context);
  const repairPlan = plan(fixture);
  const parentBefore = repairPlan.baseline.parentRevision;
  const rootBefore = rootGitlink(fixture);
  const parentRemoteBefore = remoteRefs(fixture.parentRemote);
  const lockPath = path.join(fixture.root, ".git", "index.lock");
  writeFileSync(lockPath, "owned by rollback test\n");

  try {
    assert.throws(
      () =>
        applyNestedSubmoduleRepair(repairPlan, {
          approveLocalCommit: true,
          candidateRevision: fixture.previousRevision,
        }),
      (error: unknown) => {
        assert.ok(error instanceof CoordinatorError);
        assert.equal(error.code, "NESTED_SUBMODULE_REPAIR_FAILED");
        assert.match(error.message, /rolled back/);
        return true;
      },
    );
  } finally {
    assert.equal(readFileSync(lockPath, "utf8"), "owned by rollback test\n");
    unlinkSync(lockPath);
  }

  assert.equal(git(fixture.parentDirectory, "rev-parse", "HEAD"), parentBefore);
  assert.equal(rootGitlink(fixture), rootBefore);
  assert.equal(nestedGitlink(fixture), brokenRevision);
  assert.equal(git(fixture.parentDirectory, "status", "--porcelain"), "");
  assert.equal(remoteRefs(fixture.parentRemote), parentRemoteBefore);
});
