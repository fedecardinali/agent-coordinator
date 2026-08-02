import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import path from "node:path";
import { runCommand, type CommandResult } from "../core/command.js";
import { CoordinatorError } from "../core/errors.js";
import { applyFilePlans, planFile } from "../core/files.js";
import { loadManifest, renderManifest } from "../core/manifest.js";
import {
  coordinatorManifestSchema,
  type CoordinatorManifest,
  type Repository,
} from "../core/schema.js";
import {
  installMachineGitRuntime,
  installWorkspaceGitIntegration,
  invokeGitRuntime,
} from "../git/install.js";
import { discoverSkillSources } from "../agents/skills.js";
import { synchronizeWorkspace, type WorkspaceSyncResult } from "./sync.js";

export interface InitializeOptions {
  addSubmodules?: boolean | undefined;
  dryRun?: boolean | undefined;
  discoverSkills?: boolean | undefined;
  force?: boolean | undefined;
  gitStdio?: "pipe" | "inherit" | undefined;
  installHooks?: boolean | undefined;
}

export interface InitializeResult {
  createdGitRepository: boolean;
  gitIntegration: {
    attached: boolean;
    configurationValidated: boolean;
    detail: string;
    hooksInstalled: boolean;
    invariantChecked: boolean;
    missingSubmodules: string[];
    mode: "active" | "configuration-only" | "dry-run";
    validatedSubmodules: string[];
  };
  root: string;
  submodules: string[];
  sync: WorkspaceSyncResult | null;
}

export function repositoryCloneUrl(url: string): string {
  return /^[^/:]+\/[^/]+$/.test(url) ? `git@github.com:${url}.git` : url;
}

function gitResult(
  root: string,
  argumentsList: string[],
  allowFailure = false,
): CommandResult {
  return runCommand(
    "git",
    ["-c", "core.hooksPath=/dev/null", "-c", "protocol.file.allow=always", "-C", root, ...argumentsList],
    { allowFailure, env: { GIT_COORDINATOR_INTERNAL: "1" } },
  );
}

function git(root: string, argumentsList: string[]): void {
  gitResult(root, argumentsList);
}

function pathExists(value: string): boolean {
  try {
    lstatSync(value);
    return true;
  } catch {
    return false;
  }
}

function canonicalPath(value: string): string {
  try {
    return realpathSync(value);
  } catch {
    return path.resolve(value);
  }
}

function githubRepository(value: string): string | null {
  const normalized = value
    .trim()
    .replace(/^git@github\.com:/i, "")
    .replace(/^ssh:\/\/git@github\.com\//i, "")
    .replace(/^https?:\/\/github\.com\//i, "")
    .replace(/\.git$/i, "")
    .replace(/\/+$/, "");
  return /^[^/]+\/[^/]+$/.test(normalized)
    ? normalized.toLowerCase()
    : null;
}

function repositoryUrlsMatch(expectedInput: string, actualInput: string): boolean {
  const expected = repositoryCloneUrl(expectedInput);
  const expectedGithub = githubRepository(expected);
  const actualGithub = githubRepository(actualInput);
  if (expectedGithub && actualGithub) return expectedGithub === actualGithub;
  if (path.isAbsolute(expected) && path.isAbsolute(actualInput)) {
    return canonicalPath(expected) === canonicalPath(actualInput);
  }
  return expected.replace(/\/+$/, "") === actualInput.replace(/\/+$/, "");
}

function existingRepositoryError(
  repository: Repository,
  detail: string,
): CoordinatorError {
  return new CoordinatorError(
    `Existing path '${repository.path}' cannot be adopted for repository '${repository.id}': ${detail}. It must already be the declared Git submodule and gitlink; no files were changed.`,
    "EXISTING_PATH_NOT_DECLARED_SUBMODULE",
  );
}

function configuredSubmodule(
  root: string,
  repository: Repository,
): { key: string; url: string } {
  const entries = gitResult(
    root,
    ["config", "-f", ".gitmodules", "--get-regexp", "^submodule\\..*\\.path$"],
    true,
  );
  if (entries.status !== 0) {
    throw existingRepositoryError(repository, ".gitmodules has no matching declaration");
  }
  const matches = entries.stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const separator = line.search(/\s/);
      return separator < 0
        ? { key: line, value: "" }
        : { key: line.slice(0, separator), value: line.slice(separator).trimStart() };
    })
    .filter((entry) => entry.value === repository.path);
  if (matches.length !== 1) {
    throw existingRepositoryError(
      repository,
      matches.length === 0
        ? ".gitmodules does not declare that path"
        : ".gitmodules declares that path more than once",
    );
  }
  const key = matches[0]!.key.replace(/\.path$/, "");
  const url = gitResult(
    root,
    ["config", "-f", ".gitmodules", "--get", `${key}.url`],
    true,
  );
  if (url.status !== 0 || !url.stdout) {
    throw existingRepositoryError(repository, ".gitmodules has no URL for that path");
  }
  return { key, url: url.stdout };
}

