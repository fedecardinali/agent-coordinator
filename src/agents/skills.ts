import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { runCommand } from "../core/command.js";
import { CoordinatorError } from "../core/errors.js";
import {
  applyFilePlans,
  planFile,
  safeGeneratedPath,
} from "../core/files.js";
import { sha256 } from "../core/hash.js";
import type { CoordinatorManifest, Repository } from "../core/schema.js";

const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

interface SkillCandidate {
  explicitName: boolean;
  repository: Repository;
  source: string;
  sourceCommit: string;
  sourceGitRoot: string;
  sourcePrefix: string;
  sourceName: string;
  targetName: string;
  treeOid: string;
}

export interface MaterializedSkill {
  digest: string;
  name: string;
  repository: string;
  source: string;
  sourceCommit: string;
  treeOid: string;
}

export interface AgentSkillLock {
  generatedBy: "agent-coordinator";
  generatorVersion: string;
  schemaVersion: 1;
  skills: MaterializedSkill[];
}

export interface SkillSyncResult {
  changed: boolean;
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
  const sourceName = declared || path.basename(source);
  const isFlow = /(^|\/)\.agents\/flows\//.test(source);
  const targetName = explicitName ?? (isFlow ? `${repository.id}-${sourceName}` : sourceName);
  if (!SKILL_NAME.test(targetName)) {
    throw new CoordinatorError(
      `Skill '${repository.id}:${source}' resolves to invalid portable name '${targetName}'.`,
      "INVALID_SKILL_NAME",
    );
  }
  return {
    repository,
    source,
    sourceCommit,
    sourceGitRoot,
    sourcePrefix,
    sourceName,
    targetName,
    explicitName: explicitName !== undefined,
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
      sourceInformation(context, repository, skill.source, skill.name),
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
    const uniqueTrees = new Set(collisions.map((candidate) => candidate.treeOid));
    if (uniqueTrees.size === 1) {
      resolved.push(collisions[0]!);
      continue;
    }
    if (
      manifest.agents.skillCollision === "error" ||
      collisions.some((candidate) => candidate.explicitName)
    ) {
      throw new CoordinatorError(
        `Skill name '${name}' has divergent sources: ${collisions
          .map((candidate) => `${candidate.repository.id}:${candidate.source}`)
          .join(", ")}. Assign explicit unique names.`,
        "SKILL_COLLISION",
      );
    }
    for (const collision of collisions) {
      resolved.push({
        ...collision,
        targetName: `${collision.repository.id}-${collision.targetName}`,
      });
    }
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

function archiveCandidate(candidate: SkillCandidate, destination: string): void {
  mkdirSync(destination, { recursive: true });
  const archivePath = `${destination}.tar`;
  runCommand("git", [
    "-C",
    candidate.sourceGitRoot,
    "archive",
    "--format=tar",
    "--output",
    archivePath,
    candidate.sourcePrefix
      ? `${candidate.sourceCommit}:${candidate.sourcePrefix}`
      : candidate.sourceCommit,
  ]);
  runCommand("tar", ["-xf", archivePath, "-C", destination]);
  rmSync(archivePath);
  const skillPath = path.join(destination, "SKILL.md");
  const source = readFileSync(skillPath, "utf8");
  const rewritten = source.replace(
    /(^---\s*\n[\s\S]*?^name:\s*)[^\n]+/m,
    `$1${candidate.targetName}`,
  );
  if (rewritten === source && !new RegExp(`^name:\\s*${candidate.targetName}$`, "m").test(source)) {
    throw new CoordinatorError(
      `Skill '${candidate.repository.id}:${candidate.source}' has no editable name frontmatter.`,
      "INVALID_SKILL",
    );
  }
  writeFileSync(skillPath, rewritten, { mode: 0o644 });
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
      }
    }
  };
  walk(directory, "");
  return sha256(Buffer.concat(pieces));
}

function parseLock(content: string): AgentSkillLock | null {
  try {
    const value = JSON.parse(content) as Partial<AgentSkillLock>;
    if (
      value.generatedBy !== "agent-coordinator" ||
      value.schemaVersion !== 1 ||
      typeof value.generatorVersion !== "string" ||
      !Array.isArray(value.skills) ||
      !value.skills.every(
        (skill) =>
          typeof skill === "object" &&
          skill !== null &&
          typeof skill.name === "string" &&
          SKILL_NAME.test(skill.name),
      )
    ) {
      return null;
    }
    return value as AgentSkillLock;
  } catch {
    return null;
  }
}

function readLock(lockPath: string): AgentSkillLock | null {
  if (!existsSync(lockPath)) return null;
  return parseLock(readFileSync(lockPath, "utf8"));
}

function validateTarget(root: string, name: string): string {
  if (!SKILL_NAME.test(name)) {
    throw new CoordinatorError(`Unsafe generated skill name '${name}'.`);
  }
  return safeGeneratedPath(root, path.join(".agents", "skills", name));
}

