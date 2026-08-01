#!/usr/bin/env node

// src/cli.ts
import path15 from "path";
import { Command, CommanderError } from "commander";
import pc3 from "picocolors";

// src/agents/sync.ts
import { existsSync as existsSync3, readFileSync as readFileSync3, readdirSync as readdirSync2 } from "fs";
import path3 from "path";

// src/core/errors.ts
var CoordinatorError = class extends Error {
  code;
  constructor(message, code = "COORDINATOR_ERROR") {
    super(message);
    this.name = "CoordinatorError";
    this.code = code;
  }
};
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

// src/core/files.ts
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from "fs";
import { randomUUID } from "crypto";
import path from "path";
var planRoots = /* @__PURE__ */ new WeakMap();
function lstatIfPresent(value2) {
  try {
    return lstatSync(value2);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}
function safeGeneratedPath(root, relativePath2) {
  if (!relativePath2 || path.isAbsolute(relativePath2) || relativePath2.split(/[\\/]/).includes("..") || relativePath2 === ".") {
    throw new CoordinatorError(
      `Unsafe generated file path '${relativePath2}'.`,
      "UNSAFE_FILE_PATH"
    );
  }
  const resolvedRoot = path.resolve(root);
  const absolutePath = path.resolve(resolvedRoot, relativePath2);
  if (absolutePath !== resolvedRoot && !absolutePath.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new CoordinatorError(
      `Generated file '${relativePath2}' escapes the workspace.`,
      "UNSAFE_FILE_PATH"
    );
  }
  let current = resolvedRoot;
  const components = path.relative(resolvedRoot, path.dirname(absolutePath)).split(path.sep);
  for (const component of components) {
    if (!component) continue;
    current = path.join(current, component);
    const status = lstatIfPresent(current);
    if (status?.isSymbolicLink()) {
      throw new CoordinatorError(
        `Refusing generated file '${relativePath2}' because '${path.relative(resolvedRoot, current)}' is a symlink.`,
        "UNSAFE_FILE_PATH"
      );
    }
    if (status && !status.isDirectory()) {
      throw new CoordinatorError(
        `Refusing generated file '${relativePath2}' because '${path.relative(resolvedRoot, current)}' is not a directory.`,
        "UNSAFE_FILE_PATH"
      );
    }
  }
  if (lstatIfPresent(absolutePath)?.isSymbolicLink()) {
    throw new CoordinatorError(
      `Refusing to follow generated-file symlink '${relativePath2}'.`,
      "UNSAFE_FILE_PATH"
    );
  }
  return absolutePath;
}
function registerPlan(root, plan) {
  planRoots.set(plan, path.resolve(root));
  return plan;
}
function revalidatePlan(plan) {
  const root = planRoots.get(plan);
  if (!root) {
    throw new CoordinatorError(
      `Refusing untrusted generated-file plan '${plan.relativePath}'.`,
      "UNSAFE_FILE_PLAN"
    );
  }
  const currentPath = safeGeneratedPath(root, plan.relativePath);
  if (currentPath !== plan.path) {
    throw new CoordinatorError(
      `Generated-file plan '${plan.relativePath}' changed destination before publication.`,
      "UNSAFE_FILE_PLAN"
    );
  }
}
function planFile(root, relativePath2, content, options = {}) {
  const absolutePath = safeGeneratedPath(root, relativePath2);
  if (!existsSync(absolutePath)) {
    return registerPlan(root, {
      action: "create",
      content,
      path: absolutePath,
      relativePath: relativePath2
    });
  }
  const current = readFileSync(absolutePath, "utf8");
  if (current === content) {
    return registerPlan(root, {
      action: "unchanged",
      content,
      path: absolutePath,
      relativePath: relativePath2
    });
  }
  if (!options.force && options.owned && !options.owned(current)) {
    throw new CoordinatorError(
      `Refusing to overwrite unmanaged file '${relativePath2}'. Move it, adopt it explicitly, or use --force.`,
      "UNMANAGED_FILE"
    );
  }
  return registerPlan(root, {
    action: "update",
    content,
    path: absolutePath,
    relativePath: relativePath2
  });
}
function applyFilePlans(plans) {
  for (const plan of plans) {
    revalidatePlan(plan);
    if (plan.action === "unchanged") continue;
    if (plan.action === "delete") {
      unlinkSync(plan.path);
      continue;
    }
    mkdirSync(path.dirname(plan.path), { recursive: true });
    revalidatePlan(plan);
    const temporaryPath = path.join(
      path.dirname(plan.path),
      `.${path.basename(plan.path)}.coordinator-${randomUUID()}`
    );
    let descriptor = null;
    try {
      descriptor = openSync(temporaryPath, "wx", 420);
      writeFileSync(descriptor, plan.content, "utf8");
      closeSync(descriptor);
      descriptor = null;
      revalidatePlan(plan);
      renameSync(temporaryPath, plan.path);
    } finally {
      if (descriptor !== null) closeSync(descriptor);
      if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
    }
  }
}
function planFileDeletion(root, relativePath2, owned3) {
  const absolutePath = safeGeneratedPath(root, relativePath2);
  if (!existsSync(absolutePath)) {
    return registerPlan(root, {
      action: "unchanged",
      content: "",
      path: absolutePath,
      relativePath: relativePath2
    });
  }
  const current = readFileSync(absolutePath, "utf8");
  return registerPlan(root, {
    action: owned3(current) ? "delete" : "unchanged",
    content: current,
    path: absolutePath,
    relativePath: relativePath2
  });
}
function changedPlans(plans) {
  return plans.filter((plan) => plan.action !== "unchanged");
}

// src/agents/renderers.ts
var AGENT_FILE_MARKER = "Generated by Agent Coordinator";
function agentName(repository) {
  return repository.agent.name ?? repository.id;
}
function description(manifest, repository) {
  return repository.agent.description ?? `Owns implementation and verification limited to the ${manifest.name} '${repository.id}' repository.`;
}
function instructions(manifest, repository) {
  const siblings = manifest.repositories.filter((candidate) => candidate.id !== repository.id).map((candidate) => `\`${candidate.path}\``).join(", ");
  const custom = repository.agent.instructions.length ? `

Repository-specific instructions:
${repository.agent.instructions.map((instruction) => `- ${instruction}`).join("\n")}` : "";
  const verification = repository.agent.verify.length ? `

Before returning, run:
${repository.agent.verify.map((command) => `- \`${command}\``).join("\n")}` : "";
  const workspaceMode = manifest.workspaceManifest ? `

Before editing, read \`${manifest.workspaceManifest.path}\` from the current coordinator revision and confirm \`${repository.id}\` is active. If it is pinned, read-only, or absent, stop and report that constraint to the primary agent.` : "";
  return `Work only inside \`${repository.path}\`. Never edit the coordinator root${siblings ? ` or sibling repositories ${siblings}` : ""}.

Read the coordinator \`AGENTS.md\`, then \`${repository.path}/AGENTS.md\` when it exists, and follow applicable project skills. Preserve user changes and avoid destructive Git operations. Do not create another subagent. Return a concise summary with changed files, validation outcomes, residual risks, and cross-repository contract impacts.${workspaceMode}${custom}${verification}`;
}
function tomlString(value2) {
  return value2.replaceAll('"""', '\\"\\"\\"');
}
function renderCodexAgent(manifest, repository) {
  const name = agentName(repository);
  return `# ${AGENT_FILE_MARKER}. Edit coordinator.yaml instead.
name = ${JSON.stringify(name)}
description = ${JSON.stringify(description(manifest, repository))}
nickname_candidates = [${["Atlas", "Delta", "Echo"].map((nickname) => JSON.stringify(`${name} ${nickname}`)).join(", ")}]
developer_instructions = """
${tomlString(instructions(manifest, repository))}
"""
`;
}
function renderCursorAgent(manifest, repository) {
  return `---
name: ${agentName(repository)}
description: ${JSON.stringify(description(manifest, repository))}
---

<!-- ${AGENT_FILE_MARKER}. Edit coordinator.yaml instead. -->

${instructions(manifest, repository)}
`;
}
function renderClaudeAgent(manifest, repository) {
  return `---
name: ${agentName(repository)}
description: ${JSON.stringify(description(manifest, repository))}
model: inherit
disallowedTools: Agent
---

<!-- ${AGENT_FILE_MARKER}. Edit coordinator.yaml instead. -->

${instructions(manifest, repository)}

Read selected portable skills directly from \`.agents/skills/<skill-name>/SKILL.md\`.
`;
}
function renderOpenCodeAgent(manifest, repository) {
  return `---
description: ${JSON.stringify(description(manifest, repository))}
mode: subagent
permission:
  task:
    "*": deny
---

<!-- ${AGENT_FILE_MARKER}. Edit coordinator.yaml instead. -->

${instructions(manifest, repository)}
`;
}
function renderRootAgents(manifest) {
  const repositoryList = manifest.repositories.map(
    (repository) => `- \`${repository.id}\`: \`${repository.path}\` (${repository.branch.mode}${repository.branch.readOnly ? ", read-only" : ""}); delegate to the \`${agentName(repository)}\` project agent.`
  ).join("\n");
  const verify = manifest.repositories.flatMap(
    (repository) => repository.agent.verify.map(
      (command) => `- ${repository.id}: \`${command}\``
    )
  ).join("\n");
  const workspaceManifest = manifest.workspaceManifest ? `
A branch-scoped workspace manifest is stored at \`${manifest.workspaceManifest.path}\`. Read the version from the current coordinator HEAD before delegation. Only repositories marked active may receive implementation work; pinned or absent repositories must remain untouched even when their default policy is writable.
` : "";
  return `<!-- ${AGENT_FILE_MARKER}. Edit coordinator.yaml and run coordinator agents sync. -->

# ${manifest.name} Agent Guide

## Scope

This repository coordinates independently versioned Git subrepositories. The
root owns cross-repository decisions, integration, agent configuration, and
delivery orchestration. Repository-specific implementation belongs to the
closer child repository and its local \`AGENTS.md\`.

${repositoryList}
${workspaceManifest}

## Delegation

- Keep root integration and Git metadata in the primary agent.
- Delegate one bounded task per affected repository using the project agents
  listed above.
- Give agents exclusive path ownership and never let two agents edit the same
  repository concurrently.
- Repository agents must not create nested agents.
- Run affected agents in parallel only when their paths and contracts are
  independent.
- Every agent returns changed files, checks run, failures, and contract impact.

## Portable skills

Materialized skills live at \`.agents/skills/<skill-name>/SKILL.md\`. They are
generated from committed child-repository trees. Do not edit generated copies;
change the source and run \`coordinator agents sync\`.

## Git invariant

Gitlinks are the authoritative version lock. From this root, ordinary
\`git add\`, \`git commit\`, \`git pull\`, \`git push\`, \`git checkout\`, and
\`git worktree\` are coordinated by Git Coordinator. Never repair an invariant
with reset, clean, force checkout, or discarded user changes.

## Verification

${verify || "- Run the verification commands declared by each affected child repository."}
- Run \`coordinator doctor\` before final delivery.
`;
}
function renderCodexConfig(manifest) {
  return `# ${AGENT_FILE_MARKER}. Edit coordinator.yaml instead.
model_verbosity = "low"

[agents]
max_threads = ${manifest.agents.maxParallel}
max_depth = 1
`;
}
function renderClaudeRoot(manifest) {
  return `<!-- ${AGENT_FILE_MARKER}. Edit coordinator.yaml instead. -->

# Claude Code Adapter

@../AGENTS.md

\`AGENTS.md\` is the canonical project guide. Portable skills live in
\`.agents/skills\`; interactive command adapters use
\`/${manifest.name}:<skill-name>\`.
`;
}
function renderClaudeCommand(manifest, skillName) {
  return `---
description: Load and follow the portable ${skillName} project skill.
---

<!-- ${AGENT_FILE_MARKER}. Regenerate with coordinator agents sync. -->

Follow every instruction in the project skill below. Resolve supporting-file
paths from \`.agents/skills/${skillName}/\`.

@.agents/skills/${skillName}/SKILL.md
`;
}

// src/agents/skills.ts
import {
  existsSync as existsSync2,
  lstatSync as lstatSync2,
  mkdirSync as mkdirSync2,
  mkdtempSync,
  readFileSync as readFileSync2,
  readdirSync,
  realpathSync,
  renameSync as renameSync2,
  rmSync,
  writeFileSync as writeFileSync2
} from "fs";
import os from "os";
import path2 from "path";

// src/core/command.ts
import { spawnSync } from "child_process";
function runCommand(command, argumentsList, options = {}) {
  const stdio = options.stdio ?? "pipe";
  const result = spawnSync(command, argumentsList, {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    encoding: "utf8",
    input: options.input,
    stdio
  });
  if (result.error) {
    throw new CoordinatorError(
      `Could not execute '${command}': ${result.error.message}`,
      "COMMAND_NOT_FOUND"
    );
  }
  const status = result.status ?? 1;
  const output = {
    status,
    stdout: typeof result.stdout === "string" ? result.stdout.trim() : "",
    stderr: typeof result.stderr === "string" ? result.stderr.trim() : ""
  };
  if (status !== 0 && !options.allowFailure) {
    const detail = output.stderr || output.stdout || `exit ${status}`;
    throw new CoordinatorError(
      `'${command} ${argumentsList.join(" ")}' failed: ${detail}`,
      "COMMAND_FAILED"
    );
  }
  return output;
}
function commandAvailable(command) {
  return runCommand("sh", ["-c", 'command -v -- "$1" >/dev/null 2>&1', "sh", command], {
    allowFailure: true
  }).status === 0;
}

// src/core/hash.ts
import { createHash } from "crypto";
function sha256(value2) {
  return createHash("sha256").update(value2).digest("hex");
}

