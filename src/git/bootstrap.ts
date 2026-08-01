import {
  existsSync,
  mkdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { runCommand } from "../core/command.js";
import { CoordinatorError } from "../core/errors.js";

export interface GitCoordinatorSource {
  repository: string;
  cloneUrl: string;
  ref: string;
}

export interface GitCoordinatorBootstrapOptions {
  environment?: NodeJS.ProcessEnv | undefined;
  includeLocalCheckouts?: boolean | undefined;
  source?: GitCoordinatorSource | undefined;
}

export interface BootstrappedGitCoordinator {
  checkout: string;
  cli: string;
  ref: string;
}

export const PINNED_GIT_COORDINATOR: GitCoordinatorSource = {
  repository: "fedecardinali/git-coordinator",
  cloneUrl: "https://github.com/fedecardinali/git-coordinator.git",
  // Retained by the immutable Git Coordinator v0.5.0 tag.
  ref: "3fa3eccc54fc7fd8a51a96fd6086ded88aca7ca1",
};

function environmentFor(
  options: GitCoordinatorBootstrapOptions,
): NodeJS.ProcessEnv {
  return options.environment ?? process.env;
}

function sourceFor(
  options: GitCoordinatorBootstrapOptions,
): GitCoordinatorSource {
  return options.source ?? PINNED_GIT_COORDINATOR;
}

export function agentCoordinatorHome(
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const configured = environment.AGENT_COORDINATOR_HOME?.trim();
  if (configured) return path.resolve(configured);
  const home = environment.HOME?.trim() || os.homedir();
  return path.join(home, ".local", "share", "agent-coordinator");
}

function assertImmutableRef(ref: string): void {
  if (!/^[0-9a-f]{40}$/i.test(ref)) {
    throw new CoordinatorError(
      `Git Coordinator bootstrap ref must be a full immutable commit SHA: ${ref}`,
      "GIT_COORDINATOR_REF_INVALID",
    );
  }
}

export function gitCoordinatorCheckoutPath(
  options: GitCoordinatorBootstrapOptions = {},
): string {
  const source = sourceFor(options);
  assertImmutableRef(source.ref);
  return path.join(
    agentCoordinatorHome(environmentFor(options)),
    "git-engines",
    "git-coordinator",
    source.ref,
  );
}

function commandAvailable(
  command: string,
  environment: NodeJS.ProcessEnv,
): boolean {
  return (
    runCommand(
      "/bin/sh",
      ["-c", "command -v -- \"$1\" >/dev/null 2>&1", "sh", command],
      { allowFailure: true, env: environment },
    ).status === 0
  );
}

function git(
  argumentsList: string[],
  environment: NodeJS.ProcessEnv,
  allowFailure = false,
) {
  return runCommand("git", argumentsList, {
    allowFailure,
    env: environment,
  });
}

function normalizedGithubRepository(value: string): string | null {
  const trimmed = value.trim().replace(/\/+$/, "");
  const match =
    trimmed.match(/^https?:\/\/github\.com\/([^/]+\/[^/]+)$/i) ??
    trimmed.match(/^git@github\.com:([^/]+\/[^/]+)$/i) ??
    trimmed.match(/^ssh:\/\/git@github\.com\/([^/]+\/[^/]+)$/i);
  return match?.[1]?.replace(/\.git$/i, "").toLowerCase() ?? null;
}

function sameRemote(actual: string, source: GitCoordinatorSource): boolean {
  const actualGithub = normalizedGithubRepository(actual);
  const expectedGithub = normalizedGithubRepository(source.cloneUrl);
  if (actualGithub && expectedGithub) return actualGithub === expectedGithub;

  if (path.isAbsolute(actual) && path.isAbsolute(source.cloneUrl)) {
    try {
      return realpathSync(actual) === realpathSync(source.cloneUrl);
    } catch {
      return path.resolve(actual) === path.resolve(source.cloneUrl);
    }
  }
  return actual.replace(/\/+$/, "") === source.cloneUrl.replace(/\/+$/, "");
}

function cacheInvalid(checkout: string, detail: string): CoordinatorError {
  return new CoordinatorError(
    `Managed Git Coordinator cache is not the immutable expected checkout at ${checkout}: ${detail}. The cache was left untouched; choose a new AGENT_COORDINATOR_HOME or inspect it manually.`,
    "GIT_COORDINATOR_CACHE_INVALID",
  );
}

export function verifyBootstrappedGitCoordinator(
  options: GitCoordinatorBootstrapOptions = {},
): BootstrappedGitCoordinator | null {
  const environment = environmentFor(options);
  const source = sourceFor(options);
  const checkout = gitCoordinatorCheckoutPath(options);
  if (!existsSync(checkout)) return null;

  if (!commandAvailable("git", environment)) {
    throw new CoordinatorError(
      "Git is required to verify the managed Git Coordinator engine. Install the Xcode Command Line Tools with 'xcode-select --install' and retry.",
      "GIT_MISSING",
    );
  }
  const version = git(["--version"], environment, true);
  if (version.status !== 0) {
    throw new CoordinatorError(
      `Git is present but could not run: ${version.stderr || version.stdout || `exit ${version.status}`}. Install or repair the Xcode Command Line Tools and retry.`,
      "GIT_UNAVAILABLE",
    );
  }

  const cli = path.join(checkout, "src", "cli.mjs");
  try {
    if (!statSync(cli).isFile()) throw cacheInvalid(checkout, "src/cli.mjs is not a file");
  } catch (error) {
    if (error instanceof CoordinatorError) throw error;
    throw cacheInvalid(checkout, "src/cli.mjs is missing");
  }

  const head = git(["-C", checkout, "rev-parse", "HEAD"], environment, true);
  if (head.status !== 0 || head.stdout !== source.ref) {
    throw cacheInvalid(
      checkout,
      `HEAD is ${head.stdout || "unreadable"}, expected ${source.ref}`,
    );
  }
  const branch = git(
    ["-C", checkout, "symbolic-ref", "--quiet", "HEAD"],
    environment,
    true,
  );
  if (branch.status === 0) {
    throw cacheInvalid(checkout, `HEAD is attached to ${branch.stdout}`);
  }
  const status = git(
    ["-C", checkout, "status", "--porcelain", "--untracked-files=all"],
    environment,
    true,
  );
  if (status.status !== 0 || status.stdout) {
    throw cacheInvalid(
      checkout,
      status.stdout ? "the checkout has local changes" : "Git status failed",
    );
  }
  const remote = git(
    ["-C", checkout, "remote", "get-url", "origin"],
    environment,
    true,
  );
  if (remote.status !== 0 || !sameRemote(remote.stdout, source)) {
    throw cacheInvalid(
      checkout,
      `origin is ${remote.stdout || "missing"}, expected ${source.cloneUrl}`,
    );
  }
  return { checkout, cli, ref: source.ref };
}

function cloneFailure(
  checkout: string,
  detail: string,
  usedGithubCli: boolean,
): CoordinatorError {
  const authentication = usedGithubCli
    ? "Confirm access with 'gh auth status --hostname github.com'."
    : "Authenticate Git for GitHub, or install GitHub CLI and run 'gh auth login'.";
  return new CoordinatorError(
    `Could not bootstrap the private Git Coordinator engine at ${checkout}: ${detail}. ${authentication} The partial cache was left untouched for inspection.`,
    "GIT_COORDINATOR_BOOTSTRAP_FAILED",
  );
}

export function bootstrapGitCoordinator(
  options: GitCoordinatorBootstrapOptions = {},
): BootstrappedGitCoordinator {
  const existing = verifyBootstrappedGitCoordinator(options);
  if (existing) return existing;

  const environment = environmentFor(options);
  const source = sourceFor(options);
  if (!commandAvailable("git", environment)) {
    throw new CoordinatorError(
      "Git is required to install Git Coordinator. Install the Xcode Command Line Tools with 'xcode-select --install' and retry.",
      "GIT_MISSING",
    );
  }
  const version = git(["--version"], environment, true);
  if (version.status !== 0) {
    throw new CoordinatorError(
      `Git is present but could not run: ${version.stderr || version.stdout || `exit ${version.status}`}. Install or repair the Xcode Command Line Tools and retry.`,
      "GIT_UNAVAILABLE",
    );
  }

  const checkout = gitCoordinatorCheckoutPath(options);
  const parent = path.dirname(checkout);
  try {
    mkdirSync(parent, { recursive: true });
    mkdirSync(checkout);
  } catch (error) {
    if (existsSync(checkout)) {
      const raced = verifyBootstrappedGitCoordinator(options);
      if (raced) return raced;
    }
    const detail = error instanceof Error ? error.message : String(error);
    throw new CoordinatorError(
      `Could not reserve the managed Git Coordinator cache at ${checkout}: ${detail}. No existing cache was replaced.`,
      "GIT_COORDINATOR_CACHE_CREATE_FAILED",
    );
  }

  const ghAvailable = commandAvailable("gh", environment);
  const ghAuthenticated =
    ghAvailable &&
    runCommand(
      "gh",
      ["auth", "status", "--hostname", "github.com"],
      { allowFailure: true, env: environment },
    ).status === 0;
  const clone = ghAuthenticated
    ? runCommand(
        "gh",
        [
          "repo",
          "clone",
          source.repository,
          checkout,
          "--",
          "--filter=blob:none",
          "--no-checkout",
        ],
        { allowFailure: true, env: environment },
      )
    : git(
        [
          "clone",
          "--filter=blob:none",
          "--no-checkout",
          source.cloneUrl,
          checkout,
        ],
        environment,
        true,
      );
  if (clone.status !== 0) {
    throw cloneFailure(
      checkout,
      clone.stderr || clone.stdout || `exit ${clone.status}`,
      ghAuthenticated,
    );
  }

  const checkoutResult = git(
    ["-C", checkout, "checkout", "--detach", source.ref],
    environment,
    true,
  );
  if (checkoutResult.status !== 0) {
    throw cloneFailure(
      checkout,
      `the pinned ref ${source.ref} could not be checked out: ${checkoutResult.stderr || checkoutResult.stdout || `exit ${checkoutResult.status}`}`,
      ghAuthenticated,
    );
  }

  const verified = verifyBootstrappedGitCoordinator(options);
  if (!verified) {
    throw cacheInvalid(checkout, "the checkout disappeared after cloning");
  }
  return verified;
}
