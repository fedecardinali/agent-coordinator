import { existsSync } from "node:fs";
import path from "node:path";
import { runCommand, type CommandResult } from "../core/command.js";
import { CoordinatorError } from "../core/errors.js";
import {
  bootstrapGitCoordinator,
  type GitCoordinatorBootstrapOptions,
  verifyBootstrappedGitCoordinator,
} from "./bootstrap.js";

export type GitCoordinatorLocation =
  | { kind: "command"; command: string; arguments: string[] }
  | { kind: "source"; command: string; arguments: string[]; path: string };

export function yamlNativeGitRuntimeActive(root: string): boolean {
  const result = runCommand(
    "git",
    ["-C", root, "config", "--local", "--get", "gitCoordinator.manifest"],
    {
      allowFailure: true,
      env: { GIT_COORDINATOR_INTERNAL: "1" },
    },
  );
  return result.status === 0 && result.stdout === "coordinator.yaml";
}

function sourceLocation(source: string): GitCoordinatorLocation {
  return {
    kind: "source",
    command: process.execPath,
    arguments: [source],
    path: source,
  };
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

function explicitLocation(
  environment: NodeJS.ProcessEnv,
): GitCoordinatorLocation | null {
  const explicit = environment.AGENT_COORDINATOR_GIT_COORDINATOR;
  if (!explicit) return null;
  if (!existsSync(explicit)) {
    throw new CoordinatorError(
      `AGENT_COORDINATOR_GIT_COORDINATOR does not exist: ${explicit}`,
    );
  }
  return explicit.endsWith(".mjs") || explicit.endsWith(".js")
    ? sourceLocation(explicit)
    : { kind: "command", command: explicit, arguments: [] };
}

function localSourceLocation(
  workspace: string,
  bootstrapOptions: GitCoordinatorBootstrapOptions,
): GitCoordinatorLocation | null {
  if (bootstrapOptions.includeLocalCheckouts !== true) return null;
  const candidates = [
    path.resolve(workspace, "../git-coordinator/src/cli.mjs"),
    path.resolve(import.meta.dirname, "../../../git-coordinator/src/cli.mjs"),
  ];
  const source = candidates.find((candidate) => existsSync(candidate));
  return source ? sourceLocation(source) : null;
}

function managedSourceLocation(
  bootstrapOptions: GitCoordinatorBootstrapOptions,
): GitCoordinatorLocation | null {
  const managed = verifyBootstrappedGitCoordinator(bootstrapOptions);
  return managed ? sourceLocation(managed.cli) : null;
}

export function findGitCoordinator(
  workspace = process.cwd(),
  bootstrapOptions: GitCoordinatorBootstrapOptions = {},
): GitCoordinatorLocation | null {
  const environment = bootstrapOptions.environment ?? process.env;
  const explicit = explicitLocation(environment);
  if (explicit) return explicit;
  const local = localSourceLocation(workspace, bootstrapOptions);
  if (local) return local;
  const managed = managedSourceLocation(bootstrapOptions);
  if (managed) return managed;
  if (commandAvailable("git-coordinator", environment)) {
    return { kind: "command", command: "git-coordinator", arguments: [] };
  }
  return null;
}

function runGitCoordinator(
  location: GitCoordinatorLocation,
  subcommand: "install" | "uninstall" | "check" | "attach" | "global-install",
  workspace: string,
  options: {
    allowFailure?: boolean | undefined;
    stdio?: "pipe" | "inherit" | undefined;
    environment?: NodeJS.ProcessEnv | undefined;
  } = {},
): CommandResult {
  const argumentsList = [...location.arguments, subcommand];
  if (subcommand !== "global-install") argumentsList.push(workspace);
  return runCommand(location.command, argumentsList, {
    cwd: workspace,
    allowFailure: options.allowFailure,
    stdio: options.stdio,
    env: options.environment,
  });
}

export function invokeGitCoordinator(
  subcommand: "install" | "uninstall" | "check" | "attach" | "global-install",
  workspace: string,
  options: {
    allowFailure?: boolean | undefined;
    stdio?: "pipe" | "inherit" | undefined;
    bootstrap?: GitCoordinatorBootstrapOptions | undefined;
  } = {},
): CommandResult {
  const location = findGitCoordinator(workspace, options.bootstrap);
  if (!location) {
    throw new CoordinatorError(
      "Git Coordinator is not installed. Run 'coordinator install' to install the pinned compatibility runtime, then retry.",
      "GIT_COORDINATOR_MISSING",
    );
  }
  return runGitCoordinator(location, subcommand, workspace, {
    allowFailure: options.allowFailure,
    stdio: options.stdio,
    environment: options.bootstrap?.environment,
  });
}

export function installGitRuntime(
  workspace = process.cwd(),
  bootstrapOptions: GitCoordinatorBootstrapOptions = {},
  stdio: "pipe" | "inherit" = "inherit",
): CommandResult {
  const environment = bootstrapOptions.environment ?? process.env;
  const location =
    explicitLocation(environment) ??
    localSourceLocation(workspace, bootstrapOptions) ??
    managedSourceLocation(bootstrapOptions) ??
    sourceLocation(bootstrapGitCoordinator(bootstrapOptions).cli);
  return runGitCoordinator(location, "global-install", workspace, {
    stdio,
    environment: bootstrapOptions.environment,
  });
}
