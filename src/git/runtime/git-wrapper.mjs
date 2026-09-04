#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  openSync,
  lstatSync,
  renameSync,
  unlinkSync,
  readFileSync,
  readSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { parseDocument } from "yaml";

const REAL_GIT =
  process.env.GIT_COORDINATOR_REAL_GIT ||
  process.env.COORDINATED_GIT_REAL ||
  "/usr/bin/git";
const INTERNAL_ENVIRONMENT_VARIABLE = "GIT_COORDINATOR_INTERNAL";
const LEGACY_INTERNAL_ENVIRONMENT_VARIABLE = "COORDINATED_GIT_INTERNAL";
const PINNED_RESOLUTION_ENVIRONMENT_VARIABLE =
  "AGENT_COORDINATOR_PINNED_RESOLUTION";
const GIT_COORDINATOR_WRAPPER_MARKER = "agent-coordinator-git-wrapper-v1";
const SUPPORTED_COMMANDS = new Set([
  "add",
  "checkout",
  "commit",
  "pull",
  "push",
  "switch",
  "worktree",
]);

class CoordinatedGitError extends Error {
  constructor(message, code = "GIT_OPERATION_FAILED") {
    super(message);
    this.code = code;
  }
}

let activeContext;

function run(command, argumentsList, options = {}) {
  const result = spawnSync(command, argumentsList, {
    cwd: options.cwd,
    encoding: options.capture ? "utf8" : undefined,
    env: {
      ...process.env,
      ...options.env,
      [INTERNAL_ENVIRONMENT_VARIABLE]: "1",
      [LEGACY_INTERNAL_ENVIRONMENT_VARIABLE]: "1",
    },
    stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });

  if (result.error) throw result.error;
  return result;
}

function git(argumentsList, options = {}) {
  return run(REAL_GIT, argumentsList, options);
}

function gitText(repository, argumentsList, options = {}) {
  const result = git(["-C", repository, ...argumentsList], {
    ...options,
    capture: true,
  });
  const stdout = (result.stdout ?? "").trim();
  const stderr = (result.stderr ?? "").trim();

  if (result.status !== 0 && !options.allowFailure) {
    throw new CoordinatedGitError(
      `git ${argumentsList.join(" ")} failed in ${repository}: ${stderr || stdout || `exit ${result.status}`}`,
    );
  }

  return { ...result, stdout, stderr };
}

function executeGit(repository, argumentsList, options = {}) {
  return git(["-C", repository, ...argumentsList], options);
}

function canonicalPath(value) {
  try {
    return realpathSync(value);
  } catch {
    return path.resolve(value);
  }
}

function parseInvocation(argumentsList, initialDirectory) {
  let index = 0;
  let effectiveDirectory = initialDirectory;
  const forwardedGlobalOptions = [];

  while (index < argumentsList.length) {
    const argument = argumentsList[index];
    if (argument === "-C") {
      const directory = argumentsList[index + 1];
      if (!directory) return null;
      effectiveDirectory = path.resolve(effectiveDirectory, directory);
      index += 2;
      continue;
    }
    if (argument.startsWith("-C") && argument.length > 2) {
      effectiveDirectory = path.resolve(effectiveDirectory, argument.slice(2));
      index += 1;
      continue;
    }
    if (argument === "-c" || argument === "--config-env") {
      const value = argumentsList[index + 1];
      if (!value) return null;
      forwardedGlobalOptions.push(argument, value);
      index += 2;
      continue;
    }
    if (
      argument.startsWith("-c") ||
      argument.startsWith("--config-env=") ||
      argument === "--no-pager" ||
      argument === "--paginate" ||
      argument === "--literal-pathspecs" ||
      argument === "--glob-pathspecs" ||
      argument === "--noglob-pathspecs" ||
      argument === "--icase-pathspecs"
    ) {
      forwardedGlobalOptions.push(argument);
      index += 1;
      continue;
    }
    if (
      argument === "--git-dir" ||
      argument === "--work-tree" ||
      argument === "--namespace"
    ) {
      return null;
    }
    if (
      argument.startsWith("--git-dir=") ||
      argument.startsWith("--work-tree=") ||
      argument.startsWith("--namespace=")
    ) {
      return null;
    }
    break;
  }

  const command = argumentsList[index];
  if (!command) return null;

  return {
    command,
    commandArguments: argumentsList.slice(index + 1),
    effectiveDirectory,
    forwardedGlobalOptions,
  };
}

function configuredBranchName(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new CoordinatedGitError(`${label} must be a non-empty branch name.`);
  }
  const result = git(["check-ref-format", "--branch", value], {
    capture: true,
  });
  if (result.status !== 0) {
    throw new CoordinatedGitError(`${label} is not a valid branch name: ${value}`);
  }
  return value;
}

function normalizeFallbackPolicy(value, label) {
  if (value === undefined) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CoordinatedGitError(`${label} must be a branch policy object.`);
  }
  if (value.mode === "mirror") return { mode: "mirror" };
  if (value.mode === "fixed") {
    return {
      mode: "fixed",
      name: configuredBranchName(value.name, `${label}.name`),
    };
  }
  throw new CoordinatedGitError(
    `${label}.mode must be 'mirror' or 'fixed'.`,
  );
}

function normalizeBranchPolicy(value, label) {
  if (value === undefined) {
    return { mode: "mirror", readOnly: false };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CoordinatedGitError(`${label} must be a branch policy object.`);
  }

  const mode = value.mode;
  const defaultReadOnly = mode === "fixed";
  const readOnly = value.readOnly ?? defaultReadOnly;
  if (typeof readOnly !== "boolean") {
    throw new CoordinatedGitError(`${label}.readOnly must be a boolean.`);
  }

  if (mode === "mirror") {
    return { mode, readOnly };
  }
  if (mode === "fixed") {
    return {
      mode,
      name: configuredBranchName(value.name, `${label}.name`),
      readOnly,
    };
  }
  if (mode === "map") {
    if (
      !value.branches ||
      typeof value.branches !== "object" ||
      Array.isArray(value.branches) ||
      Object.keys(value.branches).length === 0
    ) {
      throw new CoordinatedGitError(
        `${label}.branches must contain at least one coordinator-to-child mapping.`,
      );
    }
    const branches = {};
    for (const [coordinatorBranch, childBranch] of Object.entries(
      value.branches,
    )) {
      configuredBranchName(
        coordinatorBranch,
        `${label}.branches coordinator key`,
      );
      branches[coordinatorBranch] = configuredBranchName(
        childBranch,
        `${label}.branches.${coordinatorBranch}`,
      );
    }
    return {
      mode,
      branches,
      fallback: normalizeFallbackPolicy(value.fallback, `${label}.fallback`),
      readOnly,
    };
  }
  throw new CoordinatedGitError(
    `${label}.mode must be 'mirror', 'fixed', or 'map'.`,
  );
}

function normalizeWorkspaceManifest(value, label, rootDirectory) {
  if (value === undefined) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CoordinatedGitError(`${label} must be an object.`);
  }
  const manifestPath = value.path;
  if (
    typeof manifestPath !== "string" ||
    manifestPath.length === 0 ||
    path.isAbsolute(manifestPath) ||
    manifestPath.split(/[\\/]/).includes("..")
  ) {
    throw new CoordinatedGitError(`${label}.path must be a safe relative path.`);
  }
  const coordinatorToken = value.coordinatorToken ?? "$coordinator";
  if (typeof coordinatorToken !== "string" || coordinatorToken.length === 0) {
    throw new CoordinatedGitError(
      `${label}.coordinatorToken must be a non-empty string.`,
    );
  }
  const mirrorActiveInLinkedWorktrees =
    value.mirrorActiveInLinkedWorktrees ?? false;
  if (typeof mirrorActiveInLinkedWorktrees !== "boolean") {
    throw new CoordinatedGitError(
      `${label}.mirrorActiveInLinkedWorktrees must be a boolean.`,
    );
  }
  return {
    kind: "external",
    path: manifestPath,
    absolutePath: path.join(rootDirectory, manifestPath),
    coordinatorToken,
    mirrorActiveInLinkedWorktrees,
  };
}

function parseCoordinatorYaml(source, label) {
  const document = parseDocument(source, {
    prettyErrors: false,
    uniqueKeys: true,
  });
  if (document.errors.length > 0) {
    throw new CoordinatedGitError(
      `${label} is not valid YAML: ${document.errors[0].message}`,
    );
  }
  const parsed = document.toJS({ maxAliasCount: 0 });
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new CoordinatedGitError(`${label} must contain a mapping.`);
  }
  return parsed;
}

function normalizeInlineWorkspace(value, label, rootDirectory) {
  if (value === undefined) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CoordinatedGitError(`${label} must be an object.`);
  }
  const coordinatorToken = value.coordinatorToken ?? "$coordinator";
  if (typeof coordinatorToken !== "string" || coordinatorToken.length === 0) {
    throw new CoordinatedGitError(
      `${label}.coordinatorToken must be a non-empty string.`,
    );
  }
  const mirrorActiveInLinkedWorktrees =
    value.mirrorActiveInLinkedWorktrees ?? false;
  if (typeof mirrorActiveInLinkedWorktrees !== "boolean") {
    throw new CoordinatedGitError(
      `${label}.mirrorActiveInLinkedWorktrees must be a boolean.`,
    );
  }
  return {
    kind: "inline",
    path: "coordinator.yaml",
    absolutePath: path.join(rootDirectory, "coordinator.yaml"),
    coordinatorToken,
    mirrorActiveInLinkedWorktrees,
  };
}

function configurationReference(relativePath, source) {
  if (source === "worktree") return relativePath;
  return source === "index"
    ? `:${relativePath}`
    : `${source.revision}:${relativePath}`;
}

function configurationFile(rootDirectory, relativePath, source) {
  if (source === "worktree") {
    const absolutePath = path.join(rootDirectory, relativePath);
    return existsSync(absolutePath)
      ? {
          contents: readFileSync(absolutePath, "utf8"),
          label: relativePath,
        }
      : null;
  }
  const revision = configurationReference(relativePath, source);
  const shown = gitText(rootDirectory, ["show", revision], {
    allowFailure: true,
  });
  return shown.status === 0
    ? { contents: shown.stdout, label: revision }
    : null;
}

function loadContext(invocation, configurationSource = "worktree") {
  const topLevelResult = gitText(
    invocation.effectiveDirectory,
    ["rev-parse", "--show-toplevel"],
    { allowFailure: true },
  );
  if (topLevelResult.status !== 0) return null;

  const rootDirectory = canonicalPath(topLevelResult.stdout);
  if (canonicalPath(invocation.effectiveDirectory) !== rootDirectory) {
    return null;
  }

  const yaml = configurationFile(
    rootDirectory,
    "coordinator.yaml",
    configurationSource,
  );
  const legacy = configurationFile(
    rootDirectory,
    ".git-coordinator.json",
    configurationSource,
  );
  const packageConfiguration = configurationFile(
    rootDirectory,
    "package.json",
    configurationSource,
  );
  const installedManifest = gitText(
    rootDirectory,
    ["config", "--local", "--get", "gitCoordinator.manifest"],
    { allowFailure: true },
  );
  let configuration;
  let configurationLabel;
  if (yaml) {
    configuration = parseCoordinatorYaml(
      yaml.contents,
      yaml.label,
    );
    configurationLabel = yaml.label;
  } else if (installedManifest.status === 0 && installedManifest.stdout === "coordinator.yaml") {
    throw new CoordinatedGitError(
      `${configurationReference("coordinator.yaml", configurationSource)} is required by the installed Agent Coordinator Git workspace.`,
    );
  } else if (legacy) {
    try {
      configuration = JSON.parse(legacy.contents);
      configurationLabel = legacy.label;
    } catch {
      throw new CoordinatedGitError(
        `${legacy.label} is not valid JSON.`,
      );
    }
  } else if (packageConfiguration) {
    try {
      configuration = JSON.parse(packageConfiguration.contents).coordinatedGit;
      configurationLabel = `${packageConfiguration.label} coordinatedGit`;
    } catch {
      return null;
    }
  }
  if (!configuration && installedManifest.status === 0) {
    throw new CoordinatedGitError(
      `${installedManifest.stdout} is required by the installed Agent Coordinator Git workspace.`,
    );
  }
  if (
    ![1, 2].includes(configuration?.schemaVersion) ||
    !Array.isArray(configuration.repositories) ||
    configuration.repositories.length === 0
  ) {
    if (configurationLabel?.endsWith("coordinator.yaml")) {
      throw new CoordinatedGitError(
        "coordinator.yaml must use schemaVersion 1 or 2 and contain repositories.",
      );
    }
    return null;
  }

  if (configuration.workspace !== undefined && configuration.workspaceManifest !== undefined) {
    throw new CoordinatedGitError(
      `${configurationLabel} cannot contain both workspace and workspaceManifest.`,
    );
  }
  const workspaceManifest = configuration.workspace !== undefined
    ? normalizeInlineWorkspace(
        configuration.workspace,
        `${configurationLabel}.workspace`,
        rootDirectory,
      )
    : configurationLabel.endsWith("coordinator.yaml") || configuration.schemaVersion === 2
      ? normalizeWorkspaceManifest(
          configuration.workspaceManifest,
          `${configurationLabel}.workspaceManifest`,
          rootDirectory,
        )
      : null;
  const repositories = configuration.repositories.map((entry, index) => {
    if (
      typeof entry?.id !== "string" ||
      typeof entry?.path !== "string" ||
      entry.path.length === 0 ||
      path.isAbsolute(entry.path) ||
      entry.path.split(/[\\/]/).includes("..")
    ) {
      throw new CoordinatedGitError(
        `${configurationLabel} contains an invalid repository entry.`,
      );
    }

    const branchPolicy =
      configuration.schemaVersion === 1 && !configurationLabel.endsWith("coordinator.yaml")
        ? { mode: "mirror", readOnly: false }
        : normalizeBranchPolicy(
            entry.branch,
            `${configurationLabel}.repositories[${index}].branch`,
          );
    return {
      id: entry.id,
      path: entry.path,
      directory: path.join(rootDirectory, entry.path),
      branchPolicy,
      configuredBranchPolicy: branchPolicy,
    };
  });
  if (new Set(repositories.map(({ id }) => id)).size !== repositories.length) {
    throw new CoordinatedGitError(
      `${configurationLabel} contains duplicate repository ids.`,
    );
  }
  if (
    new Set(repositories.map(({ path: repositoryPath }) => repositoryPath))
      .size !== repositories.length
  ) {
    throw new CoordinatedGitError(
      `${configurationLabel} contains duplicate repository paths.`,
    );
  }

  return {
    ...invocation,
    configuration,
    repositories,
    rootDirectory,
    workspaceManifest,
    configurationLabel,
  };
}

function configurationSourceForInvocation(invocation) {
  if (["pull", "push", "worktree"].includes(invocation.command)) {
    return { revision: "HEAD" };
  }
  if (invocation.command === "commit") {
    return invocation.commandArguments.some(
      (argument) => argument === "-a" || argument === "--all",
    )
      ? "worktree"
      : "index";
  }
  return "worktree";
}

function rootGitArguments(context, commandArguments) {
  return [
    ...context.forwardedGlobalOptions,
    "-C",
    context.rootDirectory,
    ...commandArguments,
  ];
}

function executeRootGit(context, commandArguments, options = {}) {
  return git(rootGitArguments(context, commandArguments), options);
}

function isRepositoryAt(directory) {
  const result = gitText(
    directory,
    ["rev-parse", "--show-toplevel"],
    { allowFailure: true },
  );
  return (
    result.status === 0 &&
    canonicalPath(result.stdout) === canonicalPath(directory)
  );
}