// src/agents/skills.ts
var SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
function gitText(directory, argumentsList) {
  return runCommand("git", ["-C", directory, ...argumentsList]).stdout;
}
function isWithin(base, candidate) {
  const relative = path2.relative(base, candidate);
  return relative === "" || !path2.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path2.sep}`);
}
function safeExistingPath(base, relativePath2, label) {
  const absoluteBase = path2.resolve(base);
  const absoluteTarget = path2.resolve(base, relativePath2 || ".");
  if (!isWithin(absoluteBase, absoluteTarget)) {
    throw new CoordinatorError(
      `${label} escapes its declared repository: ${relativePath2}.`,
      "SKILL_SOURCE_ESCAPE"
    );
  }
  const normalizedRelative = path2.relative(absoluteBase, absoluteTarget);
  let cursor = absoluteBase;
  for (const segment of normalizedRelative.split(path2.sep).filter(Boolean)) {
    cursor = path2.join(cursor, segment);
    if (!existsSync2(cursor)) {
      throw new CoordinatorError(
        `${label} is not initialized at ${cursor}. Initialize nested submodules first.`,
        "SKILL_SOURCE_MISSING"
      );
    }
    if (lstatSync2(cursor).isSymbolicLink()) {
      throw new CoordinatorError(
        `${label} crosses unsupported symbolic link '${path2.relative(absoluteBase, cursor)}'.`,
        "SKILL_SOURCE_SYMLINK"
      );
    }
  }
  let baseRealPath;
  let targetRealPath;
  try {
    baseRealPath = realpathSync(absoluteBase);
    targetRealPath = realpathSync(absoluteTarget);
  } catch {
    throw new CoordinatorError(
      `${label} is not initialized at ${absoluteTarget}. Initialize nested submodules first.`,
      "SKILL_SOURCE_MISSING"
    );
  }
  if (!isWithin(baseRealPath, targetRealPath)) {
    throw new CoordinatorError(
      `${label} resolves outside its declared repository: ${targetRealPath}.`,
      "SKILL_SOURCE_ESCAPE"
    );
  }
  return targetRealPath;
}
function gitPath(value2) {
  return value2.split(path2.sep).join("/");
}
function treeEntry(repositoryDirectory, commit, relativePath2) {
  const result = runCommand(
    "git",
    [
      "-C",
      repositoryDirectory,
      "ls-tree",
      commit,
      "--",
      `:(literal)${relativePath2}`
    ],
    { allowFailure: true }
  );
  if (result.status !== 0) {
    throw new CoordinatorError(
      `Could not read pinned Git tree ${commit} in ${repositoryDirectory}: ${result.stderr || result.stdout || `exit ${result.status}`}.`,
      "SKILL_PINNED_TREE_UNAVAILABLE"
    );
  }
  if (!result.stdout) return null;
  const lines = result.stdout.split("\n").filter(Boolean);
  if (lines.length !== 1) return null;
  const match = /^(\d{6})\s+(\w+)\s+([0-9a-f]{40,64})\t/.exec(lines[0]);
  return match ? { mode: match[1], type: match[2], oid: match[3] } : null;
}
function indexedGitlink(root, repository) {
  const result = runCommand(
    "git",
    ["-C", root, "ls-files", "--stage", "--", repository.path],
    { allowFailure: true }
  );
  const entries = result.stdout.split("\n").filter(Boolean).map((line) => /^(\d{6}) ([0-9a-f]{40,64}) ([0-3])\t/.exec(line)).filter((entry) => entry !== null);
  if (result.status !== 0 || entries.length !== 1 || entries[0][1] !== "160000" || entries[0][3] !== "0") {
    throw new CoordinatorError(
      `Repository '${repository.id}' is not pinned by one stage-0 gitlink at '${repository.path}'. Add or resolve the submodule gitlink before synchronizing skills.`,
      "SKILL_GITLINK_MISSING"
    );
  }
  return entries[0][2];
}
function assertPinnedCheckout(context, directory, expectedCommit, label) {
  const realDirectory = realpathSync(directory);
  const previousExpectation = context.validatedCheckouts.get(realDirectory);
  if (previousExpectation) {
    if (previousExpectation !== expectedCommit) {
      throw new CoordinatorError(
        `${label} is referenced by conflicting gitlinks ${previousExpectation} and ${expectedCommit}.`,
        "SKILL_GITLINK_MISMATCH"
      );
    }
    return;
  }
  const topLevel = runCommand(
    "git",
    ["-C", directory, "rev-parse", "--show-toplevel"],
    { allowFailure: true }
  );
  let topLevelRealPath = null;
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
      "SKILL_SUBMODULE_UNINITIALIZED"
    );
  }
  const head = runCommand(
    "git",
    ["-C", directory, "rev-parse", "--verify", "HEAD^{commit}"],
    { allowFailure: true }
  );
  if (head.status !== 0 || head.stdout !== expectedCommit) {
    throw new CoordinatorError(
      `${label} checkout is at ${head.stdout || "an unreadable HEAD"}, but its parent gitlink pins ${expectedCommit}. Attach or restore the pinned commit before synchronizing skills.`,
      "SKILL_GITLINK_MISMATCH"
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
      "--ignore-submodules=all"
    ],
    { allowFailure: true }
  );
  if (status.status !== 0) {
    throw new CoordinatorError(
      `Could not inspect ${label}: ${status.stderr || status.stdout || `exit ${status.status}`}.`,
      "SKILL_SOURCE_STATUS_FAILED"
    );
  }
  if (status.stdout) {
    const detail = status.stdout.split("\n").slice(0, 3).join(", ");
    throw new CoordinatorError(
      `${label} has uncommitted or untracked changes (${detail}). Commit or remove them before synchronizing skills.`,
      "SKILL_SOURCE_DIRTY"
    );
  }
  context.validatedCheckouts.set(realDirectory, expectedCommit);
}
function resolutionContext(root) {
  const resolvedRoot = path2.resolve(root);
  let rootRealPath;
  try {
    rootRealPath = realpathSync(resolvedRoot);
  } catch {
    throw new CoordinatorError(
      `Coordinator root does not exist: ${resolvedRoot}.`,
      "SKILL_COORDINATOR_ROOT_MISSING"
    );
  }
  const topLevel = runCommand(
    "git",
    ["-C", resolvedRoot, "rev-parse", "--show-toplevel"],
    { allowFailure: true }
  );
  let topLevelRealPath = null;
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
      "SKILL_COORDINATOR_ROOT_INVALID"
    );
  }
  return {
    root: resolvedRoot,
    rootRealPath,
    validatedCheckouts: /* @__PURE__ */ new Map()
  };
}
function sourceInformation(context, repository, source, explicitName) {
  const label = `Skill source '${repository.id}:${source}'`;
  const repositoryDirectory = safeExistingPath(
    context.root,
    repository.path,
    `Repository '${repository.id}'`
  );
  if (!isWithin(context.rootRealPath, repositoryDirectory)) {
    throw new CoordinatorError(
      `Repository '${repository.id}' resolves outside the coordinator root: ${repositoryDirectory}.`,
      "SKILL_SOURCE_ESCAPE"
    );
  }
  let sourceGitRoot = repositoryDirectory;
  let sourceCommit = indexedGitlink(context.root, repository);
  assertPinnedCheckout(
    context,
    sourceGitRoot,
    sourceCommit,
    `Repository '${repository.id}'`
  );
  let sourcePrefix = gitPath(source);
  while (sourcePrefix) {
    const components = sourcePrefix.split("/").filter(Boolean);
    let nested;
    for (let index = 0; index < components.length; index += 1) {
      const prefix = components.slice(0, index + 1).join("/");
      const entry = treeEntry(sourceGitRoot, sourceCommit, prefix);
      if (!entry) {
        throw new CoordinatorError(
          `${label} is absent from pinned commit ${sourceCommit}.`,
          "SKILL_SOURCE_MISSING"
        );
      }
      if (entry.mode === "120000") {
        throw new CoordinatorError(
          `${label} crosses symbolic link '${prefix}' in pinned commit ${sourceCommit}.`,
          "SKILL_SOURCE_SYMLINK"
        );
      }
      if (entry.mode === "160000") {
        nested = {
          commit: entry.oid,
          path: prefix,
          remaining: components.slice(index + 1).join("/")
        };
        break;
      }
      if (index < components.length - 1 && entry.mode !== "040000") {
        throw new CoordinatorError(
          `${label} crosses non-directory '${prefix}' in pinned commit ${sourceCommit}.`,
          "SKILL_SOURCE_MISSING"
        );
      }
    }
    if (!nested) break;
    const nestedDirectory = safeExistingPath(sourceGitRoot, nested.path, label);
    assertPinnedCheckout(
      context,
      nestedDirectory,
      nested.commit,
      `${label} nested submodule '${nested.path}'`
    );
    sourceGitRoot = nestedDirectory;
    sourceCommit = nested.commit;
    sourcePrefix = nested.remaining;
  }
  const sourceDirectory = safeExistingPath(
    sourceGitRoot,
    sourcePrefix || ".",
    label
  );
  const sourceTree = sourcePrefix ? treeEntry(sourceGitRoot, sourceCommit, sourcePrefix) : {
    mode: "040000",
    type: "tree",
    oid: gitText(sourceGitRoot, ["rev-parse", `${sourceCommit}^{tree}`])
  };
  if (!sourceTree || sourceTree.mode !== "040000" || sourceTree.type !== "tree") {
    throw new CoordinatorError(
      `${label} is not a directory in pinned commit ${sourceCommit}.`,
      "SKILL_SOURCE_MISSING"
    );
  }
  safeExistingPath(sourceDirectory, "SKILL.md", label);
  const skillPath = sourcePrefix ? `${sourcePrefix}/SKILL.md` : "SKILL.md";
  const skillEntry = treeEntry(sourceGitRoot, sourceCommit, skillPath);
  if (!skillEntry) {
    throw new CoordinatorError(
      `${label} has no SKILL.md in pinned commit ${sourceCommit}.`,
      "SKILL_SOURCE_MISSING"
    );
  }
  if (skillEntry.mode === "120000") {
    throw new CoordinatorError(
      `${label}/SKILL.md is an unsupported symbolic link in pinned commit ${sourceCommit}.`,
      "SKILL_SOURCE_SYMLINK"
    );
  }
  if (skillEntry.type !== "blob") {
    throw new CoordinatorError(
      `${label}/SKILL.md is not a regular file in pinned commit ${sourceCommit}.`,
      "SKILL_SOURCE_MISSING"
    );
  }
  const committedSkill = gitText(sourceGitRoot, ["show", `${sourceCommit}:${skillPath}`]);
  const declared = /^---\s*\n[\s\S]*?^name:\s*["']?([^\n"']+)["']?\s*$[\s\S]*?^---\s*$/m.exec(
    committedSkill
  )?.[1]?.trim();
  const sourceName = declared || path2.basename(source);
  const isFlow = /(^|\/)\.agents\/flows\//.test(source);
  const targetName = explicitName ?? (isFlow ? `${repository.id}-${sourceName}` : sourceName);
  if (!SKILL_NAME.test(targetName)) {
    throw new CoordinatorError(
      `Skill '${repository.id}:${source}' resolves to invalid portable name '${targetName}'.`,
      "INVALID_SKILL_NAME"
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
    explicitName: explicitName !== void 0,
    treeOid: sourceTree.oid
  };
}
function resolveCandidates(root, manifest) {
  if (!manifest.repositories.some((repository) => repository.agent.skills.length > 0)) {
    return [];
  }
  const context = resolutionContext(root);
  const candidates = manifest.repositories.flatMap(
    (repository) => repository.agent.skills.map(
      (skill) => sourceInformation(context, repository, skill.source, skill.name)
    )
  );
  const grouped = /* @__PURE__ */ new Map();
  for (const candidate of candidates) {
    const collisions = grouped.get(candidate.targetName) ?? [];
    collisions.push(candidate);
    grouped.set(candidate.targetName, collisions);
  }
  const resolved = [];
  for (const [name, collisions] of grouped) {
    if (collisions.length === 1) {
      resolved.push(collisions[0]);
      continue;
    }
    const uniqueTrees = new Set(collisions.map((candidate) => candidate.treeOid));
    if (uniqueTrees.size === 1) {
      resolved.push(collisions[0]);
      continue;
    }
    if (manifest.agents.skillCollision === "error" || collisions.some((candidate) => candidate.explicitName)) {
      throw new CoordinatorError(
        `Skill name '${name}' has divergent sources: ${collisions.map((candidate) => `${candidate.repository.id}:${candidate.source}`).join(", ")}. Assign explicit unique names.`,
        "SKILL_COLLISION"
      );
    }
    for (const collision of collisions) {
      resolved.push({
        ...collision,
        targetName: `${collision.repository.id}-${collision.targetName}`
      });
    }
  }
  const finalNames = /* @__PURE__ */ new Set();
  for (const candidate of resolved) {
    if (finalNames.has(candidate.targetName)) {
      throw new CoordinatorError(
        `Skill namespace still collides at '${candidate.targetName}'. Configure an explicit name.`,
        "SKILL_COLLISION"
      );
    }
    finalNames.add(candidate.targetName);
  }
  return resolved.sort((left, right) => left.targetName.localeCompare(right.targetName));
}
function archiveCandidate(candidate, destination) {
  mkdirSync2(destination, { recursive: true });
  const archivePath = `${destination}.tar`;
  runCommand("git", [
    "-C",
    candidate.sourceGitRoot,
    "archive",
    "--format=tar",
    "--output",
    archivePath,
    candidate.sourcePrefix ? `${candidate.sourceCommit}:${candidate.sourcePrefix}` : candidate.sourceCommit
  ]);
  runCommand("tar", ["-xf", archivePath, "-C", destination]);
  rmSync(archivePath);
  const skillPath = path2.join(destination, "SKILL.md");
  const source = readFileSync2(skillPath, "utf8");
  const rewritten = source.replace(
    /(^---\s*\n[\s\S]*?^name:\s*)[^\n]+/m,
    `$1${candidate.targetName}`
  );
  if (rewritten === source && !new RegExp(`^name:\\s*${candidate.targetName}$`, "m").test(source)) {
    throw new CoordinatorError(
      `Skill '${candidate.repository.id}:${candidate.source}' has no editable name frontmatter.`,
      "INVALID_SKILL"
    );
  }
  writeFileSync2(skillPath, rewritten, { mode: 420 });
}
function directoryDigest(directory) {
  const pieces = [];
  const walk = (current, prefix) => {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort(
      (a, b) => a.name.localeCompare(b.name)
    )) {
      const absolute = path2.join(current, entry.name);
      const relative = path2.posix.join(prefix, entry.name);
      if (entry.isSymbolicLink()) {
        throw new CoordinatorError(
          `Generated skill contains unsupported symlink '${relative}'.`,
          "SKILL_SYMLINK"
        );
      }
      if (entry.isDirectory()) {
        walk(absolute, relative);
      } else if (entry.isFile()) {
        pieces.push(Buffer.from(`${relative}\0`));
        pieces.push(readFileSync2(absolute));
        pieces.push(Buffer.from("\0"));
      }
    }
  };
  walk(directory, "");
  return sha256(Buffer.concat(pieces));
}
function parseLock(content) {
  try {
    const value2 = JSON.parse(content);
    if (value2.generatedBy !== "agent-coordinator" || value2.schemaVersion !== 1 || typeof value2.generatorVersion !== "string" || !Array.isArray(value2.skills) || !value2.skills.every(
      (skill) => typeof skill === "object" && skill !== null && typeof skill.name === "string" && SKILL_NAME.test(skill.name)
    )) {
      return null;
    }
    return value2;
  } catch {
    return null;
  }
}
function readLock(lockPath) {
  if (!existsSync2(lockPath)) return null;
  return parseLock(readFileSync2(lockPath, "utf8"));
}
function validateTarget(root, name) {
  if (!SKILL_NAME.test(name)) {
    throw new CoordinatorError(`Unsafe generated skill name '${name}'.`);
  }
  return safeGeneratedPath(root, path2.join(".agents", "skills", name));
}
function assertDirectoryIdentity(directory, expected) {
  const status = lstatSync2(directory);
  if (!status.isDirectory() || status.isSymbolicLink() || status.dev !== expected.dev || status.ino !== expected.ino) {
    throw new CoordinatorError(
      `Skill registry changed while it was being synchronized: ${directory}.`,
      "SKILL_DESTINATION_CHANGED"
    );
  }
}
function rollbackSkillChanges(root, skillsRoot, identity, discardedRoot, changes) {
  const failures = [];
  for (const change of [...changes].reverse()) {
    try {
      assertDirectoryIdentity(skillsRoot, identity);
      const target = validateTarget(root, change.name);
      if (change.published && existsSync2(target)) {
        renameSync2(target, path2.join(discardedRoot, change.name));
      }
      if (change.backup && existsSync2(change.backup)) {
        renameSync2(change.backup, target);
      }
    } catch (error) {
      failures.push(
        `${change.name}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  return failures;
}
function synchronizeSkills(root, manifest, generatorVersion, options = {}) {
  const resolvedRoot = path2.resolve(root);
  const skillsRoot = safeGeneratedPath(resolvedRoot, ".agents/skills");
  const lockPath = safeGeneratedPath(
    resolvedRoot,
    ".coordinator/agents.lock.json"
  );
  const previousLock = readLock(lockPath);
  if (existsSync2(lockPath) && !previousLock && !options.force) {
    throw new CoordinatorError(
      "Refusing to overwrite unmanaged file '.coordinator/agents.lock.json'. Move it, adopt it explicitly, or use --force.",
      "UNMANAGED_FILE"
    );
  }
  const previouslyManaged = new Set(
    previousLock?.skills.map((skill) => skill.name) ?? []
  );
  const candidates = resolveCandidates(root, manifest);
  if (existsSync2(skillsRoot) && !lstatSync2(skillsRoot).isDirectory()) {
    throw new CoordinatorError(
      `Skill registry is not a directory: ${skillsRoot}.`,
      "SKILL_DESTINATION_INVALID"
    );
  }
  if (!options.check) {
    mkdirSync2(skillsRoot, { recursive: true });
    safeGeneratedPath(resolvedRoot, ".agents/skills");
  }
  const temporaryRoot = mkdtempSync(
    options.check ? path2.join(os.tmpdir(), "agent-coordinator-skills-") : path2.join(skillsRoot, ".coordinator-staging-")
  );
  try {
    const stagedRoot = path2.join(temporaryRoot, "staged");
    const backupRoot = path2.join(temporaryRoot, "backup");
    const discardedRoot = path2.join(temporaryRoot, "discarded");
    mkdirSync2(stagedRoot, { recursive: true });
    mkdirSync2(backupRoot, { recursive: true });
    mkdirSync2(discardedRoot, { recursive: true });
    const skills = candidates.map((candidate) => {
      const destination = path2.join(stagedRoot, candidate.targetName);
      archiveCandidate(candidate, destination);
      return {
        name: candidate.targetName,
        repository: candidate.repository.id,
        source: candidate.source,
        sourceCommit: candidate.sourceCommit,
        treeOid: candidate.treeOid,
        digest: directoryDigest(destination)
      };
    });
    const desired = new Set(skills.map((skill) => skill.name));
    const replacements = /* @__PURE__ */ new Set();
    let changed = previousLock?.generatorVersion !== generatorVersion;
    for (const skill of skills) {
      const target = validateTarget(resolvedRoot, skill.name);
      if (!existsSync2(target)) {
        changed = true;
        replacements.add(skill.name);
        continue;
      }
      if (!lstatSync2(target).isDirectory()) {
        throw new CoordinatorError(`Skill destination is not a directory: ${target}`);
      }
      if (!previouslyManaged.has(skill.name) && !options.force) {
        throw new CoordinatorError(
          `Refusing to replace unmanaged skill '.agents/skills/${skill.name}'.`,
          "UNMANAGED_SKILL"
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
    const nextLock = {
      schemaVersion: 1,
      generatedBy: "agent-coordinator",
      generatorVersion,
      skills
    };
    const renderedLock = `${JSON.stringify(nextLock, null, 2)}
`;
    const lockPlan = planFile(
      resolvedRoot,
      ".coordinator/agents.lock.json",
      renderedLock,
      {
        force: options.force,
        owned: (content) => parseLock(content) !== null
      }
    );
    if (lockPlan.action !== "unchanged") changed = true;
    if (options.check) {
      return { changed, names: skills.map((skill) => skill.name), skills };
    }
    const skillsRootStatus = lstatSync2(skillsRoot);
    const skillsRootIdentity = {
      dev: skillsRootStatus.dev,
      ino: skillsRootStatus.ino
    };
    assertDirectoryIdentity(skillsRoot, skillsRootIdentity);
    const applied = [];
    try {
      for (const oldName of previouslyManaged) {
        if (desired.has(oldName)) continue;
        assertDirectoryIdentity(skillsRoot, skillsRootIdentity);
        const target = validateTarget(resolvedRoot, oldName);
        if (!existsSync2(target)) continue;
        const change = {
          backup: path2.join(backupRoot, oldName),
          name: oldName,
          published: false,
          target
        };
        applied.push(change);
        renameSync2(target, change.backup);
      }
      for (const skill of skills) {
        if (!replacements.has(skill.name)) continue;
        assertDirectoryIdentity(skillsRoot, skillsRootIdentity);
        const target = validateTarget(resolvedRoot, skill.name);
        const change = {
          backup: null,
          name: skill.name,
          published: false,
          target
        };
        applied.push(change);
        if (existsSync2(target)) {
          const backup = path2.join(backupRoot, skill.name);
          change.backup = backup;
          renameSync2(target, backup);
        }
        assertDirectoryIdentity(skillsRoot, skillsRootIdentity);
        validateTarget(resolvedRoot, skill.name);
        renameSync2(path2.join(stagedRoot, skill.name), target);
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
        applied
      );
      if (rollbackFailures.length) {
        throw new CoordinatorError(
          `Skill synchronization failed (${error instanceof Error ? error.message : String(error)}) and rollback was incomplete: ${rollbackFailures.join("; ")}.`,
          "SKILL_ROLLBACK_FAILED"
        );
      }
      throw error;
    }
    return { changed, names: skills.map((skill) => skill.name), skills };
  } finally {
    if (existsSync2(temporaryRoot)) rmSync(temporaryRoot, { recursive: true });
  }
}
function discoverSkillSources(repositoryDirectory) {
  const results = [];
  const visit = (directory, depth) => {
    if (depth > 9) return;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if ([".git", "node_modules", "dist", "build"].includes(entry.name)) continue;
      const absolute = path2.join(directory, entry.name);
      if (!entry.isDirectory()) continue;
      const relative = path2.relative(repositoryDirectory, absolute);
      if (existsSync2(path2.join(absolute, "SKILL.md")) && /(^|\/)\.agents\/(skills|flows)\/[a-z0-9-]+$/.test(relative)) {
        results.push(relative);
        continue;
      }
      visit(absolute, depth + 1);
    }
  };
  if (existsSync2(repositoryDirectory)) visit(repositoryDirectory, 0);
  return results.sort();
}

// src/agents/sync.ts
function owned(content) {
  return content.includes(AGENT_FILE_MARKER);
}
function generatedAgentPaths(root) {
  const paths = [];
  const direct = [".codex/config.toml", ".claude/CLAUDE.md"];
  for (const relativePath2 of direct) {
    const absolutePath = path3.join(root, relativePath2);
    if (existsSync3(absolutePath) && owned(readFileSync3(absolutePath, "utf8"))) {
      paths.push(relativePath2);
    }
  }
  const visit = (relativeDirectory) => {
    const absoluteDirectory = path3.join(root, relativeDirectory);
    if (!existsSync3(absoluteDirectory)) return;
    for (const entry of readdirSync2(absoluteDirectory, { withFileTypes: true })) {
      const relativePath2 = path3.posix.join(relativeDirectory, entry.name);
      if (entry.isDirectory()) visit(relativePath2);
      else if (entry.isFile() && owned(readFileSync3(path3.join(root, relativePath2), "utf8"))) {
        paths.push(relativePath2);
      }
    }
  };
  for (const directory of [
    ".codex/agents",
    ".cursor/agents",
    ".claude/agents",
    ".claude/commands",
    ".opencode/agents"
  ]) {
    visit(directory);
  }
  return paths.sort();
}
function renderAgentFiles(root, manifest, skillNames, force) {
  const plans = [
    planFile(root, "AGENTS.md", renderRootAgents(manifest), { force, owned })
  ];
  const tools = new Set(manifest.agents.tools);
  if (tools.has("codex")) {
    plans.push(
      planFile(root, ".codex/config.toml", renderCodexConfig(manifest), {
        force,
        owned
      })
    );
  }
  if (tools.has("claude")) {
    const claudeSkills = path3.join(root, ".claude", "skills");
    if (existsSync3(claudeSkills)) {
      throw new CoordinatorError(
        ".claude/skills would duplicate the canonical .agents/skills registry. Move it before syncing.",
        "DUPLICATE_SKILLS"
      );
    }
    plans.push(
      planFile(root, ".claude/CLAUDE.md", renderClaudeRoot(manifest), {
        force,
        owned
      })
    );
  }
  for (const repository of manifest.repositories) {
    const name = repository.agent.name ?? repository.id;
    if (tools.has("codex")) {
      plans.push(
        planFile(
          root,
          `.codex/agents/${name}.toml`,
          renderCodexAgent(manifest, repository),
          { force, owned }
        )
      );
    }
    if (tools.has("cursor")) {
      plans.push(
        planFile(
          root,
          `.cursor/agents/${name}.md`,
          renderCursorAgent(manifest, repository),
          { force, owned }
        )
      );
    }
    if (tools.has("claude")) {
      plans.push(
        planFile(
          root,
          `.claude/agents/${name}.md`,
          renderClaudeAgent(manifest, repository),
          { force, owned }
        )
      );
    }
    if (tools.has("opencode")) {
      plans.push(
        planFile(
          root,
          `.opencode/agents/${name}.md`,
          renderOpenCodeAgent(manifest, repository),
          { force, owned }
        )
      );
    }
  }
  if (tools.has("claude")) {
    for (const skillName of skillNames) {
      plans.push(
        planFile(
          root,
          `.claude/commands/${manifest.name}/${skillName}.md`,
          renderClaudeCommand(manifest, skillName),
          { force, owned }
        )
      );
    }
  }
  return plans;
}
function synchronizeAgents(root, manifest, generatorVersion, options = {}) {
  if (manifest.agents.manage === false) {
    return { changed: false, files: [], skills: [] };
  }
  const force = options.force ?? false;
  const skillResult = synchronizeSkills(root, manifest, generatorVersion, {
    check: options.check,
    force
  });
  const files = renderAgentFiles(root, manifest, skillResult.names, force);
  const desiredPaths = new Set(files.map((file) => file.relativePath));
  for (const stalePath of generatedAgentPaths(root)) {
    if (!desiredPaths.has(stalePath)) {
      files.push(planFileDeletion(root, stalePath, owned));
    }
  }
  const changed = skillResult.changed || changedPlans(files).length > 0;
  if (!options.check) applyFilePlans(files);
  return { changed, files, skills: skillResult.names };
}

// src/ci/sync.ts
import { existsSync as existsSync6, readFileSync as readFileSync6, readdirSync as readdirSync3 } from "fs";
import path7 from "path";

// src/ci/render.ts
import { existsSync as existsSync5, readFileSync as readFileSync5 } from "fs";
import path6 from "path";

// src/core/manifest.ts
import { existsSync as existsSync4, readFileSync as readFileSync4 } from "fs";
import path5 from "path";
import { parse, stringify } from "yaml";

// src/core/schema.ts
import path4 from "path";
import { z } from "zod";
var identifier = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "use lowercase kebab-case");
var singleLine = z.string().min(1).refine(
  (value2) => !/[\r\n]/.test(value2),
  "must be a single line"
);
var relativePath = z.string().min(1).refine(
  (value2) => !path4.isAbsolute(value2) && !value2.split(/[\\/]/).includes("..") && value2 !== ".",
  "must be a safe relative path"
);
var mirrorFallbackSchema = z.object({ mode: z.literal("mirror") });
var fixedFallbackSchema = z.object({
  mode: z.literal("fixed"),
  name: singleLine
});
var branchPolicySchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("mirror"),
    readOnly: z.boolean().default(false)
  }),
  z.object({
    mode: z.literal("fixed"),
    name: singleLine,
    readOnly: z.boolean().default(true)
  }),
  z.object({
    mode: z.literal("map"),
    branches: z.record(singleLine, singleLine).refine(
      (branches) => Object.keys(branches).length > 0,
      "must contain at least one branch mapping"
    ),
    fallback: z.union([mirrorFallbackSchema, fixedFallbackSchema]).optional(),
    readOnly: z.boolean().default(false)
  })
]);
var skillExportSchema = z.object({
  source: relativePath,
  name: identifier.optional()
});
var repositoryAgentSchema = z.object({
  name: identifier.optional(),
  description: z.string().min(1).optional(),
  instructions: z.array(z.string().min(1)).default([]),
  verify: z.array(z.string().min(1)).default([]),
  skills: z.array(skillExportSchema).default([])
});
var repositorySchema = z.object({
  id: identifier,
  path: relativePath,
  url: singleLine,
  branch: branchPolicySchema.default({ mode: "mirror", readOnly: false }),
  agent: repositoryAgentSchema.default({
    instructions: [],
    verify: [],
    skills: []
  })
});
var agentTools = z.enum(["codex", "claude", "cursor", "opencode"]);
var agentsSchema = z.object({
  manage: z.boolean().optional(),
  tools: z.array(agentTools).min(1).default(["codex"]),
  maxParallel: z.number().int().positive().max(16).default(4),
  skillCollision: z.enum(["namespace", "error"]).default("namespace")
});
var workflowRunStateSchema = z.object({
  provider: z.literal("workflow-runs")
});
var githubDeploymentStateSchema = z.object({
  provider: z.literal("github-deployment"),
  environment: singleLine
});
var deploymentComponentSchema = z.object({
  repository: identifier,
  workflow: singleLine,
  state: z.discriminatedUnion("provider", [
    workflowRunStateSchema,
    githubDeploymentStateSchema
  ]),
  dispatchInputs: z.record(z.string(), z.string()).default({})
}).strict();
var deploymentEnvironmentSchema = z.object({
  githubEnvironment: singleLine,
  allowedBranches: z.array(singleLine).default([]),
  components: z.record(identifier, deploymentComponentSchema).refine(
    (components) => Object.keys(components).length > 0,
    "must contain at least one deployment component"
  )
});
var deploymentsSchema = z.object({
  tokenSecret: z.string().regex(/^[A-Z_][A-Z0-9_]*$/, "must be an uppercase GitHub secret name").default("SUBREPO_ACTIONS_TOKEN"),
  environments: z.record(identifier, deploymentEnvironmentSchema).refine(
    (environments) => Object.keys(environments).length > 0,
    "must contain at least one deployment environment"
  )
});
var workspaceManifestSchema = z.object({
  path: relativePath,
  coordinatorToken: z.string().min(1).default("$coordinator"),
  mirrorActiveInLinkedWorktrees: z.boolean().default(false)
});
var coordinatorManifestSchema = z.object({
  schemaVersion: z.literal(1),
  name: identifier,
  remote: z.string().min(1).default("origin"),
  repositories: z.array(repositorySchema).min(1),
  workspaceManifest: workspaceManifestSchema.optional(),
  agents: agentsSchema.default({
    tools: ["codex"],
    maxParallel: 4,
    skillCollision: "namespace"
  }),
  deployments: deploymentsSchema.optional()
}).superRefine((manifest, context) => {
  const ids = /* @__PURE__ */ new Set();
  const paths = /* @__PURE__ */ new Set();
  const agentNames = /* @__PURE__ */ new Set();
  for (const [index, repository] of manifest.repositories.entries()) {
    if (ids.has(repository.id)) {
      context.addIssue({
        code: "custom",
        path: ["repositories", index, "id"],
        message: `duplicate repository id '${repository.id}'`
      });
    }
    if (paths.has(repository.path)) {
      context.addIssue({
        code: "custom",
        path: ["repositories", index, "path"],
        message: `duplicate repository path '${repository.path}'`
      });
    }
    const agentName2 = repository.agent.name ?? repository.id;
    if (agentNames.has(agentName2)) {
      context.addIssue({
        code: "custom",
        path: ["repositories", index, "agent", "name"],
        message: `duplicate resolved agent name '${agentName2}'`
      });
    }
    ids.add(repository.id);
    paths.add(repository.path);
    agentNames.add(agentName2);
  }
  for (const [environmentName, environment] of Object.entries(
    manifest.deployments?.environments ?? {}
  )) {
    for (const [componentName, component] of Object.entries(
      environment.components
    )) {
      if (!ids.has(component.repository)) {
        context.addIssue({
          code: "custom",
          path: [
            "deployments",
            "environments",
            environmentName,
            "components",
            componentName,
            "repository"
          ],
          message: `unknown repository '${component.repository}'`
        });
      }
    }
  }
});

