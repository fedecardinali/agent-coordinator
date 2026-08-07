import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import path from "node:path";
import { runCommand, type CommandResult } from "../core/command.js";
import { CoordinatorError, errorMessage } from "../core/errors.js";
import { applyFilePlans, planFile } from "../core/files.js";
import { loadManifest, renderManifest } from "../core/manifest.js";
import {
  parseRepositoryIdentity,
  redactRepositoryUrl,
  repositoryCloneUrl,
  repositoryUrlsMatch as supportedRepositoryUrlsMatch,
} from "../core/repository-url.js";
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
import {
  NestedSubmoduleRepairRequiredError,
  planNestedSubmoduleRepair,
  redactNestedSubmoduleDiagnostic,
} from "./nested-repair.js";
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

export { repositoryCloneUrl } from "../core/repository-url.js";

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

function isPathWithin(base: string, candidate: string): boolean {
  const relative = path.relative(base, candidate);
  return (
    relative === "" ||
    (!path.isAbsolute(relative) &&
      relative !== ".." &&
      !relative.startsWith(`..${path.sep}`))
  );
}

function repositoryUrlsMatch(expectedInput: string, actualInput: string): boolean {
  const expected = repositoryCloneUrl(expectedInput);
  if (
    parseRepositoryIdentity(expected) ||
    parseRepositoryIdentity(actualInput)
  ) {
    return supportedRepositoryUrlsMatch(expected, actualInput);
  }
  if (path.isAbsolute(expected) && path.isAbsolute(actualInput)) {
    return canonicalPath(expected) === canonicalPath(actualInput);
  }
  return supportedRepositoryUrlsMatch(expected, actualInput);
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
  const absoluteRoot = path.resolve(root);
  const repositoryDirectory = path.resolve(root, repository.path);
  if (!isPathWithin(absoluteRoot, repositoryDirectory)) {
    throw existingRepositoryError(repository, "the destination escapes the coordinator root");
  }
  let cursor = absoluteRoot;
  for (const segment of path.relative(absoluteRoot, repositoryDirectory).split(path.sep)) {
    cursor = path.join(cursor, segment);
    if (pathExists(cursor) && lstatSync(cursor).isSymbolicLink()) {
      throw existingRepositoryError(
        repository,
        `the destination crosses symbolic link '${path.relative(absoluteRoot, cursor)}'`,
      );
    }
  }
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
      `.gitmodules URL '${redactRepositoryUrl(configured.url)}' does not match '${redactRepositoryUrl(repositoryCloneUrl(repository.url))}'`,
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
    !topLevel.stdout ||
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
    !superproject.stdout ||
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
      `origin URL '${origin.stdout ? redactRepositoryUrl(origin.stdout) : "missing"}' does not match '${redactRepositoryUrl(repositoryCloneUrl(repository.url))}'`,
    );
  }
}

interface NestedSubmodulePlan {
  directory: string;
  repository: Repository;
  root: string;
  submodules: IndexedSubmodule[];
}

interface IndexedSubmodule {
  commit: string;
  path: string;
  stage: string;
}

