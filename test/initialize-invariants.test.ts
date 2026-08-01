import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import test from "node:test";
import { CoordinatorError } from "../src/core/errors.js";
import {
  coordinatorManifestSchema,
  type CoordinatorManifest,
} from "../src/core/schema.js";
import { initializeWorkspace } from "../src/workspace/initialize.js";
import {
  createChildRemote,
  git,
  REAL_GIT,
  temporaryDirectory,
} from "./helpers.js";

function manifest(
  url: string,
  branch: CoordinatorManifest["repositories"][number]["branch"] = {
    mode: "mirror",
    readOnly: false,
  },
): CoordinatorManifest {
  return coordinatorManifestSchema.parse({
    schemaVersion: 2,
    name: "invariant-fixture",
    repositories: [
      {
        id: "backend",
        path: "api",
        url,
        branch,
      },
    ],
    agents: {
      tools: ["codex"],
      maxParallel: 1,
      skillCollision: "namespace",
    },
  });
}

function initializeGitRoot(root: string): void {
  mkdirSync(root, { recursive: true });
  execFileSync(REAL_GIT, ["init", "--initial-branch=main", root]);
}

function addSubmodule(root: string, url: string): void {
  git(
    root,
    "submodule",
    "add",
    "--name",
    "backend",
    url,
    "api",
  );
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

function fakeGitCoordinator(root: string): { engine: string; log: string } {
  const engine = path.join(root, "fake-git-coordinator.mjs");
  const log = path.join(root, "git-coordinator.log");
  writeFileSync(
    engine,
    [
      'import { appendFileSync, existsSync } from "node:fs";',
      'import path from "node:path";',
      "const [command, workspace] = process.argv.slice(2);",
      "const destination = process.env.AGENT_COORDINATOR_TEST_GIT_LOG;",
      'if (destination) appendFileSync(destination, `${command} ${workspace ?? ""}`.trimEnd() + "\\n");',
      'if (["attach", "check"].includes(command) && !existsSync(path.join(workspace, "coordinator.yaml"))) process.exit(17);',
      "if (process.env.AGENT_COORDINATOR_TEST_FAIL_GIT_COMMAND === command) process.exit(19);",
    ].join("\n"),
  );
  return { engine, log };
}

test("init rejects an existing ordinary directory before writing workspace files", () => {
  const temporary = temporaryDirectory("agent-coordinator-existing-path-");
  const child = createChildRemote(temporary, "api-remote");
  const root = path.join(temporary, "workspace");
  initializeGitRoot(root);
  mkdirSync(path.join(root, "api"));
  writeFileSync(path.join(root, "api", "keep.txt"), "keep\n");

  assert.throws(
    () =>
      initializeWorkspace(root, manifest(child.remote), "0.1.0", {
        installHooks: false,
      }),
    (error: unknown) => {
      assert.ok(error instanceof CoordinatorError);
      assert.equal(error.code, "EXISTING_PATH_NOT_DECLARED_SUBMODULE");
      assert.match(error.message, /cannot be adopted/);
      return true;
    },
  );
  assert.equal(readFileSync(path.join(root, "api", "keep.txt"), "utf8"), "keep\n");
  assert.equal(existsSync(path.join(root, "coordinator.yaml")), false);
  assert.equal(existsSync(path.join(root, ".git-coordinator.json")), false);
});

test("init rejects an existing submodule whose declared URL differs", () => {
  const temporary = temporaryDirectory("agent-coordinator-url-mismatch-");
  const actual = createChildRemote(temporary, "actual");
  const expected = createChildRemote(temporary, "expected");
  const root = path.join(temporary, "workspace");
  initializeGitRoot(root);
  addSubmodule(root, actual.remote);
  const before = readFileSync(path.join(root, ".gitmodules"), "utf8");

  assert.throws(
    () =>
      initializeWorkspace(root, manifest(expected.remote), "0.1.0", {
        installHooks: false,
      }),
    (error: unknown) => {
      assert.ok(error instanceof CoordinatorError);
      assert.equal(error.code, "EXISTING_PATH_NOT_DECLARED_SUBMODULE");
      assert.match(error.message, /URL/);
      return true;
    },
  );
  assert.equal(readFileSync(path.join(root, ".gitmodules"), "utf8"), before);
  assert.equal(existsSync(path.join(root, "coordinator.yaml")), false);
});

test("init rejects a submodule whose HEAD moved away from its gitlink", () => {
  const temporary = temporaryDirectory("agent-coordinator-gitlink-mismatch-");
  const child = createChildRemote(temporary, "api-remote");
  const root = path.join(temporary, "workspace");
  initializeGitRoot(root);
  addSubmodule(root, child.remote);
  writeFileSync(path.join(root, "api", "local.txt"), "local\n");
  git(path.join(root, "api"), "add", ".");
  git(path.join(root, "api"), "commit", "-m", "Move child HEAD");

  assert.throws(
    () =>
      initializeWorkspace(root, manifest(child.remote), "0.1.0", {
        installHooks: false,
      }),
    (error: unknown) => {
      assert.ok(error instanceof CoordinatorError);
      assert.equal(error.code, "EXISTING_PATH_NOT_DECLARED_SUBMODULE");
      assert.match(error.message, /does not match gitlink/);
      return true;
    },
  );
  assert.equal(existsSync(path.join(root, "coordinator.yaml")), false);
  assert.equal(readFileSync(path.join(root, "api", "local.txt"), "utf8"), "local\n");
});

test("--no-hooks validates topology without resolving or invoking a runtime", () => {
  const temporary = temporaryDirectory("agent-coordinator-no-hooks-");
  const child = createChildRemote(temporary, "api-remote");
  const root = path.join(temporary, "workspace");
  initializeGitRoot(root);
  addSubmodule(root, child.remote);

  const result = withEnvironment(
    {
      AGENT_COORDINATOR_GIT_COORDINATOR: path.join(temporary, "missing-engine"),
    },
    () =>
      initializeWorkspace(root, manifest(child.remote), "0.1.0", {
        installHooks: false,
      }),
  );

  assert.equal(result.gitIntegration.mode, "configuration-only");
  assert.equal(result.gitIntegration.configurationValidated, true);
  assert.equal(result.gitIntegration.hooksInstalled, false);
  assert.equal(result.gitIntegration.attached, false);
  assert.equal(result.gitIntegration.invariantChecked, false);
  assert.deepEqual(result.gitIntegration.validatedSubmodules, ["backend"]);
  assert.match(result.gitIntegration.detail, /runtime bootstrap.*skipped/);
});

test("--no-hooks with --no-submodules reports configuration-only validation", () => {
  const temporary = temporaryDirectory("agent-coordinator-config-only-");
  const child = createChildRemote(temporary, "api-remote");
  const root = path.join(temporary, "workspace");

  const result = withEnvironment(
    {
      AGENT_COORDINATOR_GIT_COORDINATOR: path.join(temporary, "missing-engine"),
    },
    () =>
      initializeWorkspace(root, manifest(child.remote), "0.1.0", {
        addSubmodules: false,
        installHooks: false,
      }),
  );

  assert.equal(result.gitIntegration.mode, "configuration-only");
  assert.equal(result.gitIntegration.configurationValidated, true);
  assert.deepEqual(result.gitIntegration.validatedSubmodules, []);
  assert.deepEqual(result.gitIntegration.missingSubmodules, ["backend"]);
  assert.equal(existsSync(path.join(root, ".git-coordinator.json")), false);
  assert.equal(existsSync(path.join(root, "coordinator.yaml")), true);
  assert.equal(existsSync(path.join(root, "api")), false);
});

test("active init installs, attaches, and checks before returning success", () => {
  const temporary = temporaryDirectory("agent-coordinator-attach-check-");
  const child = createChildRemote(temporary, "api-remote");
  const root = path.join(temporary, "workspace");
  const fake = fakeGitCoordinator(temporary);

  const result = withEnvironment(
    {
      AGENT_COORDINATOR_GIT_COORDINATOR: fake.engine,
      AGENT_COORDINATOR_TEST_FAIL_GIT_COMMAND: undefined,
      AGENT_COORDINATOR_TEST_GIT_LOG: fake.log,
    },
    () => initializeWorkspace(root, manifest(child.remote), "0.1.0"),
  );

  assert.equal(
    readFileSync(fake.log, "utf8"),
    `global-install\ninstall ${root}\nattach ${root}\ncheck ${root}\n`,
  );
  assert.equal(result.gitIntegration.mode, "active");
  assert.equal(result.gitIntegration.hooksInstalled, true);
  assert.equal(result.gitIntegration.attached, true);
  assert.equal(result.gitIntegration.invariantChecked, true);
});

test("init does not return success when the final invariant check fails", () => {
  const temporary = temporaryDirectory("agent-coordinator-check-failure-");
  const child = createChildRemote(temporary, "api-remote");
  const root = path.join(temporary, "workspace");
  const fake = fakeGitCoordinator(temporary);

  assert.throws(
    () =>
      withEnvironment(
        {
          AGENT_COORDINATOR_GIT_COORDINATOR: fake.engine,
          AGENT_COORDINATOR_TEST_FAIL_GIT_COMMAND: "check",
          AGENT_COORDINATOR_TEST_GIT_LOG: fake.log,
        },
        () => initializeWorkspace(root, manifest(child.remote), "0.1.0"),
      ),
    (error: unknown) => {
      assert.ok(error instanceof CoordinatorError);
      assert.equal(error.code, "COMMAND_FAILED");
      assert.match(error.message, /check/);
      return true;
    },
  );
  assert.equal(
    readFileSync(fake.log, "utf8"),
    `global-install\ninstall ${root}\nattach ${root}\ncheck ${root}\n`,
  );
});

test("a missing fixed branch fails before changing an existing directory", () => {
  const temporary = temporaryDirectory("agent-coordinator-fixed-missing-");
  const child = createChildRemote(temporary, "api-remote");
  const root = path.join(temporary, "workspace");
  mkdirSync(root);
  writeFileSync(path.join(root, "keep.txt"), "keep\n");

  assert.throws(
    () =>
      initializeWorkspace(
        root,
        manifest(child.remote, {
          mode: "fixed",
          name: "stable",
          readOnly: true,
        }),
        "0.1.0",
        { installHooks: false },
      ),
    (error: unknown) => {
      assert.ok(error instanceof CoordinatorError);
      assert.equal(error.code, "FIXED_BRANCH_MISSING");
      assert.match(error.message, /fixed branch 'stable'/);
      return true;
    },
  );
  assert.equal(readFileSync(path.join(root, "keep.txt"), "utf8"), "keep\n");
  assert.equal(existsSync(path.join(root, ".git")), false);
  assert.equal(existsSync(path.join(root, "coordinator.yaml")), false);
});

test("a present fixed branch becomes the initial submodule gitlink", () => {
  const temporary = temporaryDirectory("agent-coordinator-fixed-present-");
  const child = createChildRemote(temporary, "api-remote");
  git(child.source, "branch", "stable");
  git(child.source, "push", child.remote, "stable");
  const root = path.join(temporary, "workspace");

  const result = initializeWorkspace(
    root,
    manifest(child.remote, {
      mode: "fixed",
      name: "stable",
      readOnly: true,
    }),
    "0.1.0",
    { installHooks: false },
  );

  assert.equal(git(path.join(root, "api"), "branch", "--show-current"), "stable");
  assert.equal(
    git(root, "rev-parse", ":api"),
    git(child.remote, "rev-parse", "refs/heads/stable"),
  );
  assert.equal(result.gitIntegration.mode, "configuration-only");
  assert.deepEqual(result.gitIntegration.missingSubmodules, []);
});

test("a mapped initial branch pins the mapped remote head", () => {
  const temporary = temporaryDirectory("agent-coordinator-map-present-");
  const child = createChildRemote(temporary, "api-remote");
  git(child.source, "checkout", "-b", "release");
  writeFileSync(path.join(child.source, "release.txt"), "release\n");
  git(child.source, "add", ".");
  git(child.source, "commit", "-m", "Advance release");
  git(child.source, "push", child.remote, "release");
  git(child.source, "checkout", "main");
  const root = path.join(temporary, "workspace");

  initializeWorkspace(
    root,
    manifest(child.remote, {
      mode: "map",
      branches: { main: "release" },
      readOnly: false,
    }),
    "0.1.0",
    { installHooks: false },
  );

  assert.equal(git(path.join(root, "api"), "branch", "--show-current"), "release");
  assert.equal(
    git(root, "rev-parse", ":api"),
    git(child.remote, "rev-parse", "refs/heads/release"),
  );
});