// src/core/manifest.ts
var MANIFEST_NAME = "coordinator.yaml";
var GENERATED_MARKER = "Initialized by Agent Coordinator";
function findWorkspaceRoot(start = process.cwd()) {
  let current = path5.resolve(start);
  while (true) {
    if (existsSync4(path5.join(current, MANIFEST_NAME))) return current;
    const parent = path5.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}
function loadManifest(start = process.cwd()) {
  const root = findWorkspaceRoot(start);
  if (!root) {
    throw new CoordinatorError(
      `No ${MANIFEST_NAME} found from ${path5.resolve(start)}. Run 'coordinator init'.`,
      "WORKSPACE_NOT_FOUND"
    );
  }
  const manifestPath = path5.join(root, MANIFEST_NAME);
  let raw;
  try {
    raw = parse(readFileSync4(manifestPath, "utf8"));
  } catch (error) {
    throw new CoordinatorError(
      `${MANIFEST_NAME} could not be parsed: ${error instanceof Error ? error.message : String(error)}`,
      "INVALID_MANIFEST"
    );
  }
  const result = coordinatorManifestSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => `${issue.path.join(".") || MANIFEST_NAME}: ${issue.message}`).join("\n");
    throw new CoordinatorError(
      `${MANIFEST_NAME} is invalid:
${issues}`,
      "INVALID_MANIFEST"
    );
  }
  return { manifest: result.data, path: manifestPath, root };
}
function renderManifest(manifest) {
  return `# ${GENERATED_MARKER}. This file is project-owned; generated outputs derive from it.
${stringify(
    manifest,
    { lineWidth: 100 }
  )}`;
}
function githubRepositoryName(url) {
  const normalized = url.replace(/^git@github\.com:/, "").replace(/^https?:\/\/github\.com\//, "").replace(/\.git$/, "");
  return /^[^/]+\/[^/]+$/.test(normalized) ? normalized : null;
}

// src/ci/render.ts
var CI_MARKER = "Generated by Agent Coordinator";
function outputKey(value2) {
  return value2.replaceAll("-", "_");
}
function shellQuote(value2) {
  return `'${value2.replaceAll("'", `'"'"'`)}'`;
}
function yamlString(value2) {
  return JSON.stringify(value2);
}
function deploymentConfiguration(manifest) {
  if (!manifest.deployments) return null;
  const repositories = new Map(
    manifest.repositories.map((repository) => [repository.id, repository])
  );
  return {
    schemaVersion: 1,
    generatedBy: "agent-coordinator",
    environments: Object.fromEntries(
      Object.entries(manifest.deployments.environments).map(([name, environment]) => [
        name,
        {
          githubEnvironment: environment.githubEnvironment,
          allowedBranches: environment.allowedBranches,
          components: Object.fromEntries(
            Object.entries(environment.components).map(([componentName, component]) => {
              const repository = repositories.get(component.repository);
              if (!repository) {
                throw new CoordinatorError(
                  `Deployment component '${componentName}' references unknown repository '${component.repository}'.`
                );
              }
              const githubRepository2 = githubRepositoryName(repository.url);
              if (!githubRepository2) {
                throw new CoordinatorError(
                  `Repository '${repository.id}' needs a GitHub URL for coordinated deployments.`
                );
              }
              return [
                componentName,
                {
                  ...component,
                  branch: repository.branch,
                  path: repository.path,
                  githubRepository: githubRepository2
                }
              ];
            })
          )
        }
      ])
    )
  };
}
function renderDeploymentConfiguration(manifest) {
  const configuration = deploymentConfiguration(manifest);
  return configuration ? `${JSON.stringify(configuration, null, 2)}
` : null;
}
function planOutputs(componentNames) {
  return componentNames.flatMap((name) => {
    const key = outputKey(name);
    return [
      "required",
      "blocked",
      "reason",
      "repository",
      "workflow",
      "ref",
      "sha",
      "dispatch_inputs"
    ].map(
      (field) => `      ${key}_${field}: \${{ steps.plan.outputs.${key}_${field} }}`
    );
  }).join("\n");
}
function forceInputs(componentNames) {
  return componentNames.map((name) => {
    const key = outputKey(name);
    return `      force_${key}:
        description: Trigger ${name} even when its deployed revision is current
        required: false
        default: false
        type: boolean`;
  }).join("\n");
}
function forceEnvironment(componentNames) {
  return componentNames.map((name) => {
    const key = outputKey(name);
    return `          FORCE_${key.toUpperCase()}: \${{ inputs.force_${key} }}`;
  }).join("\n");
}
function triggerJob(componentName, githubEnvironment, tokenSecret) {
  const key = outputKey(componentName);
  return `
  trigger_${key}:
    name: ${componentName}
    needs: plan
    if: needs.plan.outputs.${key}_required == 'true'
    runs-on: ubuntu-latest
    timeout-minutes: 5
    environment: ${yamlString(githubEnvironment)}
    steps:
      - name: Trigger ${componentName} pipeline
        env:
          DESIRED_SHA: \${{ needs.plan.outputs.${key}_sha }}
          DISPATCH_INPUTS: \${{ needs.plan.outputs.${key}_dispatch_inputs }}
          GH_TOKEN: \${{ secrets.${tokenSecret} }}
          REPOSITORY: \${{ needs.plan.outputs.${key}_repository }}
          WORKFLOW: \${{ needs.plan.outputs.${key}_workflow }}
          WORKFLOW_REF: \${{ needs.plan.outputs.${key}_ref }}
        shell: bash
        run: |
          set -euo pipefail
          request=(
            --method POST
            -H 'Accept: application/vnd.github+json'
            -H 'X-GitHub-Api-Version: 2026-03-10'
            "repos/$REPOSITORY/actions/workflows/$WORKFLOW/dispatches"
            -f "ref=$WORKFLOW_REF"
          )
          while IFS=$'\\t' read -r input_key input_value; do
            request+=(-f "inputs[$input_key]=$input_value")
          done < <(jq -r 'to_entries[] | [.key, (.value | tostring)] | @tsv' <<< "$DISPATCH_INPUTS")

          response="$(gh api "\${request[@]}")"
          run_id="$(jq -r '.workflow_run_id // empty' <<< "$response")"
          run_url="$(jq -r '.html_url // empty' <<< "$response")"
          [[ -n "$run_id" && -n "$run_url" ]] || {
            echo "::error::GitHub did not return child run details"
            exit 1
          }

          child="$(gh api -H 'X-GitHub-Api-Version: 2026-03-10' "repos/$REPOSITORY/actions/runs/$run_id")"
          actual_sha="$(jq -r '.head_sha' <<< "$child")"
          if [[ "$actual_sha" != "$DESIRED_SHA" ]]; then
            gh api --method POST "repos/$REPOSITORY/actions/runs/$run_id/cancel" >/dev/null || true
            echo "::error::Triggered $actual_sha, expected $DESIRED_SHA"
            exit 1
          fi

          printf '## ${componentName} pipeline triggered\\n\\n[%s \xB7 run %s](%s)\\n' \\
            "$REPOSITORY" "$run_id" "$run_url" >> "$GITHUB_STEP_SUMMARY"
`;
}
function blockedJob(componentName) {
  const key = outputKey(componentName);
  return `
  blocked_${key}:
    name: ${componentName} blocked
    needs: plan
    if: needs.plan.outputs.${key}_blocked == 'true'
    runs-on: ubuntu-latest
    timeout-minutes: 2
    steps:
      - name: Report blocked component
        env:
          REASON: \${{ needs.plan.outputs.${key}_reason }}
        shell: bash
        run: |
          echo "::error::$REASON"
          exit 1
`;
}
function renderEnvironmentWorkflow(manifest, environmentName) {
  const deployments = manifest.deployments;
  const environment = deployments?.environments[environmentName];
  if (!deployments || !environment) {
    throw new CoordinatorError(`Unknown deployment environment '${environmentName}'.`);
  }
  const componentNames = Object.keys(environment.components);
  const triggerJobs = componentNames.map(
    (name) => `${triggerJob(name, environment.githubEnvironment, deployments.tokenSecret)}${blockedJob(name)}`
  ).join("");
  return `# ${CI_MARKER}. Edit coordinator.yaml and run coordinator ci sync.
name: Deploy ${environmentName}

run-name: Trigger ${environmentName} from \${{ github.ref_name }}

on:
  workflow_dispatch:
    inputs:
${forceInputs(componentNames)}

permissions:
  contents: read

concurrency:
  group: ${manifest.name}-${environmentName}-coordinator
  cancel-in-progress: false

jobs:
  plan:
    name: Plan deployment triggers
    runs-on: ubuntu-latest
    timeout-minutes: 5
    environment:
      name: ${yamlString(environment.githubEnvironment)}
      deployment: false
    outputs:
${planOutputs(componentNames)}
    steps:
      - name: Checkout coordinator
        uses: actions/checkout@v6
        with:
          fetch-depth: 1
          persist-credentials: false

      - name: Setup Node.js
        uses: actions/setup-node@v6
        with:
          node-version: 24

      - name: Compare gitlinks with deployment state
        id: plan
        env:
          GH_TOKEN: \${{ secrets.${deployments.tokenSecret} }}
          PREFERRED_REF: \${{ github.ref_name }}
          PREFERRED_REF_TYPE: \${{ github.ref_type }}
${forceEnvironment(componentNames)}
        shell: bash
        run: |
          set -euo pipefail
          [[ -n "\${GH_TOKEN:-}" ]] || {
            echo "::error::${deployments.tokenSecret} is required"
            exit 1
          }
          node .coordinator/runtime/deployment-plan.mjs \\
            .coordinator/deployments.json ${shellQuote(environmentName)}
${triggerJobs}`;
}
function loadPlannerTemplate() {
  const candidates = [
    path6.resolve(import.meta.dirname, "../../templates/deployment-plan.mjs"),
    path6.resolve(import.meta.dirname, "../templates/deployment-plan.mjs")
  ];
  const template = candidates.find((candidate) => existsSync5(candidate));
  if (!template) {
    throw new CoordinatorError("Bundled deployment planner template is missing.");
  }
  return readFileSync5(template, "utf8");
}

// src/ci/sync.ts
function owned2(content) {
  return content.includes(CI_MARKER) || content.includes('"generatedBy": "agent-coordinator"') || content.includes("export async function buildDeploymentPlan");
}
function generatedCiPaths(root) {
  const paths = [];
  for (const relativePath2 of [
    ".coordinator/deployments.json",
    ".coordinator/runtime/deployment-plan.mjs"
  ]) {
    const absolutePath = path7.join(root, relativePath2);
    if (existsSync6(absolutePath) && owned2(readFileSync6(absolutePath, "utf8"))) {
      paths.push(relativePath2);
    }
  }
  const workflows = path7.join(root, ".github", "workflows");
  if (existsSync6(workflows)) {
    for (const entry of readdirSync3(workflows, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const relativePath2 = path7.posix.join(".github/workflows", entry.name);
      if (owned2(readFileSync6(path7.join(root, relativePath2), "utf8"))) {
        paths.push(relativePath2);
      }
    }
  }
  return paths.sort();
}
function synchronizeCi(root, manifest, options = {}) {
  const force = options.force ?? false;
  const files = manifest.deployments ? [
    planFile(
      root,
      ".coordinator/deployments.json",
      renderDeploymentConfiguration(manifest),
      { force, owned: owned2 }
    ),
    planFile(
      root,
      ".coordinator/runtime/deployment-plan.mjs",
      loadPlannerTemplate(),
      { force, owned: (content) => content.includes("buildDeploymentPlan") }
    ),
    ...Object.keys(manifest.deployments.environments).map(
      (environment) => planFile(
        root,
        `.github/workflows/coordinator-deploy-${environment}.yml`,
        renderEnvironmentWorkflow(manifest, environment),
        { force, owned: owned2 }
      )
    )
  ] : [];
  const desiredPaths = new Set(files.map((file) => file.relativePath));
  for (const stalePath of generatedCiPaths(root)) {
    if (!desiredPaths.has(stalePath)) {
      files.push(planFileDeletion(root, stalePath, owned2));
    }
  }
  const changed = changedPlans(files).length > 0;
  if (!options.check) applyFilePlans(files);
  return { changed, files };
}

// src/doctor/check.ts
import { existsSync as existsSync9 } from "fs";
import path10 from "path";

// src/git/adapter.ts
import { existsSync as existsSync8 } from "fs";
import path9 from "path";

// src/git/bootstrap.ts
import {
  existsSync as existsSync7,
  mkdirSync as mkdirSync3,
  realpathSync as realpathSync2,
  statSync
} from "fs";
import os2 from "os";
import path8 from "path";
var PINNED_GIT_COORDINATOR = {
  repository: "fedecardinali/git-coordinator",
  cloneUrl: "https://github.com/fedecardinali/git-coordinator.git",
  // Retained by the immutable Git Coordinator v0.4.1 tag.
  ref: "91cc23ab35009855c5ef733f8bb313169ce65355"
};
function environmentFor(options) {
  return options.environment ?? process.env;
}
function sourceFor(options) {
  return options.source ?? PINNED_GIT_COORDINATOR;
}
function agentCoordinatorHome(environment = process.env) {
  const configured = environment.AGENT_COORDINATOR_HOME?.trim();
  if (configured) return path8.resolve(configured);
  const home2 = environment.HOME?.trim() || os2.homedir();
  return path8.join(home2, ".local", "share", "agent-coordinator");
}
function assertImmutableRef(ref) {
  if (!/^[0-9a-f]{40}$/i.test(ref)) {
    throw new CoordinatorError(
      `Git Coordinator bootstrap ref must be a full immutable commit SHA: ${ref}`,
      "GIT_COORDINATOR_REF_INVALID"
    );
  }
}
function gitCoordinatorCheckoutPath(options = {}) {
  const source = sourceFor(options);
  assertImmutableRef(source.ref);
  return path8.join(
    agentCoordinatorHome(environmentFor(options)),
    "git-engines",
    "git-coordinator",
    source.ref
  );
}
function commandAvailable2(command, environment) {
  return runCommand(
    "/bin/sh",
    ["-c", 'command -v -- "$1" >/dev/null 2>&1', "sh", command],
    { allowFailure: true, env: environment }
  ).status === 0;
}
function git(argumentsList, environment, allowFailure = false) {
  return runCommand("git", argumentsList, {
    allowFailure,
    env: environment
  });
}
function normalizedGithubRepository(value2) {
  const trimmed = value2.trim().replace(/\/+$/, "");
  const match = trimmed.match(/^https?:\/\/github\.com\/([^/]+\/[^/]+)$/i) ?? trimmed.match(/^git@github\.com:([^/]+\/[^/]+)$/i) ?? trimmed.match(/^ssh:\/\/git@github\.com\/([^/]+\/[^/]+)$/i);
  return match?.[1]?.replace(/\.git$/i, "").toLowerCase() ?? null;
}
function sameRemote(actual, source) {
  const actualGithub = normalizedGithubRepository(actual);
  const expectedGithub = normalizedGithubRepository(source.cloneUrl);
  if (actualGithub && expectedGithub) return actualGithub === expectedGithub;
  if (path8.isAbsolute(actual) && path8.isAbsolute(source.cloneUrl)) {
    try {
      return realpathSync2(actual) === realpathSync2(source.cloneUrl);
    } catch {
      return path8.resolve(actual) === path8.resolve(source.cloneUrl);
    }
  }
  return actual.replace(/\/+$/, "") === source.cloneUrl.replace(/\/+$/, "");
}
function cacheInvalid(checkout, detail) {
  return new CoordinatorError(
    `Managed Git Coordinator cache is not the immutable expected checkout at ${checkout}: ${detail}. The cache was left untouched; choose a new AGENT_COORDINATOR_HOME or inspect it manually.`,
    "GIT_COORDINATOR_CACHE_INVALID"
  );
}
function verifyBootstrappedGitCoordinator(options = {}) {
  const environment = environmentFor(options);
  const source = sourceFor(options);
  const checkout = gitCoordinatorCheckoutPath(options);
  if (!existsSync7(checkout)) return null;
  if (!commandAvailable2("git", environment)) {
    throw new CoordinatorError(
      "Git is required to verify the managed Git Coordinator engine. Install the Xcode Command Line Tools with 'xcode-select --install' and retry.",
      "GIT_MISSING"
    );
  }
  const version = git(["--version"], environment, true);
  if (version.status !== 0) {
    throw new CoordinatorError(
      `Git is present but could not run: ${version.stderr || version.stdout || `exit ${version.status}`}. Install or repair the Xcode Command Line Tools and retry.`,
      "GIT_UNAVAILABLE"
    );
  }
  const cli = path8.join(checkout, "src", "cli.mjs");
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
      `HEAD is ${head.stdout || "unreadable"}, expected ${source.ref}`
    );
  }
  const branch = git(
    ["-C", checkout, "symbolic-ref", "--quiet", "HEAD"],
    environment,
    true
  );
  if (branch.status === 0) {
    throw cacheInvalid(checkout, `HEAD is attached to ${branch.stdout}`);
  }
  const status = git(
    ["-C", checkout, "status", "--porcelain", "--untracked-files=all"],
    environment,
    true
  );
  if (status.status !== 0 || status.stdout) {
    throw cacheInvalid(
      checkout,
      status.stdout ? "the checkout has local changes" : "Git status failed"
    );
  }
  const remote = git(
    ["-C", checkout, "remote", "get-url", "origin"],
    environment,
    true
  );
  if (remote.status !== 0 || !sameRemote(remote.stdout, source)) {
    throw cacheInvalid(
      checkout,
      `origin is ${remote.stdout || "missing"}, expected ${source.cloneUrl}`
    );
  }
  return { checkout, cli, ref: source.ref };
}
function cloneFailure(checkout, detail, usedGithubCli) {
  const authentication = usedGithubCli ? "Confirm access with 'gh auth status --hostname github.com'." : "Authenticate Git for GitHub, or install GitHub CLI and run 'gh auth login'.";
  return new CoordinatorError(
    `Could not bootstrap the private Git Coordinator engine at ${checkout}: ${detail}. ${authentication} The partial cache was left untouched for inspection.`,
    "GIT_COORDINATOR_BOOTSTRAP_FAILED"
  );
}
function bootstrapGitCoordinator(options = {}) {
  const existing = verifyBootstrappedGitCoordinator(options);
  if (existing) return existing;
  const environment = environmentFor(options);
  const source = sourceFor(options);
  if (!commandAvailable2("git", environment)) {
    throw new CoordinatorError(
      "Git is required to install Git Coordinator. Install the Xcode Command Line Tools with 'xcode-select --install' and retry.",
      "GIT_MISSING"
    );
  }
  const version = git(["--version"], environment, true);
  if (version.status !== 0) {
    throw new CoordinatorError(
      `Git is present but could not run: ${version.stderr || version.stdout || `exit ${version.status}`}. Install or repair the Xcode Command Line Tools and retry.`,
      "GIT_UNAVAILABLE"
    );
  }
  const checkout = gitCoordinatorCheckoutPath(options);
  const parent = path8.dirname(checkout);
  try {
    mkdirSync3(parent, { recursive: true });
    mkdirSync3(checkout);
  } catch (error) {
    if (existsSync7(checkout)) {
      const raced = verifyBootstrappedGitCoordinator(options);
      if (raced) return raced;
    }
    const detail = error instanceof Error ? error.message : String(error);
    throw new CoordinatorError(
      `Could not reserve the managed Git Coordinator cache at ${checkout}: ${detail}. No existing cache was replaced.`,
      "GIT_COORDINATOR_CACHE_CREATE_FAILED"
    );
  }
  const ghAvailable = commandAvailable2("gh", environment);
  const ghAuthenticated = ghAvailable && runCommand(
    "gh",
    ["auth", "status", "--hostname", "github.com"],
    { allowFailure: true, env: environment }
  ).status === 0;
  const clone = ghAuthenticated ? runCommand(
    "gh",
    [
      "repo",
      "clone",
      source.repository,
      checkout,
      "--",
      "--filter=blob:none",
      "--no-checkout"
    ],
    { allowFailure: true, env: environment }
  ) : git(
    [
      "clone",
      "--filter=blob:none",
      "--no-checkout",
      source.cloneUrl,
      checkout
    ],
    environment,
    true
  );
  if (clone.status !== 0) {
    throw cloneFailure(
      checkout,
      clone.stderr || clone.stdout || `exit ${clone.status}`,
      ghAuthenticated
    );
  }
  const checkoutResult = git(
    ["-C", checkout, "checkout", "--detach", source.ref],
    environment,
    true
  );
  if (checkoutResult.status !== 0) {
    throw cloneFailure(
      checkout,
      `the pinned ref ${source.ref} could not be checked out: ${checkoutResult.stderr || checkoutResult.stdout || `exit ${checkoutResult.status}`}`,
      ghAuthenticated
    );
  }
  const verified = verifyBootstrappedGitCoordinator(options);
  if (!verified) {
    throw cacheInvalid(checkout, "the checkout disappeared after cloning");
  }
  return verified;
}