function assertInitializedRepositories(context) {
  for (const repository of context.repositories) {
    if (!isRepositoryAt(repository.directory)) {
      throw new CoordinatedGitError(
        `${repository.id} is not initialized at ${repository.directory}.`,
      );
    }
  }
}

function currentBranch(repository) {
  const result = gitText(
    repository,
    ["symbolic-ref", "--quiet", "--short", "HEAD"],
    { allowFailure: true },
  );
  return result.status === 0 ? result.stdout : null;
}

function isLinkedWorktree(rootDirectory) {
  const gitDirectory = gitText(rootDirectory, ["rev-parse", "--git-dir"]);
  const commonDirectory = gitText(rootDirectory, [
    "rev-parse",
    "--git-common-dir",
  ]);
  const resolveGitPath = (value) =>
    canonicalPath(path.resolve(rootDirectory, value));
  return resolveGitPath(gitDirectory.stdout) !== resolveGitPath(commonDirectory.stdout);
}

function parseExternalWorkspaceManifest(context, source, label) {
  let parsed;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    throw new CoordinatedGitError(
      `${label} is not valid JSON: ${error.message}`,
    );
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    !parsed.repositories ||
    typeof parsed.repositories !== "object" ||
    Array.isArray(parsed.repositories)
  ) {
    throw new CoordinatedGitError(
      `${label} must contain a repositories object.`,
    );
  }
  if (parsed.schemaVersion !== 1) {
    throw new CoordinatedGitError(`${label}.schemaVersion must be 1.`);
  }
  if (
    parsed.baseBranch === context.workspaceManifest.coordinatorToken ||
    typeof parsed.baseBranch !== "string"
  ) {
    throw new CoordinatedGitError(
      `${label}.baseBranch must be a concrete branch name.`,
    );
  }
  configuredBranchName(parsed.baseBranch, `${label}.baseBranch`);
  const actualRepositoryIds = Object.keys(parsed.repositories).sort();
  const expectedRepositoryIds = context.repositories
    .map((repository) => repository.id)
    .sort();
  if (
    actualRepositoryIds.length !== expectedRepositoryIds.length ||
    actualRepositoryIds.some(
      (repositoryId, index) =>
        repositoryId !== expectedRepositoryIds[index],
    )
  ) {
    throw new CoordinatedGitError(
      `${label}.repositories must contain exactly: ${expectedRepositoryIds.join(", ")}.`,
    );
  }
  return parsed;
}

function assertInlineWorkspaceTopology(context, configuration, label) {
  if (!Array.isArray(configuration.repositories)) {
    throw new CoordinatedGitError(`${label}.repositories must be an array.`);
  }
  const actual = new Map();
  for (const entry of configuration.repositories) {
    if (
      typeof entry?.id !== "string" ||
      typeof entry?.path !== "string" ||
      actual.has(entry.id)
    ) {
      throw new CoordinatedGitError(
        `${label}.repositories contains an invalid or duplicate repository.`,
      );
    }
    actual.set(entry.id, entry.path);
  }
  if (
    actual.size !== context.repositories.length ||
    context.repositories.some(
      (repository) => actual.get(repository.id) !== repository.path,
    )
  ) {
    throw new CoordinatedGitError(
      `${label}.repositories must preserve the configured repository ids and paths.`,
    );
  }
}

function parseInlineWorkspaceManifest(context, configuration, label) {
  if (![1, 2].includes(configuration.schemaVersion)) {
    throw new CoordinatedGitError(`${label}.schemaVersion must be 1 or 2.`);
  }
  assertInlineWorkspaceTopology(context, configuration, label);
  const workspace = configuration.workspace;
  if (
    !workspace ||
    typeof workspace !== "object" ||
    Array.isArray(workspace) ||
    !workspace.selection ||
    typeof workspace.selection !== "object" ||
    Array.isArray(workspace.selection)
  ) {
    throw new CoordinatedGitError(
      `${label}.workspace must contain a selection object.`,
    );
  }
  if (
    workspace.baseBranch === context.workspaceManifest.coordinatorToken ||
    typeof workspace.baseBranch !== "string"
  ) {
    throw new CoordinatedGitError(
      `${label}.workspace.baseBranch must be a concrete branch name.`,
    );
  }
  configuredBranchName(
    workspace.baseBranch,
    `${label}.workspace.baseBranch`,
  );
  const coordinatorToken = workspace.coordinatorToken ?? "$coordinator";
  const mirrorActiveInLinkedWorktrees =
    workspace.mirrorActiveInLinkedWorktrees ?? false;
  if (
    coordinatorToken !== context.workspaceManifest.coordinatorToken ||
    mirrorActiveInLinkedWorktrees !==
      context.workspaceManifest.mirrorActiveInLinkedWorktrees
  ) {
    throw new CoordinatedGitError(
      `${label}.workspace coordination settings must match the current workspace.`,
    );
  }
  const actualRepositoryIds = Object.keys(workspace.selection).sort();
  const expectedRepositoryIds = context.repositories
    .map((repository) => repository.id)
    .sort();
  if (
    actualRepositoryIds.length !== expectedRepositoryIds.length ||
    actualRepositoryIds.some(
      (repositoryId, index) => repositoryId !== expectedRepositoryIds[index],
    )
  ) {
    throw new CoordinatedGitError(
      `${label}.workspace.selection must contain exactly: ${expectedRepositoryIds.join(", ")}.`,
    );
  }

  const repositories = {};
  for (const repository of context.repositories) {
    const entry = workspace.selection[repository.id];
    if (
      !entry ||
      typeof entry !== "object" ||
      Array.isArray(entry) ||
      Object.keys(entry).sort().join(",") !== "branch,mode" ||
      typeof entry.branch !== "string" ||
      !["active", "pinned"].includes(entry.mode)
    ) {
      throw new CoordinatedGitError(
        `${label}.workspace.selection.${repository.id} must contain only branch and mode.`,
      );
    }
    repositories[repository.id] = {
      path: repository.path,
      branch: entry.branch,
      mode: entry.mode,
    };
  }
  return {
    schemaVersion: 1,
    baseBranch: workspace.baseBranch,
    repositories,
  };
}

function workspaceSource(context, source) {
  const manifestPath = context.workspaceManifest.path;
  if (source === "worktree") {
    if (!existsSync(context.workspaceManifest.absolutePath)) {
      throw new CoordinatedGitError(
        `${manifestPath} is required by ${context.configurationLabel}.`,
      );
    }
    return {
      contents: readFileSync(context.workspaceManifest.absolutePath, "utf8"),
      label: manifestPath,
    };
  }

  const revision =
    source === "index" ? `:${manifestPath}` : `${source.revision}:${manifestPath}`;
  const shown = gitText(context.rootDirectory, ["show", revision], {
    allowFailure: true,
  });
  if (shown.status !== 0) {
    throw new CoordinatedGitError(
      `${revision} is required by ${context.configurationLabel}.`,
    );
  }
  return { contents: shown.stdout, label: revision };
}

function readWorkspaceManifest(context, source = "worktree") {
  if (!context.workspaceManifest) return null;
  const sourceValue = workspaceSource(context, source);
  if (context.workspaceManifest.kind === "inline") {
    return parseInlineWorkspaceManifest(
      context,
      parseCoordinatorYaml(sourceValue.contents, sourceValue.label),
      sourceValue.label,
    );
  }
  return parseExternalWorkspaceManifest(
    context,
    sourceValue.contents,
    sourceValue.label,
  );
}

function manifestPolicyContext(
  context,
  coordinatorBranch,
  source = "worktree",
) {
  if (!context.workspaceManifest) return context;
  const manifest = readWorkspaceManifest(context, source);
  return manifestPolicyContextFromValue(context, coordinatorBranch, manifest);
}

function manifestPolicyContextFromValue(
  context,
  coordinatorBranch,
  manifest,
) {
  if (!context.workspaceManifest) return context;
  configuredBranchName(coordinatorBranch, "coordinator branch");
  const mirrorActive =
    context.workspaceManifest.mirrorActiveInLinkedWorktrees &&
    isLinkedWorktree(context.rootDirectory);
  const repositories = context.repositories.map((repository) => {
    const entry = manifest.repositories[repository.id];
    if (
      !entry ||
      typeof entry !== "object" ||
      Array.isArray(entry) ||
      Object.keys(entry).sort().join(",") !== "branch,mode,path" ||
      entry.path !== repository.path ||
      typeof entry.branch !== "string" ||
      !["active", "pinned"].includes(entry.mode)
    ) {
      throw new CoordinatedGitError(
        `${context.workspaceManifest.path} contains an invalid entry for ${repository.id}.`,
      );
    }
    const resolvedBranch =
      entry.mode === "active" && mirrorActive
        ? coordinatorBranch
        : entry.branch === context.workspaceManifest.coordinatorToken
          ? coordinatorBranch
          : configuredBranchName(
              entry.branch,
              `${context.workspaceManifest.path}.repositories.${repository.id}.branch`,
            );
    return {
      ...repository,
      branchPolicy:
        entry.mode === "pinned"
          ? {
              mode: "pinned",
              name: resolvedBranch,
              readOnly: true,
              manifestMode: entry.mode,
            }
          : {
              mode: "fixed",
              name: resolvedBranch,
              readOnly: false,
              manifestMode: entry.mode,
            },
    };
  });
  return { ...context, repositories, workspaceManifestValue: manifest };
}

function currentPolicyContext(context, source = "worktree") {
  const coordinatorBranch = currentBranch(context.rootDirectory);
  if (!coordinatorBranch) return context;
  return manifestPolicyContext(context, coordinatorBranch, source);
}

function configuredPolicyContext(context) {
  return {
    ...context,
    repositories: context.repositories.map((repository) => ({
      ...repository,
      branchPolicy: repository.configuredBranchPolicy,
    })),
  };
}

function creationManifest(context, coordinatorBranch) {
  if (!context.workspaceManifest) return null;
  const manifest = readWorkspaceManifest(context, "worktree");
  const configured = configuredPolicyContext(context);
  for (const repository of configured.repositories) {
    const policy = repository.branchPolicy;
    const branch =
      policy.mode === "mirror"
        ? context.workspaceManifest.coordinatorToken
        : resolvedRepositoryBranch(repository, coordinatorBranch);
    manifest.repositories[repository.id] = {
      path: repository.path,
      branch,
      mode: policy.readOnly ? "pinned" : "active",
    };
  }
  return manifest;
}

function writeWorkspaceManifest(context, manifest) {
  if (context.workspaceManifest.kind === "inline") {
    const source = readFileSync(context.workspaceManifest.absolutePath, "utf8");
    const document = parseDocument(source, {
      prettyErrors: false,
      uniqueKeys: true,
    });
    if (document.errors.length > 0) {
      throw new CoordinatedGitError(
        `${context.workspaceManifest.path} is not valid YAML: ${document.errors[0].message}`,
      );
    }
    const selection = {};
    for (const repository of context.repositories) {
      const entry = manifest.repositories[repository.id];
      selection[repository.id] = {
        branch: entry.branch,
        mode: entry.mode,
      };
    }
    document.setIn(["workspace", "selection"], selection);
    writeFileSync(
      context.workspaceManifest.absolutePath,
      document.toString({ lineWidth: 0 }),
      { mode: 0o644 },
    );
    return;
  }
  writeFileSync(
    context.workspaceManifest.absolutePath,
    `${JSON.stringify(manifest, null, 2)}\n`,
    { mode: 0o644 },
  );
}

function resolvedRepositoryBranch(repository, coordinatorBranch) {
  const policy = repository.branchPolicy;
  if (policy.mode === "mirror") return coordinatorBranch;
  if (policy.mode === "fixed" || policy.mode === "pinned") return policy.name;
  const mapped = policy.branches[coordinatorBranch];
  if (mapped) return mapped;
  if (policy.fallback?.mode === "mirror") return coordinatorBranch;
  if (policy.fallback?.mode === "fixed") return policy.fallback.name;
  throw new CoordinatedGitError(
    `${repository.id} has no branch mapping for coordinator branch '${coordinatorBranch}'.`,
  );
}

function writableRepositories(context) {
  return context.repositories.filter(
    (repository) => !repository.branchPolicy.readOnly,
  );
}

function readOnlyRepositories(context) {
  return context.repositories.filter(
    (repository) => repository.branchPolicy.readOnly,
  );
}

function rootGitlink(context, repository, rootReference = null) {
  const revision = rootReference
    ? `${rootReference}:${repository.path}`
    : `:${repository.path}`;
  return gitText(context.rootDirectory, ["rev-parse", revision], {
    allowFailure: true,
  });
}

function branchContainsRevision(context, repository, branch, revision) {
  const remote = context.configuration.remote || "origin";
  return [
    `refs/heads/${branch}`,
    `refs/remotes/${remote}/${branch}`,
  ].some((reference) => {
    const exists = gitText(
      repository.directory,
      ["rev-parse", "--verify", reference],
      { allowFailure: true },
    );
    return (
      exists.status === 0 &&
      gitText(
        repository.directory,
        ["merge-base", "--is-ancestor", revision, reference],
        { allowFailure: true },
      ).status === 0
    );
  });
}

function assertBranchInvariant(context, rootReference = null) {
  assertInitializedRepositories(context);
  const coordinatorBranch = currentBranch(context.rootDirectory);
  if (!coordinatorBranch) {
    throw new CoordinatedGitError(
      "the coordinator is detached; create or switch to a branch before continuing.",
    );
  }

  const mismatches = [];
  for (const repository of context.repositories) {
    const branch = currentBranch(repository.directory);
    const expectedBranch = resolvedRepositoryBranch(
      repository,
      coordinatorBranch,
    );
    if (repository.branchPolicy.mode === "pinned" && !branch) {
      const gitlink = rootGitlink(context, repository, rootReference);
      if (
        gitlink.status === 0 &&
        branchContainsRevision(
          context,
          repository,
          expectedBranch,
          gitlink.stdout,
        )
      ) {
        continue;
      }
    }
    if (branch !== expectedBranch) {
      mismatches.push({ repository, branch, expectedBranch });
    }
  }

  if (mismatches.length > 0) {
    const details = mismatches
      .map(
        ({ repository, branch, expectedBranch }) =>
          `${repository.id}=${branch ?? "DETACHED"} (expected ${expectedBranch})`,
      )
      .join(", ");
    throw new CoordinatedGitError(
      `branch invariant failed for coordinator '${coordinatorBranch}': ${details}.`,
      "BRANCH_MISMATCH",
    );
  }

  return coordinatorBranch;
}

function assertFullInvariant(context, rootReference = null) {
  const branch = assertBranchInvariant(context, rootReference);
  const mismatches = [];
  for (const repository of context.repositories) {
    const gitlink = rootGitlink(context, repository, rootReference);
    const head = gitText(repository.directory, ["rev-parse", "HEAD"]);
    if (gitlink.status !== 0 || gitlink.stdout !== head.stdout) {
      mismatches.push(repository.id);
    }
  }
  if (mismatches.length > 0) {
    throw new CoordinatedGitError(
      `coordinator gitlinks do not match child HEADs: ${mismatches.join(", ")}.`,
      "GITLINK_MISMATCH",
    );
  }
  return branch;
}

function assertReadOnlyRepositoriesClean(context, rootReference = null) {
  const failures = [];
  for (const repository of readOnlyRepositories(context)) {
    const status = gitText(repository.directory, ["status", "--porcelain"]);
    const gitlink = rootGitlink(context, repository, rootReference);
    const head = gitText(repository.directory, ["rev-parse", "HEAD"]);
    if (status.stdout || gitlink.status !== 0 || gitlink.stdout !== head.stdout) {
      failures.push(repository.id);
    }
  }
  if (failures.length > 0) {
    throw new CoordinatedGitError(
      `read-only repositories have changes or moved HEADs: ${failures.join(", ")}.`,
    );
  }
}

