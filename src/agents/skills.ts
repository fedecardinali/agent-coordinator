import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
} from "node:fs";
import path from "node:path";
import { runCommand } from "../core/command.js";
import { CoordinatorError } from "../core/errors.js";
import {
  applyFilePlans,
  planFile,
  safeGeneratedPath,
  type FilePlan,
} from "../core/files.js";
import { sha256 } from "../core/hash.js";
import type { CoordinatorManifest, Repository } from "../core/schema.js";

const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

interface SkillCandidate {
  repository: Repository;
  source: string;
  sourceCommit: string;
  sourceDirectory: string;
  sourceGitRoot: string;
  sourcePrefix: string;
  sourceWorkspacePath: string;
  targetName: string;
  treeOid: string;
}

export interface DiscoveredSkillSource {
  source: string;
  kind: "flow" | "skill";
}

export interface MaterializedSkill {
  linkTarget: string;
  materialization: "relative-symlink";
  name: string;
  repository: string;
  source: string;
  sourceCommit: string;
  treeOid: string;
}

export interface AgentSkillLock {
  generatedBy: "agent-coordinator";
  generatorVersion: string;
  schemaVersion: 2;
  skills: MaterializedSkill[];
}

interface LegacyMaterializedSkill {
  digest: string;
  name: string;
  repository: string;
  source: string;
  sourceCommit: string;
  treeOid: string;
}

interface LegacyAgentSkillLock {
  generatedBy: "agent-coordinator";
  generatorVersion: string;
  schemaVersion: 1;
  skills: LegacyMaterializedSkill[];
}

type ParsedAgentSkillLock = AgentSkillLock | LegacyAgentSkillLock;

export type SkillLinkActionKind =
  | "adopt-link"
  | "create-link"
  | "delete-managed"
  | "migrate-copy"
  | "replace-link";

export interface SkillLinkAction {
  action: SkillLinkActionKind;
  linkTarget: string | null;
  name: string;
}

export interface SkillSyncResult {
  actions: SkillLinkAction[];
  changed: boolean;
  migrations: string[];
  names: string[];
  skills: MaterializedSkill[];
}

function gitText(directory: string, argumentsList: string[]): string {
  return runCommand("git", ["-C", directory, ...argumentsList]).stdout;
}

interface GitTreeEntry {
  mode: string;
  oid: string;
  type: string;
}

interface SkillResolutionContext {
  root: string;
  rootRealPath: string;
  validatedCheckouts: Map<string, string>;
}

function isWithin(base: string, candidate: string): boolean {
  const relative = path.relative(base, candidate);
  return (
    relative === "" ||
    (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
  );
}

function safeExistingPath(
  base: string,
  relativePath: string,
  label: string,
): string {
  const absoluteBase = path.resolve(base);
  const absoluteTarget = path.resolve(base, relativePath || ".");
  if (!isWithin(absoluteBase, absoluteTarget)) {
    throw new CoordinatorError(
      `${label} escapes its declared repository: ${relativePath}.`,
      "SKILL_SOURCE_ESCAPE",
    );
  }

  const normalizedRelative = path.relative(absoluteBase, absoluteTarget);
  let cursor = absoluteBase;
  for (const segment of normalizedRelative.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment);
    if (!existsSync(cursor)) {
      throw new CoordinatorError(
        `${label} is not initialized at ${cursor}. Initialize nested submodules first.`,
        "SKILL_SOURCE_MISSING",
      );
    }
    if (lstatSync(cursor).isSymbolicLink()) {
      throw new CoordinatorError(
        `${label} crosses unsupported symbolic link '${path.relative(absoluteBase, cursor)}'.`,
        "SKILL_SOURCE_SYMLINK",
      );
    }
  }

  let baseRealPath: string;
  let targetRealPath: string;
  try {
    baseRealPath = realpathSync(absoluteBase);
    targetRealPath = realpathSync(absoluteTarget);
  } catch {
    throw new CoordinatorError(
      `${label} is not initialized at ${absoluteTarget}. Initialize nested submodules first.`,
      "SKILL_SOURCE_MISSING",
    );
  }
  if (!isWithin(baseRealPath, targetRealPath)) {
    throw new CoordinatorError(
      `${label} resolves outside its declared repository: ${targetRealPath}.`,
      "SKILL_SOURCE_ESCAPE",
    );
  }
  return targetRealPath;
}

function gitPath(value: string): string {
  return value.split(path.sep).join("/");
}

function treeEntry(
  repositoryDirectory: string,
  commit: string,
  relativePath: string,
): GitTreeEntry | null {
  const result = runCommand(
    "git",
    [
      "-C",
      repositoryDirectory,
      "ls-tree",
      commit,
      "--",
      `:(literal)${relativePath}`,
    ],
    { allowFailure: true },
  );
  if (result.status !== 0) {
    throw new CoordinatorError(
      `Could not read pinned Git tree ${commit} in ${repositoryDirectory}: ${result.stderr || result.stdout || `exit ${result.status}`}.`,
      "SKILL_PINNED_TREE_UNAVAILABLE",
    );
  }
  if (!result.stdout) return null;
  const lines = result.stdout.split("\n").filter(Boolean);
  if (lines.length !== 1) return null;
  const match = /^(\d{6})\s+(\w+)\s+([0-9a-f]{40,64})\t/.exec(lines[0]!);
  return match
    ? { mode: match[1]!, type: match[2]!, oid: match[3]! }
    : null;
}