// src/git/adapter.ts
function sourceLocation(source) {
  return {
    kind: "source",
    command: process.execPath,
    arguments: [source],
    path: source
  };
}
function commandAvailable3(command, environment) {
  return runCommand(
    "/bin/sh",
    ["-c", 'command -v -- "$1" >/dev/null 2>&1', "sh", command],
    { allowFailure: true, env: environment }
  ).status === 0;
}
function explicitLocation(environment) {
  const explicit = environment.AGENT_COORDINATOR_GIT_COORDINATOR;
  if (!explicit) return null;
  if (!existsSync8(explicit)) {
    throw new CoordinatorError(
      `AGENT_COORDINATOR_GIT_COORDINATOR does not exist: ${explicit}`
    );
  }
  return explicit.endsWith(".mjs") || explicit.endsWith(".js") ? sourceLocation(explicit) : { kind: "command", command: explicit, arguments: [] };
}
function localSourceLocation(workspace, bootstrapOptions) {
  if (bootstrapOptions.includeLocalCheckouts !== true) return null;
  const candidates = [
    path9.resolve(workspace, "../git-coordinator/src/cli.mjs"),
    path9.resolve(import.meta.dirname, "../../../git-coordinator/src/cli.mjs")
  ];
  const source = candidates.find((candidate) => existsSync8(candidate));
  return source ? sourceLocation(source) : null;
}
function managedSourceLocation(bootstrapOptions) {
  const managed = verifyBootstrappedGitCoordinator(bootstrapOptions);
  return managed ? sourceLocation(managed.cli) : null;
}
function findGitCoordinator(workspace = process.cwd(), bootstrapOptions = {}) {
  const environment = bootstrapOptions.environment ?? process.env;
  const explicit = explicitLocation(environment);
  if (explicit) return explicit;
  const local = localSourceLocation(workspace, bootstrapOptions);
  if (local) return local;
  const managed = managedSourceLocation(bootstrapOptions);
  if (managed) return managed;
  if (commandAvailable3("git-coordinator", environment)) {
    return { kind: "command", command: "git-coordinator", arguments: [] };
  }
  return null;
}
function runGitCoordinator(location, subcommand, workspace, options = {}) {
  const argumentsList = [...location.arguments, subcommand];
  if (subcommand !== "global-install") argumentsList.push(workspace);
  return runCommand(location.command, argumentsList, {
    cwd: workspace,
    allowFailure: options.allowFailure,
    stdio: options.stdio,
    env: options.environment
  });
}
function invokeGitCoordinator(subcommand, workspace, options = {}) {
  const location = findGitCoordinator(workspace, options.bootstrap);
  if (!location) {
    throw new CoordinatorError(
      "Git Coordinator is not installed. Run 'coordinator install' to install the pinned compatibility runtime, then retry.",
      "GIT_COORDINATOR_MISSING"
    );
  }
  return runGitCoordinator(location, subcommand, workspace, {
    allowFailure: options.allowFailure,
    stdio: options.stdio,
    environment: options.bootstrap?.environment
  });
}
function installGitRuntime(workspace = process.cwd(), bootstrapOptions = {}, stdio = "inherit") {
  const environment = bootstrapOptions.environment ?? process.env;
  const location = explicitLocation(environment) ?? localSourceLocation(workspace, bootstrapOptions) ?? managedSourceLocation(bootstrapOptions) ?? sourceLocation(bootstrapGitCoordinator(bootstrapOptions).cli);
  return runGitCoordinator(location, "global-install", workspace, {
    stdio,
    environment: bootstrapOptions.environment
  });
}