function splitAddArguments(argumentsList) {
  const options = [];
  const pathspecs = [];
  let afterSeparator = false;

  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    if (afterSeparator) {
      pathspecs.push(argument);
      continue;
    }
    if (argument === "--") {
      afterSeparator = true;
      continue;
    }
    if (argument === "--pathspec-from-file") {
      throw new CoordinatedGitError(
        "git add --pathspec-from-file is not supported by coordinated Git.",
      );
    }
    if (argument.startsWith("--pathspec-from-file=")) {
      throw new CoordinatedGitError(
        "git add --pathspec-from-file is not supported by coordinated Git.",
      );
    }
    if (argument === "--chmod") {
      const value = argumentsList[index + 1];
      if (!value) {
        throw new CoordinatedGitError("git add --chmod requires a value.");
      }
      options.push(argument, value);
      index += 1;
      continue;
    }
    if (argument.startsWith("-")) {
      options.push(argument);
      continue;
    }
    pathspecs.push(argument);
  }

  return { options, pathspecs };
}

function isBroadAdd(options, pathspecs) {
  if (pathspecs.length === 1 && [".", "./", ":/"].includes(pathspecs[0])) {
    return true;
  }
  if (pathspecs.length > 0) return false;
  return options.some((option) =>
    ["-A", "--all", "-u", "--update"].includes(option),
  );
}

function coordinatedAdd(context) {
  context = currentPolicyContext(context);
  try {
    assertBranchInvariant(context);
  } catch (error) {
    if (!context.workspaceManifest) throw error;
    attachCoordinatedBranches(context);
    context = currentPolicyContext(context);
    assertBranchInvariant(context);
  }
  assertReadOnlyRepositoriesClean(context);
  const { options, pathspecs } = splitAddArguments(context.commandArguments);

  if (isBroadAdd(options, pathspecs)) {
    for (const repository of writableRepositories(context)) {
      const result = executeGit(repository.directory, [
        "add",
        ...context.commandArguments,
      ]);
      if (result.status !== 0) return result.status;
    }
    return executeRootGit(context, ["add", ...context.commandArguments]).status;
  }

  if (pathspecs.length === 0) {
    return executeRootGit(context, ["add", ...context.commandArguments]).status;
  }

  if (pathspecs.some((pathspec) => pathspec.startsWith(":"))) {
    throw new CoordinatedGitError(
      "Git pathspec magic is not supported by coordinated git add.",
    );
  }

  const rootPathspecs = [];
  const childPathspecs = new Map(
    context.repositories.map((repository) => [repository.id, []]),
  );

  for (const pathspec of pathspecs) {
    const normalized = pathspec.replace(/^\.\//, "").replace(/\/+$/, "");
    const repository = context.repositories.find(
      (candidate) =>
        normalized === candidate.path ||
        normalized.startsWith(`${candidate.path}/`),
    );
    if (!repository) {
      rootPathspecs.push(pathspec);
      continue;
    }

    const childPath =
      normalized === repository.path
        ? "."
        : normalized.slice(repository.path.length + 1);
    childPathspecs.get(repository.id).push(childPath);
  }

  for (const repository of context.repositories) {
    const mappedPathspecs = childPathspecs.get(repository.id);
    if (mappedPathspecs.length === 0) continue;
    if (repository.branchPolicy.readOnly) {
      throw new CoordinatedGitError(
        `${repository.id} is read-only and cannot be staged.`,
      );
    }
    const result = executeGit(repository.directory, [
      "add",
      ...options,
      "--",
      ...mappedPathspecs,
    ]);
    if (result.status !== 0) return result.status;
  }

  if (rootPathspecs.length === 0) return 0;
  return executeRootGit(context, [
    "add",
    ...options,
    "--",
    ...rootPathspecs,
  ]).status;
}

function hasStagedChanges(repository) {
  return (
    gitText(repository, ["diff", "--cached", "--quiet"], {
      allowFailure: true,
    }).status !== 0
  );
}

function hasTrackedWorktreeChanges(repository) {
  return (
    gitText(repository, ["diff", "--quiet"], { allowFailure: true }).status !== 0
  );
}

function commitIncludesAllTrackedChanges(argumentsList) {
  return argumentsList.some((argument) => argument === "-a" || argument === "--all");
}

function commitAllowsEmpty(argumentsList) {
  return argumentsList.includes("--allow-empty");
}

function hasExplicitCommitMessage(argumentsList) {
  return argumentsList.some(
    (argument) =>
      argument === "-m" ||
      argument.startsWith("-m") ||
      argument === "--message" ||
      argument.startsWith("--message=") ||
      argument === "-F" ||
      argument.startsWith("-F") ||
      argument === "--file" ||
      argument.startsWith("--file="),
  );
}

function childCommitArguments(rootDirectory, argumentsList) {
  const normalized = [];
  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    if (argument === "-F" || argument === "--file") {
      const value = argumentsList[index + 1];
      normalized.push(
        argument,
        value === "-" || path.isAbsolute(value)
          ? value
          : path.resolve(rootDirectory, value),
      );
      index += 1;
      continue;
    }
    if (argument.startsWith("-F") && argument.length > 2) {
      const value = argument.slice(2);
      normalized.push(`-F${path.isAbsolute(value) ? value : path.resolve(rootDirectory, value)}`);
      continue;
    }
    if (argument.startsWith("--file=")) {
      const value = argument.slice("--file=".length);
      normalized.push(
        `--file=${value === "-" || path.isAbsolute(value) ? value : path.resolve(rootDirectory, value)}`,
      );
      continue;
    }
    normalized.push(argument);
  }
  return normalized;
}

function assertSupportedCommit(argumentsList) {
  const unsupported = [
    "--amend",
    "--fixup",
    "--squash",
    "--reuse-message",
    "--reedit-message",
    "-C",
    "-c",
    "--only",
    "--include",
    "-o",
    "-i",
  ];
  for (const option of unsupported) {
    if (
      argumentsList.some(
        (argument) => argument === option || argument.startsWith(`${option}=`),
      )
    ) {
      throw new CoordinatedGitError(
        `${option} is not yet supported for a coordinated commit.`,
      );
    }
  }
  if (argumentsList.includes("--")) {
    throw new CoordinatedGitError(
      "commit pathspecs are not yet supported for a coordinated commit.",
    );
  }
}

function repositoryHasCommitCandidate(repository, argumentsList) {
  if (commitAllowsEmpty(argumentsList)) return true;
  if (hasStagedChanges(repository)) return true;
  return (
    commitIncludesAllTrackedChanges(argumentsList) &&
    hasTrackedWorktreeChanges(repository)
  );
}

function rollbackChildCommits(context, committedRepositories) {
  const failures = [];
  for (const committed of [...committedRepositories].reverse()) {
    const result = executeGit(
      committed.repository.directory,
      ["reset", "--soft", committed.originalRevision],
      { capture: true },
    );
    if (result.status !== 0) {
      failures.push(committed.repository.id);
    }
  }

  executeRootGit(context, [
    "add",
    "--",
    ...context.repositories.map((repository) => repository.path),
  ], { capture: true });

  if (failures.length > 0) {
    process.stderr.write(
      `[agent-coordinator] WARNING: local rollback failed for ${failures.join(", ")}.\n`,
    );
  }
}

function coordinatedCommit(context) {
  context = currentPolicyContext(
    context,
    context.workspaceManifest ? "index" : "worktree",
  );
  assertSupportedCommit(context.commandArguments);
  assertBranchInvariant(context);
  assertReadOnlyRepositoriesClean(context);

  const candidates = writableRepositories(context).filter((repository) =>
    repositoryHasCommitCandidate(repository.directory, context.commandArguments),
  );
  if (candidates.length === 0) {
    return executeRootGit(context, [
      "commit",
      ...context.commandArguments,
    ]).status;
  }
  if (!hasExplicitCommitMessage(context.commandArguments)) {
    throw new CoordinatedGitError(
      "a coordinated commit currently requires -m/--message or -F/--file so every repository receives the same message.",
    );
  }

  const committedRepositories = [];
  const childArguments = childCommitArguments(
    context.rootDirectory,
    context.commandArguments,
  );
  for (const repository of candidates) {
    const originalRevision = gitText(repository.directory, ["rev-parse", "HEAD"]).stdout;
  process.stderr.write(
      `[agent-coordinator] committing ${repository.id}...\n`,
    );
    const result = executeGit(repository.directory, [
      "commit",
      ...childArguments,
    ]);
    const currentRevision = gitText(repository.directory, ["rev-parse", "HEAD"]).stdout;
    if (currentRevision !== originalRevision) {
      committedRepositories.push({
        repository,
        originalRevision,
      });
    }
    if (result.status !== 0) {
      rollbackChildCommits(context, committedRepositories);
      return result.status;
    }
  }

  const stageResult = executeRootGit(context, [
    "add",
    "--",
    ...context.repositories.map((repository) => repository.path),
  ]);
  if (stageResult.status !== 0) {
    rollbackChildCommits(context, committedRepositories);
    return stageResult.status;
  }

  process.stderr.write("[agent-coordinator] committing coordinator...\n");
  const rootResult = executeRootGit(context, [
    "commit",
    ...context.commandArguments,
  ]);
  if (rootResult.status !== 0) {
    rollbackChildCommits(context, committedRepositories);
  }
  return rootResult.status;
}

function pullArguments(argumentsList) {
  const allowedOptions = new Set([
    "--ff-only",
    "--no-rebase",
    "--no-progress",
    "--progress",
    "--quiet",
    "--verbose",
    "-q",
    "-v",
  ]);
  const forbiddenOptions = [
    "--all",
    "--allow-unrelated-histories",
    "--autostash",
    "--ff",
    "--force",
    "--no-ff",
    "--rebase",
    "--recurse-submodules",
    "--strategy",
    "--strategy-option",
    "--tags",
    "-f",
    "-r",
    "-s",
    "-X",
  ];
  const options = [];
  const positionals = [];

  for (const argument of argumentsList) {
    if (
      forbiddenOptions.some(
        (option) => argument === option || argument.startsWith(`${option}=`),
      )
    ) {
      throw new CoordinatedGitError(
        `${argument} is incompatible with a fast-forward-only coordinated pull.`,
      );
    }
    if (argument.startsWith("-")) {
      if (!allowedOptions.has(argument)) {
        throw new CoordinatedGitError(
          `${argument} is not supported for a coordinated pull.`,
        );
      }
      if (!["--ff-only", "--no-rebase"].includes(argument)) {
        options.push(argument);
      }
      continue;
    }
    positionals.push(argument);
  }

  if (positionals.length > 2) {
    throw new CoordinatedGitError(
      "coordinated pull supports one remote and one branch.",
    );
  }
  return { options, positionals };
}

function assertPullWorktreesClean(context) {
  const dirty = [];
  const rootStatus = gitText(context.rootDirectory, ["status", "--porcelain"]);
  if (rootStatus.stdout) dirty.push("coordinator");

  for (const repository of writableRepositories(context)) {
    const status = gitText(repository.directory, ["status", "--porcelain"]);
    if (status.stdout) dirty.push(repository.id);
  }

  if (dirty.length > 0) {
    throw new CoordinatedGitError(
      `coordinated pull requires clean worktrees: ${dirty.join(", ")}.`,
      "DIRTY_WORKTREE",
    );
  }
}

function remoteTrackingReference(remote, branch) {
  return `refs/remotes/${remote}/${branch}`;
}

function fetchPullTarget(context, target, remote, options) {
  const reference = remoteTrackingReference(remote, target.branch);
  const argumentsList = [
    "fetch",
    ...options,
    "--no-recurse-submodules",
    "--no-tags",
    remote,
    `+refs/heads/${target.branch}:${reference}`,
  ];
  process.stderr.write(
    `[agent-coordinator] fetching ${target.label}/${target.branch}...\n`,
  );
  const result = target.root
    ? executeRootGit(context, argumentsList)
    : executeGit(target.directory, argumentsList);
  if (result.status !== 0) {
    throw new CoordinatedGitError(
      `Could not fetch ${target.label}/${target.branch}. Check the Git output above for authentication, connectivity, or a missing remote branch. No coordinated fast-forward has started.`,
      "FETCH_FAILED",
    );
  }

  const localRevision = gitText(target.directory, ["rev-parse", "HEAD"]).stdout;
  const remoteRevision = gitText(target.directory, ["rev-parse", reference]).stdout;
  let state = "diverged";
  if (localRevision === remoteRevision) {
    state = "equal";
  } else if (
    gitText(
      target.directory,
      ["merge-base", "--is-ancestor", localRevision, remoteRevision],
      { allowFailure: true },
    ).status === 0
  ) {
    state = "behind";
  } else if (
    gitText(
      target.directory,
      ["merge-base", "--is-ancestor", remoteRevision, localRevision],
      { allowFailure: true },
    ).status === 0
  ) {
    state = "ahead";
  }

  return {
    localRevision,
    reference,
    remoteRevision,
    result,
    state,
    target,
  };
}