function nestedCheckoutPath(
  directory: string,
  relativePath: string,
  label: string,
): string {
  const parent = path.resolve(directory);
  const checkout = path.resolve(directory, relativePath);
  const relative = path.relative(parent, checkout);
  if (
    !relative ||
    path.isAbsolute(relative) ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`)
  ) {
    throw new CoordinatorError(
      `${label} has unsafe nested gitlink path '${relativePath}'.`,
      "NESTED_SUBMODULE_PATH_INVALID",
    );
  }
  let cursor = parent;
  for (const segment of relative.split(path.sep)) {
    cursor = path.join(cursor, segment);
    if (pathExists(cursor) && lstatSync(cursor).isSymbolicLink()) {
      throw new CoordinatorError(
        `${label} nested gitlink '${relativePath}' crosses symbolic link '${path.relative(parent, cursor)}'.`,
        "NESTED_SUBMODULE_PATH_INVALID",
      );
    }
  }
  if (
    pathExists(checkout) &&
    !isPathWithin(canonicalPath(parent), canonicalPath(checkout))
  ) {
    throw new CoordinatorError(
      `${label} nested gitlink '${relativePath}' resolves outside its parent repository.`,
      "NESTED_SUBMODULE_PATH_INVALID",
    );
  }
  return checkout;
}

function indexedSubmodules(directory: string): IndexedSubmodule[] {
  const configured = gitResult(
    directory,
    [
      "config",
      "--blob=HEAD:.gitmodules",
      "-z",
      "--get-regexp",
      "^submodule\\..*\\.path$",
    ],
    true,
  );
  if (configured.status !== 0) return [];
  const paths = configured.stdout
    .split("\0")
    .filter(Boolean)
    .map((entry) => entry.slice(entry.indexOf("\n") + 1))
    .filter(Boolean);
  if (!paths.length) return [];

  const result = gitResult(
    directory,
    ["ls-files", "--stage", "-z", "--", ...paths],
    true,
  );
  if (result.status !== 0) {
    throw new CoordinatorError(
      `Could not inspect nested gitlinks at '${directory}': ${result.stderr || result.stdout || `exit ${result.status}`}.`,
      "NESTED_SUBMODULE_STATUS_FAILED",
    );
  }
  return result.stdout
    .split("\0")
    .filter(Boolean)
    .map((entry) => /^(\d{6}) ([0-9a-f]{40,64}) ([0-3])\t([\s\S]+)$/.exec(entry))
    .filter((entry): entry is RegExpExecArray => entry?.[1] === "160000")
    .map((entry) => ({
      commit: entry[2]!,
      path: entry[4]!,
      stage: entry[3]!,
    }));
}

function planNestedSubmodules(
  root: string,
  repository: Repository,
): NestedSubmodulePlan[] {
  const plans: NestedSubmodulePlan[] = [];
  const visited = new Set<string>();
  const inspect = (directory: string, label: string): void => {
    const directoryRealPath = canonicalPath(directory);
    if (visited.has(directoryRealPath)) return;
    visited.add(directoryRealPath);

    const missing: IndexedSubmodule[] = [];
    const initialized: Array<{ directory: string; label: string }> = [];
    for (const submodule of indexedSubmodules(directory)) {
      if (submodule.stage !== "0") {
        throw new CoordinatorError(
          `${label} has an unresolved nested gitlink at '${submodule.path}'. Resolve the index before rerunning init.`,
          "NESTED_SUBMODULE_CONFLICT",
        );
      }
      const checkout = nestedCheckoutPath(directory, submodule.path, label);
      const topLevel = gitResult(checkout, ["rev-parse", "--show-toplevel"], true);
      if (
        topLevel.status !== 0 ||
        !topLevel.stdout ||
        canonicalPath(topLevel.stdout) !== canonicalPath(checkout)
      ) {
        if (
          pathExists(checkout) &&
          (!lstatSync(checkout).isDirectory() || readdirSync(checkout).length > 0)
        ) {
          throw new CoordinatorError(
            `${label} nested gitlink '${submodule.path}' is occupied by an unrecognized checkout or files. Init will not overwrite it.`,
            "NESTED_SUBMODULE_PATH_INVALID",
          );
        }
        missing.push(submodule);
        continue;
      }
      const superproject = gitResult(
        checkout,
        ["rev-parse", "--show-superproject-working-tree"],
        true,
      );
      if (
        superproject.status !== 0 ||
        !superproject.stdout ||
        canonicalPath(superproject.stdout) !== canonicalPath(directory)
      ) {
        throw new CoordinatorError(
          `${label} nested submodule '${submodule.path}' is not owned by its declared parent worktree.`,
          "NESTED_SUBMODULE_PATH_INVALID",
        );
      }
      const head = gitResult(checkout, ["rev-parse", "HEAD"], true);
      if (head.status !== 0 || head.stdout !== submodule.commit) {
        throw new CoordinatorError(
          `${label} nested submodule '${submodule.path}' is at ${head.stdout || "an unreadable HEAD"}, but its gitlink pins ${submodule.commit}. Init will not move an existing checkout; restore or commit its intended gitlink first.`,
          "NESTED_SUBMODULE_GITLINK_MISMATCH",
        );
      }
      initialized.push({
        directory: checkout,
        label: `${label} nested submodule '${submodule.path}'`,
      });
    }
    if (missing.length) {
      plans.push({
        directory,
        repository,
        root,
        submodules: missing.sort((left, right) =>
          left.path.localeCompare(right.path),
        ),
      });
    }
    for (const child of initialized) inspect(child.directory, child.label);
  };

  inspect(
    path.join(root, repository.path),
    `Repository '${repository.id}'`,
  );
  return plans;
}

function initializeNestedSubmodules(plans: NestedSubmodulePlan[]): void {
  for (const plan of plans) {
    for (const submodule of plan.submodules) {
      const result = gitResult(
        plan.directory,
        [
          "submodule",
          "update",
          "--init",
          "--recursive",
          "--checkout",
          "--",
          submodule.path,
        ],
        true,
      );
      if (result.status !== 0) {
        const detail = result.stderr || result.stdout || `exit ${result.status}`;
        const safeDetail = redactNestedSubmoduleDiagnostic(detail);
        const rollback = gitResult(
          plan.directory,
          ["submodule", "deinit", "-f", "--", submodule.path],
          true,
        );
        const rollbackDetail = rollback.stderr || rollback.stdout;
        if (rollback.status !== 0) {
          throw new CoordinatorError(
            `Could not initialize nested submodule '${submodule.path}' for repository '${plan.repository.id}': ${safeDetail}. Cleanup of the newly created nested checkout also failed: ${redactNestedSubmoduleDiagnostic(rollbackDetail || `exit ${rollback.status}`)}. Inspect that path before retrying.`,
            "NESTED_SUBMODULE_ROLLBACK_FAILED",
          );
        }

        let repairUnavailable = "";
        const topLevelParent = path.join(
          plan.root,
          plan.repository.path,
        );
        if (
          canonicalPath(plan.directory) === canonicalPath(topLevelParent)
        ) {
          try {
            const repairPlan = planNestedSubmoduleRepair(
              plan.root,
              plan.repository,
              submodule.path,
            );
            throw new NestedSubmoduleRepairRequiredError(repairPlan, safeDetail);
          } catch (error) {
            if (error instanceof NestedSubmoduleRepairRequiredError) throw error;
            repairUnavailable = ` Automatic repair is unavailable: ${errorMessage(error)}`;
          }
        }
        throw new CoordinatorError(
          `Could not initialize nested submodule '${submodule.path}' for repository '${plan.repository.id}': ${safeDetail}. The newly created checkout was rolled back by deinitializing that nested path; coordinator.yaml and top-level checkouts were preserved.${repairUnavailable} Resolve access or the parent gitlink and rerun init.`,
          "NESTED_SUBMODULE_INIT_FAILED",
        );
      }
    }
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
    !topLevel.stdout ||
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
  if (addSubmodules && !dryRun) {
    const nestedPlans = materialized.flatMap((repository) =>
      planNestedSubmodules(root, repository),
    );
    initializeNestedSubmodules(nestedPlans);
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
      );
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