// src/git/configuration.ts
function gitConfiguration(manifest) {
  const configuration = {
    schemaVersion: 2,
    generatedBy: "agent-coordinator",
    remote: manifest.remote,
    repositories: manifest.repositories.map((repository) => ({
      id: repository.id,
      path: repository.path,
      branch: repository.branch
    }))
  };
  if (manifest.workspaceManifest) {
    configuration.workspaceManifest = manifest.workspaceManifest;
  }
  return configuration;
}
function renderGitConfiguration(manifest) {
  return `${JSON.stringify(gitConfiguration(manifest), null, 2)}
`;
}
function isOwnedGitConfiguration(content) {
  try {
    const parsed = JSON.parse(content);
    return parsed.generatedBy === "agent-coordinator";
  } catch {
    return false;
  }
}

// src/workspace/sync.ts
function synchronizeWorkspace(root, manifest, generatorVersion, options = {}) {
  const git4 = planFile(
    root,
    ".git-coordinator.json",
    renderGitConfiguration(manifest),
    {
      force: options.force,
      owned: isOwnedGitConfiguration
    }
  );
  const previewOptions = { ...options, check: true };
  const previewAgents = synchronizeAgents(
    root,
    manifest,
    generatorVersion,
    previewOptions
  );
  const previewCi = synchronizeCi(root, manifest, previewOptions);
  if (options.check) {
    return {
      git: git4,
      agents: previewAgents,
      ci: previewCi,
      changed: changedPlans([git4]).length > 0 || previewAgents.changed || previewCi.changed
    };
  }
  applyFilePlans([git4]);
  const agents2 = synchronizeAgents(root, manifest, generatorVersion, options);
  const ci2 = synchronizeCi(root, manifest, options);
  return {
    git: git4,
    agents: agents2,
    ci: ci2,
    changed: changedPlans([git4]).length > 0 || previewAgents.changed || previewCi.changed
  };
}

// src/doctor/check.ts
function check(label, operation) {
  try {
    const result = operation();
    return { label, detail: result.detail, status: result.status ?? "pass" };
  } catch (error) {
    return { label, detail: errorMessage(error), status: "fail" };
  }
}
function runDoctor(root, manifest, version) {
  const checks = [];
  checks.push(
    check("Node.js", () => {
      const [major, minor] = process.versions.node.split(".").map(Number);
      const supported = major > 20 || major === 20 && minor >= 12;
      return {
        detail: `Node ${process.versions.node}`,
        status: supported ? "pass" : "fail"
      };
    })
  );
  checks.push(
    check("Git", () => ({
      detail: runCommand("git", ["--version"]).stdout
    }))
  );
  checks.push(
    check("GitHub CLI", () => {
      if (!commandAvailable("gh")) return { detail: "gh is not installed", status: "warn" };
      const auth = runCommand("gh", ["auth", "status"], { allowFailure: true });
      return {
        detail: auth.status === 0 ? "authenticated" : "installed, not authenticated",
        status: auth.status === 0 ? "pass" : "warn"
      };
    })
  );
  checks.push(
    check("Repositories", () => {
      const missing = manifest.repositories.filter(
        (repository) => !existsSync9(path10.join(root, repository.path, ".git"))
      );
      return missing.length ? {
        detail: `missing: ${missing.map((repository) => repository.id).join(", ")}`,
        status: "fail"
      } : { detail: `${manifest.repositories.length} initialized` };
    })
  );
  checks.push(
    check("Gitlinks", () => {
      const result = runCommand("git", ["-C", root, "submodule", "status", "--recursive"], {
        allowFailure: true,
        env: { GIT_COORDINATOR_INTERNAL: "1" }
      });
      if (result.status !== 0) return { detail: result.stderr || "unavailable", status: "warn" };
      const drift = result.stdout.split("\n").filter((line) => /^(?:\+|-|U)/.test(line));
      return drift.length ? { detail: `${drift.length} submodule revisions differ from gitlinks`, status: "fail" } : { detail: "all initialized submodules match their gitlinks" };
    })
  );
  checks.push(
    check("Generated configuration", () => {
      const result = synchronizeWorkspace(root, manifest, version, { check: true });
      return result.changed ? { detail: "generated files are stale; run coordinator sync", status: "fail" } : {
        detail: manifest.agents.manage === false ? "Git and CI are synchronized; existing agent files are intentionally unmanaged" : "Git, agents, skills, and CI are synchronized"
      };
    })
  );
  checks.push(
    check("Git Coordinator", () => {
      if (!findGitCoordinator(root)) {
        return { detail: "runtime not installed", status: "fail" };
      }
      const result = invokeGitCoordinator("check", root, { allowFailure: true });
      return result.status === 0 ? { detail: result.stdout || "invariant OK" } : { detail: result.stderr || result.stdout, status: "fail" };
    })
  );
  return {
    checks,
    healthy: !checks.some((item) => item.status === "fail")
  };
}

// src/status/inspect.ts
import { existsSync as existsSync10, readdirSync as readdirSync4 } from "fs";
import path11 from "path";
function gitText2(directory, argumentsList) {
  const result = runCommand("git", ["-c", "core.hooksPath=/dev/null", "-C", directory, ...argumentsList], {
    allowFailure: true,
    env: { GIT_COORDINATOR_INTERNAL: "1" }
  });
  return result.status === 0 ? result.stdout : null;
}
function policyLabel(repository) {
  if (repository.branch.mode === "fixed") return `fixed:${repository.branch.name}`;
  if (repository.branch.mode === "map") return "mapped";
  return "mirror";
}
function inspectRepository(root, repository) {
  const directory = path11.join(root, repository.path);
  if (!existsSync10(directory)) {
    return {
      id: repository.id,
      branch: "\u2014",
      policy: policyLabel(repository),
      readOnly: repository.branch.readOnly,
      health: "blocked",
      state: "missing"
    };
  }
  const branch = gitText2(directory, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  const dirty = gitText2(directory, ["status", "--porcelain"]);
  const detached = !branch;
  return {
    id: repository.id,
    branch: branch ?? "detached",
    policy: policyLabel(repository),
    readOnly: repository.branch.readOnly,
    health: detached && !repository.branch.readOnly ? "attention" : "ready",
    state: dirty ? "modified" : repository.branch.readOnly ? "read-only" : "clean"
  };
}
function inspectWorkspace(root, manifest, version) {
  const repositories = manifest.repositories.map(
    (repository) => inspectRepository(root, repository)
  );
  const rootBranch = gitText2(root, ["symbolic-ref", "--quiet", "--short", "HEAD"]) ?? "unborn";
  const skillsDirectory = path11.join(root, ".agents", "skills");
  const skills = existsSync10(skillsDirectory) ? readdirSync4(skillsDirectory, { withFileTypes: true }).filter(
    (entry) => entry.isDirectory() && existsSync10(path11.join(skillsDirectory, entry.name, "SKILL.md"))
  ).length : 0;
  const environments = Object.values(manifest.deployments?.environments ?? {});
  const health = repositories.some((repository) => repository.health === "blocked") ? "blocked" : repositories.some((repository) => repository.health === "attention") || manifest.agents.manage === false ? "attention" : "ready";
  return {
    name: manifest.name,
    root,
    branch: rootBranch,
    repositories,
    agents: {
      managed: manifest.agents.manage !== false,
      tools: manifest.agents.tools,
      skills
    },
    ci: {
      environments: environments.length,
      components: environments.reduce(
        (total, environment) => total + Object.keys(environment.components).length,
        0
      )
    },
    gitRuntime: findGitCoordinator(root) !== null,
    health,
    version
  };
}
function demoWorkspaceStatus(version) {
  return {
    name: "market-intel",
    root: "~/Developer/market-intel-coordinator",
    branch: "feature/MIQ-8-sentry-feedback",
    gitRuntime: true,
    health: "ready",
    version,
    repositories: [
      {
        id: "backend",
        branch: "feature/MIQ-8-sentry-feedback",
        policy: "mirror",
        readOnly: false,
        health: "ready",
        state: "clean"
      },
      {
        id: "frontend",
        branch: "feature/MIQ-8-sentry-feedback",
        policy: "mirror",
        readOnly: false,
        health: "ready",
        state: "clean"
      },
      {
        id: "infra",
        branch: "main",
        policy: "fixed:main",
        readOnly: true,
        health: "ready",
        state: "read-only"
      }
    ],
    agents: {
      managed: true,
      tools: ["Codex", "Claude", "Cursor", "OpenCode"],
      skills: 29
    },
    ci: { environments: 2, components: 4 }
  };
}

// src/ui/dashboard.ts
import pc from "picocolors";
var WIDTH = 78;
function truncate(value2, width) {
  if (value2.length <= width) return value2.padEnd(width);
  return `${value2.slice(0, Math.max(0, width - 1))}\u2026`;
}
function colorize(enabled) {
  return {
    accent: (value2) => enabled ? pc.cyan(value2) : value2,
    brand: (value2) => enabled ? pc.magenta(value2) : value2,
    dim: (value2) => enabled ? pc.dim(value2) : value2,
    ready: (value2) => enabled ? pc.green(value2) : value2,
    attention: (value2) => enabled ? pc.yellow(value2) : value2,
    blocked: (value2) => enabled ? pc.red(value2) : value2
  };
}
function indicator(health) {
  if (health === "ready") return "\u25CF";
  if (health === "attention") return "\u25C6";
  return "\xD7";
}
function section(title) {
  const left = `\u2500 ${title} `;
  return `\u251C${left}${"\u2500".repeat(Math.max(0, WIDTH - left.length - 2))}\u2524`;
}
function row(content) {
  const plain = content.replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "");
  const padding = " ".repeat(Math.max(0, WIDTH - 3 - plain.length));
  return `\u2502 ${content}${padding}\u2502`;
}
function renderDashboard(status, options = {}) {
  const useColor = options.color ?? !process.env.NO_COLOR;
  const c = colorize(useColor);
  const lines = [];
  const title = ` Agent Coordinator \xB7 ${status.name} `;
  const version = `v${status.version} `;
  const fill = Math.max(1, WIDTH - title.length - version.length - 2);
  lines.push(c.brand(`\u256D${title}${"\u2500".repeat(fill)}${version}\u256E`));
  lines.push(row(`${c.accent("branch")}  ${status.branch}`));
  lines.push(section("Repositories"));
  for (const repository of status.repositories) {
    const healthColor = c[repository.health];
    const id = repository.id.padEnd(12);
    const policy = repository.policy.padEnd(13);
    const branch = truncate(repository.branch, 27);
    lines.push(
      row(
        `${healthColor(indicator(repository.health))} ${id} ${c.dim(policy)} ${branch} ${c.dim(repository.state)}`
      )
    );
  }
  lines.push(section("Agent tooling"));
  lines.push(
    row(
      status.agents.managed ? `${c.ready("\u25CF")} ${status.agents.tools.join("  ")}   ${c.accent(String(status.agents.skills))} skills synced` : `${c.attention("\u25C6")} ${status.agents.tools.join("  ")}   existing agent files unmanaged`
    )
  );
  lines.push(section("Delivery"));
  lines.push(
    row(
      `${status.gitRuntime ? c.ready("\u25CF Git runtime ready") : c.blocked("\xD7 Git runtime missing")}   ${c.accent(String(status.ci.environments))} environments   ${c.accent(String(status.ci.components))} component routes`
    )
  );
  if (options.footer !== false) {
    lines.push(section("Actions"));
    lines.push(
      row(
        `${c.accent("[s]")} synchronize   ${c.accent("[d]")} doctor   ${c.accent("[q]")} exit`
      )
    );
  }
  lines.push(c.brand(`\u2570${"\u2500".repeat(WIDTH - 2)}\u256F`));
  return lines.join("\n");
}

