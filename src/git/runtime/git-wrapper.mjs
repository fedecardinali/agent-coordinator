#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  openSync,
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

class CoordinatedGitError extends Error {}

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
  if (result.status !== 0) return { result };

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
    ...writableRepositories(context).map((repository) => ({
      branch: resolvedRepositoryBranch(repository, branch),
      directory: repository.directory,
      label: repository.id,
      repository,
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
    if (plan.result.status !== 0) return plan.result.status;
    plans.push(plan);
  }

  const diverged = plans.filter((plan) => plan.state === "diverged");
  if (diverged.length > 0) {
    throw new CoordinatedGitError(
      `coordinated pull cannot fast-forward: ${diverged
        .map((plan) => `${plan.target.label}/${plan.target.branch}`)
        .join(", ")}. Resolve the divergence explicitly before retrying.`,
    );
  }

  for (const plan of plans) {
    if (plan.state !== "behind") continue;
    process.stderr.write(
      `[agent-coordinator] fast-forwarding ${plan.target.label}/${plan.target.branch}...\n`,
    );
    const argumentsList = ["merge", "--ff-only", plan.reference];
    const result = plan.target.root
      ? executeRootGit(context, argumentsList)
      : executeGit(plan.target.directory, argumentsList);
    if (result.status !== 0) return result.status;
  }

  const stageResult = executeRootGit(context, [
    "add",
    "--",
    ...context.repositories.map((repository) => repository.path),
  ]);
  if (stageResult.status !== 0) return stageResult.status;

  if (hasStagedChanges(context.rootDirectory)) {
    process.stderr.write(
      "[agent-coordinator] recording updated repository revisions...\n",
    );
    const commitResult = executeRootGit(context, [
      "commit",
      "-m",
      "Sync coordinated repositories",
    ]);
    if (commitResult.status !== 0) return commitResult.status;
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
    if (["advance", "detach", "cancel"].includes(configured)) return configured;
    throw new CoordinatedGitError(
      `${PINNED_RESOLUTION_ENVIRONMENT_VARIABLE} must be advance, detach, or cancel.`,
    );
  }

  if (!process.stdin.isTTY || !process.stderr.isTTY) {
    throw new CoordinatedGitError(
      `${repository.id} branch '${branch}' is at ${branchRevision.slice(0, 8)} while the gitlink pins ${pinnedRevision.slice(0, 8)}. Rerun interactively or set ${PINNED_RESOLUTION_ENVIRONMENT_VARIABLE}=advance|detach|cancel.`,
    );
  }

  process.stderr.write(
    `[agent-coordinator] ${repository.id} branch '${branch}' is at ${branchRevision.slice(0, 8)}, while the new branch would pin ${pinnedRevision.slice(0, 8)}.\n` +
      "  [a] Advance the new branch pin to the current local branch tip\n" +
      "  [d] Keep the historical gitlink detached\n" +
      "  [c] Cancel branch creation\n",
  );
  while (true) {
    process.stderr.write("Choose a, d, or c: ");
    const answer = readTerminalLine();
    if (answer === "a" || answer === "advance") return "advance";
    if (answer === "d" || answer === "detach") return "detach";
    if (answer === "c" || answer === "cancel") return "cancel";
  }
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

function assertCommitAvailable(repository, revision) {
  const result = gitText(
    repository.directory,
    ["cat-file", "-e", `${revision}^{commit}`],
    { allowFailure: true },
  );
  if (result.status !== 0) {
    throw new CoordinatedGitError(
      `${repository.id} does not contain gitlink commit ${revision.slice(0, 8)} required by the start-point.`,
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
  const targetContext = context.workspaceManifest
    ? manifestPolicyContext(context, branch, { revision: branch })
    : context;
  try {
    const preparedRepositories = targetContext.repositories.map(
      (repository) => ({
        repository,
        prepared: prepareRepositoryAtRevision(
          targetContext,
          repository,
          branch,
          rootGitlinkRevision(targetContext, repository, branch),
          createdBranches,
        ),
      }),
    );

    for (const { repository, prepared } of preparedRepositories) {
      if (prepared.detached) {
        switchRepositoryDetached(
          repository.directory,
          rootGitlinkRevision(targetContext, repository, branch),
        );
      } else {
        switchRepository(repository.directory, prepared.branch);
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
    const effectiveContext = currentPolicyContext(context);
    assertFullInvariant(effectiveContext);
    process.stderr.write(
      `[agent-coordinator] switched to '${branch}': ${branchMappingSummary(effectiveContext, branch)}.\n`,
    );
    return 0;
  } catch (error) {
    rollbackRepositories(states, createdBranches);
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
  return dispatch(context);
}

try {
  const status = main();
  process.exitCode = Number.isInteger(status) ? status : 1;
} catch (error) {
  const message =
    error instanceof Error ? error.message : "unknown coordinated Git error";
  process.stderr.write(`[agent-coordinator] ERROR: ${message}\n`);
  process.exitCode = error instanceof CoordinatedGitError ? 1 : 2;
}