function assertLinkableSkillTree(
  repositoryDirectory: string,
  commit: string,
  relativePath: string,
  label: string,
): void {
  const argumentsList = ["-C", repositoryDirectory, "ls-tree", "-r", "-z", commit];
  if (relativePath) argumentsList.push("--", `:(literal)${relativePath}`);
  const result = runCommand("git", argumentsList, { allowFailure: true });
  if (result.status !== 0) {
    throw new CoordinatorError(
      `Could not inspect the pinned tree for ${label}: ${result.stderr || result.stdout || `exit ${result.status}`}.`,
      "SKILL_PINNED_TREE_UNAVAILABLE",
    );
  }
  for (const entry of result.stdout.split("\0").filter(Boolean)) {
    const match = /^(\d{6})\s+(\w+)\s+[0-9a-f]{40,64}\t([\s\S]+)$/.exec(entry);
    if (!match) continue;
    if (match[1] === "120000" || match[1] === "160000") {
      throw new CoordinatorError(
        `${label} contains unsupported ${match[1] === "120000" ? "symbolic link" : "nested gitlink"} '${match[3]}'. Source-direct skills must be ordinary committed files and directories.`,
        "SKILL_SOURCE_LINK_UNSUPPORTED",
      );
    }
  }
}

function indexedGitlink(root: string, repository: Repository): string {
  const result = runCommand(
    "git",
    ["-C", root, "ls-files", "--stage", "--", repository.path],
    { allowFailure: true },
  );
  const entries = result.stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => /^(\d{6}) ([0-9a-f]{40,64}) ([0-3])\t/.exec(line))
    .filter((entry): entry is RegExpExecArray => entry !== null);
  if (
    result.status !== 0 ||
    entries.length !== 1 ||
    entries[0]![1] !== "160000" ||
    entries[0]![3] !== "0"
  ) {
    throw new CoordinatorError(
      `Repository '${repository.id}' is not pinned by one stage-0 gitlink at '${repository.path}'. Add or resolve the submodule gitlink before synchronizing skills.`,
      "SKILL_GITLINK_MISSING",
    );
  }
  return entries[0]![2]!;
}

function assertPinnedCheckout(
  context: SkillResolutionContext,
  directory: string,
  expectedCommit: string,
  label: string,
): void {
  const realDirectory = realpathSync(directory);
  const previousExpectation = context.validatedCheckouts.get(realDirectory);
  if (previousExpectation) {
    if (previousExpectation !== expectedCommit) {
      throw new CoordinatorError(
        `${label} is referenced by conflicting gitlinks ${previousExpectation} and ${expectedCommit}.`,
        "SKILL_GITLINK_MISMATCH",
      );
    }
    return;
  }

  const topLevel = runCommand(
    "git",
    ["-C", directory, "rev-parse", "--show-toplevel"],
    { allowFailure: true },
  );
  let topLevelRealPath: string | null = null;
  if (topLevel.status === 0 && topLevel.stdout) {
    try {
      topLevelRealPath = realpathSync(topLevel.stdout);
    } catch {
      topLevelRealPath = null;
    }
  }
  if (topLevelRealPath !== realDirectory) {
    throw new CoordinatorError(
      `${label} is not an initialized Git submodule at ${directory}. Run git submodule update --init --recursive.`,
      "SKILL_SUBMODULE_UNINITIALIZED",
    );
  }

  const head = runCommand(
    "git",
    ["-C", directory, "rev-parse", "--verify", "HEAD^{commit}"],
    { allowFailure: true },
  );
  if (head.status !== 0 || head.stdout !== expectedCommit) {
    throw new CoordinatorError(
      `${label} checkout is at ${head.stdout || "an unreadable HEAD"}, but its parent gitlink pins ${expectedCommit}. Attach or restore the pinned commit before synchronizing skills.`,
      "SKILL_GITLINK_MISMATCH",
    );
  }

  const status = runCommand(
    "git",
    [
      "-C",
      directory,
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
      "--ignore-submodules=all",
    ],
    { allowFailure: true },
  );
  if (status.status !== 0) {
    throw new CoordinatorError(
      `Could not inspect ${label}: ${status.stderr || status.stdout || `exit ${status.status}`}.`,
      "SKILL_SOURCE_STATUS_FAILED",
    );
  }
  if (status.stdout) {
    const detail = status.stdout.split("\n").slice(0, 3).join(", ");
    throw new CoordinatorError(
      `${label} has uncommitted or untracked changes (${detail}). Commit or remove them before synchronizing skills.`,
      "SKILL_SOURCE_DIRTY",
    );
  }
  context.validatedCheckouts.set(realDirectory, expectedCommit);
}

function resolutionContext(root: string): SkillResolutionContext {
  const resolvedRoot = path.resolve(root);
  let rootRealPath: string;
  try {
    rootRealPath = realpathSync(resolvedRoot);
  } catch {
    throw new CoordinatorError(
      `Coordinator root does not exist: ${resolvedRoot}.`,
      "SKILL_COORDINATOR_ROOT_MISSING",
    );
  }
  const topLevel = runCommand(
    "git",
    ["-C", resolvedRoot, "rev-parse", "--show-toplevel"],
    { allowFailure: true },
  );
  let topLevelRealPath: string | null = null;
  if (topLevel.status === 0 && topLevel.stdout) {
    try {
      topLevelRealPath = realpathSync(topLevel.stdout);
    } catch {
      topLevelRealPath = null;
    }
  }
  if (topLevelRealPath !== rootRealPath) {
    throw new CoordinatorError(
      `Coordinator root is not the Git worktree root: ${resolvedRoot}.`,
      "SKILL_COORDINATOR_ROOT_INVALID",
    );
  }
  return {
    root: resolvedRoot,
    rootRealPath,
    validatedCheckouts: new Map(),
  };
}