function coordinatedPull(context) {
  context = currentPolicyContext(
    context,
    context.workspaceManifest ? { revision: "HEAD" } : "worktree",
  );
  const branch = assertFullInvariant(
    context,
    context.workspaceManifest ? "HEAD" : null,
  );
  assertReadOnlyRepositoriesClean(
    context,
    context.workspaceManifest ? "HEAD" : null,
  );
  assertPullWorktreesClean(context);

  const { options, positionals } = pullArguments(context.commandArguments);
  const configuredRemote = gitText(
    context.rootDirectory,
    ["config", "--get", `branch.${branch}.remote`],
    { allowFailure: true },
  );
  const remote =
    positionals[0] ||
    configuredRemote.stdout ||
    context.configuration.remote ||
    "origin";
  const requestedBranch = positionals[1];
  if (
    requestedBranch &&
    ![branch, `refs/heads/${branch}`].includes(requestedBranch)
  ) {
    throw new CoordinatedGitError(
      `pull branch '${requestedBranch}' does not represent coordinated branch '${branch}'.`,
    );
  }

  const targets = [
    {
      branch,
      directory: context.rootDirectory,
      label: "coordinator",
      root: true,
    },
    ...context.repositories.map((repository) => ({
      branch: resolvedRepositoryBranch(repository, branch),
      directory: repository.directory,
      label: repository.id,
      repository,
      readOnly: repository.branchPolicy.readOnly,
      root: false,
    })),
  ];

  for (const target of targets) {
    const remoteCheck = gitText(
      target.directory,
      ["remote", "get-url", remote],
      { allowFailure: true },
    );
    if (remoteCheck.status !== 0) {
      throw new CoordinatedGitError(
        `${target.label} does not define remote '${remote}'.`,
      );
    }
  }

  const plans = [];
  for (const target of targets) {
    const plan = fetchPullTarget(context, target, remote, options);
    plans.push(plan);
  }

  const diverged = plans.filter((plan) =>
    plan.state === "diverged" && !plan.target.readOnly);
  if (diverged.length > 0) {
    throw new CoordinatedGitError(
      `coordinated pull cannot fast-forward: ${diverged
        .map((plan) => `${plan.target.label}/${plan.target.branch}`)
        .join(", ")}. Resolve the divergence explicitly before retrying.`,
      "DIVERGED_HISTORY",
    );
  }

  // Fetch objects first, then validate the incoming contract before moving any HEAD.
  const rootPlan = plans.find((plan) => plan.target.root);
  if (!rootPlan) throw new CoordinatedGitError("Pull planning lost the coordinator target.");
  const incomingReference = rootPlan.state === "behind" ? rootPlan.reference : "HEAD";
  const incomingConfiguration = loadContext(context, { revision: incomingReference });
  if (!incomingConfiguration) throw new CoordinatedGitError(
    "The incoming coordinator has no valid Agent Coordinator configuration. No coordinated fast-forward has started.",
    "INCOMING_CONFIGURATION_MISSING",
  );
  const incomingContext = currentPolicyContext(
    incomingConfiguration,
    { revision: incomingReference },
  );
  if (
    incomingContext.repositories.length !== context.repositories.length ||
    incomingContext.repositories.some((repository) => {
      const previous = context.repositories.find((entry) => entry.id === repository.id);
      return !previous || previous.path !== repository.path ||
        previous.branchPolicy.readOnly !== repository.branchPolicy.readOnly ||
        resolvedRepositoryBranch(previous, branch) !== resolvedRepositoryBranch(repository, branch);
    })
  ) {
    throw new CoordinatedGitError(
      "The incoming coordinator changes repository paths or branch policies. Review its manifest before updating the workspace. No coordinated fast-forward has started.",
      "INCOMING_CONFIGURATION_CHANGED",
    );
  }
  const incomingRevisions = new Map();
  for (const repository of incomingContext.repositories) {
    const revision = rootGitlinkRevision(incomingContext, repository, incomingReference);
    incomingRevisions.set(repository.id, revision);
    const treeEntry = gitText(context.rootDirectory, [
      "ls-tree", incomingReference, "--", repository.path,
    ]);
    if (!treeEntry.stdout.startsWith("160000 commit " + revision + "\t")) {
      throw new CoordinatedGitError(
        repository.id + " is not a valid gitlink in the incoming coordinator. No coordinated fast-forward has started.",
        "INVALID_INCOMING_GITLINK",
      );
    }
    const childPlan = plans.find((plan) => plan.target.repository?.id === repository.id);
    if (!childPlan || !revisionIsAncestor(repository, revision, childPlan.remoteRevision)) {
      throw new CoordinatedGitError(
        repository.id + " cannot obtain incoming gitlink " + revision.slice(0, 8) +
          " from " + remote + "/" + resolvedRepositoryBranch(repository, branch) +
          ". The remote coordinator references an unpublished or rewritten commit. Repair that gitlink or restore the commit before retrying. No worktree or local branch was moved.",
        "MISSING_INCOMING_COMMIT",
      );
    }
    if (repository.branchPolicy.readOnly &&
        repository.branchPolicy.mode !== "pinned" &&
        revision !== childPlan.remoteRevision &&
        revision !== gitText(repository.directory, ["rev-parse", "HEAD"]).stdout) {
      throw new CoordinatedGitError(
        repository.id + " is read-only and its incoming gitlink is not the fetched branch tip. Review that coordinator revision before retrying.",
        "AMBIGUOUS_READ_ONLY_UPDATE",
      );
    }
    if (repository.branchPolicy.readOnly &&
        repository.branchPolicy.mode !== "pinned" &&
        revision !== gitText(repository.directory, ["rev-parse", "HEAD"]).stdout &&
        childPlan.state !== "behind") {
      throw new CoordinatedGitError(
        repository.id + " is read-only and cannot fast-forward safely to its incoming gitlink. Preserve or reconcile its local history before retrying.",
        "READ_ONLY_HISTORY_CONFLICT",
      );
    }
  }

  // Advance children before the coordinator. A later failure can then be repaired
  // by recording their tips; the coordinator never moves before all children do.
  const applyPlans = [...plans.filter((plan) => !plan.target.root), rootPlan];
  for (const plan of applyPlans) {
    const currentRevision = gitText(plan.target.directory, ["rev-parse", "HEAD"]).stdout;
    if (currentRevision !== plan.localRevision) {
      throw new CoordinatedGitError(
        plan.target.label + " changed after pull planning. Run the pull again.",
        "STALE_PULL_PLAN",
      );
    }
    if (plan.target.readOnly &&
        currentRevision === incomingRevisions.get(plan.target.repository.id)) {
      continue;
    }
    if (plan.target.readOnly && plan.target.repository.branchPolicy.mode === "pinned") {
      const revision = incomingRevisions.get(plan.target.repository.id);
      if (currentRevision !== revision) switchRepositoryDetached(plan.target.directory, revision);
      continue;
    }
    if (plan.state !== "behind") continue;
    process.stderr.write(
      `[agent-coordinator] fast-forwarding ${plan.target.label}/${plan.target.branch}...\n`,
    );
    const argumentsList = ["merge", "--ff-only", plan.reference];
    const result = plan.target.root
      ? executeRootGit(context, argumentsList)
      : executeGit(plan.target.directory, argumentsList);
    if (result.status !== 0) {
      throw new CoordinatedGitError(
        "Could not fast-forward " + plan.target.label + ". Earlier child repositories may already be updated; run 'coordinator git recover' to inspect the exact state.",
        "PARTIAL_PULL",
      );
    }
  }

  const stageResult = executeRootGit(context, [
    "add",
    "--",
    ...context.repositories.map((repository) => repository.path),
  ]);
  if (stageResult.status !== 0) {
    throw new CoordinatedGitError(
      "Repositories were updated, but their gitlinks could not be staged. Run 'coordinator git recover' to inspect and record the current revisions.",
      "PARTIAL_PULL",
    );
  }

  if (hasStagedChanges(context.rootDirectory)) {
    process.stderr.write(
      "[agent-coordinator] recording updated repository revisions...\n",
    );
    const commitResult = executeRootGit(context, [
      "commit",
      "-m",
      "Sync coordinated repositories",
    ]);
    if (commitResult.status !== 0) {
      throw new CoordinatedGitError(
        "Repositories and staged gitlinks are updated, but the coordinator commit failed. Review the Git error above, then commit the staged gitlinks.",
        "PENDING_GITLINK_COMMIT",
      );
    }
  }

  const refreshedContext = loadContext(
    context,
    configurationSourceForInvocation(context),
  );
  if (!refreshedContext) {
    throw new CoordinatedGitError(
      "coordinator configuration disappeared during pull.",
    );
  }
  const effectiveContext = currentPolicyContext(
    refreshedContext,
    refreshedContext.workspaceManifest ? { revision: "HEAD" } : "worktree",
  );
  assertFullInvariant(
    effectiveContext,
    effectiveContext.workspaceManifest ? "HEAD" : null,
  );
  assertReadOnlyRepositoriesClean(
    effectiveContext,
    effectiveContext.workspaceManifest ? "HEAD" : null,
  );
  return 0;
}

function pushArguments(argumentsList) {
  const forbidden = [
    "--all",
    "--atomic",
    "--delete",
    "-d",
    "--force",
    "-f",
    "--force-with-lease",
    "--force-if-includes",
    "--mirror",
    "--prune",
    "--tags",
  ];
  for (const argument of argumentsList) {
    if (
      forbidden.some(
        (option) => argument === option || argument.startsWith(`${option}=`),
      )
    ) {
      throw new CoordinatedGitError(
        `${argument} is intentionally blocked for a coordinated push.`,
      );
    }
  }

  const options = [];
  const positionals = [];
  const optionsWithValue = new Set([
    "--exec",
    "--push-option",
    "-o",
    "--receive-pack",
  ]);

  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    if (optionsWithValue.has(argument)) {
      const value = argumentsList[index + 1];
      if (!value) {
        throw new CoordinatedGitError(`${argument} requires a value.`);
      }
      options.push(argument, value);
      index += 1;
    } else if (argument.startsWith("-")) {
      options.push(argument);
    } else {
      positionals.push(argument);
    }
  }

  if (positionals.length > 2) {
    throw new CoordinatedGitError(
      "coordinated push supports one remote and one branch refspec.",
    );
  }
  return { options, positionals };
}

function assertPushRemotes(context, remote) {
  for (const repository of writableRepositories(context)) {
    const remoteCheck = gitText(
      repository.directory,
      ["remote", "get-url", remote],
      { allowFailure: true },
    );
    if (remoteCheck.status !== 0) {
      throw new CoordinatedGitError(
        `${repository.id} does not define remote '${remote}'.`,
      );
    }
  }
}

function pushWritableRepositories(context, branch, remote, options = []) {
  assertPushRemotes(context, remote);
  const published = [];
  for (const repository of writableRepositories(context)) {
    const repositoryBranch = resolvedRepositoryBranch(repository, branch);
    const childUpstream = gitText(
      repository.directory,
      [
        "rev-parse",
        "--abbrev-ref",
        "--symbolic-full-name",
        "@{upstream}",
      ],
      { allowFailure: true },
    );
    const childOptions =
      childUpstream.status !== 0
        ? [...options, "--set-upstream"]
        : options;
    process.stderr.write(
      `[agent-coordinator] pushing ${repository.id}/${repositoryBranch}...\n`,
    );
    const result = executeGit(repository.directory, [
      "push",
      ...childOptions,
      remote,
      `HEAD:refs/heads/${repositoryBranch}`,
    ]);
    if (result.status !== 0) {
      const completed =
        published.length > 0 ? ` Already pushed: ${published.join(", ")}.` : "";
      process.stderr.write(
        `[agent-coordinator] push stopped at ${repository.id}.${completed}\n`,
      );
      return result.status;
    }
    published.push(repository.id);
  }
  return 0;
}

function coordinatedPush(context) {
  context = currentPolicyContext(
    context,
    context.workspaceManifest ? { revision: "HEAD" } : "worktree",
  );
  const branch = assertFullInvariant(
    context,
    context.workspaceManifest ? "HEAD" : null,
  );
  assertReadOnlyRepositoriesClean(
    context,
    context.workspaceManifest ? "HEAD" : null,
  );
  const { options, positionals } = pushArguments(context.commandArguments);
  const configuredRemote = gitText(
    context.rootDirectory,
    ["config", "--get", `branch.${branch}.remote`],
    { allowFailure: true },
  );
  const remote = positionals[0] || configuredRemote.stdout || "origin";
  const requestedRefspec = positionals[1];

  if (
    requestedRefspec &&
    ![
      branch,
      "HEAD",
      `HEAD:${branch}`,
      `HEAD:refs/heads/${branch}`,
      `${branch}:${branch}`,
      `${branch}:refs/heads/${branch}`,
    ].includes(requestedRefspec)
  ) {
    throw new CoordinatedGitError(
      `push refspec '${requestedRefspec}' does not represent coordinated branch '${branch}'.`,
    );
  }

  const upstream = gitText(
    context.rootDirectory,
    ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"],
    { allowFailure: true },
  );
  const automaticallySetUpstream =
    positionals.length === 0 && upstream.status !== 0;
  const childrenResult = pushWritableRepositories(
    context,
    branch,
    remote,
    options,
  );
  if (childrenResult !== 0) return childrenResult;

  process.stderr.write(`[agent-coordinator] pushing coordinator/${branch}...\n`);
  const rootPushArguments = automaticallySetUpstream
    ? ["push", "--set-upstream", remote, `HEAD:refs/heads/${branch}`]
    : ["push", ...context.commandArguments];
  return executeRootGit(context, rootPushArguments).status;
}

function branchExists(repository, branch) {
  return (
    gitText(
      repository,
      ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
      { allowFailure: true },
    ).status === 0
  );
}

function validateBranchName(branch) {
  const result = git(["check-ref-format", "--branch", branch], {
    capture: true,
  });
  if (result.status !== 0) {
    throw new CoordinatedGitError(`invalid branch name: ${branch}`);
  }
}

function switchRepository(repository, branch) {
  const result = executeGit(repository, ["switch", branch]);
  if (result.status !== 0) {
    throw new CoordinatedGitError(
      `could not switch ${repository} to '${branch}'.`,
    );
  }
}

function switchRepositoryDetached(repository, revision) {
  const result = executeGit(repository, ["switch", "--detach", revision]);
  if (result.status !== 0) {
    throw new CoordinatedGitError(
      `could not detach ${repository} at '${revision.slice(0, 8)}'.`,
    );
  }
}

function restoreRepository(repository, state) {
  const argumentsList = state.branch
    ? ["switch", state.branch]
    : ["switch", "--detach", state.revision];
  return executeGit(repository, argumentsList, { capture: true }).status === 0;
}

function repositoryState(repository) {
  return {
    branch: currentBranch(repository),
    revision: gitText(repository, ["rev-parse", "HEAD"]).stdout,
  };
}

function rollbackRepositories(states, createdBranches = []) {
  const failures = [];
  for (const { repository, state } of [...states].reverse()) {
    if (!restoreRepository(repository, state)) failures.push(repository);
  }
  for (const { repository, branch } of [...createdBranches].reverse()) {
    const result = executeGit(
      repository,
      ["branch", "-D", branch],
      { capture: true },
    );
    if (result.status !== 0) failures.push(`${repository}:${branch}`);
  }
  if (failures.length > 0) {
    process.stderr.write(
      `[agent-coordinator] WARNING: rollback needs manual recovery for ${failures.join(", ")}.\n`,
    );
  }
}

function rootGitlinkRevision(context, repository, rootReference = null) {
  const result = rootGitlink(context, repository, rootReference);
  if (result.status !== 0) {
    throw new CoordinatedGitError(
      `${repository.id} gitlink is missing from ${rootReference ?? "the coordinator index"}.`,
    );
  }
  return result.stdout;
}

function prepareBranchAtRevision(
  repository,
  branch,
  desiredRevision,
  createdBranches,
) {
  const created = planBranchAtRevision(repository, branch, desiredRevision);
  if (!created) return false;

  const result = executeGit(repository.directory, [
    "branch",
    branch,
    desiredRevision,
  ]);
  if (result.status !== 0) {
    throw new CoordinatedGitError(
      `could not create '${branch}' in ${repository.id}.`,
    );
  }
  createdBranches.push({
    repository: repository.directory,
    branch,
  });
  return true;
}

function planBranchAtRevision(repository, branch, desiredRevision) {
  validateBranchName(branch);
  if (branchExists(repository.directory, branch)) {
    const branchRevision = gitText(repository.directory, [
      "rev-parse",
      `refs/heads/${branch}`,
    ]).stdout;
    if (branchRevision !== desiredRevision) {
      throw new CoordinatedGitError(
        `${repository.id} branch '${branch}' is at ${branchRevision.slice(0, 8)}, expected gitlink ${desiredRevision.slice(0, 8)}.`,
      );
    }
    return false;
  }
  return true;
}

function revisionIsAncestor(repository, ancestor, descendant) {
  return (
    gitText(
      repository.directory,
      ["merge-base", "--is-ancestor", ancestor, descendant],
      { allowFailure: true },
    ).status === 0
  );
}

function assertPreparedBranchRevision(
  repository,
  prepared,
  { checkedOut = false } = {},
) {
  if (!prepared.expectedBranchRevision) return;
  const reference = gitText(
    repository.directory,
    ["rev-parse", `refs/heads/${prepared.branch}`],
    { allowFailure: true },
  );
  const checkoutMatches =
    !checkedOut ||
    (currentBranch(repository.directory) === prepared.branch &&
      gitText(repository.directory, ["rev-parse", "HEAD"]).stdout ===
        prepared.expectedBranchRevision);
  if (
    reference.status !== 0 ||
    reference.stdout !== prepared.expectedBranchRevision ||
    !checkoutMatches
  ) {
    throw new CoordinatedGitError(
      `${repository.id} branch '${prepared.branch}' changed after checkout planning. Retry once the child repository is stable.`,
    );
  }
}

