import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import test from "node:test";
import { CoordinatorError } from "../src/core/errors.js";
import {
  installMachineGitRuntime,
  installedGitRuntimePath,
  installWorkspaceGitIntegration,
  uninstallMachineGitRuntime,
  uninstallWorkspaceGitIntegration,
} from "../src/git/install.js";
import { git, temporaryDirectory } from "./helpers.js";

function isolatedEnvironment(root: string): NodeJS.ProcessEnv {
  const bin = path.join(root, "bin");
  mkdirSync(bin);
  return {
    ...process.env,
    AGENT_COORDINATOR_HOME: path.join(root, "agent-home"),
    AGENT_COORDINATOR_GIT_BIN_DIR: bin,
    PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
  };
}

function workspace(root: string): void {
  mkdirSync(root);
  git(root, "init", "--initial-branch=main");
  writeFileSync(
    path.join(root, "coordinator.yaml"),
    "schemaVersion: 2\nname: fixture\nrepositories: []\n",
  );
}

function hookCommand(root: string): string {
  const mode = git(root, "config", "--local", "--get", "gitCoordinator.hookMode");
  if (mode === "configured") {
    return git(
      root,
      "config",
      "--local",
      "--get",
      "hook.git-coordinator-pre-push.command",
    );
  }
  const hooksPath = git(root, "config", "--local", "--get", "core.hooksPath");
  return readFileSync(path.join(hooksPath, "pre-push"), "utf8");
}

test("machine install retires recognized legacy shims without deleting rollback files", (context) => {
  const temporary = temporaryDirectory("agent-coordinator-legacy-install-");
  context.after(() => rmSync(temporary, { recursive: true }));
  const environment = isolatedEnvironment(temporary);
  const legacyHome = path.join(temporary, "legacy-home");
  environment.GIT_COORDINATOR_HOME = legacyHome;
  const legacyRuntime = path.join(legacyHome, "src", "git-wrapper.mjs");
  const legacyCli = path.join(legacyHome, "src", "cli.mjs");
  mkdirSync(path.dirname(legacyRuntime), { recursive: true });
  writeFileSync(legacyRuntime, "#!/usr/bin/env node\n/* git-coordinator-wrapper-v1 */\n");
  writeFileSync(legacyCli, "#!/usr/bin/env node\n/* git-coordinator-wrapper-v1 */\n");
  chmodSync(legacyRuntime, 0o755);
  chmodSync(legacyCli, 0o755);
  const bin = environment.AGENT_COORDINATOR_GIT_BIN_DIR!;
  symlinkSync(legacyRuntime, path.join(bin, "git"));
  symlinkSync(legacyCli, path.join(bin, "git-coordinator"));

  installMachineGitRuntime({ environment });
  const installed = installedGitRuntimePath(environment);
  assert.equal(realpathSync(path.join(bin, "git")), realpathSync(installed));
  assert.equal(existsSync(path.join(bin, "git-coordinator")), false);
  assert.equal(existsSync(legacyRuntime), true);
  assert.equal(existsSync(legacyCli), true);

  uninstallMachineGitRuntime({ environment });
  assert.equal(existsSync(path.join(bin, "git")), false);
  assert.equal(existsSync(installed), false);
  assert.equal(existsSync(legacyRuntime), true);
});

test("machine install refuses an unmanaged git executable before writing runtime state", (context) => {
  const temporary = temporaryDirectory("agent-coordinator-unmanaged-install-");
  context.after(() => rmSync(temporary, { recursive: true }));
  const environment = isolatedEnvironment(temporary);
  const executable = path.join(environment.AGENT_COORDINATOR_GIT_BIN_DIR!, "git");
  writeFileSync(executable, "#!/bin/sh\nexit 42\n");
  chmodSync(executable, 0o755);

  assert.throws(
    () => installMachineGitRuntime({ environment }),
    (error: unknown) =>
      error instanceof CoordinatorError &&
      error.code === "UNMANAGED_GIT_EXECUTABLE",
  );
  assert.equal(readFileSync(executable, "utf8"), "#!/bin/sh\nexit 42\n");
  assert.equal(existsSync(installedGitRuntimePath(environment)), false);
});