// src/ui/prompts.ts
import {
  cancel,
  confirm,
  intro,
  isCancel,
  multiselect,
  note,
  outro,
  select,
  text
} from "@clack/prompts";
import path12 from "path";
import pc2 from "picocolors";
function value(input) {
  if (isCancel(input)) {
    cancel("No changes were made.");
    throw new CoordinatorError("Operation cancelled.", "CANCELLED");
  }
  return input;
}
function slug(input) {
  return input.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}
function roleSuggestion(repositoryName) {
  const name = repositoryName.toLowerCase();
  if (/(back-?end|api-core|server)$/.test(name)) return "backend";
  if (/(front-?end|web-admin|client|web)$/.test(name)) return "frontend";
  if (/(infra|infrastructure|terraform)$/.test(name)) return "infra";
  if (/(e2e|end-to-end)$/.test(name)) return "e2e";
  if (/api-tests?$/.test(name)) return "api-tests";
  return slug(repositoryName);
}
function currentGithubUser() {
  if (!commandAvailable("gh")) return void 0;
  const result = runCommand("gh", ["api", "user", "--jq", ".login"], {
    allowFailure: true
  });
  return result.status === 0 ? result.stdout : void 0;
}
function listGithubRepositories(owner) {
  const result = runCommand(
    "gh",
    [
      "repo",
      "list",
      owner,
      "--limit",
      "200",
      "--json",
      "name,nameWithOwner,description,sshUrl,isPrivate"
    ],
    { allowFailure: true }
  );
  if (result.status !== 0) {
    throw new CoordinatorError(
      result.stderr || `Could not list repositories for ${owner}.`
    );
  }
  return JSON.parse(result.stdout);
}
async function branchPolicy(repository) {
  const mode = value(
    await select({
      message: `How should ${repository} follow coordinator branches?`,
      options: [
        {
          value: "mirror",
          label: "Mirror",
          hint: "same branch name as the coordinator"
        },
        {
          value: "fixed",
          label: "Fixed writable",
          hint: "always use one branch"
        },
        {
          value: "read-only",
          label: "Fixed read-only",
          hint: "pin a stable repository such as infrastructure"
        }
      ]
    })
  );
  if (mode === "mirror") return { mode: "mirror", readOnly: false };
  const name = value(
    await text({
      message: `Fixed branch for ${repository}`,
      defaultValue: "main",
      placeholder: "main",
      validate: (input) => input?.trim() ? void 0 : "A branch is required"
    })
  );
  return { mode: "fixed", name, readOnly: mode === "read-only" };
}
async function promptWorkspaceManifest(directory) {
  intro(pc2.bgMagenta(pc2.white(" Agent Coordinator \xB7 new workspace ")));
  const suggestedName = slug(path12.basename(path12.resolve(directory))) || "workspace";
  const name = value(
    await text({
      message: "Workspace name",
      defaultValue: suggestedName,
      placeholder: suggestedName,
      validate: (input) => /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(input ?? "") ? void 0 : "Use lowercase kebab-case"
    })
  );
  const suggestedOwner = currentGithubUser();
  const owner = value(
    await text({
      message: "GitHub owner or organization",
      ...suggestedOwner ? { defaultValue: suggestedOwner } : {},
      placeholder: "your-organization",
      validate: (input) => input?.trim() ? void 0 : "An owner is required"
    })
  );
  const available = listGithubRepositories(owner);
  const chosen = value(
    await multiselect({
      message: "Select the repositories that form this workspace",
      required: true,
      options: available.map((repository) => ({
        value: repository.nameWithOwner,
        label: repository.name,
        hint: `${repository.isPrivate ? "private" : "public"}${repository.description ? ` \xB7 ${repository.description}` : ""}`
      }))
    })
  );
  const selectedRepositories = chosen.map(
    (nameWithOwner) => available.find((repository) => repository.nameWithOwner === nameWithOwner)
  );
  const usedIds = /* @__PURE__ */ new Set();
  const repositories = [];
  for (const repository of selectedRepositories) {
    const suggestedId = roleSuggestion(repository.name);
    const id = value(
      await text({
        message: `Role id for ${repository.name}`,
        defaultValue: suggestedId,
        placeholder: suggestedId,
        validate: (input) => {
          if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(input ?? "")) {
            return "Use lowercase kebab-case";
          }
          if (usedIds.has(input)) return "That role id is already used";
          return void 0;
        }
      })
    );
    usedIds.add(id);
    const policy = await branchPolicy(id);
    repositories.push({
      id,
      path: repository.name,
      url: repository.sshUrl,
      branch: policy,
      agent: { instructions: [], verify: [], skills: [] }
    });
  }
  const tools = value(
    await multiselect({
      message: "Generate project agents for",
      initialValues: ["codex", "claude"],
      required: true,
      options: [
        { value: "codex", label: "Codex" },
        { value: "claude", label: "Claude Code" },
        { value: "cursor", label: "Cursor" },
        { value: "opencode", label: "OpenCode" }
      ]
    })
  );
  const discoverSkills = value(
    await confirm({
      message: "Discover and materialize committed skills from the selected repositories?",
      initialValue: true
    })
  );
  note(
    [
      `${repositories.length} repositories`,
      `${tools.length} agent runtimes`,
      discoverSkills ? "committed skills will be discovered" : "skills can be added later",
      "Git Coordinator will preserve ordinary git commands",
      "a compatible Git runtime may be installed machine-wide"
    ].join("\n"),
    "Plan"
  );
  const proceed = value(
    await confirm({
      message: `Initialize ${name} in ${path12.resolve(directory)}?`,
      initialValue: true
    })
  );
  if (!proceed) {
    cancel("No changes were made.");
    throw new CoordinatorError("Operation cancelled.", "CANCELLED");
  }
  return {
    discoverSkills,
    manifest: {
      schemaVersion: 1,
      name,
      remote: "origin",
      repositories,
      agents: {
        tools,
        maxParallel: Math.min(4, Math.max(1, repositories.length)),
        skillCollision: "namespace"
      }
    }
  };
}
function finishWorkspacePrompt() {
  outro("Workspace verified. Ready to coordinate.");
}
async function promptDashboardAction() {
  return value(
    await select({
      message: "What would you like to do?",
      options: [
        { value: "status", label: "Refresh status" },
        { value: "sync", label: "Synchronize Git, agents, skills, and CI" },
        { value: "doctor", label: "Run workspace doctor" },
        { value: "exit", label: "Exit" }
      ]
    })
  );
}

// package.json
var package_default = {
  name: "agent-coordinator",
  version: "0.1.3",
  private: true,
  description: "A beautiful control plane for multi-repository Git, coding agents, and delivery workflows.",
  type: "module",
  bin: {
    coordinator: "./dist/cli.js"
  },
  files: [
    "dist",
    "docs/assets",
    "templates",
    "README.md"
  ],
  engines: {
    node: ">=20.12.0"
  },
  scripts: {
    compile: "tsup",
    dev: "tsx src/cli.ts",
    typecheck: "tsc --noEmit",
    test: "tsx --test test/**/*.test.ts",
    "check:dist": "git diff --exit-code -- dist",
    check: "npm run typecheck && npm test && npm run compile && npm run check:dist",
    "demo:asset": "npm run compile && node scripts/render-terminal-demo.mjs"
  },
  dependencies: {
    "@clack/prompts": "^1.7.0",
    commander: "^14.0.3",
    picocolors: "^1.1.1",
    yaml: "^2.9.0",
    zod: "^4.4.3"
  },
  devDependencies: {
    "@types/node": "^20.19.27",
    tsup: "^8.5.1",
    tsx: "^4.20.6",
    typescript: "^7.0.2"
  },
  overrides: {
    esbuild: "^0.28.1"
  },
  license: "UNLICENSED"
};

// src/version.ts
var VERSION = package_default.version;

// src/update/check.ts
var PROJECT_REPOSITORY = "fedecardinali/agent-coordinator";
var SEMVER_TAG = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
function parseReleaseTag(tag) {
  const match = SEMVER_TAG.exec(tag);
  if (!match) {
    throw new CoordinatorError(
      `Latest release tag '${tag}' is not a supported semantic version.`,
      "INVALID_RELEASE_TAG"
    );
  }
  const prerelease = match[4]?.split(".") ?? [];
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    normalized: `${match[1]}.${match[2]}.${match[3]}${match[4] ? `-${match[4]}` : ""}`,
    prerelease,
    tag
  };
}
function comparePrerelease(left, right) {
  if (!left.length && !right.length) return 0;
  if (!left.length) return 1;
  if (!right.length) return -1;
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const leftPart = left[index];
    const rightPart = right[index];
    if (leftPart === void 0) return -1;
    if (rightPart === void 0) return 1;
    if (leftPart === rightPart) continue;
    const leftNumeric = /^\d+$/.test(leftPart);
    const rightNumeric = /^\d+$/.test(rightPart);
    if (leftNumeric && rightNumeric) return Number(leftPart) - Number(rightPart);
    if (leftNumeric) return -1;
    if (rightNumeric) return 1;
    return leftPart.localeCompare(rightPart);
  }
  return 0;
}
function newer(candidate, current) {
  const left = parseReleaseTag(candidate);
  const right = parseReleaseTag(current);
  for (let index = 0; index < left.core.length; index += 1) {
    const difference = left.core[index] - right.core[index];
    if (difference !== 0) return difference > 0;
  }
  return comparePrerelease(left.prerelease, right.prerelease) > 0;
}
function commandFailure(result) {
  return result.stderr || result.stdout || `exit ${result.status}`;
}
function checkForUpdate(current) {
  if (!commandAvailable("gh")) {
    throw new CoordinatorError("GitHub CLI is required to check private releases.");
  }
  const authentication = runCommand(
    "gh",
    ["auth", "status", "--hostname", "github.com"],
    { allowFailure: true }
  );
  if (authentication.status !== 0) {
    throw new CoordinatorError(
      "GitHub CLI is not authenticated for github.com. Run 'gh auth login' and retry.",
      "GITHUB_AUTH_REQUIRED"
    );
  }
  const repository = runCommand(
    "gh",
    ["api", `repos/${PROJECT_REPOSITORY}`, "--jq", ".full_name"],
    { allowFailure: true }
  );
  if (repository.status !== 0) {
    throw new CoordinatorError(
      `Cannot access private update repository '${PROJECT_REPOSITORY}': ${commandFailure(repository)}.`,
      "UPDATE_REPOSITORY_UNAVAILABLE"
    );
  }
  const result = runCommand(
    "gh",
    ["api", `repos/${PROJECT_REPOSITORY}/releases/latest`],
    { allowFailure: true }
  );
  if (result.status !== 0) {
    if (/\bHTTP 404\b/i.test(`${result.stderr}
${result.stdout}`)) {
      return {
        current,
        latest: null,
        tag: null,
        updateAvailable: false,
        url: null
      };
    }
    throw new CoordinatorError(
      `Could not check private releases for '${PROJECT_REPOSITORY}': ${commandFailure(result)}.`,
      "UPDATE_CHECK_FAILED"
    );
  }
  let release;
  try {
    release = JSON.parse(result.stdout);
  } catch {
    throw new CoordinatorError(
      "GitHub returned an invalid latest-release response.",
      "INVALID_RELEASE_RESPONSE"
    );
  }
  if (typeof release.tag_name !== "string") {
    throw new CoordinatorError(
      "GitHub's latest release has no valid tag_name.",
      "INVALID_RELEASE_RESPONSE"
    );
  }
  const parsed = parseReleaseTag(release.tag_name);
  return {
    current,
    latest: parsed.normalized,
    tag: parsed.tag,
    updateAvailable: newer(parsed.tag, current),
    url: typeof release.html_url === "string" ? release.html_url : null
  };
}
function applyUpdate(tag, options = {}) {
  parseReleaseTag(tag);
  return runCommand(
    "npm",
    [
      "install",
      "--global",
      `git+https://github.com/${PROJECT_REPOSITORY}.git#${tag}`
    ],
    { stdio: options.stdio ?? "inherit" }
  );
}