function validateMaterializedRepository(
  root: string,
  repository: Repository,
): void {
  const repositoryDirectory = path.join(root, repository.path);
  if (!pathExists(repositoryDirectory)) {
    throw new CoordinatorError(
      `Repository '${repository.id}' is not materialized at '${repository.path}'.`,
      "SUBMODULE_MISSING",
    );
  }
  const configured = configuredSubmodule(root, repository);
  if (!repositoryUrlsMatch(repository.url, configured.url)) {
    throw existingRepositoryError(
      repository,
      `.gitmodules URL '${configured.url}' does not match '${repositoryCloneUrl(repository.url)}'`,
    );
  }

  const staged = gitResult(
    root,
    ["ls-files", "--stage", "--", repository.path],
    true,
  );
  const gitlink = staged.stdout
    .split("\n")
    .map((line) => /^(\d+) ([0-9a-f]+) \d+\t(.*)$/.exec(line))
    .find((entry) => entry?.[3] === repository.path);
  if (staged.status !== 0 || !gitlink || gitlink[1] !== "160000") {
    throw existingRepositoryError(repository, "the coordinator index has no gitlink for that path");
  }

  const topLevel = gitResult(
    repositoryDirectory,
    ["rev-parse", "--show-toplevel"],
    true,
  );
  if (
    topLevel.status !== 0 ||
    canonicalPath(topLevel.stdout) !== canonicalPath(repositoryDirectory)
  ) {
    throw existingRepositoryError(repository, "the destination is not that submodule's Git worktree");
  }
  const superproject = gitResult(
    repositoryDirectory,
    ["rev-parse", "--show-superproject-working-tree"],
    true,
  );
  if (
    superproject.status !== 0 ||
    canonicalPath(superproject.stdout) !== canonicalPath(root)
  ) {
    throw existingRepositoryError(repository, "the Git worktree belongs to another superproject");
  }
  const head = gitResult(repositoryDirectory, ["rev-parse", "HEAD"], true);
  if (head.status !== 0 || head.stdout !== gitlink[2]) {
    throw existingRepositoryError(
      repository,
      `child HEAD ${head.stdout || "unreadable"} does not match gitlink ${gitlink[2]}`,
    );
  }
  const origin = gitResult(
    repositoryDirectory,
    ["remote", "get-url", "origin"],
    true,
  );
  if (
    origin.status !== 0 ||
    !repositoryUrlsMatch(repository.url, origin.stdout)
  ) {
    throw existingRepositoryError(
      repository,
      `origin URL '${origin.stdout || "missing"}' does not match '${repositoryCloneUrl(repository.url)}'`,
    );
  }
}

function validateExistingDestinations(
  root: string,
  manifest: CoordinatorManifest,
): void {
  const existing = manifest.repositories.filter((repository) =>
    pathExists(path.join(root, repository.path)),
  );
  if (!existing.length) return;
  const topLevel = gitResult(root, ["rev-parse", "--show-toplevel"], true);
  if (
    topLevel.status !== 0 ||
    canonicalPath(topLevel.stdout) !== canonicalPath(root)
  ) {
    throw existingRepositoryError(
      existing[0]!,
      "the coordinator root is not an existing Git worktree",
    );
  }
  for (const repository of existing) {
    validateMaterializedRepository(root, repository);
  }
}

interface InitialRepositoryBranch {
  existsOnRemote: boolean;
  name: string;
}

function coordinatorBranchForInitialization(root: string): string {
  if (!pathExists(path.join(root, ".git"))) return "main";
  const current = gitResult(
    root,
    ["symbolic-ref", "--quiet", "--short", "HEAD"],
    true,
  );
  if (current.status !== 0 || !current.stdout) {
    throw new CoordinatorError(
      "The coordinator worktree is detached. Attach it to a branch before initialization. No workspace files were changed.",
      "COORDINATOR_BRANCH_MISSING",
    );
  }
  return current.stdout;
}