function readTerminalLine() {
  let terminal;
  try {
    terminal = openSync("/dev/tty", "r");
  } catch (error) {
    throw new CoordinatedGitError(
      `could not open the controlling terminal: ${error.message}`,
    );
  }
  const buffer = Buffer.alloc(1);
  let value = "";
  try {
    while (true) {
      const bytesRead = readSync(terminal, buffer, 0, 1, null);
      if (bytesRead === 0) {
        throw new CoordinatedGitError(
          "terminal input closed before a pinned branch resolution was selected.",
        );
      }
      const character = buffer.toString("utf8", 0, bytesRead);
      if (character === "\n") return value.trim().toLowerCase();
      if (character !== "\r") value += character;
    }
  } finally {
    closeSync(terminal);
  }
}

function pinnedBranchResolution(
  repository,
  branch,
  pinnedRevision,
  branchRevision,
) {
  const configured = process.env[PINNED_RESOLUTION_ENVIRONMENT_VARIABLE];
  if (configured) {
    if (["advance", "latest", "detach", "cancel"].includes(configured)) {
      return configured;
    }
    throw new CoordinatedGitError(
      `${PINNED_RESOLUTION_ENVIRONMENT_VARIABLE} must be advance, latest, detach, or cancel.`,
    );
  }

  if (!process.stdin.isTTY || !process.stderr.isTTY) {
    throw new CoordinatedGitError(
      `${repository.id} branch '${branch}' is at ${branchRevision.slice(0, 8)} while the gitlink pins ${pinnedRevision.slice(0, 8)}. Rerun interactively or set ${PINNED_RESOLUTION_ENVIRONMENT_VARIABLE}=advance|latest|detach|cancel.`,
    );
  }

  process.stderr.write(
    `[agent-coordinator] ${repository.id} branch '${branch}' is at ${branchRevision.slice(0, 8)}, while the new branch would pin ${pinnedRevision.slice(0, 8)}.\n` +
      "  [a] Advance the new branch pin to the current local branch tip\n" +
      "  [l] Fetch the latest remote branch and update the new branch pin\n" +
      "  [d] Keep the historical gitlink detached\n" +
      "  [c] Cancel branch creation\n",
  );
  while (true) {
    process.stderr.write("Choose a, l, d, or c: ");
    const answer = readTerminalLine();
    if (answer === "a" || answer === "advance") return "advance";
    if (answer === "l" || answer === "latest") return "latest";
    if (answer === "d" || answer === "detach") return "detach";
    if (answer === "c" || answer === "cancel") return "cancel";
  }
}

function fetchLatestPinnedRevision(
  context,
  repository,
  branch,
  pinnedRevision,
) {
  const remote = context.configuration.remote || "origin";
  const temporaryReference =
    `refs/agent-coordinator/pinned-resolution/${randomUUID()}`;
  process.stderr.write(
    `[agent-coordinator] fetching latest ${repository.id}/${branch} from ${remote}...\n`,
  );
  let operationError = null;
  let remoteRevision = null;
  try {
    const result = executeGit(repository.directory, [
      "fetch",
      "--no-tags",
      "--no-recurse-submodules",
      "--no-write-fetch-head",
      "--",
      remote,
      `+refs/heads/${branch}:${temporaryReference}`,
    ]);
    if (result.status !== 0) {
      throw new CoordinatedGitError(
        `could not fetch latest ${remote}/${branch} for ${repository.id}.`,
      );
    }
    remoteRevision = gitText(repository.directory, [
      "rev-parse",
      temporaryReference,
    ]).stdout;
    if (
      gitText(
        repository.directory,
        ["merge-base", "--is-ancestor", pinnedRevision, remoteRevision],
        { allowFailure: true },
      ).status !== 0
    ) {
      throw new CoordinatedGitError(
        `${repository.id} latest ${remote}/${branch} at ${remoteRevision.slice(0, 8)} does not contain pinned gitlink ${pinnedRevision.slice(0, 8)}.`,
      );
    }
  } catch (error) {
    operationError = error;
  } finally {
    const cleanup = executeGit(
      repository.directory,
      ["update-ref", "-d", temporaryReference],
      { capture: true },
    );
    if (cleanup.status !== 0) {
      const cleanupMessage =
        `could not remove temporary ref ${temporaryReference} in ${repository.id}.`;
      if (operationError) {
        throw new CoordinatedGitError(
          `${operationError.message} Additionally, ${cleanupMessage}`,
        );
      }
      throw new CoordinatedGitError(cleanupMessage);
    }
  }
  if (operationError) throw operationError;
  return remoteRevision;
}

function prepareRepositoryAtRevision(
  context,
  repository,
  coordinatorBranch,
  desiredRevision,
  createdBranches,
  options = {},
) {
  const repositoryBranch = resolvedRepositoryBranch(
    repository,
    coordinatorBranch,
  );
  if (repository.branchPolicy.mode !== "pinned") {
    validateBranchName(repositoryBranch);
    if (
      options.reconcileExistingBranch &&
      branchExists(repository.directory, repositoryBranch)
    ) {
      assertCommitAvailable(repository, desiredRevision, "the target branch");
      const branchRevision = gitText(repository.directory, [
        "rev-parse",
        `refs/heads/${repositoryBranch}`,
      ]).stdout;
      if (branchRevision === desiredRevision) {
        return {
          branch: repositoryBranch,
          created: false,
          desiredRevision,
          detached: false,
          expectedBranchRevision: branchRevision,
          updateGitlink: false,
        };
      }
      if (
        !repository.branchPolicy.readOnly &&
        revisionIsAncestor(repository, desiredRevision, branchRevision)
      ) {
        return {
          branch: repositoryBranch,
          created: false,
          desiredRevision: branchRevision,
          detached: false,
          expectedBranchRevision: branchRevision,
          previousGitlink: desiredRevision,
          updateGitlink: true,
        };
      }
      if (!repository.branchPolicy.readOnly) {
        if (revisionIsAncestor(repository, branchRevision, desiredRevision)) {
          throw new CoordinatedGitError(
            `${repository.id} branch '${repositoryBranch}' at ${branchRevision.slice(0, 8)} is behind target gitlink ${desiredRevision.slice(0, 8)}. Fast-forward the child branch before switching.`,
          );
        }
        throw new CoordinatedGitError(
          `${repository.id} branch '${repositoryBranch}' at ${branchRevision.slice(0, 8)} has diverged from target gitlink ${desiredRevision.slice(0, 8)}. Resolve the child branch or mapping before switching.`,
        );
      }
    }
    const created = options.planOnly
      ? planBranchAtRevision(repository, repositoryBranch, desiredRevision)
      : prepareBranchAtRevision(
          repository,
          repositoryBranch,
          desiredRevision,
          createdBranches,
        );
    return {
      branch: repositoryBranch,
      created,
      desiredRevision,
      detached: false,
      updateGitlink: false,
    };
  }

  validateBranchName(repositoryBranch);
  const checkedOutBranch = currentBranch(repository.directory);
  const checkedOutRevision = gitText(repository.directory, [
    "rev-parse",
    "HEAD",
  ]).stdout;
  if (
    checkedOutBranch === repositoryBranch &&
    checkedOutRevision === desiredRevision
  ) {
    return {
      branch: repositoryBranch,
      created: false,
      desiredRevision,
      detached: false,
      updateGitlink: false,
    };
  }
  const branchRevisionResult = gitText(
    repository.directory,
    ["rev-parse", `refs/heads/${repositoryBranch}`],
    { allowFailure: true },
  );
  if (branchRevisionResult.status !== 0) {
    return {
      branch: repositoryBranch,
      created: false,
      desiredRevision,
      detached: true,
      updateGitlink: false,
    };
  }
  const branchRevision = branchRevisionResult.stdout;
  if (branchRevision === desiredRevision) {
    return {
      branch: repositoryBranch,
      created: false,
      desiredRevision,
      detached: true,
      updateGitlink: false,
    };
  }
  if (
    !branchContainsRevision(
      context,
      repository,
      repositoryBranch,
      desiredRevision,
    )
  ) {
    throw new CoordinatedGitError(
      `${repository.id} pinned gitlink ${desiredRevision.slice(0, 8)} is not reachable from '${repositoryBranch}'.`,
    );
  }
  if (!options.resolvePinnedDivergence) {
    return {
      branch: repositoryBranch,
      created: false,
      desiredRevision,
      detached: true,
      updateGitlink: false,
    };
  }

  const resolution = pinnedBranchResolution(
    repository,
    repositoryBranch,
    desiredRevision,
    branchRevision,
  );
  if (resolution === "cancel") {
    throw new CoordinatedGitError(
      `branch creation cancelled while resolving ${repository.id}.`,
    );
  }
  if (resolution === "advance") {
    return {
      branch: repositoryBranch,
      created: false,
      desiredRevision: branchRevision,
      detached: false,
      previousGitlink: desiredRevision,
      updateGitlink: true,
    };
  }
  if (resolution === "latest") {
    const latestRevision = fetchLatestPinnedRevision(
      context,
      repository,
      repositoryBranch,
      desiredRevision,
    );
    return {
      branch: repositoryBranch,
      created: false,
      desiredRevision: latestRevision,
      detached: true,
      previousGitlink: desiredRevision,
      updateGitlink: latestRevision !== desiredRevision,
    };
  }
  return {
    branch: repositoryBranch,
    created: false,
    desiredRevision,
    detached: true,
    updateGitlink: false,
  };
}

function checkoutPreparedRepository(context, repository, prepared) {
  if (prepared.detached) {
    switchRepositoryDetached(repository.directory, prepared.desiredRevision);
    return;
  }
  switchRepository(repository.directory, prepared.branch);
  if (prepared.created) {
    setUpstreamFromRemote(context, repository, prepared.branch);
  }
}

function assertCleanWorkspaceBranchChange(context) {
  if (!context.workspaceManifest) return;
  const status = gitText(context.rootDirectory, [
    "status",
    "--porcelain",
    "--untracked-files=normal",
    "--ignore-submodules=none",
  ]);
  if (status.stdout) {
    throw new CoordinatedGitError(
      "the coordinator and its submodules must be clean before creating or switching a manifest-managed branch.",
      "DIRTY_WORKTREE",
    );
  }
}

function setUpstreamFromRemote(context, repository, branch) {
  const remote = context.configuration.remote || "origin";
  const remoteBranch = gitText(
    repository.directory,
    [
      "show-ref",
      "--verify",
      "--quiet",
      `refs/remotes/${remote}/${branch}`,
    ],
    { allowFailure: true },
  );
  if (remoteBranch.status === 0) {
    executeGit(
      repository.directory,
      ["branch", "--set-upstream-to", `${remote}/${branch}`, branch],
      { capture: true },
    );
  }
}

function branchMappingSummary(context, coordinatorBranch) {
  return context.repositories
    .map((repository) => {
      const repositoryBranch = resolvedRepositoryBranch(
        repository,
        coordinatorBranch,
      );
      const suffix = repository.branchPolicy.readOnly ? " (read-only)" : "";
      return `${repository.id}=${repositoryBranch}${suffix}`;
    })
    .join(", ");
}

function createCoordinatedBranch(context, branch) {
  validateBranchName(branch);
  context = currentPolicyContext(context);
  assertFullInvariant(context);
  assertCleanWorkspaceBranchChange(context);
  if (branchExists(context.rootDirectory, branch)) {
    throw new CoordinatedGitError(
      `branch '${branch}' already exists in the coordinator.`,
    );
  }

  const allRepositories = [
    ...context.repositories.map((repository) => repository.directory),
    context.rootDirectory,
  ];
  const states = allRepositories.map((repository) => ({
    repository,
    state: repositoryState(repository),
  }));
  const createdBranches = [];
  const nextManifest = creationManifest(context, branch);
  const originalManifest = context.workspaceManifest
    ? readFileSync(context.workspaceManifest.absolutePath, "utf8")
    : null;
  const creationContext = nextManifest
    ? manifestPolicyContextFromValue(context, branch, nextManifest)
    : configuredPolicyContext(context);
  let manifestWritten = false;
  let preparedRepositories = [];
  try {
    preparedRepositories = creationContext.repositories.map(
      (repository) => ({
        repository,
        prepared: prepareRepositoryAtRevision(
          creationContext,
          repository,
          branch,
          rootGitlinkRevision(creationContext, repository),
          createdBranches,
          { planOnly: true, resolvePinnedDivergence: true },
        ),
      }),
    );

    for (const { repository, prepared } of preparedRepositories) {
      if (!prepared.created) continue;
      const result = executeGit(repository.directory, [
        "branch",
        prepared.branch,
        prepared.desiredRevision,
      ]);
      if (result.status !== 0) {
        throw new CoordinatedGitError(
          `could not create '${prepared.branch}' in ${repository.id}.`,
        );
      }
      createdBranches.push({
        repository: repository.directory,
        branch: prepared.branch,
      });
    }

    const rootResult = executeGit(context.rootDirectory, ["branch", branch]);
    if (rootResult.status !== 0) {
      throw new CoordinatedGitError(
        `could not create '${branch}' in the coordinator.`,
      );
    }
    createdBranches.push({
      repository: context.rootDirectory,
      branch,
    });

    for (const { repository, prepared } of preparedRepositories) {
      checkoutPreparedRepository(creationContext, repository, prepared);
    }
    switchRepository(context.rootDirectory, branch);
    if (nextManifest) {
      writeWorkspaceManifest(context, nextManifest);
      manifestWritten = true;
    }
    const advancedRepositories = preparedRepositories.filter(
      ({ prepared }) => prepared.updateGitlink,
    );
    for (const { repository } of advancedRepositories) {
      const result = executeGit(context.rootDirectory, [
        "add",
        "--",
        repository.path,
      ]);
      if (result.status !== 0) {
        throw new CoordinatedGitError(
          `could not stage the updated ${repository.id} gitlink.`,
        );
      }
    }
    const effectiveContext = currentPolicyContext(context);
    assertFullInvariant(effectiveContext);
    if (advancedRepositories.length > 0) {
      process.stderr.write(
        `[agent-coordinator] staged updated pinned gitlinks: ${advancedRepositories.map(({ repository }) => repository.id).join(", ")}.\n`,
      );
    }
    process.stderr.write(
      `[agent-coordinator] created '${branch}': ${branchMappingSummary(effectiveContext, branch)}.\n`,
    );
    return 0;
  } catch (error) {
    const gitlinkRollbackFailures = [];
    for (const { repository, prepared } of preparedRepositories) {
      if (!prepared.updateGitlink) continue;
      const result = executeGit(
        context.rootDirectory,
        [
          "update-index",
          "--cacheinfo",
          `160000,${prepared.previousGitlink},${repository.path}`,
        ],
        { capture: true },
      );
      if (result.status !== 0) gitlinkRollbackFailures.push(repository.id);
    }
    if (manifestWritten) {
      writeFileSync(context.workspaceManifest.absolutePath, originalManifest, {
        mode: 0o644,
      });
    }
    rollbackRepositories(states, createdBranches);
    if (gitlinkRollbackFailures.length > 0) {
      process.stderr.write(
        `[agent-coordinator] WARNING: rollback could not restore staged gitlinks for ${gitlinkRollbackFailures.join(", ")}.\n`,
      );
    }
    throw error;
  }
}

function resolveStartPointCommit(context, startPoint) {
  const result = gitText(
    context.rootDirectory,
    ["rev-parse", "--verify", `${startPoint}^{commit}`],
    { allowFailure: true },
  );
  if (result.status !== 0) {
    throw new CoordinatedGitError(
      `start-point '${startPoint}' does not resolve to a commit in the coordinator.`,
    );
  }
  return result.stdout;
}