interface PublishedSkillChange {
  backup: string | null;
  name: string;
  published: boolean;
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
      if (change.published && existsSync(target)) {
        renameSync(target, path.join(discardedRoot, change.name));
      }
      if (change.backup && existsSync(change.backup)) {
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

export function synchronizeSkills(
  root: string,
  manifest: CoordinatorManifest,
  generatorVersion: string,
  options: { check?: boolean | undefined; force?: boolean | undefined } = {},
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
  const previouslyManaged = new Set(
    previousLock?.skills.map((skill) => skill.name) ?? [],
  );
  const candidates = resolveCandidates(root, manifest);
  if (existsSync(skillsRoot) && !lstatSync(skillsRoot).isDirectory()) {
    throw new CoordinatorError(
      `Skill registry is not a directory: ${skillsRoot}.`,
      "SKILL_DESTINATION_INVALID",
    );
  }
  if (!options.check) {
    mkdirSync(skillsRoot, { recursive: true });
    safeGeneratedPath(resolvedRoot, ".agents/skills");
  }
  const temporaryRoot = mkdtempSync(
    options.check
      ? path.join(os.tmpdir(), "agent-coordinator-skills-")
      : path.join(skillsRoot, ".coordinator-staging-"),
  );
  try {
    const stagedRoot = path.join(temporaryRoot, "staged");
    const backupRoot = path.join(temporaryRoot, "backup");
    const discardedRoot = path.join(temporaryRoot, "discarded");
    mkdirSync(stagedRoot, { recursive: true });
    mkdirSync(backupRoot, { recursive: true });
    mkdirSync(discardedRoot, { recursive: true });
    const skills = candidates.map((candidate): MaterializedSkill => {
      const destination = path.join(stagedRoot, candidate.targetName);
      archiveCandidate(candidate, destination);
      return {
        name: candidate.targetName,
        repository: candidate.repository.id,
        source: candidate.source,
        sourceCommit: candidate.sourceCommit,
        treeOid: candidate.treeOid,
        digest: directoryDigest(destination),
      };
    });
    const desired = new Set(skills.map((skill) => skill.name));
    const replacements = new Set<string>();
    let changed = previousLock?.generatorVersion !== generatorVersion;

    for (const skill of skills) {
      const target = validateTarget(resolvedRoot, skill.name);
      if (!existsSync(target)) {
        changed = true;
        replacements.add(skill.name);
        continue;
      }
      if (!lstatSync(target).isDirectory()) {
        throw new CoordinatorError(`Skill destination is not a directory: ${target}`);
      }
      if (!previouslyManaged.has(skill.name) && !options.force) {
        throw new CoordinatorError(
          `Refusing to replace unmanaged skill '.agents/skills/${skill.name}'.`,
          "UNMANAGED_SKILL",
        );
      }
      if (directoryDigest(target) !== skill.digest) {
        changed = true;
        replacements.add(skill.name);
      }
    }
    for (const oldName of previouslyManaged) {
      if (!desired.has(oldName)) changed = true;
    }

    const nextLock: AgentSkillLock = {
      schemaVersion: 1,
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
        force: options.force,
        owned: (content) => parseLock(content) !== null,
      },
    );
    if (lockPlan.action !== "unchanged") changed = true;

    if (options.check) {
      return { changed, names: skills.map((skill) => skill.name), skills };
    }

    const skillsRootStatus = lstatSync(skillsRoot);
    const skillsRootIdentity = {
      dev: skillsRootStatus.dev,
      ino: skillsRootStatus.ino,
    };
    assertDirectoryIdentity(skillsRoot, skillsRootIdentity);
    const applied: PublishedSkillChange[] = [];
    try {
      for (const oldName of previouslyManaged) {
        if (desired.has(oldName)) continue;
        assertDirectoryIdentity(skillsRoot, skillsRootIdentity);
        const target = validateTarget(resolvedRoot, oldName);
        if (!existsSync(target)) continue;
        const change: PublishedSkillChange = {
          backup: path.join(backupRoot, oldName),
          name: oldName,
          published: false,
          target,
        };
        applied.push(change);
        renameSync(target, change.backup!);
      }
      for (const skill of skills) {
        if (!replacements.has(skill.name)) continue;
        assertDirectoryIdentity(skillsRoot, skillsRootIdentity);
        const target = validateTarget(resolvedRoot, skill.name);
        const change: PublishedSkillChange = {
          backup: null,
          name: skill.name,
          published: false,
          target,
        };
        applied.push(change);
        if (existsSync(target)) {
          const backup = path.join(backupRoot, skill.name);
          change.backup = backup;
          renameSync(target, backup);
        }
        assertDirectoryIdentity(skillsRoot, skillsRootIdentity);
        validateTarget(resolvedRoot, skill.name);
        renameSync(path.join(stagedRoot, skill.name), target);
        change.published = true;
      }
      assertDirectoryIdentity(skillsRoot, skillsRootIdentity);
      applyFilePlans([lockPlan]);
    } catch (error) {
      const rollbackFailures = rollbackSkillChanges(
        resolvedRoot,
        skillsRoot,
        skillsRootIdentity,
        discardedRoot,
        applied,
      );
      if (rollbackFailures.length) {
        throw new CoordinatorError(
          `Skill synchronization failed (${error instanceof Error ? error.message : String(error)}) and rollback was incomplete: ${rollbackFailures.join("; ")}.`,
          "SKILL_ROLLBACK_FAILED",
        );
      }
      throw error;
    }
    return { changed, names: skills.map((skill) => skill.name), skills };
  } finally {
    if (existsSync(temporaryRoot)) rmSync(temporaryRoot, { recursive: true });
  }
}

export function discoverSkillSources(repositoryDirectory: string): string[] {
  const results: string[] = [];
  const visit = (directory: string, depth: number) => {
    if (depth > 9) return;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if ([".git", "node_modules", "dist", "build"].includes(entry.name)) continue;
      const absolute = path.join(directory, entry.name);
      if (!entry.isDirectory()) continue;
      const relative = path.relative(repositoryDirectory, absolute);
      if (
        existsSync(path.join(absolute, "SKILL.md")) &&
        /(^|\/)\.agents\/(skills|flows)\/[a-z0-9-]+$/.test(relative)
      ) {
        results.push(relative);
        continue;
      }
      visit(absolute, depth + 1);
    }
  };
  if (existsSync(repositoryDirectory)) visit(repositoryDirectory, 0);
  return results.sort();
}