function initialRepositoryBranch(
  repository: Repository,
  coordinatorBranch: string,
): { fixed: boolean; name: string } {
  const policy = repository.branch;
  if (policy.mode === "mirror") {
    return { fixed: false, name: coordinatorBranch };
  }
  if (policy.mode === "fixed") {
    return { fixed: true, name: policy.name };
  }
  const mapped = policy.branches[coordinatorBranch];
  if (mapped) return { fixed: false, name: mapped };
  if (policy.fallback?.mode === "mirror") {
    return { fixed: false, name: coordinatorBranch };
  }
  if (policy.fallback?.mode === "fixed") {
    return { fixed: true, name: policy.fallback.name };
  }
  throw new CoordinatorError(
    `Repository '${repository.id}' has no branch mapping for coordinator branch '${coordinatorBranch}'. No workspace files were changed.`,
    "BRANCH_MAPPING_MISSING",
  );
}

function resolveInitialBranches(
  root: string,
  manifest: CoordinatorManifest,
): Map<string, InitialRepositoryBranch> {
  const coordinatorBranch = coordinatorBranchForInitialization(root);
  const resolved = new Map<string, InitialRepositoryBranch>();
  for (const repository of manifest.repositories) {
    const selection = initialRepositoryBranch(repository, coordinatorBranch);
    const branch = selection.name;
    const validName = runCommand(
      "git",
      ["check-ref-format", "--branch", branch],
      { allowFailure: true },
    );
    if (validName.status !== 0) {
      throw new CoordinatorError(
        `Repository '${repository.id}' has invalid fixed branch '${branch}'. No workspace files were changed.`,
        "INVALID_FIXED_BRANCH",
      );
    }
    const remote = repositoryCloneUrl(repository.url);
    const available = runCommand(
      "git",
      ["ls-remote", "--exit-code", "--heads", remote, `refs/heads/${branch}`],
      { allowFailure: true },
    );
    const existsOnRemote = available.status === 0 && Boolean(available.stdout);
    if (!existsOnRemote && (available.status === 0 || available.status === 2)) {
      if (!selection.fixed) {
        resolved.set(repository.id, { existsOnRemote: false, name: branch });
        continue;
      }
      throw new CoordinatorError(
        `Repository '${repository.id}' requires fixed branch '${branch}', but '${remote}' does not contain it. No workspace files were changed.`,
        "FIXED_BRANCH_MISSING",
      );
    }
    if (available.status !== 0) {
      throw new CoordinatorError(
        `Could not verify fixed branch '${branch}' for repository '${repository.id}' at '${remote}': ${available.stderr || available.stdout || `exit ${available.status}`}. No workspace files were changed.`,
        "FIXED_BRANCH_CHECK_FAILED",
      );
    }
    resolved.set(repository.id, { existsOnRemote, name: branch });
  }
  return resolved;
}

function validateNativeConfiguration(
  root: string,
  manifest: CoordinatorManifest,
): void {
  try {
    const loaded = loadManifest(root);
    if (JSON.stringify(loaded.manifest) !== JSON.stringify(manifest)) {
      throw new CoordinatorError(
        "Validated coordinator.yaml does not match the initialized workspace manifest.",
        "GIT_CONFIGURATION_INVALID",
      );
    }
  } catch (error) {
    if (error instanceof CoordinatorError) throw error;
    throw new CoordinatorError(
      `coordinator.yaml could not be validated as the native Git configuration: ${error instanceof Error ? error.message : String(error)}`,
      "GIT_CONFIGURATION_INVALID",
    );
  }
}