function assertRepositoriesClean(contexts) {
  const repositories = new Map();
  for (const context of contexts) {
    repositories.set(context.rootDirectory, "coordinator");
    for (const repository of context.repositories) {
      repositories.set(repository.directory, repository.id);
    }
  }

  const dirty = [];
  for (const [directory, label] of repositories) {
    const status = gitText(directory, [
      "status",
      "--porcelain",
      "--untracked-files=normal",
      "--ignore-submodules=none",
    ]);
    if (status.stdout) dirty.push(label);
  }
  if (dirty.length > 0) {
    throw new CoordinatedGitError(
      `coordinated branch creation from a start-point requires clean worktrees: ${dirty.join(", ")}.`,
    );
  }
}

function assertCommitAvailable(
  repository,
  revision,
  requirement = "the start-point",
) {
  const result = gitText(
    repository.directory,
    ["cat-file", "-e", `${revision}^{commit}`],
    { allowFailure: true },
  );
  if (result.status !== 0) {
    throw new CoordinatedGitError(
      `${repository.id} does not contain gitlink commit ${revision.slice(0, 8)} required by ${requirement}.`,
      "MISSING_GITLINK_COMMIT",
    );
  }
}

function worktreeUsingBranch(repository, branch) {
  const result = gitText(repository.directory, ["worktree", "list", "--porcelain"]);
  const expected = `branch refs/heads/${branch}`;
  for (const record of result.stdout.split(/\n\n+/)) {
    const lines = record.split("\n");
    const worktree = lines.find((line) => line.startsWith("worktree "));
    if (!worktree || !lines.includes(expected)) continue;
    const directory = canonicalPath(worktree.slice("worktree ".length));
    if (directory !== canonicalPath(repository.directory)) return directory;
  }
  return null;
}

function planRepositoryAtStartPoint(
  context,
  repository,
  coordinatorBranch,
  desiredRevision,
) {
  const branch = resolvedRepositoryBranch(repository, coordinatorBranch);
  validateBranchName(branch);
  assertCommitAvailable(repository, desiredRevision);

  if (repository.branchPolicy.mode === "pinned") {
    const state = repositoryState(repository.directory);
    if (state.branch === branch && state.revision === desiredRevision) {
      return { branch, created: false, detached: false, desiredRevision };
    }
    if (
      !branchContainsRevision(
        context,
        repository,
        branch,
        desiredRevision,
      )
    ) {
      throw new CoordinatedGitError(
        `${repository.id} pinned gitlink ${desiredRevision.slice(0, 8)} is not reachable from '${branch}'.`,
      );
    }
    return { branch, created: false, detached: true, desiredRevision };
  }

  if (branchExists(repository.directory, branch)) {
    const branchRevision = gitText(repository.directory, [
      "rev-parse",
      `refs/heads/${branch}`,
    ]).stdout;
    if (branchRevision !== desiredRevision) {
      throw new CoordinatedGitError(
        `${repository.id} branch '${branch}' is at ${branchRevision.slice(0, 8)}, expected gitlink ${desiredRevision.slice(0, 8)}.`,
      );
    }
    const occupiedBy = worktreeUsingBranch(repository, branch);
    if (occupiedBy) {
      throw new CoordinatedGitError(
        `${repository.id} branch '${branch}' is already checked out at ${occupiedBy}.`,
      );
    }
    return { branch, created: false, detached: false, desiredRevision };
  }

  return { branch, created: true, detached: false, desiredRevision };
}

function creationManifestFromValue(context, coordinatorBranch, manifest) {
  if (!context.workspaceManifest) return null;
  const nextManifest = JSON.parse(JSON.stringify(manifest));
  const configured = configuredPolicyContext(context);
  for (const repository of configured.repositories) {
    const policy = repository.branchPolicy;
    const branch =
      policy.mode === "mirror"
        ? context.workspaceManifest.coordinatorToken
        : resolvedRepositoryBranch(repository, coordinatorBranch);
    nextManifest.repositories[repository.id] = {
      path: repository.path,
      branch,
      mode: policy.readOnly ? "pinned" : "active",
    };
  }
  return nextManifest;
}

function fileState(file) {
  return existsSync(file)
    ? { contents: readFileSync(file, "utf8"), exists: true }
    : { exists: false };
}

function restoreFileState(file, state) {
  if (state.exists) {
    writeFileSync(file, state.contents, { mode: 0o644 });
  } else if (existsSync(file)) {
    unlinkSync(file);
  }
}

function createCoordinatedBranchAtStartPoint(context, branch, startPoint) {
  validateBranchName(branch);
  const currentContext = currentPolicyContext(context);
  assertFullInvariant(currentContext);
  assertCleanWorkspaceBranchChange(currentContext);

  const startRevision = resolveStartPointCommit(context, startPoint);
  const targetConfiguration = loadContext(context, { revision: startRevision });
  if (!targetConfiguration) {
    throw new CoordinatedGitError(
      `start-point '${startPoint}' does not contain an interpretable coordinator configuration.`,
    );
  }
  assertInitializedRepositories(currentContext);
  assertInitializedRepositories(targetConfiguration);
  assertRepositoriesClean([currentContext, targetConfiguration]);

  const targetContext = targetConfiguration.workspaceManifest
    ? manifestPolicyContext(targetConfiguration, branch, {
        revision: startRevision,
      })
    : configuredPolicyContext(targetConfiguration);
  if (branchExists(context.rootDirectory, branch)) {
    throw new CoordinatedGitError(
      `branch '${branch}' already exists in the coordinator.`,
    );
  }

  const repositoryPlans = targetContext.repositories.map((repository) => {
    const desiredRevision = rootGitlinkRevision(
      targetContext,
      repository,
      startRevision,
    );
    return {
      repository,
      prepared: planRepositoryAtStartPoint(
        targetContext,
        repository,
        branch,
        desiredRevision,
      ),
    };
  });
  const nextManifest = targetConfiguration.workspaceManifest
    ? creationManifestFromValue(
        targetConfiguration,
        branch,
        targetContext.workspaceManifestValue,
      )
    : null;
  const manifestState = targetConfiguration.workspaceManifest
    ? fileState(targetConfiguration.workspaceManifest.absolutePath)
    : null;
  const states = [
    ...targetContext.repositories.map((repository) => ({
      repository: repository.directory,
      state: repositoryState(repository.directory),
    })),
    {
      repository: context.rootDirectory,
      state: repositoryState(context.rootDirectory),
    },
  ];
  const createdBranches = [];
  let manifestWritten = false;

  try {
    const rootResult = executeGit(context.rootDirectory, [
      "branch",
      branch,
      startRevision,
    ]);
    if (rootResult.status !== 0) {
      throw new CoordinatedGitError(
        `could not create '${branch}' in the coordinator at ${startRevision.slice(0, 8)}.`,
      );
    }
    createdBranches.push({ repository: context.rootDirectory, branch });

    for (const { repository, prepared } of repositoryPlans) {
      if (!prepared.created) continue;
      const result = executeGit(repository.directory, [
        "branch",
        prepared.branch,
        prepared.desiredRevision,
      ]);
      if (result.status !== 0) {
        throw new CoordinatedGitError(
          `could not create '${prepared.branch}' in ${repository.id}.`,
        );
      }
      createdBranches.push({
        repository: repository.directory,
        branch: prepared.branch,
      });
    }

    for (const { repository, prepared } of repositoryPlans) {
      if (prepared.detached) {
        switchRepositoryDetached(repository.directory, prepared.desiredRevision);
      } else {
        switchRepository(repository.directory, prepared.branch);
        if (prepared.created) {
          setUpstreamFromRemote(targetContext, repository, prepared.branch);
        }
      }
    }
    switchRepository(context.rootDirectory, branch);
    if (nextManifest) {
      writeWorkspaceManifest(targetConfiguration, nextManifest);
      manifestWritten = true;
    }

    const effectiveContext = loadContext(context);
    if (!effectiveContext) {
      throw new CoordinatedGitError(
        "coordinator configuration disappeared after creating the branch.",
      );
    }
    const effectivePolicyContext = currentPolicyContext(effectiveContext);
    assertFullInvariant(effectivePolicyContext);
    assertReadOnlyRepositoriesClean(effectivePolicyContext);
    process.stderr.write(
      `[agent-coordinator] created '${branch}' from ${startPoint} (${startRevision.slice(0, 8)}): ${branchMappingSummary(effectivePolicyContext, branch)}.\n`,
    );
    return 0;
  } catch (error) {
    if (manifestWritten) {
      restoreFileState(
        targetConfiguration.workspaceManifest.absolutePath,
        manifestState,
      );
    }
    rollbackRepositories(states, createdBranches);
    throw error;
  }
}

function switchCoordinatedBranch(context, branch) {
  validateBranchName(branch);
  context = currentPolicyContext(context);
  assertFullInvariant(context);
  assertCleanWorkspaceBranchChange(context);
  if (!branchExists(context.rootDirectory, branch)) {
    throw new CoordinatedGitError(
      `branch '${branch}' does not exist in the coordinator.`,
    );
  }

  const allRepositories = [
    ...context.repositories.map((repository) => repository.directory),
    context.rootDirectory,
  ];
  const states = allRepositories.map((repository) => ({
    repository,
    state: repositoryState(repository),
  }));
  const createdBranches = [];
  let rootSwitched = false;
  const targetContext = context.workspaceManifest
    ? manifestPolicyContext(context, branch, { revision: branch })
    : context;
  let preparedRepositories = [];
  try {
    preparedRepositories = targetContext.repositories.map(
      (repository) => ({
        repository,
        prepared: prepareRepositoryAtRevision(
          targetContext,
          repository,
          branch,
          rootGitlinkRevision(targetContext, repository, branch),
          createdBranches,
          { planOnly: true, reconcileExistingBranch: true },
        ),
      }),
    );

    for (const { repository, prepared } of preparedRepositories) {
      if (!prepared.created) continue;
      const result = executeGit(repository.directory, [
        "branch",
        prepared.branch,
        prepared.desiredRevision,
      ]);
      if (result.status !== 0) {
        throw new CoordinatedGitError(
          `could not create '${prepared.branch}' in ${repository.id}.`,
        );
      }
      createdBranches.push({
        repository: repository.directory,
        branch: prepared.branch,
      });
    }

    for (const { repository, prepared } of preparedRepositories) {
      if (prepared.detached) {
        switchRepositoryDetached(
          repository.directory,
          rootGitlinkRevision(targetContext, repository, branch),
        );
      } else {
        assertPreparedBranchRevision(repository, prepared);
        switchRepository(repository.directory, prepared.branch);
        assertPreparedBranchRevision(repository, prepared, {
          checkedOut: true,
        });
        if (prepared.created) {
          setUpstreamFromRemote(
            targetContext,
            repository,
            prepared.branch,
          );
        }
      }
    }
    switchRepository(context.rootDirectory, branch);
    rootSwitched = true;
    const advancedRepositories = preparedRepositories.filter(
      ({ prepared }) => prepared.updateGitlink,
    );
    for (const { repository, prepared } of advancedRepositories) {
      assertPreparedBranchRevision(repository, prepared, {
        checkedOut: true,
      });
      const result = executeGit(context.rootDirectory, [
        "update-index",
        "--cacheinfo",
        `160000,${prepared.desiredRevision},${repository.path}`,
      ]);
      if (result.status !== 0) {
        throw new CoordinatedGitError(
          `could not stage the updated ${repository.id} gitlink.`,
        );
      }
    }
    const effectiveContext = currentPolicyContext(context);
    assertFullInvariant(effectiveContext);
    if (advancedRepositories.length > 0) {
      process.stderr.write(
        `[agent-coordinator] staged updated gitlinks: ${advancedRepositories.map(({ repository }) => repository.id).join(", ")}.\n`,
      );
    }
    process.stderr.write(
      `[agent-coordinator] switched to '${branch}': ${branchMappingSummary(effectiveContext, branch)}.\n`,
    );
    return 0;
  } catch (error) {
    const gitlinkRollbackFailures = [];
    if (rootSwitched) {
      for (const { repository, prepared } of preparedRepositories) {
        if (!prepared.updateGitlink) continue;
        const result = executeGit(
          context.rootDirectory,
          [
            "update-index",
            "--cacheinfo",
            `160000,${prepared.previousGitlink},${repository.path}`,
          ],
          { capture: true },
        );
        if (result.status !== 0) gitlinkRollbackFailures.push(repository.id);
      }
    }
    rollbackRepositories(states, createdBranches);
    if (gitlinkRollbackFailures.length > 0) {
      process.stderr.write(
        `[agent-coordinator] WARNING: rollback could not restore staged gitlinks for ${gitlinkRollbackFailures.join(", ")}.\n`,
      );
    }
    throw error;
  }
}

function attachCoordinatedBranches(context) {
  context = currentPolicyContext(context);
  assertInitializedRepositories(context);
  const targetBranch = currentBranch(context.rootDirectory);
  if (!targetBranch) {
    throw new CoordinatedGitError(
      "the coordinator is detached; attach it to a branch first.",
    );
  }

  const states = context.repositories.map((repository) => ({
    repository: repository.directory,
    state: repositoryState(repository.directory),
  }));
  const createdBranches = [];
  try {
    for (const repository of context.repositories) {
      const prepared = prepareRepositoryAtRevision(
        context,
        repository,
        targetBranch,
        rootGitlinkRevision(context, repository),
        createdBranches,
      );
      checkoutPreparedRepository(context, repository, prepared);
    }
    assertFullInvariant(context);
    process.stderr.write(
      `[agent-coordinator] attached '${targetBranch}': ${branchMappingSummary(context, targetBranch)}.\n`,
    );
    return 0;
  } catch (error) {
    rollbackRepositories(states, createdBranches);
    throw error;
  }
}

function coordinatedCheckout(context) {
  const argumentsList = context.commandArguments;
  if (argumentsList.includes("--") || argumentsList.length === 0) {
    return executeRootGit(context, [
      context.command,
      ...argumentsList,
    ]).status;
  }

  const createFlags =
    context.command === "checkout" ? new Set(["-b"]) : new Set(["-c"]);
  const forceCreateFlags =
    context.command === "checkout" ? new Set(["-B"]) : new Set(["-C"]);
  const createFlagIndex = argumentsList.findIndex((argument) =>
    createFlags.has(argument),
  );
  const forceCreateFlagIndex = argumentsList.findIndex((argument) =>
    forceCreateFlags.has(argument),
  );

  if (forceCreateFlagIndex >= 0) {
    throw new CoordinatedGitError(
      `${argumentsList[forceCreateFlagIndex]} is blocked because coordinated branch replacement is destructive.`,
    );
  }
  if (createFlagIndex >= 0) {
    const branch = argumentsList[createFlagIndex + 1];
    const startPoint = argumentsList[createFlagIndex + 2];
    if (
      createFlagIndex !== 0 ||
      !branch ||
      argumentsList.length < 2 ||
      argumentsList.length > 3
    ) {
      throw new CoordinatedGitError(
        `coordinated ${context.command} branch creation supports only '${context.command} ${argumentsList[createFlagIndex]} <branch> [<start-point>]'.`,
      );
    }
    if (startPoint) {
      return createCoordinatedBranchAtStartPoint(context, branch, startPoint);
    }
    return createCoordinatedBranch(context, branch);
  }

  const positional = argumentsList.filter((argument) => !argument.startsWith("-"));
  if (positional.length !== 1) {
    return executeRootGit(context, [
      context.command,
      ...argumentsList,
    ]).status;
  }

  let branch = positional[0];
  if (branch === "-") {
    const previous = gitText(context.rootDirectory, [
      "rev-parse",
      "--abbrev-ref",
      "@{-1}",
    ]);
    branch = previous.stdout;
  }

  if (!branchExists(context.rootDirectory, branch)) {
    if (
      context.command === "checkout" &&
      (existsSync(path.join(context.rootDirectory, branch)) ||
        gitText(
          context.rootDirectory,
          ["ls-files", "--error-unmatch", "--", branch],
          { allowFailure: true },
        ).status === 0)
    ) {
      return executeRootGit(context, [
        context.command,
        ...argumentsList,
      ]).status;
    }
    throw new CoordinatedGitError(
      `branch '${branch}' does not exist locally in the coordinator; create it with ${context.command} ${context.command === "checkout" ? "-b" : "-c"} ${branch}.`,
    );
  }
  return switchCoordinatedBranch(context, branch);
}