function sourceInformation(
  context: SkillResolutionContext,
  repository: Repository,
  source: string,
  explicitName: string | undefined,
  _kind: "flow" | "skill" | undefined,
): SkillCandidate {
  const label = `Skill source '${repository.id}:${source}'`;
  const repositoryDirectory = safeExistingPath(
    context.root,
    repository.path,
    `Repository '${repository.id}'`,
  );
  if (!isWithin(context.rootRealPath, repositoryDirectory)) {
    throw new CoordinatorError(
      `Repository '${repository.id}' resolves outside the coordinator root: ${repositoryDirectory}.`,
      "SKILL_SOURCE_ESCAPE",
    );
  }

  let sourceGitRoot = repositoryDirectory;
  let sourceCommit = indexedGitlink(context.root, repository);
  assertPinnedCheckout(
    context,
    sourceGitRoot,
    sourceCommit,
    `Repository '${repository.id}'`,
  );

  let sourcePrefix = gitPath(source);
  while (sourcePrefix) {
    const components = sourcePrefix.split("/").filter(Boolean);
    let nested:
      | { commit: string; path: string; remaining: string }
      | undefined;
    for (let index = 0; index < components.length; index += 1) {
      const prefix = components.slice(0, index + 1).join("/");
      const entry = treeEntry(sourceGitRoot, sourceCommit, prefix);
      if (!entry) {
        throw new CoordinatorError(
          `${label} is absent from pinned commit ${sourceCommit}.`,
          "SKILL_SOURCE_MISSING",
        );
      }
      if (entry.mode === "120000") {
        throw new CoordinatorError(
          `${label} crosses symbolic link '${prefix}' in pinned commit ${sourceCommit}.`,
          "SKILL_SOURCE_SYMLINK",
        );
      }
      if (entry.mode === "160000") {
        nested = {
          commit: entry.oid,
          path: prefix,
          remaining: components.slice(index + 1).join("/"),
        };
        break;
      }
      if (index < components.length - 1 && entry.mode !== "040000") {
        throw new CoordinatorError(
          `${label} crosses non-directory '${prefix}' in pinned commit ${sourceCommit}.`,
          "SKILL_SOURCE_MISSING",
        );
      }
    }
    if (!nested) break;

    const nestedDirectory = safeExistingPath(sourceGitRoot, nested.path, label);
    assertPinnedCheckout(
      context,
      nestedDirectory,
      nested.commit,
      `${label} nested submodule '${nested.path}'`,
    );
    sourceGitRoot = nestedDirectory;
    sourceCommit = nested.commit;
    sourcePrefix = nested.remaining;
  }

  const sourceDirectory = safeExistingPath(
    sourceGitRoot,
    sourcePrefix || ".",
    label,
  );
  const sourceTree: GitTreeEntry | null = sourcePrefix
    ? treeEntry(sourceGitRoot, sourceCommit, sourcePrefix)
    : {
        mode: "040000",
        type: "tree",
        oid: gitText(sourceGitRoot, ["rev-parse", `${sourceCommit}^{tree}`]),
      };
  if (!sourceTree || sourceTree.mode !== "040000" || sourceTree.type !== "tree") {
    throw new CoordinatorError(
      `${label} is not a directory in pinned commit ${sourceCommit}.`,
      "SKILL_SOURCE_MISSING",
    );
  }
  assertLinkableSkillTree(
    sourceGitRoot,
    sourceCommit,
    sourcePrefix,
    label,
  );
  safeExistingPath(sourceDirectory, "SKILL.md", label);
  const skillPath = sourcePrefix ? `${sourcePrefix}/SKILL.md` : "SKILL.md";
  const skillEntry = treeEntry(sourceGitRoot, sourceCommit, skillPath);
  if (!skillEntry) {
    throw new CoordinatorError(
      `${label} has no SKILL.md in pinned commit ${sourceCommit}.`,
      "SKILL_SOURCE_MISSING",
    );
  }
  if (skillEntry.mode === "120000") {
    throw new CoordinatorError(
      `${label}/SKILL.md is an unsupported symbolic link in pinned commit ${sourceCommit}.`,
      "SKILL_SOURCE_SYMLINK",
    );
  }
  if (skillEntry.type !== "blob") {
    throw new CoordinatorError(
      `${label}/SKILL.md is not a regular file in pinned commit ${sourceCommit}.`,
      "SKILL_SOURCE_MISSING",
    );
  }
  const committedSkill = gitText(sourceGitRoot, ["show", `${sourceCommit}:${skillPath}`]);
  const declared = /^---\s*\n[\s\S]*?^name:\s*["']?([^\n"']+)["']?\s*$[\s\S]*?^---\s*$/m.exec(
    committedSkill,
  )?.[1]?.trim();
  if (!declared) {
    throw new CoordinatorError(
      `Skill '${repository.id}:${source}' must declare a canonical name in SKILL.md frontmatter before it can be linked.`,
      "INVALID_SKILL",
    );
  }
  if (explicitName !== undefined && explicitName !== declared) {
    throw new CoordinatorError(
      `Skill '${repository.id}:${source}' requests alias '${explicitName}', but its canonical SKILL.md name is '${declared}'. Source-direct skill links cannot rewrite frontmatter; rename the source skill or remove the alias.`,
      "SKILL_LINK_ALIAS_UNSUPPORTED",
    );
  }
  const targetName = declared;
  if (!SKILL_NAME.test(targetName)) {
    throw new CoordinatorError(
      `Skill '${repository.id}:${source}' resolves to invalid portable name '${targetName}'.`,
      "INVALID_SKILL_NAME",
    );
  }
  const sourceWorkspacePath = gitPath(
    path.relative(context.rootRealPath, sourceDirectory),
  );
  if (
    !sourceWorkspacePath ||
    sourceWorkspacePath === ".." ||
    sourceWorkspacePath.startsWith("../")
  ) {
    throw new CoordinatorError(
      `Skill '${repository.id}:${source}' does not resolve to a linkable directory inside the coordinator workspace.`,
      "SKILL_SOURCE_ESCAPE",
    );
  }
  return {
    repository,
    source,
    sourceCommit,
    sourceDirectory,
    sourceGitRoot,
    sourcePrefix,
    sourceWorkspacePath,
    targetName,
    treeOid: sourceTree.oid,
  };
}