export function initializeWorkspace(
  directory: string,
  input: CoordinatorManifest,
  generatorVersion: string,
  options: InitializeOptions = {},
): InitializeResult {
  const manifest = coordinatorManifestSchema.parse(input);
  const root = path.resolve(directory);
  const dryRun = options.dryRun ?? false;
  const force = options.force ?? false;
  const addSubmodules = options.addSubmodules ?? true;
  const installHooks = options.installHooks ?? true;
  const gitStdio = options.gitStdio ?? "inherit";

  const manifestPlan = planFile(root, "coordinator.yaml", renderManifest(manifest), {
    force,
    owned: () => false,
  });
  if (pathExists(root)) validateExistingDestinations(root, manifest);
  const initialBranches = resolveInitialBranches(root, manifest);
  const initiallyMissing = manifest.repositories.filter(
    (repository) => !pathExists(path.join(root, repository.path)),
  );
  if (!addSubmodules && installHooks && initiallyMissing.length) {
    throw new CoordinatorError(
      `Cannot install Git integration because these declared submodules are not materialized: ${initiallyMissing.map((repository) => repository.id).join(", ")}. Initialize them or combine --no-submodules with --no-hooks for configuration-only mode. No workspace files were changed.`,
      "SUBMODULES_REQUIRED_FOR_INTEGRATION",
    );
  }
  if (!existsSync(root) && !dryRun) mkdirSync(root, { recursive: true });
  const gitDirectory = path.join(root, ".git");
  const createdGitRepository = !existsSync(gitDirectory);
  if (createdGitRepository && !dryRun) {
    mkdirSync(root, { recursive: true });
    runCommand("git", ["init", "--initial-branch=main", root]);
  }

  if (!dryRun) applyFilePlans([manifestPlan]);

  const added: string[] = [];
  if (addSubmodules && !dryRun) {
    for (const repository of manifest.repositories) {
      const repositoryDirectory = path.join(root, repository.path);
      if (pathExists(repositoryDirectory)) continue;
      const initialBranch = initialBranches.get(repository.id)!;
      const branchArguments = initialBranch.existsOnRemote
        ? ["-b", initialBranch.name]
        : [];
      git(root, [
        "submodule",
        "add",
        "--name",
        repository.id,
        ...branchArguments,
        repositoryCloneUrl(repository.url),
        repository.path,
      ]);
      added.push(repository.id);
    }
  }

  const materialized = manifest.repositories.filter((repository) =>
    pathExists(path.join(root, repository.path)),
  );
  for (const repository of materialized) {
    validateMaterializedRepository(root, repository);
  }
  const missingSubmodules = manifest.repositories
    .filter((repository) => !pathExists(path.join(root, repository.path)))
    .map((repository) => repository.id);
  if (!dryRun && installHooks && missingSubmodules.length) {
    throw new CoordinatorError(
      `Cannot install Git integration because these declared submodules are not materialized: ${missingSubmodules.join(", ")}. No hooks, attach, or invariant check were run.`,
      "SUBMODULES_REQUIRED_FOR_INTEGRATION",
    );
  }

  if ((options.discoverSkills ?? false) && !dryRun) {
    for (const repository of manifest.repositories) {
      if (repository.agent.skills.length) continue;
      repository.agent.skills = discoverSkillSources(
        path.join(root, repository.path),
      ).map((source) => ({ source }));
    }
    const discoveredManifestPlan = planFile(
      root,
      "coordinator.yaml",
      renderManifest(manifest),
      { force: true, owned: () => false },
    );
    applyFilePlans([discoveredManifestPlan]);
  }

  const sync = dryRun
    ? null
    : synchronizeWorkspace(root, manifest, generatorVersion, { force });
  if (!dryRun) validateNativeConfiguration(root, manifest);
  if (!dryRun && installHooks) {
    installMachineGitRuntime({ stdio: gitStdio });
    installWorkspaceGitIntegration(root, { stdio: gitStdio });
    invokeGitRuntime("attach", root, { stdio: gitStdio });
    invokeGitRuntime("check", root, { stdio: gitStdio });
  }
  const gitIntegration: InitializeResult["gitIntegration"] = dryRun
    ? {
        attached: false,
        configurationValidated: false,
        detail: "Dry run only; no Git integration, hooks, attach, or invariant check was applied.",
        hooksInstalled: false,
        invariantChecked: false,
        missingSubmodules: initiallyMissing.map((repository) => repository.id),
        mode: "dry-run",
        validatedSubmodules: [],
      }
    : installHooks
      ? {
          attached: true,
          configurationValidated: true,
          detail: "Native coordinator.yaml Git configuration, submodule topology, branch attachment, and embedded Git runtime invariant validated.",
          hooksInstalled: true,
          invariantChecked: true,
          missingSubmodules: [],
          mode: "active",
          validatedSubmodules: materialized.map((repository) => repository.id),
        }
      : {
          attached: false,
          configurationValidated: true,
          detail:
            "Configuration-only mode (--no-hooks): native coordinator.yaml Git configuration and materialized submodules were validated; runtime installation, hooks, attach, and the runtime invariant check were intentionally skipped.",
          hooksInstalled: false,
          invariantChecked: false,
          missingSubmodules,
          mode: "configuration-only",
          validatedSubmodules: materialized.map((repository) => repository.id),
        };
  return {
    root,
    createdGitRepository,
    gitIntegration,
    submodules: added,
    sync,
  };
}
