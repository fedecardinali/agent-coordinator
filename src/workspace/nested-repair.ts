import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import { runCommand, type CommandResult } from "../core/command.js";
import { CoordinatorError, errorMessage } from "../core/errors.js";
import { redactRepositoryUrl } from "../core/repository-url.js";
import type { Repository } from "../core/schema.js";

export type NestedSubmoduleRepairCandidateSource =
  | "previous-reachable-pin"
  | "remote-default-head";

export interface NestedSubmoduleRepairCandidate {
  ref: string | null;
  revision: string;
  sources: NestedSubmoduleRepairCandidateSource[];
  subject: string | null;
}

export interface NestedSubmoduleRepairPlan {
  baseline: {
    parentBranch: string;
    parentRevision: string;
    pinnedRevision: string;
    rootGitlinkRevision: string;
  };
  candidates: NestedSubmoduleRepairCandidate[];
  effects: {
    createsLocalCommit: true;
    pushes: false;
    retriesInitialization: true;
    updatesCoordinatorGitlink: true;
  };
  fingerprint: string;
  id: string;
  nestedPath: string;
  parentDirectory: string;
  remote: {
    defaultRef: string;
    displayUrl: string;
  };
  repositoryId: string;
  repositoryPath: string;
  root: string;
}

export interface NestedSubmoduleRepairResult {
  candidateRevision: string;
  nestedPath: string;
  parentCommit: string;
  previousParentCommit: string;
  previousPinnedRevision: string;
  pushed: false;
  repositoryId: string;
  rootGitlinkUpdated: true;
}

interface PrivatePlanState {
  canonicalPlan: NestedSubmoduleRepairPlan;
  planIntegrity: string;
  repository: Repository;
}

const privatePlanState = new WeakMap<
  NestedSubmoduleRepairPlan,
  PrivatePlanState
>();

function git(
  cwd: string,
  argumentsList: string[],
  allowFailure = false,
): CommandResult {
  return runCommand("git", argumentsList, {
    allowFailure,
    cwd,
    env: { GIT_COORDINATOR_INTERNAL: "1" },
  });
}

function gitDirectory(
  directory: string,
  argumentsList: string[],
  allowFailure = false,
): CommandResult {
  return runCommand("git", ["--git-dir", directory, ...argumentsList], {
    allowFailure,
    env: { GIT_COORDINATOR_INTERNAL: "1" },
  });
}

function safeNestedPath(value: string): boolean {
  return (
    Boolean(value) &&
    value !== "." &&
    !/[\x00-\x1f\x7f]/.test(value) &&
    !path.isAbsolute(value) &&
    !value.split(/[\\/]/).includes("..")
  );
}

function gitlinkRevision(directory: string, relativePath: string): string {
  const result = git(
    directory,
    ["ls-files", "--stage", "-z", "--", relativePath],
    true,
  );
  const match = /^(160000) ([0-9a-f]{40,64}) 0\t([^\0]+)\0?$/.exec(
    result.stdout,
  );
  if (
    result.status !== 0 ||
    !match ||
    match[3] !== relativePath
  ) {
    throw new CoordinatorError(
      `Automatic nested repair requires exactly one stage-0 gitlink at '${relativePath}'.`,
      "NESTED_SUBMODULE_REPAIR_UNAVAILABLE",
    );
  }
  return match[2]!;
}