function resolveCandidates(
  root: string,
  manifest: CoordinatorManifest,
): SkillCandidate[] {
  if (!manifest.repositories.some((repository) => repository.agent.skills.length > 0)) {
    return [];
  }
  const context = resolutionContext(root);
  const candidates = manifest.repositories.flatMap((repository) =>
    repository.agent.skills.map((skill) =>
      sourceInformation(
        context,
        repository,
        skill.source,
        skill.name,
        skill.kind,
      ),
    ),
  );
  const grouped = new Map<string, SkillCandidate[]>();
  for (const candidate of candidates) {
    const collisions = grouped.get(candidate.targetName) ?? [];
    collisions.push(candidate);
    grouped.set(candidate.targetName, collisions);
  }
  const resolved: SkillCandidate[] = [];
  for (const [name, collisions] of grouped) {
    if (collisions.length === 1) {
      resolved.push(collisions[0]!);
      continue;
    }
    throw new CoordinatorError(
      `Skill name '${name}' has divergent sources: ${collisions
        .map((candidate) => `${candidate.repository.id}:${candidate.source}`)
        .join(", ")}. Source-direct skill links require one globally unique canonical SKILL.md name; automatic namespace rewriting is unavailable.`,
      "SKILL_COLLISION",
    );
  }
  const finalNames = new Set<string>();
  for (const candidate of resolved) {
    if (finalNames.has(candidate.targetName)) {
      throw new CoordinatorError(
        `Skill namespace still collides at '${candidate.targetName}'. Configure an explicit name.`,
        "SKILL_COLLISION",
      );
    }
    finalNames.add(candidate.targetName);
  }
  return resolved.sort((left, right) => left.targetName.localeCompare(right.targetName));
}

function directoryDigest(directory: string): string {
  const pieces: Buffer[] = [];
  const walk = (current: string, prefix: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const absolute = path.join(current, entry.name);
      const relative = path.posix.join(prefix, entry.name);
      if (entry.isSymbolicLink()) {
        throw new CoordinatorError(
          `Generated skill contains unsupported symlink '${relative}'.`,
          "SKILL_SYMLINK",
        );
      }
      if (entry.isDirectory()) {
        walk(absolute, relative);
      } else if (entry.isFile()) {
        pieces.push(Buffer.from(`${relative}\0`));
        pieces.push(readFileSync(absolute));
        pieces.push(Buffer.from("\0"));
      } else {
        throw new CoordinatorError(
          `Generated skill contains unsupported filesystem entry '${relative}'.`,
          "SKILL_UNSUPPORTED_ENTRY",
        );
      }
    }
  };
  walk(directory, "");
  return sha256(Buffer.concat(pieces));
}

function validOid(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{40,64}$/.test(value);
}

function validLockSkillBase(value: unknown): value is {
  name: string;
  repository: string;
  source: string;
  sourceCommit: string;
  treeOid: string;
} {
  if (typeof value !== "object" || value === null) return false;
  const skill = value as Record<string, unknown>;
  return (
    typeof skill.name === "string" &&
    SKILL_NAME.test(skill.name) &&
    typeof skill.repository === "string" &&
    SKILL_NAME.test(skill.repository) &&
    typeof skill.source === "string" &&
    Boolean(skill.source) &&
    !/[\0\r\n]/.test(skill.source) &&
    validOid(skill.sourceCommit) &&
    validOid(skill.treeOid)
  );
}

function validRelativeLink(value: unknown): value is string {
  return (
    typeof value === "string" &&
    Boolean(value) &&
    !path.posix.isAbsolute(value) &&
    !path.win32.isAbsolute(value) &&
    !/[\0\r\n]/.test(value)
  );
}

function parseLock(content: string): ParsedAgentSkillLock | null {
  try {
    const value = JSON.parse(content) as Record<string, unknown>;
    if (
      value.generatedBy !== "agent-coordinator" ||
      typeof value.generatorVersion !== "string" ||
      !Array.isArray(value.skills)
    ) {
      return null;
    }
    const names = value.skills
      .map((skill) =>
        typeof skill === "object" && skill !== null
          ? (skill as Record<string, unknown>).name
          : null,
      )
      .filter((name): name is string => typeof name === "string");
    if (new Set(names).size !== value.skills.length) return null;
    if (value.schemaVersion === 1) {
      if (
        !value.skills.every(
          (skill) =>
            validLockSkillBase(skill) &&
            typeof (skill as Record<string, unknown>).digest === "string" &&
            /^[0-9a-f]{64}$/.test(
              (skill as Record<string, unknown>).digest as string,
            ),
        )
      ) {
        return null;
      }
      return value as unknown as LegacyAgentSkillLock;
    }
    if (value.schemaVersion === 2) {
      if (
        !value.skills.every(
          (skill) =>
            validLockSkillBase(skill) &&
            (skill as Record<string, unknown>).materialization ===
              "relative-symlink" &&
            validRelativeLink(
              (skill as Record<string, unknown>).linkTarget,
            ),
        )
      ) {
        return null;
      }
      return value as unknown as AgentSkillLock;
    }
    return null;
  } catch {
    return null;
  }
}