test("workspace reinstall preserves Husky and points hooks at the embedded runtime", (context) => {
  const temporary = temporaryDirectory("agent-coordinator-husky-reinstall-");
  context.after(() => rmSync(temporary, { recursive: true }));
  const environment = isolatedEnvironment(temporary);
  const root = path.join(temporary, "workspace");
  workspace(root);
  mkdirSync(path.join(root, ".husky", "_"), { recursive: true });
  git(root, "config", "--local", "core.hooksPath", ".husky/_");
  installMachineGitRuntime({ environment });

  installWorkspaceGitIntegration(root, { environment });
  const preserved = git(
    root,
    "config",
    "--local",
    "--get",
    "gitCoordinator.previousHooksPath",
  );
  assert.equal(preserved, realpathSync(path.join(root, ".husky", "_")));
  assert.match(hookCommand(root), new RegExp(installedGitRuntimePath(environment)));

  installWorkspaceGitIntegration(root, { environment });
  assert.equal(
    git(root, "config", "--local", "--get", "gitCoordinator.previousHooksPath"),
    preserved,
  );
  assert.match(hookCommand(root), new RegExp(installedGitRuntimePath(environment)));

  const managedHooks = git(root, "config", "--local", "--get", "core.hooksPath");
  uninstallWorkspaceGitIntegration(root, { environment });
  assert.equal(git(root, "config", "--local", "--get", "core.hooksPath"), preserved);
  assert.equal(existsSync(managedHooks), false);
  assert.throws(() =>
    git(root, "config", "--local", "--get", "gitCoordinator.previousHooksPath"),
  );
});

test("workspace reinstall does not remember its own managed hooks as a previous path", (context) => {
  const temporary = temporaryDirectory("agent-coordinator-managed-reinstall-");
  context.after(() => rmSync(temporary, { recursive: true }));
  const environment = isolatedEnvironment(temporary);
  const root = path.join(temporary, "workspace");
  workspace(root);
  const managedHooks = path.join(root, ".git", "git-coordinator-hooks");
  mkdirSync(managedHooks);
  git(root, "config", "--local", "core.hooksPath", managedHooks);
  installMachineGitRuntime({ environment });

  installWorkspaceGitIntegration(root, { environment });
  assert.throws(() =>
    git(root, "config", "--local", "--get", "gitCoordinator.previousHooksPath"),
  );
  assert.match(hookCommand(root), new RegExp(installedGitRuntimePath(environment)));
});

test("workspace install refuses a colliding unmanaged hooks directory", (context) => {
  const temporary = temporaryDirectory("agent-coordinator-unmanaged-hooks-");
  context.after(() => rmSync(temporary, { recursive: true }));
  const environment = isolatedEnvironment(temporary);
  const root = path.join(temporary, "workspace");
  workspace(root);
  mkdirSync(path.join(root, ".husky", "_"), { recursive: true });
  git(root, "config", "--local", "core.hooksPath", ".husky/_");
  const hooksDirectory = path.join(root, ".git", "git-coordinator-hooks");
  const userHook = path.join(hooksDirectory, "pre-commit");
  mkdirSync(hooksDirectory);
  writeFileSync(userHook, "#!/bin/sh\necho user-owned\n");
  chmodSync(userHook, 0o755);
  installMachineGitRuntime({ environment });

  assert.throws(
    () => installWorkspaceGitIntegration(root, { environment }),
    (error: unknown) =>
      error instanceof CoordinatorError && error.code === "UNMANAGED_GIT_HOOK",
  );
  assert.equal(readFileSync(userHook, "utf8"), "#!/bin/sh\necho user-owned\n");
  assert.equal(git(root, "config", "--local", "--get", "core.hooksPath"), ".husky/_");
  assert.throws(() =>
    git(root, "config", "--local", "--get", "gitCoordinator.previousHooksPath"),
  );
});