function configuredSubmodule(
  directory: string,
  nestedPath: string,
): { name: string; url: string } {
  const configured = git(
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
  const matches = configured.stdout
    .split("\0")
    .filter(Boolean)
    .map((entry) => {
      const separator = entry.indexOf("\n");
      return separator < 0
        ? { key: entry, value: "" }
        : { key: entry.slice(0, separator), value: entry.slice(separator + 1) };
    })
    .filter((entry) => entry.value === nestedPath);
  if (configured.status !== 0 || matches.length !== 1) {
    throw new CoordinatorError(
      `Automatic nested repair could not resolve '${nestedPath}' uniquely in the parent .gitmodules file.`,
      "NESTED_SUBMODULE_REPAIR_UNAVAILABLE",
    );
  }
  const key = matches[0]!.key.replace(/\.path$/, "");
  const name = key.replace(/^submodule\./, "");
  const initializedUrl = git(
    directory,
    ["config", "--get", `${key}.url`],
    true,
  );
  const declaredUrl = git(
    directory,
    ["config", "--blob=HEAD:.gitmodules", "--get", `${key}.url`],
    true,
  );
  if (initializedUrl.status === 0 && initializedUrl.stdout) {
    return { name, url: initializedUrl.stdout };
  }
  if (declaredUrl.status !== 0 || !declaredUrl.stdout) {
    throw new CoordinatorError(
      `Automatic nested repair could not resolve the remote for '${nestedPath}'.`,
      "NESTED_SUBMODULE_REPAIR_UNAVAILABLE",
    );
  }
  return {
    name,
    url: resolveDeclaredSubmoduleUrl(directory, declaredUrl.stdout),
  };
}

function defaultParentRemoteUrl(directory: string): string {
  const branch = git(
    directory,
    ["symbolic-ref", "--quiet", "--short", "HEAD"],
    true,
  );
  const configuredRemote = branch.stdout
    ? git(
        directory,
        ["config", "--get", `branch.${branch.stdout}.remote`],
        true,
      )
    : null;
  const remoteName =
    configuredRemote?.status === 0 && configuredRemote.stdout
      ? configuredRemote.stdout
      : "origin";
  if (remoteName === ".") return directory;
  const remoteUrl = git(
    directory,
    ["config", "--get-all", `remote.${remoteName}.url`],
    true,
  );
  return remoteUrl.status === 0 && remoteUrl.stdout
    ? remoteUrl.stdout.split("\n")[0]!
    : directory;
}

function resolveRelativePath(base: string, relative: string): string {
  return path.posix.normalize(
    `${base.replace(/\/+$/, "")}/${relative}`,
  );
}

function resolveDeclaredSubmoduleUrl(
  directory: string,
  declaredUrl: string,
): string {
  if (!/^\.\.?\//.test(declaredUrl)) return declaredUrl;
  const upstream = defaultParentRemoteUrl(directory);
  try {
    const parsed = new URL(upstream);
    if (/^[a-z][a-z\d+.-]*:\/\//i.test(upstream)) {
      parsed.pathname = resolveRelativePath(parsed.pathname, declaredUrl);
      parsed.search = "";
      parsed.hash = "";
      return parsed.toString();
    }
  } catch {
    // SCP-style and local repository paths are resolved below.
  }
  const scp = /^((?:[^@\s/:]+@)?(?:\[[^\]\s]+\]|[^/\s:]+):)(.*)$/.exec(
    upstream,
  );
  if (scp) {
    return `${scp[1]}${resolveRelativePath(scp[2]!, declaredUrl)}`;
  }
  const absoluteUpstream = path.isAbsolute(upstream)
    ? upstream
    : path.resolve(directory, upstream);
  return path.resolve(absoluteUpstream, declaredUrl);
}

function remoteSnapshot(
  parentDirectory: string,
  remoteUrl: string,
): { head: { ref: string; revision: string }; refRevisions: string[] } {
  const result = git(
    parentDirectory,
    [
      "ls-remote",
      "--symref",
      "--end-of-options",
      remoteUrl,
      "HEAD",
      "refs/heads/*",
    ],
    true,
  );
  if (result.status !== 0) {
    const detail = redactNestedSubmoduleDiagnostic(
      result.stderr || result.stdout || `exit ${result.status}`,
    );
    throw new CoordinatorError(
      `Automatic nested repair could not inspect ${redactNestedSubmoduleDiagnostic(remoteUrl)}: ${detail}.`,
      "NESTED_SUBMODULE_REPAIR_UNAVAILABLE",
    );
  }
  const lines = result.stdout.split("\n").filter(Boolean);
  const symbolic = lines
    .map((line) => /^ref:\s+(refs\/heads\/[^\s]+)\s+HEAD$/.exec(line))
    .find(Boolean);
  const revision = lines
    .map((line) => /^([0-9a-f]{40,64})\s+HEAD$/.exec(line))
    .find(Boolean);
  if (!symbolic?.[1] || !revision?.[1]) {
    throw new CoordinatorError(
      `Automatic nested repair requires a symbolic default branch at ${redactNestedSubmoduleDiagnostic(remoteUrl)}.`,
      "NESTED_SUBMODULE_REPAIR_UNAVAILABLE",
    );
  }
  const refRevisions = [
    ...new Set(
      lines
        .map((line) => /^([0-9a-f]{40,64})\s+refs\/heads\/[^\s]+$/.exec(line)?.[1])
        .filter((value): value is string => Boolean(value)),
    ),
  ];
  if (!refRevisions.includes(revision[1])) refRevisions.push(revision[1]);
  return {
    head: { ref: symbolic[1], revision: revision[1] },
    refRevisions,
  };
}

function nestedGitDirectory(
  parentDirectory: string,
  nestedName: string,
): string {
  if (!nestedName || /[\x00-\x1f\x7f]/.test(nestedName)) {
    throw new CoordinatorError(
      "Automatic nested repair refused an unsafe logical submodule name.",
      "NESTED_SUBMODULE_REPAIR_UNAVAILABLE",
    );
  }
  const modulesRootResult = git(
    parentDirectory,
    ["rev-parse", "--git-path", "modules"],
    true,
  );
  const result = git(
    parentDirectory,
    ["rev-parse", "--git-path", `modules/${nestedName}`],
    true,
  );
  const modulesRoot = path.resolve(parentDirectory, modulesRootResult.stdout);
  const resolved = path.resolve(parentDirectory, result.stdout);
  if (
    modulesRootResult.status !== 0 ||
    !modulesRootResult.stdout ||
    result.status !== 0 ||
    !result.stdout ||
    !existsSync(modulesRoot) ||
    !existsSync(resolved)
  ) {
    throw new CoordinatorError(
      `Automatic nested repair could not inspect the failed clone for '${nestedName}'.`,
      "NESTED_SUBMODULE_REPAIR_UNAVAILABLE",
    );
  }
  let canonicalModulesRoot: string;
  let canonicalResolved: string;
  try {
    canonicalModulesRoot = realpathSync(modulesRoot);
    canonicalResolved = realpathSync(resolved);
  } catch {
    throw new CoordinatorError(
      "Automatic nested repair could not canonicalize the failed submodule cache.",
      "NESTED_SUBMODULE_REPAIR_UNAVAILABLE",
    );
  }
  const relative = path.relative(canonicalModulesRoot, canonicalResolved);
  if (
    !relative ||
    relative.startsWith(`..${path.sep}`) ||
    relative === ".." ||
    path.isAbsolute(relative)
  ) {
    throw new CoordinatorError(
      "Automatic nested repair refused a submodule cache outside the parent Git modules directory.",
      "NESTED_SUBMODULE_REPAIR_UNAVAILABLE",
    );
  }
  return canonicalResolved;
}

function objectExists(gitDir: string, revision: string): boolean {
  return (
    gitDirectory(gitDir, ["cat-file", "-e", `${revision}^{commit}`], true)
      .status === 0
  );
}

function reachableFromAdvertisedRef(
  gitDir: string,
  revision: string,
  refRevisions: string[],
): boolean {
  if (!objectExists(gitDir, revision)) return false;
  return refRevisions.some(
    (refRevision) =>
      gitDirectory(
        gitDir,
        ["merge-base", "--is-ancestor", revision, refRevision],
        true,
      ).status === 0,
  );
}

function subject(gitDir: string, revision: string): string | null {
  const result = gitDirectory(
    gitDir,
    ["show", "-s", "--format=%s", revision],
    true,
  );
  return result.status === 0 && result.stdout
    ? result.stdout.replace(/[\x00-\x1f\x7f]+/g, " ")
    : null;
}

function previousPinnedRevisions(
  parentDirectory: string,
  nestedPath: string,
  currentRevision: string,
): string[] {
  const history = git(
    parentDirectory,
    ["log", "--format=%H", "--max-count=100", "--", nestedPath],
    true,
  );
  if (history.status !== 0) return [];
  const revisions: string[] = [];
  for (const commit of history.stdout.split("\n").filter(Boolean)) {
    const tree = git(
      parentDirectory,
      ["ls-tree", commit, "--", nestedPath],
      true,
    );
    const match = /^160000 commit ([0-9a-f]{40,64})\t/.exec(tree.stdout);
    if (match?.[1] && match[1] !== currentRevision && !revisions.includes(match[1])) {
      revisions.push(match[1]);
    }
  }
  return revisions;
}

function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function immutableClone<T>(value: T): T {
  const clone = structuredClone(value);
  const seen = new WeakSet<object>();
  const freeze = (candidate: unknown): void => {
    if (!candidate || typeof candidate !== "object" || seen.has(candidate)) {
      return;
    }
    seen.add(candidate);
    for (const nested of Object.values(candidate)) freeze(nested);
    Object.freeze(candidate);
  };
  freeze(clone);
  return clone;
}

function requireCleanAttachedParent(
  parentDirectory: string,
): { branch: string; revision: string } {
  const status = git(
    parentDirectory,
    ["status", "--porcelain=v1", "--untracked-files=all"],
    true,
  );
  if (status.status !== 0 || status.stdout) {
    throw new CoordinatorError(
      "Automatic nested repair requires a clean parent repository.",
      "NESTED_SUBMODULE_REPAIR_UNAVAILABLE",
    );
  }
  const branch = git(
    parentDirectory,
    ["symbolic-ref", "--quiet", "--short", "HEAD"],
    true,
  );
  const revision = git(parentDirectory, ["rev-parse", "HEAD"], true);
  if (branch.status !== 0 || !branch.stdout || revision.status !== 0 || !revision.stdout) {
    throw new CoordinatorError(
      "Automatic nested repair requires the clean parent repository to be attached to a branch.",
      "NESTED_SUBMODULE_REPAIR_UNAVAILABLE",
    );
  }
  return { branch: branch.stdout, revision: revision.stdout };
}

function expectedRepositoryBranch(
  root: string,
  repository: Repository,
): string {
  const rootBranch = git(
    root,
    ["symbolic-ref", "--quiet", "--short", "HEAD"],
    true,
  );
  if (rootBranch.status !== 0 || !rootBranch.stdout) {
    throw new CoordinatorError(
      "Automatic nested repair requires the coordinator to be attached to a branch.",
      "NESTED_SUBMODULE_REPAIR_UNAVAILABLE",
    );
  }
  const policy = repository.branch;
  if (policy.mode === "mirror") return rootBranch.stdout;
  if (policy.mode === "fixed") return policy.name;
  const mapped = policy.branches[rootBranch.stdout];
  if (mapped) return mapped;
  if (policy.fallback?.mode === "mirror") return rootBranch.stdout;
  if (policy.fallback?.mode === "fixed") return policy.fallback.name;
  throw new CoordinatorError(
    `Repository '${repository.id}' has no repairable branch mapping for coordinator branch '${rootBranch.stdout}'.`,
    "NESTED_SUBMODULE_REPAIR_UNAVAILABLE",
  );
}

export function planNestedSubmoduleRepair(
  rootInput: string,
  repository: Repository,
  nestedPath: string,
): NestedSubmoduleRepairPlan {
  const canonicalRepository = immutableClone(repository);
  const root = path.resolve(rootInput);
  if (canonicalRepository.branch.readOnly) {
    throw new CoordinatorError(
      `Repository '${canonicalRepository.id}' is read-only; Agent Coordinator will not create a repair commit in it.`,
      "NESTED_SUBMODULE_REPAIR_UNAVAILABLE",
    );
  }
  if (!safeNestedPath(nestedPath)) {
    throw new CoordinatorError(
      "Automatic nested repair refused an unsafe nested path.",
      "NESTED_SUBMODULE_REPAIR_UNAVAILABLE",
    );
  }
  const parentDirectory = path.resolve(root, canonicalRepository.path);
  const parent = requireCleanAttachedParent(parentDirectory);
  const expectedBranch = expectedRepositoryBranch(root, canonicalRepository);
  if (parent.branch !== expectedBranch) {
    throw new CoordinatorError(
      `Automatic nested repair expected repository '${canonicalRepository.id}' on branch '${expectedBranch}', but it is attached to '${parent.branch}'.`,
      "NESTED_SUBMODULE_REPAIR_UNAVAILABLE",
    );
  }
  const rootGitlinkRevision = gitlinkRevision(root, canonicalRepository.path);
  if (rootGitlinkRevision !== parent.revision) {
    throw new CoordinatorError(
      `Coordinator gitlink '${canonicalRepository.path}' does not match the parent repository HEAD.`,
      "NESTED_SUBMODULE_REPAIR_UNAVAILABLE",
    );
  }
  const pinnedRevision = gitlinkRevision(parentDirectory, nestedPath);
  const configured = configuredSubmodule(parentDirectory, nestedPath);
  const nestedGitDir = nestedGitDirectory(parentDirectory, configured.name);
  const remote = remoteSnapshot(parentDirectory, configured.url);
  if (
    reachableFromAdvertisedRef(
      nestedGitDir,
      pinnedRevision,
      remote.refRevisions,
    )
  ) {
    throw new CoordinatorError(
      `Pinned commit ${pinnedRevision} remains reachable from the nested remote; this is not a directly repairable unavailable gitlink.`,
      "NESTED_SUBMODULE_REPAIR_UNAVAILABLE",
    );
  }
  const defaultHead = remote.head;
  const byRevision = new Map<string, NestedSubmoduleRepairCandidate>();
  for (const revision of previousPinnedRevisions(
    parentDirectory,
    nestedPath,
    pinnedRevision,
  )) {
    if (!reachableFromAdvertisedRef(nestedGitDir, revision, remote.refRevisions)) {
      continue;
    }
    byRevision.set(revision, {
      ref: null,
      revision,
      sources: ["previous-reachable-pin"],
      subject: subject(nestedGitDir, revision),
    });
    break;
  }
  const existingDefault = byRevision.get(defaultHead.revision);
  if (existingDefault) {
    existingDefault.ref = defaultHead.ref;
    existingDefault.sources.push("remote-default-head");
  } else {
    byRevision.set(defaultHead.revision, {
      ref: defaultHead.ref,
      revision: defaultHead.revision,
      sources: ["remote-default-head"],
      subject: subject(nestedGitDir, defaultHead.revision),
    });
  }
  const candidates = [...byRevision.values()];
  const baseline = {
    parentBranch: parent.branch,
    parentRevision: parent.revision,
    pinnedRevision,
    rootGitlinkRevision,
  };
  const publicPlan = {
    baseline,
    candidates,
    nestedPath,
    parentDirectory,
    remote: {
      defaultRef: defaultHead.ref,
      displayUrl: redactNestedSubmoduleDiagnostic(configured.url),
    },
    repositoryId: canonicalRepository.id,
    repositoryPath: canonicalRepository.path,
    root,
  };
  const planFingerprint = fingerprint(publicPlan);
  const plan: NestedSubmoduleRepairPlan = {
    ...publicPlan,
    effects: {
      createsLocalCommit: true,
      pushes: false,
      retriesInitialization: true,
      updatesCoordinatorGitlink: true,
    },
    fingerprint: planFingerprint,
    id: planFingerprint.slice(0, 16),
  };
  privatePlanState.set(plan, {
    canonicalPlan: immutableClone(plan),
    planIntegrity: fingerprint(plan),
    repository: canonicalRepository,
  });
  return plan;
}

function restoreBaseline(
  plan: NestedSubmoduleRepairPlan,
  parentCommitCreated: boolean,
  rootGitlinkUpdated: boolean,
): string[] {
  const failures: string[] = [];
  const attempt = (cwd: string, argumentsList: string[]): void => {
    const result = git(cwd, argumentsList, true);
    if (result.status !== 0) {
      failures.push(result.stderr || result.stdout || `git ${argumentsList[0]} exited ${result.status}`);
    }
  };
  if (rootGitlinkUpdated) {
    attempt(plan.root, [
      "update-index",
      "--cacheinfo",
      "160000",
      plan.baseline.rootGitlinkRevision,
      plan.repositoryPath,
    ]);
  }
  if (parentCommitCreated) {
    attempt(plan.parentDirectory, [
      "reset",
      "--soft",
      plan.baseline.parentRevision,
    ]);
  }
  attempt(plan.parentDirectory, [
    "update-index",
    "--cacheinfo",
    "160000",
    plan.baseline.pinnedRevision,
    plan.nestedPath,
  ]);
  attempt(plan.parentDirectory, [
    "submodule",
    "deinit",
    "-f",
    "--",
    plan.nestedPath,
  ]);
  try {
    const parentRevision = git(
      plan.parentDirectory,
      ["rev-parse", "HEAD"],
      true,
    ).stdout;
    if (parentRevision !== plan.baseline.parentRevision) {
      failures.push(
        `parent HEAD remained at ${parentRevision || "an unreadable revision"}`,
      );
    }
    if (
      gitlinkRevision(plan.parentDirectory, plan.nestedPath) !==
      plan.baseline.pinnedRevision
    ) {
      failures.push("parent nested gitlink did not return to its baseline");
    }
    if (
      gitlinkRevision(plan.root, plan.repositoryPath) !==
      plan.baseline.rootGitlinkRevision
    ) {
      failures.push("coordinator gitlink did not return to its baseline");
    }
    const status = git(
      plan.parentDirectory,
      ["status", "--porcelain=v1", "--untracked-files=all"],
      true,
    );
    if (status.status !== 0 || status.stdout) {
      failures.push("parent repository was not clean after rollback");
    }
  } catch (error) {
    failures.push(`could not verify rollback: ${errorMessage(error)}`);
  }
  return failures;
}

function validateCommitMessage(value: string): string {
  const message = value.trim();
  if (!message || /[\r\n]/.test(message)) {
    throw new CoordinatorError(
      "Nested repair commit message must be a non-empty single line.",
      "NESTED_SUBMODULE_REPAIR_INVALID",
    );
  }
  return message;
}

export function redactNestedSubmoduleDiagnostic(value: string): string {
  const urlsRedacted = value.replace(
    /[a-z][a-z\d+.-]*:\/\/[^\s'"<>]+/gi,
    (url) => redactRepositoryUrl(url),
  );
  return urlsRedacted.replace(
    /(^|[\s'"(<])([^\s'"<>@]+)@((?:\[[^\]\s]+\]|[a-z\d._-]+)):(?!\/\/)([^\s'"<>]+)/gi,
    (_match, prefix: string, _credentials: string, host: string, repositoryPath: string) =>
      `${prefix}git@${host}:${repositoryPath}`,
  );
}

export function applyNestedSubmoduleRepair(
  plan: NestedSubmoduleRepairPlan,
  options: {
    approveLocalCommit: true;
    candidateRevision: string;
    commitMessage?: string | undefined;
  },
): NestedSubmoduleRepairResult {
  if (options.approveLocalCommit !== true) {
    throw new CoordinatorError(
      "Nested repair requires explicit approval to create a local parent commit.",
      "NESTED_SUBMODULE_REPAIR_APPROVAL_REQUIRED",
    );
  }
  const privateState = privatePlanState.get(plan);
  if (!privateState) {
    throw new CoordinatorError(
      "Nested repair accepts only an in-process verified plan.",
      "NESTED_SUBMODULE_REPAIR_PLAN_INVALID",
    );
  }
  try {
    if (fingerprint(plan) !== privateState.planIntegrity) {
      throw new Error("plan changed");
    }
  } catch {
    throw new CoordinatorError(
      "Nested repair plan changed after verification; inspect the repository again before applying it.",
      "NESTED_SUBMODULE_REPAIR_PLAN_INVALID",
    );
  }
  const executionPlan = privateState.canonicalPlan;
  const refreshed = planNestedSubmoduleRepair(
    executionPlan.root,
    privateState.repository,
    executionPlan.nestedPath,
  );
  if (refreshed.fingerprint !== executionPlan.fingerprint) {
    throw new CoordinatorError(
      "Nested repair plan is stale; inspect the repository again before applying it.",
      "NESTED_SUBMODULE_REPAIR_PLAN_STALE",
    );
  }
  const candidate = refreshed.candidates.find(
    ({ revision }) => revision === options.candidateRevision,
  );
  if (!candidate) {
    throw new CoordinatorError(
      `Revision '${options.candidateRevision}' is not a verified repair candidate.`,
      "NESTED_SUBMODULE_REPAIR_CANDIDATE_INVALID",
    );
  }
  const commitMessage = validateCommitMessage(
    options.commitMessage ??
      `fix: repair unavailable ${path.basename(executionPlan.nestedPath)} gitlink`,
  );
  let parentCommitCreated = false;
  let rootGitlinkUpdated = false;
  try {
    git(executionPlan.parentDirectory, [
      "update-index",
      "--cacheinfo",
      "160000",
      candidate.revision,
      executionPlan.nestedPath,
    ]);
    git(executionPlan.parentDirectory, [
      "submodule",
      "update",
      "--init",
      "--recursive",
      "--checkout",
      "--",
      executionPlan.nestedPath,
    ]);
    const nestedDirectory = path.resolve(
      executionPlan.parentDirectory,
      executionPlan.nestedPath,
    );
    const nestedHead = git(nestedDirectory, ["rev-parse", "HEAD"], true);
    if (nestedHead.status !== 0 || nestedHead.stdout !== candidate.revision) {
      throw new CoordinatorError(
        `Repaired nested checkout did not reach ${candidate.revision}.`,
        "NESTED_SUBMODULE_REPAIR_CHECKOUT_FAILED",
      );
    }
    git(executionPlan.parentDirectory, [
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "commit.gpgSign=false",
      "commit",
      "--quiet",
      "-m",
      commitMessage,
      "--",
      executionPlan.nestedPath,
    ]);
    parentCommitCreated = true;
    const parentCommit = git(executionPlan.parentDirectory, ["rev-parse", "HEAD"]).stdout;
    git(executionPlan.root, [
      "update-index",
      "--cacheinfo",
      "160000",
      parentCommit,
      executionPlan.repositoryPath,
    ]);
    rootGitlinkUpdated = true;
    if (
      gitlinkRevision(executionPlan.root, executionPlan.repositoryPath) !==
      parentCommit
    ) {
      throw new CoordinatorError(
        "Coordinator gitlink did not update to the local repair commit.",
        "NESTED_SUBMODULE_REPAIR_ROOT_UPDATE_FAILED",
      );
    }
    if (
      git(
        executionPlan.parentDirectory,
        ["status", "--porcelain=v1"],
        true,
      ).stdout
    ) {
      throw new CoordinatorError(
        "Parent repository is not clean after the local repair commit.",
        "NESTED_SUBMODULE_REPAIR_PARENT_DIRTY",
      );
    }
    return {
      candidateRevision: candidate.revision,
      nestedPath: executionPlan.nestedPath,
      parentCommit,
      previousParentCommit: executionPlan.baseline.parentRevision,
      previousPinnedRevision: executionPlan.baseline.pinnedRevision,
      pushed: false,
      repositoryId: executionPlan.repositoryId,
      rootGitlinkUpdated: true,
    };
  } catch (error) {
    const rollbackFailures = restoreBaseline(
      executionPlan,
      parentCommitCreated,
      rootGitlinkUpdated,
    );
    const safeError = redactNestedSubmoduleDiagnostic(errorMessage(error));
    if (rollbackFailures.length) {
      const safeRollbackFailures = rollbackFailures.map((failure) =>
        redactNestedSubmoduleDiagnostic(failure),
      );
      throw new CoordinatorError(
        `Nested repair failed: ${safeError}. Rollback also failed: ${safeRollbackFailures.join("; ")}. Inspect '${executionPlan.parentDirectory}' before retrying.`,
        "NESTED_SUBMODULE_REPAIR_ROLLBACK_FAILED",
      );
    }
    throw new CoordinatorError(
      `Nested repair failed and its local changes were rolled back: ${safeError}`,
      "NESTED_SUBMODULE_REPAIR_FAILED",
    );
  }
}

export class NestedSubmoduleRepairRequiredError extends CoordinatorError {
  readonly plan: NestedSubmoduleRepairPlan;

  constructor(plan: NestedSubmoduleRepairPlan, gitDetail: string) {
    const safeDetail = redactNestedSubmoduleDiagnostic(gitDetail);
    super(
      `Could not initialize nested submodule '${plan.nestedPath}' for repository '${plan.repositoryId}': ${safeDetail}. The incomplete nested checkout was deinitialized; coordinator.yaml and top-level checkouts were preserved. A verified local repair is available, but it requires explicit approval because it creates one commit in '${plan.repositoryId}'. The repair itself will not push; a later coordinated push may publish the commit. Rerun 'coordinator init --resume' in an interactive terminal to review it.`,
      "NESTED_SUBMODULE_REPAIR_REQUIRED",
    );
    this.plan = plan;
  }
}