// src/workspace/initialize.ts
import {
  existsSync as existsSync11,
  lstatSync as lstatSync3,
  mkdirSync as mkdirSync4,
  readFileSync as readFileSync7,
  realpathSync as realpathSync3
} from "fs";
import path13 from "path";
function repositoryCloneUrl(url) {
  return /^[^/:]+\/[^/]+$/.test(url) ? `git@github.com:${url}.git` : url;
}
function gitResult(root, argumentsList, allowFailure = false) {
  return runCommand(
    "git",
    ["-c", "core.hooksPath=/dev/null", "-c", "protocol.file.allow=always", "-C", root, ...argumentsList],
    { allowFailure, env: { GIT_COORDINATOR_INTERNAL: "1" } }
  );
}
function git2(root, argumentsList) {
  gitResult(root, argumentsList);
}
function pathExists(value2) {
  try {
    lstatSync3(value2);
    return true;
  } catch {
    return false;
  }
}
function canonicalPath(value2) {
  try {
    return realpathSync3(value2);
  } catch {
    return path13.resolve(value2);
  }
}
function githubRepository(value2) {
  const normalized = value2.trim().replace(/^git@github\.com:/i, "").replace(/^ssh:\/\/git@github\.com\//i, "").replace(/^https?:\/\/github\.com\//i, "").replace(/\.git$/i, "").replace(/\/+$/, "");
  return /^[^/]+\/[^/]+$/.test(normalized) ? normalized.toLowerCase() : null;
}
function repositoryUrlsMatch(expectedInput, actualInput) {
  const expected = repositoryCloneUrl(expectedInput);
  const expectedGithub = githubRepository(expected);
  const actualGithub = githubRepository(actualInput);
  if (expectedGithub && actualGithub) return expectedGithub === actualGithub;
  if (path13.isAbsolute(expected) && path13.isAbsolute(actualInput)) {
    return canonicalPath(expected) === canonicalPath(actualInput);
  }
  return expected.replace(/\/+$/, "") === actualInput.replace(/\/+$/, "");
}
function existingRepositoryError(repository, detail) {
  return new CoordinatorError(
    `Existing path '${repository.path}' cannot be adopted for repository '${repository.id}': ${detail}. It must already be the declared Git submodule and gitlink; no files were changed.`,
    "EXISTING_PATH_NOT_DECLARED_SUBMODULE"
  );
}
function configuredSubmodule(root, repository) {
  const entries = gitResult(
    root,
    ["config", "-f", ".gitmodules", "--get-regexp", "^submodule\\..*\\.path$"],
    true
  );
  if (entries.status !== 0) {
    throw existingRepositoryError(repository, ".gitmodules has no matching declaration");
  }
  const matches = entries.stdout.split("\n").filter(Boolean).map((line) => {
    const separator = line.search(/\s/);
    return separator < 0 ? { key: line, value: "" } : { key: line.slice(0, separator), value: line.slice(separator).trimStart() };
  }).filter((entry) => entry.value === repository.path);
  if (matches.length !== 1) {
    throw existingRepositoryError(
      repository,
      matches.length === 0 ? ".gitmodules does not declare that path" : ".gitmodules declares that path more than once"
    );
  }
  const key = matches[0].key.replace(/\.path$/, "");
  const url = gitResult(
    root,
    ["config", "-f", ".gitmodules", "--get", `${key}.url`],
    true
  );
  if (url.status !== 0 || !url.stdout) {
    throw existingRepositoryError(repository, ".gitmodules has no URL for that path");
  }
  return { key, url: url.stdout };
}
function validateMaterializedRepository(root, repository) {
  const repositoryDirectory = path13.join(root, repository.path);
  if (!pathExists(repositoryDirectory)) {
    throw new CoordinatorError(
      `Repository '${repository.id}' is not materialized at '${repository.path}'.`,
      "SUBMODULE_MISSING"
    );
  }
  const configured = configuredSubmodule(root, repository);
  if (!repositoryUrlsMatch(repository.url, configured.url)) {
    throw existingRepositoryError(
      repository,
      `.gitmodules URL '${configured.url}' does not match '${repositoryCloneUrl(repository.url)}'`
    );
  }
  const staged = gitResult(
    root,
    ["ls-files", "--stage", "--", repository.path],
    true
  );
  const gitlink = staged.stdout.split("\n").map((line) => /^(\d+) ([0-9a-f]+) \d+\t(.*)$/.exec(line)).find((entry) => entry?.[3] === repository.path);
  if (staged.status !== 0 || !gitlink || gitlink[1] !== "160000") {
    throw existingRepositoryError(repository, "the coordinator index has no gitlink for that path");
  }
  const topLevel = gitResult(
    repositoryDirectory,
    ["rev-parse", "--show-toplevel"],
    true
  );
  if (topLevel.status !== 0 || canonicalPath(topLevel.stdout) !== canonicalPath(repositoryDirectory)) {
    throw existingRepositoryError(repository, "the destination is not that submodule's Git worktree");
  }
  const superproject = gitResult(
    repositoryDirectory,
    ["rev-parse", "--show-superproject-working-tree"],
    true
  );
  if (superproject.status !== 0 || canonicalPath(superproject.stdout) !== canonicalPath(root)) {
    throw existingRepositoryError(repository, "the Git worktree belongs to another superproject");
  }
  const head = gitResult(repositoryDirectory, ["rev-parse", "HEAD"], true);
  if (head.status !== 0 || head.stdout !== gitlink[2]) {
    throw existingRepositoryError(
      repository,
      `child HEAD ${head.stdout || "unreadable"} does not match gitlink ${gitlink[2]}`
    );
  }
  const origin = gitResult(
    repositoryDirectory,
    ["remote", "get-url", "origin"],
    true
  );
  if (origin.status !== 0 || !repositoryUrlsMatch(repository.url, origin.stdout)) {
    throw existingRepositoryError(
      repository,
      `origin URL '${origin.stdout || "missing"}' does not match '${repositoryCloneUrl(repository.url)}'`
    );
  }
}
function validateExistingDestinations(root, manifest) {
  const existing = manifest.repositories.filter(
    (repository) => pathExists(path13.join(root, repository.path))
  );
  if (!existing.length) return;
  const topLevel = gitResult(root, ["rev-parse", "--show-toplevel"], true);
  if (topLevel.status !== 0 || canonicalPath(topLevel.stdout) !== canonicalPath(root)) {
    throw existingRepositoryError(
      existing[0],
      "the coordinator root is not an existing Git worktree"
    );
  }
  for (const repository of existing) {
    validateMaterializedRepository(root, repository);
  }
}
function coordinatorBranchForInitialization(root) {
  if (!pathExists(path13.join(root, ".git"))) return "main";
  const current = gitResult(
    root,
    ["symbolic-ref", "--quiet", "--short", "HEAD"],
    true
  );
  if (current.status !== 0 || !current.stdout) {
    throw new CoordinatorError(
      "The coordinator worktree is detached. Attach it to a branch before initialization. No workspace files were changed.",
      "COORDINATOR_BRANCH_MISSING"
    );
  }
  return current.stdout;
}
function initialRepositoryBranch(repository, coordinatorBranch) {
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
    "BRANCH_MAPPING_MISSING"
  );
}
function resolveInitialBranches(root, manifest) {
  const coordinatorBranch = coordinatorBranchForInitialization(root);
  const resolved = /* @__PURE__ */ new Map();
  for (const repository of manifest.repositories) {
    const selection = initialRepositoryBranch(repository, coordinatorBranch);
    const branch = selection.name;
    const validName = runCommand(
      "git",
      ["check-ref-format", "--branch", branch],
      { allowFailure: true }
    );
    if (validName.status !== 0) {
      throw new CoordinatorError(
        `Repository '${repository.id}' has invalid fixed branch '${branch}'. No workspace files were changed.`,
        "INVALID_FIXED_BRANCH"
      );
    }
    const remote = repositoryCloneUrl(repository.url);
    const available = runCommand(
      "git",
      ["ls-remote", "--exit-code", "--heads", remote, `refs/heads/${branch}`],
      { allowFailure: true }
    );
    const existsOnRemote = available.status === 0 && Boolean(available.stdout);
    if (!existsOnRemote && (available.status === 0 || available.status === 2)) {
      if (!selection.fixed) {
        resolved.set(repository.id, { existsOnRemote: false, name: branch });
        continue;
      }
      throw new CoordinatorError(
        `Repository '${repository.id}' requires fixed branch '${branch}', but '${remote}' does not contain it. No workspace files were changed.`,
        "FIXED_BRANCH_MISSING"
      );
    }
    if (available.status !== 0) {
      throw new CoordinatorError(
        `Could not verify fixed branch '${branch}' for repository '${repository.id}' at '${remote}': ${available.stderr || available.stdout || `exit ${available.status}`}. No workspace files were changed.`,
        "FIXED_BRANCH_CHECK_FAILED"
      );
    }
    resolved.set(repository.id, { existsOnRemote, name: branch });
  }
  return resolved;
}
function validateGeneratedConfiguration(root, manifest) {
  const configurationPath = path13.join(root, ".git-coordinator.json");
  if (!existsSync11(configurationPath)) {
    throw new CoordinatorError(
      "Workspace initialization did not produce Git configuration.",
      "GIT_CONFIGURATION_MISSING"
    );
  }
  let current;
  try {
    current = readFileSync7(configurationPath, "utf8");
  } catch (error) {
    throw new CoordinatorError(
      `Generated Git configuration could not be read: ${error instanceof Error ? error.message : String(error)}`,
      "GIT_CONFIGURATION_INVALID"
    );
  }
  if (current !== renderGitConfiguration(manifest)) {
    throw new CoordinatorError(
      "Generated .git-coordinator.json does not match the validated workspace manifest.",
      "GIT_CONFIGURATION_INVALID"
    );
  }
}
function initializeWorkspace(directory, input, generatorVersion, options = {}) {
  const manifest = coordinatorManifestSchema.parse(input);
  const root = path13.resolve(directory);
  const dryRun = options.dryRun ?? false;
  const force = options.force ?? false;
  const addSubmodules = options.addSubmodules ?? true;
  const installHooks = options.installHooks ?? true;
  const gitStdio = options.gitStdio ?? "inherit";
  const manifestPlan = planFile(root, "coordinator.yaml", renderManifest(manifest), {
    force,
    owned: () => false
  });
  if (pathExists(root)) validateExistingDestinations(root, manifest);
  const initialBranches = resolveInitialBranches(root, manifest);
  const initiallyMissing = manifest.repositories.filter(
    (repository) => !pathExists(path13.join(root, repository.path))
  );
  if (!addSubmodules && installHooks && initiallyMissing.length) {
    throw new CoordinatorError(
      `Cannot install Git integration because these declared submodules are not materialized: ${initiallyMissing.map((repository) => repository.id).join(", ")}. Initialize them or combine --no-submodules with --no-hooks for configuration-only mode. No workspace files were changed.`,
      "SUBMODULES_REQUIRED_FOR_INTEGRATION"
    );
  }
  if (!existsSync11(root) && !dryRun) mkdirSync4(root, { recursive: true });
  const gitDirectory = path13.join(root, ".git");
  const createdGitRepository = !existsSync11(gitDirectory);
  if (createdGitRepository && !dryRun) {
    mkdirSync4(root, { recursive: true });
    runCommand("git", ["init", "--initial-branch=main", root]);
  }
  if (!dryRun) applyFilePlans([manifestPlan]);
  const added = [];
  if (addSubmodules && !dryRun) {
    for (const repository of manifest.repositories) {
      const repositoryDirectory = path13.join(root, repository.path);
      if (pathExists(repositoryDirectory)) continue;
      const initialBranch = initialBranches.get(repository.id);
      const branchArguments = initialBranch.existsOnRemote ? ["-b", initialBranch.name] : [];
      git2(root, [
        "submodule",
        "add",
        "--name",
        repository.id,
        ...branchArguments,
        repositoryCloneUrl(repository.url),
        repository.path
      ]);
      added.push(repository.id);
    }
  }
  const materialized = manifest.repositories.filter(
    (repository) => pathExists(path13.join(root, repository.path))
  );
  for (const repository of materialized) {
    validateMaterializedRepository(root, repository);
  }
  const missingSubmodules = manifest.repositories.filter((repository) => !pathExists(path13.join(root, repository.path))).map((repository) => repository.id);
  if (!dryRun && installHooks && missingSubmodules.length) {
    throw new CoordinatorError(
      `Cannot install Git integration because these declared submodules are not materialized: ${missingSubmodules.join(", ")}. No hooks, attach, or invariant check were run.`,
      "SUBMODULES_REQUIRED_FOR_INTEGRATION"
    );
  }
  if ((options.discoverSkills ?? false) && !dryRun) {
    for (const repository of manifest.repositories) {
      if (repository.agent.skills.length) continue;
      repository.agent.skills = discoverSkillSources(
        path13.join(root, repository.path)
      ).map((source) => ({ source }));
    }
    const discoveredManifestPlan = planFile(
      root,
      "coordinator.yaml",
      renderManifest(manifest),
      { force: true, owned: () => false }
    );
    applyFilePlans([discoveredManifestPlan]);
  }
  const sync = dryRun ? null : synchronizeWorkspace(root, manifest, generatorVersion, { force });
  if (!dryRun) validateGeneratedConfiguration(root, manifest);
  if (!dryRun && installHooks) {
    installGitRuntime(root, {}, gitStdio);
    invokeGitCoordinator("install", root, { stdio: gitStdio });
    invokeGitCoordinator("attach", root, { stdio: gitStdio });
    invokeGitCoordinator("check", root, { stdio: gitStdio });
  }
  const gitIntegration = dryRun ? {
    attached: false,
    configurationValidated: false,
    detail: "Dry run only; no Git configuration, hooks, attach, or invariant check was applied.",
    hooksInstalled: false,
    invariantChecked: false,
    missingSubmodules: initiallyMissing.map((repository) => repository.id),
    mode: "dry-run",
    validatedSubmodules: []
  } : installHooks ? {
    attached: true,
    configurationValidated: true,
    detail: "Generated Git configuration, submodule topology, branch attachment, and Git Coordinator invariant validated.",
    hooksInstalled: true,
    invariantChecked: true,
    missingSubmodules: [],
    mode: "active",
    validatedSubmodules: materialized.map((repository) => repository.id)
  } : {
    attached: false,
    configurationValidated: true,
    detail: "Configuration-only mode (--no-hooks): generated Git configuration and materialized submodules were validated; runtime bootstrap, hooks, attach, and the runtime invariant check were intentionally skipped.",
    hooksInstalled: false,
    invariantChecked: false,
    missingSubmodules,
    mode: "configuration-only",
    validatedSubmodules: materialized.map((repository) => repository.id)
  };
  return {
    root,
    createdGitRepository,
    gitIntegration,
    submodules: added,
    sync
  };
}

// src/workspace/migrate.ts
import { existsSync as existsSync12, readFileSync as readFileSync8 } from "fs";
import path14 from "path";
function slug2(value2) {
  return value2.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}
