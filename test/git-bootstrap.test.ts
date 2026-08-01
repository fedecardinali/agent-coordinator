import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import test from "node:test";
import { CoordinatorError } from "../src/core/errors.js";
import {
  bootstrapGitCoordinator,
  gitCoordinatorCheckoutPath,
  PINNED_GIT_COORDINATOR,
  type GitCoordinatorBootstrapOptions,
  type GitCoordinatorSource,
} from "../src/git/bootstrap.js";
import { findGitCoordinator, installGitRuntime } from "../src/git/adapter.js";
import { REAL_GIT, git, temporaryDirectory } from "./helpers.js";

interface EngineFixture {
  log: string;
  options: GitCoordinatorBootstrapOptions;
  source: GitCoordinatorSource;
}

function engineFixture(): EngineFixture {
  const root = temporaryDirectory("agent-coordinator-git-engine-");
  const repository = path.join(root, "engine-source");
  const remote = path.join(root, "engine.git");
  const home = path.join(root, "agent-home");
  const log = path.join(root, "engine-invocations.log");
  mkdirSync(path.join(repository, "src"), { recursive: true });
  execFileSync(REAL_GIT, ["init", "--initial-branch=main", repository]);
  writeFileSync(
    path.join(repository, "src", "cli.mjs"),
    [
      'import { appendFileSync } from "node:fs";',
      "const destination = process.env.AGENT_COORDINATOR_TEST_ENGINE_LOG;",
      'if (destination) appendFileSync(destination, `${process.argv.slice(2).join(" ")}\\n`);',
    ].join("\n"),
  );
  git(repository, "add", ".");
  git(repository, "commit", "-m", "Pinned engine fixture");
  const ref = git(repository, "rev-parse", "HEAD");
  execFileSync(REAL_GIT, ["clone", "--bare", repository, remote]);
  const source = {
    repository: "test/git-coordinator",
    cloneUrl: remote,
    ref,
  };
  const environment = {
    ...process.env,
    AGENT_COORDINATOR_HOME: home,
    AGENT_COORDINATOR_TEST_ENGINE_LOG: log,
    PATH: "/usr/bin:/bin",
  };
  return {
    log,
    source,
    options: {
      environment,
      includeLocalCheckouts: false,
      source,
    },
  };
}

test("Git engine bootstrap creates and reuses a detached immutable checkout", () => {
  const fixture = engineFixture();
  const first = bootstrapGitCoordinator(fixture.options);
  const second = bootstrapGitCoordinator(fixture.options);

  assert.equal(first.checkout, gitCoordinatorCheckoutPath(fixture.options));
  assert.deepEqual(second, first);
  assert.equal(git(first.checkout, "rev-parse", "HEAD"), fixture.source.ref);
  assert.equal(git(first.checkout, "status", "--porcelain"), "");
  assert.deepEqual(
    findGitCoordinator(
      temporaryDirectory("agent-coordinator-cache-lookup-"),
      fixture.options,
    ),
    {
      kind: "source",
      command: process.execPath,
      arguments: [first.cli],
      path: first.cli,
    },
  );
  const symbolic = spawnSync(
    REAL_GIT,
    ["-C", first.checkout, "symbolic-ref", "--quiet", "HEAD"],
    { encoding: "utf8" },
  );
  assert.notEqual(symbolic.status, 0);
});

test("sibling engine discovery is opt-in and cannot bypass the pinned cache by default", () => {
  const root = temporaryDirectory("agent-coordinator-local-engine-");
  const workspace = path.join(root, "workspace");
  const source = path.join(root, "git-coordinator", "src", "cli.mjs");
  mkdirSync(workspace);
  mkdirSync(path.dirname(source), { recursive: true });
  writeFileSync(source, "// local development engine\n");
  const options: GitCoordinatorBootstrapOptions = {
    environment: {
      ...process.env,
      AGENT_COORDINATOR_HOME: path.join(root, "home"),
      PATH: "/usr/bin:/bin",
    },
  };

  assert.equal(findGitCoordinator(workspace, options), null);
  assert.deepEqual(
    findGitCoordinator(workspace, { ...options, includeLocalCheckouts: true }),
    {
      kind: "source",
      command: process.execPath,
      arguments: [source],
      path: source,
    },
  );
});

test("Git engine bootstrap refuses to repair or overwrite a changed cache", () => {
  const fixture = engineFixture();
  const managed = bootstrapGitCoordinator(fixture.options);
  appendFileSync(managed.cli, "// local change\n");

  assert.throws(
    () => bootstrapGitCoordinator(fixture.options),
    (error: unknown) => {
      assert.ok(error instanceof CoordinatorError);
      assert.equal(error.code, "GIT_COORDINATOR_CACHE_INVALID");
      assert.match(error.message, /left untouched/);
      return true;
    },
  );
  assert.match(readFileSync(managed.cli, "utf8"), /local change/);
});

test("Git engine bootstrap reports a missing Git installation clearly", () => {
  const root = temporaryDirectory("agent-coordinator-no-git-");
  const emptyPath = path.join(root, "empty-bin");
  mkdirSync(emptyPath);
  assert.throws(
    () =>
      bootstrapGitCoordinator({
        environment: {
          AGENT_COORDINATOR_HOME: path.join(root, "home"),
          PATH: emptyPath,
        },
        includeLocalCheckouts: false,
        source: {
          repository: "test/git-coordinator",
          cloneUrl: path.join(root, "missing.git"),
          ref: "1111111111111111111111111111111111111111",
        },
      }),
    (error: unknown) => {
      assert.ok(error instanceof CoordinatorError);
      assert.equal(error.code, "GIT_MISSING");
      assert.match(error.message, /xcode-select --install/);
      return true;
    },
  );
});

test("Git engine bootstrap retains a failed clone and explains authentication", () => {
  const root = temporaryDirectory("agent-coordinator-clone-failure-");
  const options: GitCoordinatorBootstrapOptions = {
    environment: {
      ...process.env,
      AGENT_COORDINATOR_HOME: path.join(root, "home"),
      PATH: "/usr/bin:/bin",
    },
    includeLocalCheckouts: false,
    source: {
      repository: "test/missing-git-coordinator",
      cloneUrl: path.join(root, "missing.git"),
      ref: "2222222222222222222222222222222222222222",
    },
  };
  assert.throws(
    () => bootstrapGitCoordinator(options),
    (error: unknown) => {
      assert.ok(error instanceof CoordinatorError);
      assert.equal(error.code, "GIT_COORDINATOR_BOOTSTRAP_FAILED");
      assert.match(error.message, /gh auth login/);
      assert.match(error.message, /partial cache was left untouched/);
      return true;
    },
  );
  assert.equal(
    path.resolve(gitCoordinatorCheckoutPath(options)).startsWith(
      path.resolve(root, "home"),
    ),
    true,
  );
});

test("coordinator install bootstraps the engine before global-install", () => {
  const fixture = engineFixture();
  const workspace = temporaryDirectory("agent-coordinator-install-");
  const result = installGitRuntime(workspace, fixture.options);

  assert.equal(result.status, 0);
  assert.equal(readFileSync(fixture.log, "utf8"), "global-install\n");
  assert.equal(
    git(gitCoordinatorCheckoutPath(fixture.options), "rev-parse", "HEAD"),
    fixture.source.ref,
  );
});

test("the production Git engine source is pinned to a full commit", () => {
  assert.equal(PINNED_GIT_COORDINATOR.repository, "fedecardinali/git-coordinator");
  assert.match(PINNED_GIT_COORDINATOR.ref, /^[0-9a-f]{40}$/);
});