function listWorktrees(repository) {
  const result = gitText(repository, ["worktree", "list", "--porcelain"]);
  return result.stdout
    .split(/\n\n+/)
    .map((record) => {
      const line = record
        .split("\n")
        .find((candidate) => candidate.startsWith("worktree "));
      return line ? canonicalPath(line.slice("worktree ".length)) : null;
    })
    .filter(Boolean);
}

function sanitizedWorktreeBranch(worktreeDirectory) {
  const slug =
    path
      .basename(worktreeDirectory)
      .replace(/[^A-Za-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "worktree";
  return `codex/${slug}`;
}

function ensureWorktreeBranch(context) {
  let branch = currentBranch(context.rootDirectory);
  if (branch) return branch;

  const base = sanitizedWorktreeBranch(context.rootDirectory);
  branch = base;
  let suffix = 2;
  while (branchExists(context.rootDirectory, branch)) {
    branch = `${base}-${suffix}`;
    suffix += 1;
  }

  const result = executeRootGit(
    context,
    ["switch", "-c", branch],
    { capture: false },
  );
  if (result.status !== 0) {
    throw new CoordinatedGitError(
      `could not attach detached worktree to generated branch '${branch}'.`,
    );
  }
  process.stderr.write(
    `[agent-coordinator] attached detached worktree to '${branch}'.\n`,
  );
  return branch;
}

function initializeMissingSubmodules(context) {
  const missing = context.repositories.some(
    (repository) => !isRepositoryAt(repository.directory),
  );
  if (!missing) return;

  process.stderr.write(
    "[agent-coordinator] initializing worktree submodules...\n",
  );
  const result = executeRootGit(context, [
    "submodule",
    "update",
    "--init",
    "--recursive",
  ]);
  if (result.status !== 0) {
    throw new CoordinatedGitError("submodule initialization failed.");
  }
}

function bootstrapWorktree(worktreeDirectory) {
  const invocation = {
    command: "hook",
    commandArguments: [],
    effectiveDirectory: worktreeDirectory,
    forwardedGlobalOptions: [],
  };
  const context = loadContext(invocation);
  if (!context) return;

  initializeMissingSubmodules(context);
  ensureWorktreeBranch(context);
  attachCoordinatedBranches(context);
}

function coordinatedWorktreeRemove(context) {
  const argumentsList = context.commandArguments.slice(1);
  const force = argumentsList.some(
    (argument) => argument === "-f" || argument === "--force",
  );
  const positionals = argumentsList.filter((argument) => !argument.startsWith("-"));
  if (positionals.length !== 1) {
    return executeRootGit(context, [
      "worktree",
      ...context.commandArguments,
    ]).status;
  }

  const targetDirectory = canonicalPath(
    path.resolve(context.rootDirectory, positionals[0]),
  );
  const targetInvocation = {
    command: "worktree-remove",
    commandArguments: [],
    effectiveDirectory: targetDirectory,
    forwardedGlobalOptions: [],
  };
  const targetContext = loadContext(targetInvocation, { revision: "HEAD" });
  if (!targetContext) {
    return executeRootGit(context, [
      "worktree",
      ...context.commandArguments,
    ]).status;
  }

  initializeMissingSubmodules(targetContext);
  if (!force) {
    for (const repository of targetContext.repositories) {
      const status = gitText(repository.directory, ["status", "--porcelain"]);
      if (status.stdout) {
        throw new CoordinatedGitError(
          `refusing to remove worktree: ${repository.id} has local changes.`,
        );
      }
      const remoteBranches = gitText(
        repository.directory,
        ["branch", "-r", "--contains", "HEAD"],
        { allowFailure: true },
      );
      if (remoteBranches.status !== 0 || !remoteBranches.stdout) {
        throw new CoordinatedGitError(
          `refusing to remove worktree: ${repository.id} HEAD is not present on a remote branch.`,
        );
      }
    }
  }

  const deinitialize = executeRootGit(targetContext, [
    "submodule",
    "deinit",
    ...(force ? ["--force"] : []),
    "--all",
  ]);
  if (deinitialize.status !== 0) return deinitialize.status;

  // Git refuses to remove any worktree that has initialized submodules unless
  // --force is present, even after a clean deinit. The safety checks above
  // provide the ordinary non-force protection before this internal force.
  const remove = executeRootGit(context, [
    "worktree",
    "remove",
    "--force",
    targetDirectory,
  ]);
  if (remove.status !== 0) {
    process.stderr.write(
      `[agent-coordinator] worktree removal failed after submodule deinitialization; restoring ${targetDirectory}.\n`,
    );
    bootstrapWorktree(targetDirectory);
  } else {
    const restoreRegistration = executeRootGit(
      context,
      ["submodule", "init"],
      { capture: true },
    );
    if (restoreRegistration.status !== 0) {
      process.stderr.write(
        "[agent-coordinator] WARNING: worktree removed, but primary submodule registration must be restored with 'git submodule init'.\n",
      );
    }
  }
  return remove.status;
}

function coordinatedWorktree(context) {
  if (context.commandArguments[0] === "remove") {
    return coordinatedWorktreeRemove(context);
  }
  if (context.commandArguments[0] !== "add") {
    return executeRootGit(context, [
      "worktree",
      ...context.commandArguments,
    ]).status;
  }

  const before = new Set(listWorktrees(context.rootDirectory));
  const result = executeRootGit(context, [
    "worktree",
    ...context.commandArguments,
  ]);
  if (result.status !== 0) return result.status;
  if (context.commandArguments.includes("--no-checkout")) return 0;

  const added = listWorktrees(context.rootDirectory).filter(
    (worktree) => !before.has(worktree),
  );
  for (const worktree of added) bootstrapWorktree(worktree);
  return 0;
}

function prePushReferences() {
  let input = "";
  try {
    input = readFileSync(0, "utf8");
  } catch {
    return [];
  }
  return input
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const fields = line.trim().split(/\s+/);
      if (fields.length !== 4) {
        throw new CoordinatedGitError(
          `could not parse direct pre-push input: ${line}`,
        );
      }
      const [localReference, localRevision, remoteReference, remoteRevision] =
        fields;
      return {
        localReference,
        localRevision,
        remoteReference,
        remoteRevision,
      };
    });
}

function zeroRevision(revision) {
  return /^0+$/.test(revision);
}

function assertDirectPushReference(context, branch, remote, reference) {
  const head = gitText(context.rootDirectory, ["rev-parse", "HEAD"]).stdout;
  const expectedLocalReference = `refs/heads/${branch}`;
  const expectedRemoteReference = `refs/heads/${branch}`;
  if (
    reference.localRevision !== head ||
    ![
      expectedLocalReference,
      "HEAD",
      reference.localRevision,
    ].includes(reference.localReference) ||
    reference.remoteReference !== expectedRemoteReference
  ) {
    throw new CoordinatedGitError(
      `direct push must publish only coordinated branch '${branch}' from its current HEAD.`,
    );
  }
  if (zeroRevision(reference.localRevision)) {
    throw new CoordinatedGitError(
      "branch deletion is intentionally blocked for a coordinated push.",
    );
  }
  if (zeroRevision(reference.remoteRevision)) return;

  const remoteObject = gitText(
    context.rootDirectory,
    ["cat-file", "-e", `${reference.remoteRevision}^{commit}`],
    { allowFailure: true },
  );
  if (remoteObject.status !== 0) {
    const fetch = executeRootGit(context, [
      "fetch",
      "--no-tags",
      remote,
      `+${reference.remoteReference}:${remoteTrackingReference(remote, branch)}`,
    ]);
    if (fetch.status !== 0) {
      throw new CoordinatedGitError(
        `could not fetch ${remote}/${branch} before direct push.`,
      );
    }
  }
  const fastForward = gitText(
    context.rootDirectory,
    [
      "merge-base",
      "--is-ancestor",
      reference.remoteRevision,
      reference.localRevision,
    ],
    { allowFailure: true },
  );
  if (fastForward.status !== 0) {
    throw new CoordinatedGitError(
      `direct push of coordinator/${branch} is not a fast-forward. Run 'git pull' and resolve the divergence first.`,
    );
  }
}

function coordinatedDirectPrePush(context, hookArguments) {
  context = currentPolicyContext(
    context,
    context.workspaceManifest ? { revision: "HEAD" } : "worktree",
  );
  const branch = assertFullInvariant(
    context,
    context.workspaceManifest ? "HEAD" : null,
  );
  assertReadOnlyRepositoriesClean(
    context,
    context.workspaceManifest ? "HEAD" : null,
  );
  const references = prePushReferences();
  if (references.length === 0) return 0;
  if (references.length !== 1) {
    throw new CoordinatedGitError(
      "direct coordinated push supports exactly one branch.",
    );
  }
  const configuredRemote = gitText(
    context.rootDirectory,
    ["config", "--get", `branch.${branch}.remote`],
    { allowFailure: true },
  );
  const remote = hookArguments[0] || configuredRemote.stdout || "origin";
  assertDirectPushReference(context, branch, remote, references[0]);
  process.stderr.write(
    `[agent-coordinator] coordinating direct application push for '${branch}'...\n`,
  );
  return pushWritableRepositories(context, branch, remote);
}

function clearRepositoryLocalHookEnvironment() {
  const result = git(["rev-parse", "--local-env-vars"], { capture: true });
  if (result.status !== 0) return;
  for (const name of (result.stdout ?? "").split(/\r?\n/)) {
    if (name) delete process.env[name];
  }
}

function runHook(argumentsList) {
  const [hook, ...hookArguments] = argumentsList;
  clearRepositoryLocalHookEnvironment();
  const invocation = {
    command: "hook",
    commandArguments: [],
    effectiveDirectory: process.cwd(),
    forwardedGlobalOptions: [],
  };
  const configurationSource =
    hook === "pre-push"
      ? { revision: "HEAD" }
      : hook === "pre-commit"
        ? "index"
        : "worktree";
  const context = loadContext(invocation, configurationSource);
  if (!context) return 0;

  if (hook === "post-checkout") {
    if (hookArguments[2] !== "1") return 0;
    if (
      process.env[INTERNAL_ENVIRONMENT_VARIABLE] === "1" ||
      process.env[LEGACY_INTERNAL_ENVIRONMENT_VARIABLE] === "1"
    ) {
      return 0;
    }
    bootstrapWorktree(process.cwd());
    return 0;
  }
  if (hook === "pre-push") {
    const internal =
      process.env[INTERNAL_ENVIRONMENT_VARIABLE] === "1" ||
      process.env[LEGACY_INTERNAL_ENVIRONMENT_VARIABLE] === "1";
    if (!internal) return coordinatedDirectPrePush(context, hookArguments);
    const effectiveContext = currentPolicyContext(
      context,
      context.workspaceManifest ? { revision: "HEAD" } : "worktree",
    );
    const rootReference = context.workspaceManifest ? "HEAD" : null;
    assertFullInvariant(effectiveContext, rootReference);
    assertReadOnlyRepositoriesClean(effectiveContext, rootReference);
    return 0;
  }
  if (hook === "pre-commit") {
    if (
      process.env[INTERNAL_ENVIRONMENT_VARIABLE] !== "1" &&
      process.env[LEGACY_INTERNAL_ENVIRONMENT_VARIABLE] !== "1"
    ) {
      throw new CoordinatedGitError(
        `${hook} bypassed the installed Git wrapper; invoke 'git' from PATH instead of an absolute system Git path.`,
      );
    }
    const source =
      context.workspaceManifest && hook === "pre-commit"
        ? "index"
        : context.workspaceManifest
          ? { revision: "HEAD" }
          : "worktree";
    const effectiveContext = currentPolicyContext(context, source);
    assertFullInvariant(effectiveContext);
    assertReadOnlyRepositoriesClean(effectiveContext);
    return 0;
  }
  throw new CoordinatedGitError(`unsupported hook: ${hook}`);
}

function recoveryCommand(directory, argumentsList) {
  const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
  return ["git", "-C", quote(directory), ...argumentsList.map(quote)].join(" ");
}

function recoveryChanges(directory, ignoredPaths = []) {
  const result = git(["-C", directory, "status", "--porcelain=v1", "-z", "--untracked-files=normal", "--ignore-submodules=none"], { capture: true });
  if (result.status !== 0) throw new CoordinatedGitError("Could not inspect changes in " + directory);
  const entries = (result.stdout || "").split("\0");
  const changes = [];
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index];
    if (!entry) continue;
    const file = entry.slice(3);
    const status = entry.slice(0, 2);
    const managedGitlinkChange =
      ignoredPaths.includes(file) && [" M", "M ", "MM"].includes(status);
    if (!managedGitlinkChange) changes.push(entry);
    if (/[RC]/.test(entry.slice(0, 2))) index++;
  }
  return changes;
}

function recoveryOperationInProgress(directory) {
  return ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply", "sequencer"].some((name) => {
    const location = gitText(directory, ["rev-parse", "--git-path", name]).stdout;
    return existsSync(path.resolve(directory, location));
  });
}

function lastFailurePath(context) {
  return path.resolve(context.rootDirectory, gitText(context.rootDirectory, [
    "rev-parse", "--git-path", "agent-coordinator-last-error.json",
  ]).stdout);
}

function readLastFailure(context) {
  try {
    const file = lastFailurePath(context);
    if (lstatSync(file).isSymbolicLink()) return null;
    const value = JSON.parse(readFileSync(file, "utf8"));
    return value.owner === "Agent Coordinator" ? value : null;
  } catch {
    return null;
  }
}

function rememberFailure(context, error) {
  if (!context || !SUPPORTED_COMMANDS.has(context.command)) return;
  let temporary;
  try {
    const file = lastFailurePath(context);
    if (existsSync(file) && !readLastFailure(context)) return;
    temporary = file + "." + randomUUID();
    // Deliberately exclude raw arguments, Git output, remote URLs and file contents.
    writeFileSync(temporary, JSON.stringify({
      owner: "Agent Coordinator", schemaVersion: 1,
      at: new Date().toISOString(), operation: context.command,
      code: error.code || "GIT_OPERATION_FAILED",
    }) + "\n", { mode: 0o600, flag: "wx" });
    renameSync(temporary, file);
  } catch {
    // Diagnostics must never replace the original failure.
  } finally {
    if (temporary && existsSync(temporary)) unlinkSync(temporary);
  }
}