function readLock(lockPath: string): ParsedAgentSkillLock | null {
  if (!existsSync(lockPath)) return null;
  return parseLock(readFileSync(lockPath, "utf8"));
}

function lstatIfPresent(value: string): ReturnType<typeof lstatSync> | null {
  try {
    return lstatSync(value);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function validateTarget(root: string, name: string): string {
  if (!SKILL_NAME.test(name)) {
    throw new CoordinatorError(`Unsafe generated skill name '${name}'.`);
  }
  const skillsRoot = safeGeneratedPath(root, path.join(".agents", "skills"));
  return path.join(skillsRoot, name);
}

interface PublishedSkillChange {
  backup: string | null;
  name: string;
  published: boolean;
  publishedSnapshot: SkillDestinationSnapshot | null;
  target: string;
}

interface DirectoryIdentity {
  dev: number;
  ino: number;
}

function assertDirectoryIdentity(
  directory: string,
  expected: DirectoryIdentity,
): void {
  const status = lstatSync(directory);
  if (
    !status.isDirectory() ||
    status.isSymbolicLink() ||
    status.dev !== expected.dev ||
    status.ino !== expected.ino
  ) {
    throw new CoordinatorError(
      `Skill registry changed while it was being synchronized: ${directory}.`,
      "SKILL_DESTINATION_CHANGED",
    );
  }
}

function rollbackSkillChanges(
  root: string,
  skillsRoot: string,
  identity: DirectoryIdentity,
  discardedRoot: string,
  changes: PublishedSkillChange[],
): string[] {
  const failures: string[] = [];
  for (const change of [...changes].reverse()) {
    try {
      assertDirectoryIdentity(skillsRoot, identity);
      const target = validateTarget(root, change.name);
      const current = destinationSnapshot(target);
      if (change.published) {
        if (
          !change.publishedSnapshot ||
          !snapshotsMatch(current, change.publishedSnapshot)
        ) {
          throw new CoordinatorError(
            `Published skill link '${change.name}' changed before rollback; its current destination was preserved.`,
            "SKILL_ROLLBACK_DESTINATION_CHANGED",
          );
        }
        const discarded = path.join(discardedRoot, change.name);
        renameSync(target, discarded);
        if (
          !snapshotsMatch(
            destinationSnapshot(discarded),
            change.publishedSnapshot,
          )
        ) {
          if (destinationSnapshot(target).kind === "missing") {
            renameSync(discarded, target);
          }
          throw new CoordinatorError(
            `Published skill link '${change.name}' changed while rollback captured it; recovery data was preserved.`,
            "SKILL_ROLLBACK_DESTINATION_CHANGED",
          );
        }
      } else if (current.kind !== "missing") {
        throw new CoordinatorError(
          `Skill destination '${change.name}' was occupied before rollback; both it and the backup were preserved.`,
          "SKILL_ROLLBACK_DESTINATION_CHANGED",
        );
      }
      if (change.backup && lstatIfPresent(change.backup)) {
        if (destinationSnapshot(target).kind !== "missing") {
          throw new CoordinatorError(
            `Skill destination '${change.name}' is occupied; its backup was preserved.`,
            "SKILL_ROLLBACK_DESTINATION_CHANGED",
          );
        }
        renameSync(change.backup, target);
      }
    } catch (error) {
      failures.push(
        `${change.name}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return failures;
}

type SkillDestinationSnapshot =
  | { kind: "directory"; dev: number; digest: string | null; ino: number }
  | { kind: "missing" }
  | { dev: number; ino: number; kind: "other" }
  | { dev: number; ino: number; kind: "symlink"; linkTarget: string };

interface ResolvedSkillLink {
  candidate: SkillCandidate;
  skill: MaterializedSkill;
}

interface PlannedSkillMutation {
  action: SkillLinkAction;
  desired: MaterializedSkill | null;
  expected: SkillDestinationSnapshot;
  target: string;
}

function destinationSnapshot(target: string): SkillDestinationSnapshot {
  const status = lstatIfPresent(target);
  if (!status) return { kind: "missing" };
  if (status.isSymbolicLink()) {
    return {
      dev: Number(status.dev),
      ino: Number(status.ino),
      kind: "symlink",
      linkTarget: readlinkSync(target),
    };
  }
  if (status.isDirectory()) {
    let digest: string | null = null;
    try {
      digest = directoryDigest(target);
    } catch {
      // A legacy copy containing links or unreadable entries is not intact.
    }
    return {
      dev: Number(status.dev),
      digest,
      ino: Number(status.ino),
      kind: "directory",
    };
  }
  return {
    dev: Number(status.dev),
    ino: Number(status.ino),
    kind: "other",
  };
}

function snapshotsMatch(
  left: SkillDestinationSnapshot,
  right: SkillDestinationSnapshot,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function linkedSkill(
  resolvedRoot: string,
  candidate: SkillCandidate,
): MaterializedSkill {
  const linkTarget = path.posix.relative(
    ".agents/skills",
    candidate.sourceWorkspacePath,
  );
  if (!validRelativeLink(linkTarget) || linkTarget === ".") {
    throw new CoordinatorError(
      `Skill '${candidate.repository.id}:${candidate.source}' produced an unsafe registry link target.`,
      "SKILL_LINK_TARGET_UNSAFE",
    );
  }
  const target = validateTarget(resolvedRoot, candidate.targetName);
  const resolvedTarget = path.resolve(
    path.dirname(target),
    linkTarget.split("/").join(path.sep),
  );
  let canonicalTarget: string;
  try {
    canonicalTarget = realpathSync(resolvedTarget);
  } catch {
    throw new CoordinatorError(
      `Skill '${candidate.repository.id}:${candidate.source}' does not resolve to an initialized source directory.`,
      "SKILL_SOURCE_MISSING",
    );
  }
  if (canonicalTarget !== candidate.sourceDirectory) {
    throw new CoordinatorError(
      `Skill '${candidate.repository.id}:${candidate.source}' registry link does not resolve to its validated source.`,
      "SKILL_LINK_TARGET_UNSAFE",
    );
  }
  return {
    linkTarget,
    materialization: "relative-symlink",
    name: candidate.targetName,
    repository: candidate.repository.id,
    source: candidate.source,
    sourceCommit: candidate.sourceCommit,
    treeOid: candidate.treeOid,
  };
}

function resolveSkillLinks(
  resolvedRoot: string,
  manifest: CoordinatorManifest,
): ResolvedSkillLink[] {
  return resolveCandidates(resolvedRoot, manifest).map((candidate) => ({
    candidate,
    skill: linkedSkill(resolvedRoot, candidate),
  }));
}

function sourcePlanSignature(links: ResolvedSkillLink[]): string {
  return JSON.stringify(
    links.map(({ candidate, skill }) => ({
      skill,
      sourceDirectory: candidate.sourceDirectory,
    })),
  );
}

function managedDestinationChanged(name: string): CoordinatorError {
  return new CoordinatorError(
    `Managed skill destination '.agents/skills/${name}' no longer matches its lockfile state. Preserve it or preview adoption with 'coordinator agents check --force' before running 'coordinator agents sync --force'.`,
    "SKILL_MANAGED_DESTINATION_CHANGED",
  );
}

function createDirectoryIfMissing(directory: string, label: string): void {
  try {
    mkdirSync(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const status = lstatSync(directory);
  if (!status.isDirectory() || status.isSymbolicLink()) {
    throw new CoordinatorError(
      `${label} is not a safe directory: ${directory}.`,
      "SKILL_DESTINATION_INVALID",
    );
  }
}

function ensureSkillRegistry(root: string): DirectoryIdentity {
  const agentsRoot = safeGeneratedPath(root, ".agents");
  createDirectoryIfMissing(agentsRoot, "Agent registry");
  const agentsStatus = lstatSync(agentsRoot);
  const agentsIdentity = {
    dev: Number(agentsStatus.dev),
    ino: Number(agentsStatus.ino),
  };
  assertDirectoryIdentity(agentsRoot, agentsIdentity);

  const skillsRoot = path.join(agentsRoot, "skills");
  createDirectoryIfMissing(skillsRoot, "Skill registry");
  assertDirectoryIdentity(agentsRoot, agentsIdentity);
  safeGeneratedPath(root, ".agents/skills");
  const skillsStatus = lstatSync(skillsRoot);
  const skillsIdentity = {
    dev: Number(skillsStatus.dev),
    ino: Number(skillsStatus.ino),
  };
  assertDirectoryIdentity(skillsRoot, skillsIdentity);
  return skillsIdentity;
}

function createSkillLink(
  linkTarget: string,
  destination: string,
  name: string,
): void {
  try {
    symlinkSync(linkTarget, destination, "dir");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new CoordinatorError(
        `Skill destination '.agents/skills/${name}' changed during publication.`,
        "SKILL_DESTINATION_CHANGED",
      );
    }
    throw new CoordinatorError(
      `Could not create relative source link for skill '${name}': ${error instanceof Error ? error.message : String(error)}. Ensure this filesystem and account permit symbolic links.`,
      "SKILL_SYMLINK_UNAVAILABLE",
    );
  }
}

export function synchronizeSkills(
  root: string,
  manifest: CoordinatorManifest,
  generatorVersion: string,
  options: {
    check?: boolean | undefined;
    dependentFilePlans?: FilePlan[] | undefined;
    expectedSkills?: MaterializedSkill[] | undefined;
    force?: boolean | undefined;
  } = {},
): SkillSyncResult {
  const resolvedRoot = path.resolve(root);
  const skillsRoot = safeGeneratedPath(resolvedRoot, ".agents/skills");
  const lockPath = safeGeneratedPath(
    resolvedRoot,
    ".coordinator/agents.lock.json",
  );
  const previousLock = readLock(lockPath);
  if (existsSync(lockPath) && !previousLock && !options.force) {
    throw new CoordinatorError(
      "Refusing to overwrite unmanaged file '.coordinator/agents.lock.json'. Move it, adopt it explicitly, or use --force.",
      "UNMANAGED_FILE",
    );
  }
  const legacyByName = new Map<string, LegacyMaterializedSkill>(
    previousLock?.schemaVersion === 1
      ? previousLock.skills.map((skill) => [skill.name, skill])
      : [],
  );
  const linkedByName = new Map<string, MaterializedSkill>(
    previousLock?.schemaVersion === 2
      ? previousLock.skills.map((skill) => [skill.name, skill])
      : [],
  );
  const previouslyManaged = new Set([
    ...legacyByName.keys(),
    ...linkedByName.keys(),
  ]);
  const links = resolveSkillLinks(resolvedRoot, manifest);
  const skills = links.map(({ skill }) => skill);
  if (
    options.expectedSkills &&
    JSON.stringify(skills) !== JSON.stringify(options.expectedSkills)
  ) {
    throw new CoordinatorError(
      "Skill sources changed after dependent agent files were planned. Run synchronization again.",
      "SKILL_PLAN_STALE",
    );
  }
  const skillsRootStatus = lstatIfPresent(skillsRoot);
  if (skillsRootStatus && !skillsRootStatus.isDirectory()) {
    throw new CoordinatorError(
      `Skill registry is not a directory: ${skillsRoot}.`,
      "SKILL_DESTINATION_INVALID",
    );
  }
  const desired = new Set(skills.map((skill) => skill.name));
  const mutations: PlannedSkillMutation[] = [];
  const migrations: string[] = [];
  const force = options.force ?? false;

  for (const skill of skills) {
    const target = validateTarget(resolvedRoot, skill.name);
    const snapshot = destinationSnapshot(target);
    const legacy = legacyByName.get(skill.name);
    const linked = linkedByName.get(skill.name);
    let action: SkillLinkActionKind | null = null;
    if (snapshot.kind === "missing") {
      action = "create-link";
    } else if (legacy) {
      if (
        snapshot.kind === "directory" &&
        snapshot.digest === legacy.digest
      ) {
        action = "migrate-copy";
        migrations.push(
          `${skill.name}: managed copy -> relative source symlink`,
        );
      } else if (
        snapshot.kind === "symlink" &&
        snapshot.linkTarget === skill.linkTarget
      ) {
        action = "adopt-link";
      } else if (!force) {
        throw new CoordinatorError(
          `Managed skill copy '.agents/skills/${skill.name}' was modified or replaced and cannot be migrated safely. Preview forced adoption with 'coordinator agents check --force'.`,
          "SKILL_MANAGED_COPY_MODIFIED",
        );
      } else {
        action = "replace-link";
      }
    } else if (linked) {
      if (
        snapshot.kind === "symlink" &&
        snapshot.linkTarget === skill.linkTarget
      ) {
        action = null;
      } else if (snapshot.kind === "symlink") {
        action = "replace-link";
      } else if (!force) {
        throw managedDestinationChanged(skill.name);
      } else {
        action = "replace-link";
      }
    } else if (!force) {
      throw new CoordinatorError(
        `Refusing to replace unmanaged skill '.agents/skills/${skill.name}'. Preview adoption with 'coordinator agents check --force'.`,
        "UNMANAGED_SKILL",
      );
    } else if (
      snapshot.kind === "symlink" &&
      snapshot.linkTarget === skill.linkTarget
    ) {
      action = "adopt-link";
    } else {
      action = "replace-link";
    }
    if (action) {
      mutations.push({
        action: { action, linkTarget: skill.linkTarget, name: skill.name },
        desired: skill,
        expected: snapshot,
        target,
      });
    }
  }

  for (const oldName of previouslyManaged) {
    if (desired.has(oldName)) continue;
    const target = validateTarget(resolvedRoot, oldName);
    const snapshot = destinationSnapshot(target);
    if (snapshot.kind === "missing") continue;
    const legacy = legacyByName.get(oldName);
    const linked = linkedByName.get(oldName);
    const intact = legacy
      ? snapshot.kind === "directory" && snapshot.digest === legacy.digest
      : linked
        ? snapshot.kind === "symlink" &&
          snapshot.linkTarget === linked.linkTarget
        : false;
    if (!intact && !force) throw managedDestinationChanged(oldName);
    mutations.push({
      action: { action: "delete-managed", linkTarget: null, name: oldName },
      desired: null,
      expected: snapshot,
      target,
    });
  }

  const nextLock: AgentSkillLock = {
    schemaVersion: 2,
    generatedBy: "agent-coordinator",
    generatorVersion,
    skills,
  };
  const renderedLock = `${JSON.stringify(nextLock, null, 2)}\n`;
  const lockPlan = planFile(
    resolvedRoot,
    ".coordinator/agents.lock.json",
    renderedLock,
    {
      force,
      owned: (content) => parseLock(content) !== null,
    },
  );
  const actions = mutations.map(({ action }) => action);
  const changed = actions.length > 0 || lockPlan.action !== "unchanged";
  const result = {
    actions,
    changed,
    migrations,
    names: skills.map((skill) => skill.name),
    skills,
  };
  if (options.check) return result;

  const skillsRootIdentity = ensureSkillRegistry(resolvedRoot);
  const refreshedLinks = resolveSkillLinks(resolvedRoot, manifest);
  if (sourcePlanSignature(refreshedLinks) !== sourcePlanSignature(links)) {
    throw new CoordinatorError(
      "Skill sources changed after planning; run synchronization again.",
      "SKILL_SOURCE_CHANGED",
    );
  }
  for (const mutation of mutations) {
    if (!snapshotsMatch(destinationSnapshot(mutation.target), mutation.expected)) {
      throw new CoordinatorError(
        `Skill destination '.agents/skills/${mutation.action.name}' changed after planning.`,
        "SKILL_DESTINATION_CHANGED",
      );
    }
  }

  const temporaryRoot = mkdtempSync(
    path.join(skillsRoot, ".coordinator-staging-"),
  );
  let preserveTemporaryRoot = false;
  try {
    const backupRoot = path.join(temporaryRoot, "backup");
    const discardedRoot = path.join(temporaryRoot, "discarded");
    mkdirSync(backupRoot);
    mkdirSync(discardedRoot);
    const applied: PublishedSkillChange[] = [];
    try {
      for (const mutation of mutations) {
        assertDirectoryIdentity(skillsRoot, skillsRootIdentity);
        if (
          !snapshotsMatch(
            destinationSnapshot(mutation.target),
            mutation.expected,
          )
        ) {
          throw new CoordinatorError(
            `Skill destination '.agents/skills/${mutation.action.name}' changed during publication.`,
            "SKILL_DESTINATION_CHANGED",
          );
        }
        if (mutation.action.action === "adopt-link") continue;
        const change: PublishedSkillChange = {
          backup: null,
          name: mutation.action.name,
          published: false,
          publishedSnapshot: null,
          target: mutation.target,
        };
        applied.push(change);
        if (lstatIfPresent(mutation.target)) {
          change.backup = path.join(backupRoot, mutation.action.name);
          renameSync(mutation.target, change.backup);
          if (
            !snapshotsMatch(
              destinationSnapshot(change.backup),
              mutation.expected,
            )
          ) {
            throw new CoordinatorError(
              `Skill destination '.agents/skills/${mutation.action.name}' changed while it was being backed up.`,
              "SKILL_DESTINATION_CHANGED",
            );
          }
        }
        if (mutation.desired) {
          assertDirectoryIdentity(skillsRoot, skillsRootIdentity);
          createSkillLink(
            mutation.desired.linkTarget,
            mutation.target,
            mutation.action.name,
          );
          const publishedSnapshot = destinationSnapshot(mutation.target);
          if (
            publishedSnapshot.kind !== "symlink" ||
            publishedSnapshot.linkTarget !== mutation.desired.linkTarget
          ) {
            throw new CoordinatorError(
              `Published skill link '${mutation.action.name}' does not match its plan.`,
              "SKILL_DESTINATION_CHANGED",
            );
          }
          change.published = true;
          change.publishedSnapshot = publishedSnapshot;
        }
      }
      assertDirectoryIdentity(skillsRoot, skillsRootIdentity);
      const finalLinks = resolveSkillLinks(resolvedRoot, manifest);
      if (sourcePlanSignature(finalLinks) !== sourcePlanSignature(links)) {
        throw new CoordinatorError(
          "Skill sources changed during publication.",
          "SKILL_SOURCE_CHANGED",
        );
      }
      applyFilePlans([lockPlan, ...(options.dependentFilePlans ?? [])]);
    } catch (error) {
      const rollbackFailures = rollbackSkillChanges(
        resolvedRoot,
        skillsRoot,
        skillsRootIdentity,
        discardedRoot,
        applied,
      );
      if (rollbackFailures.length) {
        preserveTemporaryRoot = true;
        throw new CoordinatorError(
          `Skill synchronization failed (${error instanceof Error ? error.message : String(error)}) and rollback was incomplete: ${rollbackFailures.join("; ")}. Recovery data was preserved at ${temporaryRoot}.`,
          "SKILL_ROLLBACK_FAILED",
        );
      }
      throw error;
    }
    return result;
  } finally {
    if (!preserveTemporaryRoot && lstatIfPresent(temporaryRoot)) {
      rmSync(temporaryRoot, { recursive: true });
    }
  }
}

export function discoverSkillSources(
  repositoryDirectory: string,
): DiscoveredSkillSource[] {
  const results = new Map<string, DiscoveredSkillSource>();
  let repositoryRealPath: string;
  try {
    repositoryRealPath = realpathSync(repositoryDirectory);
  } catch {
    return [];
  }
  const visit = (
    directory: string,
    exportedDirectory: string,
    depth: number,
    ancestors: Set<string>,
  ) => {
    if (depth > 9) return;
    let directoryRealPath: string;
    try {
      directoryRealPath = realpathSync(directory);
    } catch {
      return;
    }
    if (!isWithin(repositoryRealPath, directoryRealPath)) return;
    if (ancestors.has(directoryRealPath)) return;
    const nextAncestors = new Set(ancestors).add(directoryRealPath);
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if ([".git", "node_modules", "dist", "build"].includes(entry.name)) continue;
      const absolute = path.join(directory, entry.name);
      let candidateRealPath: string;
      try {
        if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
        candidateRealPath = realpathSync(absolute);
        if (!statSync(candidateRealPath).isDirectory()) continue;
      } catch {
        continue;
      }
      if (!isWithin(repositoryRealPath, candidateRealPath)) continue;
      const relative = gitPath(path.relative(repositoryRealPath, candidateRealPath));
      const exported = gitPath(path.join(exportedDirectory, entry.name));
      const exportMatch =
        /(^|\/)\.agents\/(skills|flows)\/[a-z0-9-]+$/.exec(exported);
      if (
        relative &&
        existsSync(path.join(candidateRealPath, "SKILL.md")) &&
        exportMatch
      ) {
        const kind = exportMatch[2] === "flows" ? "flow" : "skill";
        results.set(`${kind}\0${relative}`, { source: relative, kind });
        continue;
      }
      visit(candidateRealPath, exported, depth + 1, nextAncestors);
    }
  };
  if (existsSync(repositoryDirectory)) {
    visit(repositoryRealPath, "", 0, new Set());
  }
  return [...results.values()].sort(
    (left, right) =>
      left.source.localeCompare(right.source) || left.kind.localeCompare(right.kind),
  );
}