function submoduleUrl(root, repositoryPath) {
  const result = runCommand(
    "git",
    [
      "-C",
      root,
      "config",
      "-f",
      ".gitmodules",
      "--get-regexp",
      "^submodule\\..*\\.path$"
    ],
    { allowFailure: true }
  );
  const line = result.stdout.split("\n").find((entry) => entry.trim().endsWith(` ${repositoryPath}`));
  if (!line) return repositoryPath;
  const key = line.split(/\s+/)[0].replace(/\.path$/, ".url");
  return runCommand("git", ["-C", root, "config", "-f", ".gitmodules", "--get", key], {
    allowFailure: true
  }).stdout || repositoryPath;
}
function migrateLegacyWorkspace(rootInput) {
  const root = path14.resolve(rootInput);
  const configurationPath = path14.join(root, ".git-coordinator.json");
  if (!existsSync12(configurationPath)) {
    throw new CoordinatorError(`${configurationPath} does not exist.`);
  }
  let legacy;
  try {
    legacy = JSON.parse(readFileSync8(configurationPath, "utf8"));
  } catch (error) {
    throw new CoordinatorError(
      `.git-coordinator.json is invalid: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (![1, 2].includes(legacy.schemaVersion ?? 0) || !legacy.repositories?.length) {
    throw new CoordinatorError("Unsupported Git Coordinator configuration.");
  }
  const tools = [
    [".codex", "codex"],
    [".claude", "claude"],
    [".cursor", "cursor"],
    [".opencode", "opencode"]
  ].filter(([directory]) => existsSync12(path14.join(root, directory))).map(([, tool]) => tool);
  const manifest = {
    schemaVersion: 1,
    name: slug2(path14.basename(root)),
    remote: legacy.remote ?? "origin",
    repositories: legacy.repositories.map((repository) => {
      if (!repository.id || !repository.path) {
        throw new CoordinatorError("Legacy repository entry is missing id or path.");
      }
      return {
        id: repository.id,
        path: repository.path,
        url: submoduleUrl(root, repository.path),
        branch: legacy.schemaVersion === 1 ? { mode: "mirror", readOnly: false } : repository.branch ?? { mode: "mirror", readOnly: false },
        agent: { instructions: [], verify: [], skills: [] }
      };
    }),
    agents: {
      manage: false,
      tools: tools.length ? tools : ["codex"],
      maxParallel: 4,
      skillCollision: "namespace"
    }
  };
  if (legacy.workspaceManifest) manifest.workspaceManifest = legacy.workspaceManifest;
  const validated = coordinatorManifestSchema.safeParse(manifest);
  if (!validated.success) {
    const issues = validated.error.issues.map((issue) => `${issue.path.join(".") || "coordinator.yaml"}: ${issue.message}`).join("\n");
    throw new CoordinatorError(
      `Legacy Git Coordinator configuration cannot be migrated without edits:
${issues}`,
      "INVALID_LEGACY_CONFIGURATION"
    );
  }
  return validated.data;
}

// src/cli.ts
function globals(program2) {
  return program2.optsWithGlobals();
}
function writeJson(value2) {
  process.stdout.write(`${JSON.stringify(value2, null, 2)}
`);
}
function collect(value2, previous) {
  return [...previous, value2];
}
function slug3(value2) {
  return value2.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}
function repositoryFromSpec(spec) {
  const separator = spec.indexOf("=");
  if (separator <= 0 || separator === spec.length - 1) {
    throw new CoordinatorError(
      `Invalid repository '${spec}'. Use role=owner/repository or role=clone-url.`
    );
  }
  const id = spec.slice(0, separator);
  const sourceAndPath = spec.slice(separator + 1);
  const comma = sourceAndPath.lastIndexOf(",");
  const source = comma > 0 ? sourceAndPath.slice(0, comma) : sourceAndPath;
  const repositoryPath = comma > 0 ? sourceAndPath.slice(comma + 1) : source.replace(/\.git$/, "").split(/[/:]/).at(-1);
  return {
    id,
    path: repositoryPath,
    url: repositoryCloneUrl(source),
    branch: { mode: "mirror", readOnly: false },
    agent: { instructions: [], verify: [], skills: [] }
  };
}
function parseTools(value2) {
  const tools = value2.split(",").map((tool) => tool.trim()).filter(Boolean);
  const valid = /* @__PURE__ */ new Set(["codex", "claude", "cursor", "opencode"]);
  const invalid = tools.filter((tool) => !valid.has(tool));
  if (invalid.length) throw new CoordinatorError(`Unknown agent tools: ${invalid.join(", ")}`);
  return tools;
}
function summarizeChanges(result) {
  return {
    changed: result.changed,
    git: result.git.action,
    agents: changedPlans(result.agents.files).map((file) => ({
      path: file.relativePath,
      action: file.action
    })),
    skills: result.agents.skills,
    ci: changedPlans(result.ci.files).map((file) => ({
      path: file.relativePath,
      action: file.action
    }))
  };
}
function renderDoctor(result, color) {
  const style = {
    pass: (value2) => color ? pc3.green(value2) : value2,
    warn: (value2) => color ? pc3.yellow(value2) : value2,
    fail: (value2) => color ? pc3.red(value2) : value2
  };
  return result.checks.map((item) => {
    const icon = item.status === "pass" ? "\u25CF" : item.status === "warn" ? "\u25C6" : "\xD7";
    return `${style[item.status](icon)} ${item.label.padEnd(24)} ${item.detail}`;
  }).join("\n");
}
async function showStatus(program2) {
  const loaded = loadManifest();
  const status = inspectWorkspace(loaded.root, loaded.manifest, VERSION);
  const options = globals(program2);
  if (options.json) writeJson(status);
  else process.stdout.write(`${renderDashboard(status, { color: options.color })}
`);
}
async function showDoctor(program2) {
  const loaded = loadManifest();
  const result = runDoctor(loaded.root, loaded.manifest, VERSION);
  const options = globals(program2);
  if (options.json) writeJson(result);
  else {
    process.stdout.write(`${renderDoctor(result, options.color)}
`);
    process.stdout.write(
      result.healthy ? pc3.green("\nWorkspace ready.\n") : pc3.red("\nWorkspace needs attention.\n")
    );
  }
  if (!result.healthy) process.exitCode = 1;
}
async function home(program2) {
  const root = findWorkspaceRoot();
  if (!root) {
    if (!process.stdin.isTTY) {
      program2.help();
      return;
    }
    const prompted = await promptWorkspaceManifest(process.cwd());
    initializeWorkspace(process.cwd(), prompted.manifest, VERSION, {
      discoverSkills: prompted.discoverSkills
    });
    finishWorkspacePrompt();
    await showStatus(program2);
    return;
  }
  await showStatus(program2);
  if (!process.stdin.isTTY) return;
  const action = await promptDashboardAction();
  if (action === "sync") {
    const loaded = loadManifest(root);
    const result = synchronizeWorkspace(loaded.root, loaded.manifest, VERSION);
    process.stdout.write(result.changed ? "Workspace synchronized.\n" : "Workspace already synchronized.\n");
  } else if (action === "doctor") {
    await showDoctor(program2);
  } else if (action === "status") {
    await showStatus(program2);
  }
}
var jsonRequested = process.argv.includes("--json");
var program = new Command();
if (jsonRequested) {
  program.configureOutput({ writeErr: () => {
  } });
}
program.exitOverride();
program.name("coordinator").description("Beautiful multi-repository Git, agent, and delivery coordination.").version(VERSION).option("--json", "print machine-readable JSON", false).option("--no-color", "disable terminal colors").showSuggestionAfterError().showHelpAfterError().action(async () => home(program));
program.command("init").description("initialize a coordinator in an empty or existing directory").argument("[directory]", "workspace directory", ".").option("-n, --name <name>", "workspace name").option("-r, --repo <spec>", "repository role=owner/repo[,path]", collect, []).option("--tools <tools>", "comma-separated agent runtimes", "codex,claude").option("--discover-skills", "discover committed skills after cloning", false).option("--no-submodules", "write configuration without cloning repositories").option("--no-hooks", "configuration only: skip runtime bootstrap, hooks, attach, and check").option("--dry-run", "show the initialization contract without writing").option("--force", "adopt conflicting generated destinations").action(async (directory, options) => {
  let manifest;
  let discoverSkills = options.discoverSkills;
  let interactive = false;
  if (!options.repo.length) {
    if (!process.stdin.isTTY) {
      throw new CoordinatorError("At least one --repo is required without an interactive terminal.");
    }
    interactive = true;
    const prompted = await promptWorkspaceManifest(directory);
    manifest = prompted.manifest;
    discoverSkills = prompted.discoverSkills;
  } else {
    manifest = coordinatorManifestSchema.parse({
      schemaVersion: 1,
      name: options.name ?? slug3(path15.basename(path15.resolve(directory))),
      remote: "origin",
      repositories: options.repo.map(repositoryFromSpec),
      agents: {
        tools: parseTools(options.tools),
        maxParallel: Math.min(4, options.repo.length),
        skillCollision: "namespace"
      }
    });
  }
  const result = initializeWorkspace(directory, manifest, VERSION, {
    addSubmodules: options.submodules,
    dryRun: options.dryRun,
    discoverSkills,
    gitStdio: globals(program).json ? "pipe" : "inherit",
    installHooks: options.hooks,
    force: options.force
  });
  if (options.dryRun) {
    writeJson({ directory: path15.resolve(directory), manifest, discoverSkills, result });
    return;
  }
  if (interactive) finishWorkspacePrompt();
  if (globals(program).json) writeJson(result);
  else {
    process.stdout.write(
      `Initialized ${manifest.name} with ${manifest.repositories.length} repositories.
`
    );
    process.stdout.write(`${result.gitIntegration.detail}
`);
    if (result.gitIntegration.missingSubmodules.length) {
      process.stdout.write(
        "Next: rerun init with the same repositories and submodule cloning enabled before using ordinary Git.\n"
      );
    } else if (result.gitIntegration.mode === "configuration-only") {
      process.stdout.write(
        "Next: coordinator git install && coordinator git attach && coordinator git check\n"
      );
    } else {
      process.stdout.write('Next: git add . && git commit -m "Initialize coordinator"\n');
    }
  }
});
program.command("status").description("show the workspace dashboard").action(() => showStatus(program));
program.command("demo").description("render a deterministic product dashboard").action(() => {
  const options = globals(program);
  const status = demoWorkspaceStatus(VERSION);
  if (options.json) writeJson(status);
  else process.stdout.write(`${renderDashboard(status, { color: options.color })}
`);
});
program.command("doctor").description("validate the complete workspace contract").action(() => showDoctor(program));
program.command("sync").description("synchronize Git, agent, skill, and CI outputs").option("--check", "fail when generated outputs are stale").option("--force", "adopt conflicting generated destinations").action((options) => {
  const loaded = loadManifest();
  const result = synchronizeWorkspace(loaded.root, loaded.manifest, VERSION, options);
  const summary = summarizeChanges(result);
  if (globals(program).json) writeJson(summary);
  else if (options.check) {
    process.stdout.write(
      `${result.changed ? "Generated workspace files are stale" : "Generated workspace files are current"}.
`
    );
  } else {
    process.stdout.write(
      `${result.changed ? "Workspace synchronized; generated files updated" : "Workspace already synchronized"}.
`
    );
  }
  if (options.check && result.changed) process.exitCode = 1;
});
var agents = program.command("agents").description("manage tool-specific agents and portable skills");
for (const mode of ["sync", "check"]) {
  agents.command(mode).description(mode === "sync" ? "materialize agents and committed skills" : "verify generated agents and skills").option(
    "--force",
    mode === "sync" ? "adopt conflicting generated destinations" : "preview changes for conflicting unmanaged destinations"
  ).action((options) => {
    const loaded = loadManifest();
    const result = synchronizeAgents(loaded.root, loaded.manifest, VERSION, {
      check: mode === "check",
      force: options.force
    });
    const summary = {
      managed: loaded.manifest.agents.manage !== false,
      changed: result.changed,
      skills: result.skills,
      files: changedPlans(result.files).map((file) => file.relativePath)
    };
    if (globals(program).json) writeJson(summary);
    else if (loaded.manifest.agents.manage === false) {
      process.stdout.write(
        "Agent management is disabled; existing agent and skill files were left untouched.\n"
      );
    } else if (mode === "check") {
      process.stdout.write(
        `${result.skills.length} skills; ${result.changed ? "generated agent files are stale" : "generated agent files are current"}.
`
      );
    } else {
      process.stdout.write(
        `${result.skills.length} skills; ${result.changed ? "agent files synchronized and updated" : "agent files already synchronized"}.
`
      );
    }
    if (mode === "check" && result.changed) process.exitCode = 1;
  });
}
var ci = program.command("ci").description("generate coordinated GitHub Actions delivery workflows");
for (const mode of ["sync", "check"]) {
  ci.command(mode).description(mode === "sync" ? "generate CI/CD files" : "verify generated CI/CD files").option("--force", "adopt conflicting generated destinations").action((options) => {
    const loaded = loadManifest();
    const result = synchronizeCi(loaded.root, loaded.manifest, {
      check: mode === "check",
      force: options.force
    });
    if (globals(program).json) writeJson(result);
    else if (mode === "check") {
      process.stdout.write(
        `${result.changed ? "Generated CI/CD files are stale" : "Generated CI/CD files are current"}.
`
      );
    } else {
      process.stdout.write(
        `${result.changed ? "CI/CD synchronized; generated files updated" : "CI/CD already synchronized"}.
`
      );
    }
    if (mode === "check" && result.changed) process.exitCode = 1;
  });
}
var git3 = program.command("git").description("operate the Git Coordinator compatibility runtime");
for (const command of ["install", "attach", "check"]) {
  git3.command(command).description(
    command === "install" ? "install the pinned runtime and this workspace's Git integration" : `${command} the Git Coordinator workspace integration`
  ).action(() => {
    const root = findWorkspaceRoot() ?? process.cwd();
    const json = globals(program).json;
    const runtime = command === "install" ? installGitRuntime(root, {}, json ? "pipe" : "inherit") : null;
    const result = invokeGitCoordinator(command, root, {
      stdio: json ? "pipe" : "inherit"
    });
    if (json) {
      writeJson({
        command,
        root,
        runtime: runtime ? { status: runtime.status, stdout: runtime.stdout, stderr: runtime.stderr } : null,
        result
      });
    }
    if (result.status !== 0) process.exitCode = result.status;
  });
}
program.command("install").description("install or refresh the transparent Git runtime on this machine").action(() => {
  const json = globals(program).json;
  const result = installGitRuntime(
    process.cwd(),
    {},
    json ? "pipe" : "inherit"
  );
  if (json) writeJson(result);
});
program.command("update").description("check for or install the latest private release").option("--apply", "install the latest release").action((options) => {
  const status = checkForUpdate(VERSION);
  let applied = false;
  if (options.apply && status.tag && status.updateAvailable) {
    applyUpdate(status.tag, {
      stdio: globals(program).json ? "pipe" : "inherit"
    });
    applied = true;
  }
  if (globals(program).json) writeJson({ ...status, applied });
  else if (!status.latest) {
    process.stdout.write("No published release is available yet.\n");
  } else if (status.updateAvailable) {
    process.stdout.write(
      options.apply ? `Updated Agent Coordinator to ${status.latest}.
` : `Agent Coordinator ${status.latest} is available. Run coordinator update --apply.
`
    );
  } else {
    process.stdout.write(`Agent Coordinator ${VERSION} is current.
`);
  }
});
program.command("migrate").description("create coordinator.yaml from an existing .git-coordinator.json").argument("[directory]", "legacy workspace", ".").option("--write", "write coordinator.yaml instead of printing it").option("--adopt-git", "mark only the legacy Git configuration as coordinator-managed").option("--force", "replace an existing project-owned manifest").action((directory, options) => {
  const root = path15.resolve(directory);
  const manifest = migrateLegacyWorkspace(root);
  const content = renderManifest(manifest);
  if (!options.write) {
    if (options.adoptGit) {
      throw new CoordinatorError("--adopt-git requires --write after reviewing the preview.");
    }
    if (globals(program).json) writeJson({ root, manifest, yaml: content });
    else process.stdout.write(content);
    return;
  }
  const plans = [
    planFile(root, "coordinator.yaml", content, {
      force: options.force,
      owned: () => false
    })
  ];
  if (options.adoptGit) {
    plans.push(
      planFile(root, ".git-coordinator.json", renderGitConfiguration(manifest), {
        force: true
      })
    );
  }
  applyFilePlans(plans);
  const result = plans.map((plan) => ({
    path: plan.path,
    action: plan.action
  }));
  if (globals(program).json) writeJson(result);
  else {
    for (const plan of plans) process.stdout.write(`${plan.action}: ${plan.path}
`);
    process.stdout.write(
      "Agent management remains disabled; existing agent and skill files were left untouched.\n"
    );
    process.stdout.write(
      options.adoptGit ? "Next: review coordinator.yaml, then run coordinator sync, coordinator git install, coordinator git attach, and coordinator doctor.\n" : "Next: review coordinator.yaml, then rerun with --write --adopt-git to adopt only the Git adapter.\n"
    );
  }
});
program.parseAsync(process.argv).catch((error) => {
  if (error instanceof CommanderError) {
    if (error.exitCode === 0) return;
    if (jsonRequested) writeJson({ error: error.message, code: error.code });
    process.exitCode = error.exitCode || 1;
    return;
  }
  if (error instanceof CoordinatorError && error.code === "CANCELLED") {
    process.exitCode = 0;
    return;
  }
  const options = program.opts();
  if (options.json || jsonRequested) {
    writeJson({
      error: errorMessage(error),
      code: error instanceof CoordinatorError ? error.code : "UNEXPECTED_ERROR"
    });
  } else {
    process.stderr.write(`${pc3.red("\xD7")} ${errorMessage(error)}
`);
  }
  process.exitCode = 1;
});
//# sourceMappingURL=cli.js.map