function diagnoseRecovery(context) {
  context = currentPolicyContext(context);
  const branch = currentBranch(context.rootDirectory);
  const issues = [];
  const blocked = [];
  const alignBlocked = [];
  const recordBlocked = [];
  const alignSteps = [];
  const recordSteps = [];
  const repositories = [];
  const addIssue = (code, repository, message, commands = []) =>
    issues.push({ code, repository, message, commands });
  const rootChanges = recoveryChanges(context.rootDirectory, context.repositories.map((repository) => repository.path));
  if (!branch) {
    blocked.push("Choose a coordinator branch first; its HEAD is detached.");
    addIssue("DETACHED_COORDINATOR", "coordinator", blocked.at(-1), ["git branch --all"]);
  }
  if (rootChanges.length) {
    blocked.push("Save the coordinator's file changes before applying a repair.");
    addIssue("DIRTY_WORKTREE", "coordinator", blocked.at(-1), [
      recoveryCommand(context.rootDirectory, ["status", "--short"]),
      recoveryCommand(context.rootDirectory, ["stash", "push", "--include-untracked", "-m", "Before coordinator recovery"]),
    ]);
  }
  if (recoveryOperationInProgress(context.rootDirectory)) {
    blocked.push("Finish or abort the coordinator's current merge, rebase or cherry-pick first.");
    addIssue("OPERATION_IN_PROGRESS", "coordinator", blocked.at(-1), ["git status"]);
  }
  for (const repository of context.repositories) {
    if (!isRepositoryAt(repository.directory)) {
      blocked.push(repository.id + " is not initialized.");
      addIssue("NOT_INITIALIZED", repository.id, blocked.at(-1), [
        recoveryCommand(context.rootDirectory, ["submodule", "update", "--init", "--", repository.path]),
      ]);
      repositories.push({ id: repository.id, initialized: false });
      continue;
    }
    const state = repositoryState(repository.directory);
    const changes = recoveryChanges(repository.directory);
    const gitlink = rootGitlink(context, repository);
    const entry = gitText(context.rootDirectory, ["ls-files", "--stage", "--", repository.path]).stdout;
    let expectedBranch = null;
    try {
      if (branch) expectedBranch = resolvedRepositoryBranch(repository, branch);
    } catch (error) {
      blocked.push(error.message);
      addIssue("MISSING_BRANCH_MAPPING", repository.id, error.message + " Review " + context.configurationLabel + ".");
    }
    const pinnedDetached = repository.branchPolicy.mode === "pinned" && !state.branch &&
      gitlink.status === 0 && expectedBranch &&
      branchContainsRevision(context, repository, expectedBranch, gitlink.stdout);
    const branchMatches = Boolean(expectedBranch && (state.branch === expectedBranch || pinnedDetached));
    const reference = expectedBranch
      ? gitText(repository.directory, ["rev-parse", "--verify", "refs/heads/" + expectedBranch], { allowFailure: true }).stdout
      : null;
    repositories.push({
      id: repository.id, path: repository.path, initialized: true,
      branch: state.branch, expectedBranch, revision: state.revision,
      recordedRevision: gitlink.status === 0 ? gitlink.stdout : null,
      expectedBranchRevision: reference, readOnly: repository.branchPolicy.readOnly, changes, entry,
    });
    if (changes.length) {
      blocked.push(repository.id + " has uncommitted files. Save them before repairing.");
      addIssue("DIRTY_WORKTREE", repository.id, blocked.at(-1), [
        recoveryCommand(repository.directory, ["status", "--short"]),
        recoveryCommand(repository.directory, ["stash", "push", "--include-untracked", "-m", "Before coordinator recovery"]),
      ]);
    }
    if (recoveryOperationInProgress(repository.directory)) {
      blocked.push(repository.id + " has an unfinished Git operation. Use git status there to continue or abort it.");
      addIssue("OPERATION_IN_PROGRESS", repository.id, blocked.at(-1), [recoveryCommand(repository.directory, ["status"])]);
    }
    if (gitlink.status !== 0 || !/^160000 [a-f0-9]+ 0\t/.test(entry)) {
      blocked.push(repository.id + " has no unambiguous gitlink in the index. Resolve the coordinator index first.");
      addIssue("MISSING_GITLINK", repository.id, blocked.at(-1));
      continue;
    }
    const committedGitlink = rootGitlink(context, repository, "HEAD");
    if (committedGitlink.status === 0 && committedGitlink.stdout !== gitlink.stdout) {
      addIssue(
        "PENDING_GITLINK_COMMIT",
        repository.id,
        "Revision " + gitlink.stdout.slice(0, 8) + " is staged but not committed in the coordinator.",
        [
          recoveryCommand(context.rootDirectory, ["diff", "--cached", "--submodule=short"]),
          recoveryCommand(context.rootDirectory, ["commit", "-m", "Record coordinated repository revisions"]),
        ],
      );
    }
    if (!branchMatches) {
      recordBlocked.push(repository.id + " must match its branch policy before recording its revision.");
      addIssue("BRANCH_MISMATCH", repository.id,
        "On " + (state.branch || "detached HEAD") + "; coordinator '" + branch + "' expects '" + expectedBranch + "'. Align the checkout, or correct the branch mapping in " + context.configurationLabel + ".");
    }
    if (state.revision !== gitlink.stdout) {
      addIssue("GITLINK_MISMATCH", repository.id,
        "Checkout is at " + state.revision.slice(0, 8) + "; coordinator records " + gitlink.stdout.slice(0, 8) + ". Choose which revision to keep.");
      if (repository.branchPolicy.readOnly) {
        recordBlocked.push(repository.id + " is read-only; its recorded revision cannot be changed by this repair.");
      } else {
        recordSteps.push({ repository: repository.id, path: repository.path, from: gitlink.stdout, to: state.revision,
          description: "Record " + repository.id + " at " + state.revision.slice(0, 8) + " (stage its gitlink only)." });
      }
    }
    const available = gitText(repository.directory, ["cat-file", "-e", gitlink.stdout + "^{commit}"], { allowFailure: true }).status === 0;
    if (!available) {
      alignBlocked.push(repository.id + " is missing recorded commit " + gitlink.stdout.slice(0, 8) + ".");
      addIssue("MISSING_GITLINK_COMMIT", repository.id, alignBlocked.at(-1) + " Fetch it; if the server says 'not our ref', restore the commit on the remote or review a replacement gitlink.", [
        recoveryCommand(repository.directory, ["fetch", "--no-recurse-submodules", context.configuration.remote || "origin", gitlink.stdout]),
      ]);
    }
    if (!branchMatches || state.revision !== gitlink.stdout) {
      if (!state.branch && !revisionIsAncestor(repository, state.revision, gitlink.stdout)) {
        alignBlocked.push(repository.id + " has detached work that must be saved on a branch before switching.");
      }
      try {
        const prepared = prepareRepositoryAtRevision(context, repository, branch, gitlink.stdout, [], { planOnly: true });
        if (prepared.detached && !branchContainsRevision(context, repository, expectedBranch, gitlink.stdout)) {
          throw new CoordinatedGitError(repository.id + " recorded revision is outside its pinned branch.");
        }
        alignSteps.push({ repository: repository.id, path: repository.path, from: state.revision, to: gitlink.stdout,
          description: "Align " + repository.id + " to " + (prepared.detached ? "detached " : expectedBranch + " at ") + gitlink.stdout.slice(0, 8),
          prepared });
      } catch (error) {
        alignBlocked.push(error.message + " Existing branches will not be reset.");
      }
    }
    const upstream = gitText(repository.directory, ["rev-parse", "--verify", "@{upstream}"], { allowFailure: true });
    if (upstream.status === 0 && !revisionIsAncestor(repository, state.revision, upstream.stdout) &&
        !revisionIsAncestor(repository, upstream.stdout, state.revision)) {
      addIssue("DIVERGED_HISTORY", repository.id, "Local and cached upstream histories have diverged. Review the commits and choose merge or rebase in this repository.", [
        recoveryCommand(repository.directory, ["log", "--oneline", "--left-right", "HEAD...@{upstream}"]),
      ]);
    }
  }
  // Inspect cached incoming pins without fetching or changing the workspace.
  const upstream = gitText(context.rootDirectory, ["rev-parse", "--verify", "@{upstream}"], { allowFailure: true });
  if (upstream.status === 0) {
    for (const repository of context.repositories) {
      if (!isRepositoryAt(repository.directory)) continue;
      const incoming = rootGitlink(context, repository, upstream.stdout);
      if (incoming.status === 0 &&
          gitText(repository.directory, ["cat-file", "-e", incoming.stdout + "^{commit}"], { allowFailure: true }).status !== 0) {
        addIssue("MISSING_INCOMING_COMMIT", repository.id,
          "Cached upstream coordinator references " + incoming.stdout.slice(0, 8) + ", which is not available locally. Fetch that commit; if the remote cannot provide it, its coordinator gitlink needs repair. This diagnosis does not contact the remote.", [
            recoveryCommand(repository.directory, ["fetch", "--no-recurse-submodules", context.configuration.remote || "origin", incoming.stdout]),
          ]);
      }
    }
  }
  const plans = [
    { strategy: "align", label: "Use the revisions recorded by the coordinator", steps: alignSteps, blocked: [...blocked, ...alignBlocked] },
    { strategy: "record", label: "Keep current checkouts and stage their revisions", steps: recordSteps, blocked: [...blocked, ...recordBlocked] },
  ].map((plan) => ({ ...plan, available: plan.steps.length > 0 && plan.blocked.length === 0 }));
  const snapshot = { branch, head: gitText(context.rootDirectory, ["rev-parse", "HEAD"]).stdout,
    rootChanges, repositories, plans, configuration: context.configuration,
    manifest: context.workspaceManifest ? readFileSync(context.workspaceManifest.absolutePath, "utf8") : null };
  return {
    schemaVersion: 1, owner: "Agent Coordinator", root: context.rootDirectory, branch,
    snapshot: createHash("sha256").update(JSON.stringify(snapshot)).digest("hex"),
    issues, plans, repositories, lastFailure: readLastFailure(context), applied: false,
  };
}

function applyRecovery(context, strategy, snapshot) {
  context = currentPolicyContext(context);
  const report = diagnoseRecovery(context);
  if (report.snapshot !== snapshot) throw new CoordinatedGitError(
    "The workspace changed since this preview. Run coordinator git recover again to review a fresh plan.", "STALE_RECOVERY_PLAN");
  const plan = report.plans.find((entry) => entry.strategy === strategy);
  if (!plan?.available) throw new CoordinatedGitError(
    "This recovery cannot be applied: " + (plan?.blocked.join(" ") || "no changes to apply."), "RECOVERY_BLOCKED");
  const states = context.repositories.map((repository) => ({
    repository: repository.directory, state: repositoryState(repository.directory),
  }));
  const createdBranches = [];
  try {
    if (strategy === "record") {
      const argumentsList = ["update-index"];
      for (const step of plan.steps) {
        argumentsList.push("--cacheinfo", "160000," + step.to + "," + step.path);
      }
      const result = executeGit(context.rootDirectory, argumentsList, { capture: true });
      if (result.status !== 0) throw new CoordinatedGitError(
        "Could not stage repository revisions. The index was left unchanged.",
        "RECOVERY_STAGE_FAILED",
      );
    }
    for (const step of plan.steps) {
      const repository = context.repositories.find((entry) => entry.id === step.repository);
      if (strategy === "align") {
        const prepared = prepareRepositoryAtRevision(context, repository, report.branch, step.to, createdBranches);
        checkoutPreparedRepository(context, repository, prepared);
      }
    }
    assertFullInvariant(context);
    assertReadOnlyRepositoriesClean(context);
    return { ...diagnoseRecovery(context), applied: true, strategy,
      next: strategy === "record"
        ? ["git diff --cached --submodule=short", "git commit -m 'Record coordinated repository revisions'"]
        : ["coordinator git check", "Retry your original Git command."] };
  } catch (error) {
    const rollbackFailures = [];
    for (const step of strategy === "record" ? [...plan.steps].reverse() : []) {
      if (executeGit(context.rootDirectory, ["update-index", "--cacheinfo", "160000," + step.from + "," + step.path], { capture: true }).status !== 0) {
        rollbackFailures.push(step.repository);
      }
    }
    if (strategy === "align") rollbackRepositories(states, createdBranches);
    if (rollbackFailures.length) process.stderr.write("[agent-coordinator] WARNING: restore staged gitlinks manually for " + rollbackFailures.join(", ") + ".\n");
    throw error;
  }
}

function dispatch(context) {
  switch (context.command) {
    case "add":
      return coordinatedAdd(context);
    case "commit":
      return coordinatedCommit(context);
    case "pull":
      return coordinatedPull(context);
    case "push":
      return coordinatedPush(context);
    case "checkout":
    case "switch":
      return coordinatedCheckout(context);
    case "worktree":
      return coordinatedWorktree(context);
    default:
      return executeRootGit(context, [
        context.command,
        ...context.commandArguments,
      ]).status;
  }
}

function main() {
  const argumentsList = process.argv.slice(2);
  if (argumentsList[0] === "--diagnose" || argumentsList[0] === "--recover") {
    const invocation = {
      command: "recover",
      commandArguments: [],
      effectiveDirectory: process.cwd(),
      forwardedGlobalOptions: [],
    };
    const context = loadContext(invocation);
    if (!context) throw new CoordinatedGitError(
      "current directory is not a configured coordinator root.", "GIT_CONFIGURATION_MISSING");
    activeContext = context;
    if (argumentsList[0] === "--diagnose") {
      process.stdout.write(JSON.stringify(diagnoseRecovery(context)) + "\n");
      return 0;
    }
    const strategy = argumentsList[1];
    const snapshot = argumentsList[2];
    if (!["align", "record"].includes(strategy) || !snapshot) {
      throw new CoordinatedGitError(
        "Recovery requires a reviewed strategy and snapshot.", "INVALID_RECOVERY_REQUEST");
    }
    process.stdout.write(JSON.stringify(applyRecovery(context, strategy, snapshot)) + "\n");
    return 0;
  }
  if (argumentsList[0] === "--hook") {
    return runHook(argumentsList.slice(1));
  }
  if (argumentsList[0] === "--check") {
    const invocation = {
      command: "check",
      commandArguments: [],
      effectiveDirectory: process.cwd(),
      forwardedGlobalOptions: [],
    };
    const context = loadContext(invocation);
    if (!context) {
      throw new CoordinatedGitError(
        "current directory is not a configured coordinator root.",
      );
    }
    const effectiveContext = currentPolicyContext(context);
    const branch = assertFullInvariant(effectiveContext);
    assertReadOnlyRepositoriesClean(effectiveContext);
    process.stdout.write(
      `Agent Coordinator Git invariant OK: coordinator=${branch}; ${branchMappingSummary(effectiveContext, branch)}.\n`,
    );
    return 0;
  }
  if (argumentsList[0] === "--attach") {
    const invocation = {
      command: "attach",
      commandArguments: [],
      effectiveDirectory: process.cwd(),
      forwardedGlobalOptions: [],
    };
    const context = loadContext(invocation);
    if (!context) {
      throw new CoordinatedGitError(
        "current directory is not a configured coordinator root.",
      );
    }
    initializeMissingSubmodules(context);
    return attachCoordinatedBranches(context);
  }
  if (
    process.env[INTERNAL_ENVIRONMENT_VARIABLE] === "1" ||
    process.env[LEGACY_INTERNAL_ENVIRONMENT_VARIABLE] === "1"
  ) {
    return git(argumentsList).status;
  }

  const invocation = parseInvocation(argumentsList, process.cwd());
  if (!invocation || !SUPPORTED_COMMANDS.has(invocation.command)) {
    return git(argumentsList).status;
  }

  const context = loadContext(
    invocation,
    configurationSourceForInvocation(invocation),
  );
  if (!context) return git(argumentsList).status;
  activeContext = context;
  return dispatch(context);
}

try {
  const status = main();
  process.exitCode = Number.isInteger(status) ? status : 1;
} catch (error) {
  const message =
    error instanceof Error ? error.message : "unknown coordinated Git error";
  process.stderr.write(
    `[agent-coordinator] ERROR: [${error instanceof CoordinatedGitError ? error.code : "UNEXPECTED_ERROR"}] ${message}\n`,
  );
  if (error instanceof CoordinatedGitError) {
    rememberFailure(activeContext, error);
    if (activeContext?.command !== "recover") {
      process.stderr.write(
        "[agent-coordinator] Next: run 'coordinator git recover' for a diagnosis and safe recovery options.\n",
      );
    }
  }
  process.exitCode = error instanceof CoordinatedGitError ? 1 : 2;
}
