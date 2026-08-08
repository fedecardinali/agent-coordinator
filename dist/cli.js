#!/usr/bin/env node

// src/cli.ts
import path16 from "path";
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
  linkSync,
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
var planPathStates = /* @__PURE__ */ new WeakMap();
function pathStatesMatch(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}
function lstatIfPresent(value2) {
  try {
    return lstatSync(value2);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}
function plannedPathState(value2) {
  const status = lstatIfPresent(value2);
  if (!status) return { kind: "missing" };
  if (!status.isFile()) {
    throw new CoordinatorError(
      `Generated-file destination is not a regular file: ${value2}.`,
      "UNSAFE_FILE_PATH"
    );
  }
  return {
    content: readFileSync(value2, "utf8"),
    dev: Number(status.dev),
    ino: Number(status.ino),
    kind: "file",
    mode: Number(status.mode)
  };
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
function registerPlan(root, plan, state = plannedPathState(plan.path)) {
  planRoots.set(plan, path.resolve(root));
  planPathStates.set(plan, state);
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
  const expectedState = planPathStates.get(plan);
  if (!expectedState || !pathStatesMatch(plannedPathState(currentPath), expectedState)) {
    throw new CoordinatorError(
      `Generated-file destination '${plan.relativePath}' changed after planning. Run the command again.`,
      "FILE_PLAN_STALE"
    );
  }
}
function ensurePlanParent(plan) {
  const root = planRoots.get(plan);
  if (!root) {
    throw new CoordinatorError(
      `Refusing untrusted generated-file plan '${plan.relativePath}'.`,
      "UNSAFE_FILE_PLAN"
    );
  }
  const relativeParent = path.dirname(plan.relativePath);
  if (relativeParent === ".") return;
  let current = root;
  for (const component of relativeParent.split(/[\\/]/).filter(Boolean)) {
    current = path.join(current, component);
    try {
      mkdirSync(current);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    const status = lstatSync(current);
    if (!status.isDirectory() || status.isSymbolicLink()) {
      throw new CoordinatorError(
        `Refusing generated file '${plan.relativePath}' because '${path.relative(root, current)}' is not a safe directory.`,
        "UNSAFE_FILE_PATH"
      );
    }
  }
  revalidatePlan(plan);
}
function planFile(root, relativePath2, content, options = {}) {
  const absolutePath = safeGeneratedPath(root, relativePath2);
  const state = plannedPathState(absolutePath);
  if (state.kind === "missing") {
    return registerPlan(root, {
      action: "create",
      content,
      path: absolutePath,
      relativePath: relativePath2
    }, state);
  }
  const current = state.content;
  if (current === content) {
    return registerPlan(root, {
      action: "unchanged",
      content,
      path: absolutePath,
      relativePath: relativePath2
    }, state);
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
  }, state);
}
function randomSibling(plan, purpose) {
  return path.join(
    path.dirname(plan.path),
    `.${path.basename(plan.path)}.coordinator-${purpose}-${randomUUID()}`
  );
}
function cleanupTransactionFiles(changes) {
  for (const change of changes) {
    for (const [candidate, expected] of [
      [change.stagedPath, change.stagedState],
      [change.backupPath, change.expectedState],
      [change.discardPath, change.publishedState]
    ]) {
      if (!candidate || !expected) continue;
      try {
        const current = plannedPathState(candidate);
        if (pathStatesMatch(current, expected) && current.kind !== "missing") {
          unlinkSync(candidate);
        }
      } catch {
      }
    }
  }
}
function rollbackFileChanges(changes) {
  const failures = [];
  for (const change of [...changes].reverse()) {
    try {
      const root = planRoots.get(change.plan);
      if (!root) throw new CoordinatorError("Untrusted file plan.", "UNSAFE_FILE_PLAN");
      const currentPath = safeGeneratedPath(root, change.plan.relativePath);
      if (currentPath !== change.plan.path) {
        throw new CoordinatorError("File plan destination changed.", "UNSAFE_FILE_PLAN");
      }
      if (change.publishedState) {
        const current = plannedPathState(change.plan.path);
        if (!pathStatesMatch(current, change.publishedState)) {
          throw new CoordinatorError(
            "published destination changed before rollback",
            "FILE_ROLLBACK_DESTINATION_CHANGED"
          );
        }
        change.discardPath = randomSibling(change.plan, "discard");
        renameSync(change.plan.path, change.discardPath);
        if (!pathStatesMatch(
          plannedPathState(change.discardPath),
          change.publishedState
        )) {
          if (plannedPathState(change.plan.path).kind === "missing") {
            renameSync(change.discardPath, change.plan.path);
            change.discardPath = null;
          }
          throw new CoordinatorError(
            "published destination changed while rollback captured it",
            "FILE_ROLLBACK_DESTINATION_CHANGED"
          );
        }
      }
      if (change.backupPath) {
        if (plannedPathState(change.plan.path).kind !== "missing") {
          throw new CoordinatorError(
            "destination is occupied; backup preserved",
            "FILE_ROLLBACK_DESTINATION_CHANGED"
          );
        }
        try {
          linkSync(change.backupPath, change.plan.path);
        } catch (error) {
          throw new CoordinatorError(
            `could not restore backup: ${error instanceof Error ? error.message : String(error)}`,
            "FILE_ROLLBACK_FAILED"
          );
        }
        if (!pathStatesMatch(
          plannedPathState(change.plan.path),
          change.expectedState
        )) {
          throw new CoordinatorError(
            "restored backup does not match the planned original",
            "FILE_ROLLBACK_FAILED"
          );
        }
        unlinkSync(change.backupPath);
        change.backupPath = null;
      }
    } catch (error) {
      failures.push(
        `${change.plan.relativePath}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  return failures;
}
function applyFilePlans(plans) {
  const paths = /* @__PURE__ */ new Set();
  for (const plan of plans) {
    if (paths.has(plan.path)) {
      throw new CoordinatorError(
        `Generated-file destination '${plan.relativePath}' was planned more than once.`,
        "DUPLICATE_FILE_PLAN"
      );
    }
    paths.add(plan.path);
    revalidatePlan(plan);
  }
  const changes = [];
  const applied = [];
  try {
    for (const plan of plans) {
      if (plan.action === "unchanged") continue;
      ensurePlanParent(plan);
      revalidatePlan(plan);
      const expectedState = planPathStates.get(plan);
      if (!expectedState) {
        throw new CoordinatorError(
          `Missing expected state for '${plan.relativePath}'.`,
          "UNSAFE_FILE_PLAN"
        );
      }
      const change = {
        backupPath: null,
        discardPath: null,
        expectedState,
        plan,
        publishedState: null,
        stagedPath: null,
        stagedState: null
      };
      if (plan.action !== "delete") {
        change.stagedPath = randomSibling(plan, "staged");
        let descriptor = null;
        try {
          descriptor = openSync(change.stagedPath, "wx", 420);
          writeFileSync(descriptor, plan.content, "utf8");
          closeSync(descriptor);
          descriptor = null;
        } finally {
          if (descriptor !== null) closeSync(descriptor);
        }
        change.stagedState = plannedPathState(change.stagedPath);
      }
      changes.push(change);
    }
    for (const change of changes) {
      const { plan } = change;
      revalidatePlan(plan);
      applied.push(change);
      if (change.expectedState.kind === "file") {
        change.backupPath = randomSibling(plan, "backup");
        renameSync(plan.path, change.backupPath);
        if (!pathStatesMatch(
          plannedPathState(change.backupPath),
          change.expectedState
        )) {
          throw new CoordinatorError(
            `Generated-file destination '${plan.relativePath}' changed while it was being backed up.`,
            "FILE_PLAN_STALE"
          );
        }
      }
      if (plan.action !== "delete") {
        if (!change.stagedPath || !change.stagedState) {
          throw new CoordinatorError(
            `Generated file '${plan.relativePath}' was not staged.`,
            "UNSAFE_FILE_PLAN"
          );
        }
        try {
          linkSync(change.stagedPath, plan.path);
        } catch (error) {
          throw new CoordinatorError(
            `Generated-file destination '${plan.relativePath}' changed during publication: ${error instanceof Error ? error.message : String(error)}.`,
            "FILE_PLAN_STALE"
          );
        }
        change.publishedState = change.stagedState;
        if (!pathStatesMatch(
          plannedPathState(plan.path),
          change.publishedState
        )) {
          throw new CoordinatorError(
            `Generated-file destination '${plan.relativePath}' changed during publication.`,
            "FILE_PLAN_STALE"
          );
        }
      }
    }
    for (const change of changes) {
      const root = planRoots.get(change.plan);
      safeGeneratedPath(root, change.plan.relativePath);
      const finalState = plannedPathState(change.plan.path);
      const expectedFinal = change.publishedState ?? { kind: "missing" };
      if (!pathStatesMatch(finalState, expectedFinal)) {
        throw new CoordinatorError(
          `Generated-file destination '${change.plan.relativePath}' changed before commit.`,
          "FILE_PLAN_STALE"
        );
      }
    }
  } catch (error) {
    const rollbackFailures = rollbackFileChanges(applied);
    if (!rollbackFailures.length) cleanupTransactionFiles(changes);
    if (rollbackFailures.length) {
      const recoveryPaths = changes.flatMap((change) => [change.stagedPath, change.backupPath, change.discardPath]).filter((value2) => Boolean(value2));
      throw new CoordinatorError(
        `Generated-file publication failed (${error instanceof Error ? error.message : String(error)}) and rollback was incomplete: ${rollbackFailures.join("; ")}. Recovery files were preserved: ${recoveryPaths.join(", ")}.`,
        "FILE_ROLLBACK_FAILED"
      );
    }
    throw error;
  }
  cleanupTransactionFiles(changes);
}
function planFileDeletion(root, relativePath2, owned2) {
  const absolutePath = safeGeneratedPath(root, relativePath2);
  const state = plannedPathState(absolutePath);
  if (state.kind === "missing") {
    return registerPlan(root, {
      action: "unchanged",
      content: "",
      path: absolutePath,
      relativePath: relativePath2
    }, state);
  }
  const current = state.content;
  return registerPlan(root, {
    action: owned2(current) ? "delete" : "unchanged",
    content: current,
    path: absolutePath,
    relativePath: relativePath2
  }, state);
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
  const workspaceMode = manifest.workspace ? `

Before editing, read \`workspace.selection.${repository.id}\` in \`coordinator.yaml\` from the current coordinator revision and confirm it is active. If it is pinned, read-only, or absent, stop and report that constraint to the primary agent.` : manifest.workspaceManifest ? `

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
  const repositoryList = manifest.repositories.map((repository) => {
    const policy = `${repository.branch.mode}${repository.branch.readOnly ? ", read-only" : ""}`;
    return `- \`${repository.id}\`: \`${repository.path}\` (${policy}); delegate to the \`${agentName(repository)}\` project agent.`;
  }).join("\n");
  const verify = manifest.repositories.flatMap(
    (repository) => repository.agent.verify.map(
      (command) => `- ${repository.id}: \`${command}\``
    )
  ).join("\n");
  const workspaceManifest = manifest.workspace ? "\nBranch-scoped repository intent is stored in `workspace.selection` inside `coordinator.yaml`. Read it from the current coordinator HEAD before delegation. Only repositories marked active may receive implementation work; pinned or absent repositories must remain untouched even when their default policy is writable.\n" : manifest.workspaceManifest ? `
A legacy branch-scoped workspace manifest is stored at \`${manifest.workspaceManifest.path}\`. Read the version from the current coordinator HEAD before delegation. Only repositories marked active may receive implementation work; pinned or absent repositories must remain untouched even when their default policy is writable.
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

Linked skills live at \`.agents/skills/<skill-name>/SKILL.md\`. Each registry
entry is a relative symlink to its committed source in a pinned child checkout.
Do not replace registry links. Editing through one changes its owning child
checkout immediately; commit the change in that repository, then run
\`coordinator agents sync\`.

## Git invariant

Gitlinks are the authoritative version lock. From this root, ordinary
\`git add\`, \`git commit\`, \`git pull\`, \`git push\`, \`git checkout\`, and
\`git worktree\` are coordinated by Agent Coordinator. Never repair an invariant
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
  readlinkSync,
  readdirSync,
  realpathSync,
  renameSync as renameSync2,
  rmSync,
  statSync,
  symlinkSync
} from "fs";
import path2 from "path";

// src/core/command.ts
import { spawnSync } from "child_process";
function runCommand(command, argumentsList, options = {}) {
  const stdio = options.stdio ?? "pipe";
  const result2 = spawnSync(command, argumentsList, {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    encoding: "utf8",
    input: options.input,
    stdio
  });
  if (result2.error) {
    throw new CoordinatorError(
      `Could not execute '${command}': ${result2.error.message}`,
      "COMMAND_NOT_FOUND"
    );
  }
  const status = result2.status ?? 1;
  const output = {
    status,
    stdout: typeof result2.stdout === "string" ? result2.stdout.trim() : "",
    stderr: typeof result2.stderr === "string" ? result2.stderr.trim() : ""
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
  const result2 = runCommand(
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
  if (result2.status !== 0) {
    throw new CoordinatorError(
      `Could not read pinned Git tree ${commit} in ${repositoryDirectory}: ${result2.stderr || result2.stdout || `exit ${result2.status}`}.`,
      "SKILL_PINNED_TREE_UNAVAILABLE"
    );
  }
  if (!result2.stdout) return null;
  const lines = result2.stdout.split("\n").filter(Boolean);
  if (lines.length !== 1) return null;
  const match = /^(\d{6})\s+(\w+)\s+([0-9a-f]{40,64})\t/.exec(lines[0]);
  return match ? { mode: match[1], type: match[2], oid: match[3] } : null;
}
function assertLinkableSkillTree(repositoryDirectory, commit, relativePath2, label) {
  const argumentsList = ["-C", repositoryDirectory, "ls-tree", "-r", "-z", commit];
  if (relativePath2) argumentsList.push("--", `:(literal)${relativePath2}`);
  const result2 = runCommand("git", argumentsList, { allowFailure: true });
  if (result2.status !== 0) {
    throw new CoordinatorError(
      `Could not inspect the pinned tree for ${label}: ${result2.stderr || result2.stdout || `exit ${result2.status}`}.`,
      "SKILL_PINNED_TREE_UNAVAILABLE"
    );
  }
  for (const entry of result2.stdout.split("\0").filter(Boolean)) {
    const match = /^(\d{6})\s+(\w+)\s+[0-9a-f]{40,64}\t([\s\S]+)$/.exec(entry);
    if (!match) continue;
    if (match[1] === "120000" || match[1] === "160000") {
      throw new CoordinatorError(
        `${label} contains unsupported ${match[1] === "120000" ? "symbolic link" : "nested gitlink"} '${match[3]}'. Source-direct skills must be ordinary committed files and directories.`,
        "SKILL_SOURCE_LINK_UNSUPPORTED"
      );
    }
  }
}
function indexedGitlink(root, repository) {
  const result2 = runCommand(
    "git",
    ["-C", root, "ls-files", "--stage", "--", repository.path],
    { allowFailure: true }
  );
  const entries = result2.stdout.split("\n").filter(Boolean).map((line) => /^(\d{6}) ([0-9a-f]{40,64}) ([0-3])\t/.exec(line)).filter((entry) => entry !== null);
  if (result2.status !== 0 || entries.length !== 1 || entries[0][1] !== "160000" || entries[0][3] !== "0") {
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
function sourceInformation(context, repository, source, explicitName, _kind) {
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
  assertLinkableSkillTree(
    sourceGitRoot,
    sourceCommit,
    sourcePrefix,
    label
  );
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
  if (!declared) {
    throw new CoordinatorError(
      `Skill '${repository.id}:${source}' must declare a canonical name in SKILL.md frontmatter before it can be linked.`,
      "INVALID_SKILL"
    );
  }
  if (explicitName !== void 0 && explicitName !== declared) {
    throw new CoordinatorError(
      `Skill '${repository.id}:${source}' requests alias '${explicitName}', but its canonical SKILL.md name is '${declared}'. Source-direct skill links cannot rewrite frontmatter; rename the source skill or remove the alias.`,
      "SKILL_LINK_ALIAS_UNSUPPORTED"
    );
  }
  const targetName = declared;
  if (!SKILL_NAME.test(targetName)) {
    throw new CoordinatorError(
      `Skill '${repository.id}:${source}' resolves to invalid portable name '${targetName}'.`,
      "INVALID_SKILL_NAME"
    );
  }
  const sourceWorkspacePath = gitPath(
    path2.relative(context.rootRealPath, sourceDirectory)
  );
  if (!sourceWorkspacePath || sourceWorkspacePath === ".." || sourceWorkspacePath.startsWith("../")) {
    throw new CoordinatorError(
      `Skill '${repository.id}:${source}' does not resolve to a linkable directory inside the coordinator workspace.`,
      "SKILL_SOURCE_ESCAPE"
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
      (skill) => sourceInformation(
        context,
        repository,
        skill.source,
        skill.name,
        skill.kind
      )
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
    throw new CoordinatorError(
      `Skill name '${name}' has divergent sources: ${collisions.map((candidate) => `${candidate.repository.id}:${candidate.source}`).join(", ")}. Source-direct skill links require one globally unique canonical SKILL.md name; automatic namespace rewriting is unavailable.`,
      "SKILL_COLLISION"
    );
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
      } else {
        throw new CoordinatorError(
          `Generated skill contains unsupported filesystem entry '${relative}'.`,
          "SKILL_UNSUPPORTED_ENTRY"
        );
      }
    }
  };
  walk(directory, "");
  return sha256(Buffer.concat(pieces));
}
function validOid(value2) {
  return typeof value2 === "string" && /^[0-9a-f]{40,64}$/.test(value2);
}
function validLockSkillBase(value2) {
  if (typeof value2 !== "object" || value2 === null) return false;
  const skill = value2;
  return typeof skill.name === "string" && SKILL_NAME.test(skill.name) && typeof skill.repository === "string" && SKILL_NAME.test(skill.repository) && typeof skill.source === "string" && Boolean(skill.source) && !/[\0\r\n]/.test(skill.source) && validOid(skill.sourceCommit) && validOid(skill.treeOid);
}
function validRelativeLink(value2) {
  return typeof value2 === "string" && Boolean(value2) && !path2.posix.isAbsolute(value2) && !path2.win32.isAbsolute(value2) && !/[\0\r\n]/.test(value2);
}
function parseLock(content) {
  try {
    const value2 = JSON.parse(content);
    if (value2.generatedBy !== "agent-coordinator" || typeof value2.generatorVersion !== "string" || !Array.isArray(value2.skills)) {
      return null;
    }
    const names = value2.skills.map(
      (skill) => typeof skill === "object" && skill !== null ? skill.name : null
    ).filter((name) => typeof name === "string");
    if (new Set(names).size !== value2.skills.length) return null;
    if (value2.schemaVersion === 1) {
      if (!value2.skills.every(
        (skill) => validLockSkillBase(skill) && typeof skill.digest === "string" && /^[0-9a-f]{64}$/.test(
          skill.digest
        )
      )) {
        return null;
      }
      return value2;
    }
    if (value2.schemaVersion === 2) {
      if (!value2.skills.every(
        (skill) => validLockSkillBase(skill) && skill.materialization === "relative-symlink" && validRelativeLink(
          skill.linkTarget
        )
      )) {
        return null;
      }
      return value2;
    }
    return null;
  } catch {
    return null;
  }
}
function readLock(lockPath) {
  if (!existsSync2(lockPath)) return null;
  return parseLock(readFileSync2(lockPath, "utf8"));
}
function lstatIfPresent2(value2) {
  try {
    return lstatSync2(value2);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}
function validateTarget(root, name) {
  if (!SKILL_NAME.test(name)) {
    throw new CoordinatorError(`Unsafe generated skill name '${name}'.`);
  }
  const skillsRoot = safeGeneratedPath(root, path2.join(".agents", "skills"));
  return path2.join(skillsRoot, name);
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
function rollbackSkillChanges(root, skillsRoot, identity2, discardedRoot, changes) {
  const failures = [];
  for (const change of [...changes].reverse()) {
    try {
      assertDirectoryIdentity(skillsRoot, identity2);
      const target = validateTarget(root, change.name);
      const current = destinationSnapshot(target);
      if (change.published) {
        if (!change.publishedSnapshot || !snapshotsMatch(current, change.publishedSnapshot)) {
          throw new CoordinatorError(
            `Published skill link '${change.name}' changed before rollback; its current destination was preserved.`,
            "SKILL_ROLLBACK_DESTINATION_CHANGED"
          );
        }
        const discarded = path2.join(discardedRoot, change.name);
        renameSync2(target, discarded);
        if (!snapshotsMatch(
          destinationSnapshot(discarded),
          change.publishedSnapshot
        )) {
          if (destinationSnapshot(target).kind === "missing") {
            renameSync2(discarded, target);
          }
          throw new CoordinatorError(
            `Published skill link '${change.name}' changed while rollback captured it; recovery data was preserved.`,
            "SKILL_ROLLBACK_DESTINATION_CHANGED"
          );
        }
      } else if (current.kind !== "missing") {
        throw new CoordinatorError(
          `Skill destination '${change.name}' was occupied before rollback; both it and the backup were preserved.`,
          "SKILL_ROLLBACK_DESTINATION_CHANGED"
        );
      }
      if (change.backup && lstatIfPresent2(change.backup)) {
        if (destinationSnapshot(target).kind !== "missing") {
          throw new CoordinatorError(
            `Skill destination '${change.name}' is occupied; its backup was preserved.`,
            "SKILL_ROLLBACK_DESTINATION_CHANGED"
          );
        }
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
function destinationSnapshot(target) {
  const status = lstatIfPresent2(target);
  if (!status) return { kind: "missing" };
  if (status.isSymbolicLink()) {
    return {
      dev: Number(status.dev),
      ino: Number(status.ino),
      kind: "symlink",
      linkTarget: readlinkSync(target)
    };
  }
  if (status.isDirectory()) {
    let digest = null;
    try {
      digest = directoryDigest(target);
    } catch {
    }
    return {
      dev: Number(status.dev),
      digest,
      ino: Number(status.ino),
      kind: "directory"
    };
  }
  return {
    dev: Number(status.dev),
    ino: Number(status.ino),
    kind: "other"
  };
}
function snapshotsMatch(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}
function linkedSkill(resolvedRoot, candidate) {
  const linkTarget = path2.posix.relative(
    ".agents/skills",
    candidate.sourceWorkspacePath
  );
  if (!validRelativeLink(linkTarget) || linkTarget === ".") {
    throw new CoordinatorError(
      `Skill '${candidate.repository.id}:${candidate.source}' produced an unsafe registry link target.`,
      "SKILL_LINK_TARGET_UNSAFE"
    );
  }
  const target = validateTarget(resolvedRoot, candidate.targetName);
  const resolvedTarget = path2.resolve(
    path2.dirname(target),
    linkTarget.split("/").join(path2.sep)
  );
  let canonicalTarget;
  try {
    canonicalTarget = realpathSync(resolvedTarget);
  } catch {
    throw new CoordinatorError(
      `Skill '${candidate.repository.id}:${candidate.source}' does not resolve to an initialized source directory.`,
      "SKILL_SOURCE_MISSING"
    );
  }
  if (canonicalTarget !== candidate.sourceDirectory) {
    throw new CoordinatorError(
      `Skill '${candidate.repository.id}:${candidate.source}' registry link does not resolve to its validated source.`,
      "SKILL_LINK_TARGET_UNSAFE"
    );
  }
  return {
    linkTarget,
    materialization: "relative-symlink",
    name: candidate.targetName,
    repository: candidate.repository.id,
    source: candidate.source,
    sourceCommit: candidate.sourceCommit,
    treeOid: candidate.treeOid
  };
}
function resolveSkillLinks(resolvedRoot, manifest) {
  return resolveCandidates(resolvedRoot, manifest).map((candidate) => ({
    candidate,
    skill: linkedSkill(resolvedRoot, candidate)
  }));
}
function sourcePlanSignature(links) {
  return JSON.stringify(
    links.map(({ candidate, skill }) => ({
      skill,
      sourceDirectory: candidate.sourceDirectory
    }))
  );
}
function managedDestinationChanged(name) {
  return new CoordinatorError(
    `Managed skill destination '.agents/skills/${name}' no longer matches its lockfile state. Preserve it or preview adoption with 'coordinator agents check --force' before running 'coordinator agents sync --force'.`,
    "SKILL_MANAGED_DESTINATION_CHANGED"
  );
}
function createDirectoryIfMissing(directory, label) {
  try {
    mkdirSync2(directory);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  const status = lstatSync2(directory);
  if (!status.isDirectory() || status.isSymbolicLink()) {
    throw new CoordinatorError(
      `${label} is not a safe directory: ${directory}.`,
      "SKILL_DESTINATION_INVALID"
    );
  }
}
function ensureSkillRegistry(root) {
  const agentsRoot = safeGeneratedPath(root, ".agents");
  createDirectoryIfMissing(agentsRoot, "Agent registry");
  const agentsStatus = lstatSync2(agentsRoot);
  const agentsIdentity = {
    dev: Number(agentsStatus.dev),
    ino: Number(agentsStatus.ino)
  };
  assertDirectoryIdentity(agentsRoot, agentsIdentity);
  const skillsRoot = path2.join(agentsRoot, "skills");
  createDirectoryIfMissing(skillsRoot, "Skill registry");
  assertDirectoryIdentity(agentsRoot, agentsIdentity);
  safeGeneratedPath(root, ".agents/skills");
  const skillsStatus = lstatSync2(skillsRoot);
  const skillsIdentity = {
    dev: Number(skillsStatus.dev),
    ino: Number(skillsStatus.ino)
  };
  assertDirectoryIdentity(skillsRoot, skillsIdentity);
  return skillsIdentity;
}
function createSkillLink(linkTarget, destination, name) {
  try {
    symlinkSync(linkTarget, destination, "dir");
  } catch (error) {
    if (error.code === "EEXIST") {
      throw new CoordinatorError(
        `Skill destination '.agents/skills/${name}' changed during publication.`,
        "SKILL_DESTINATION_CHANGED"
      );
    }
    throw new CoordinatorError(
      `Could not create relative source link for skill '${name}': ${error instanceof Error ? error.message : String(error)}. Ensure this filesystem and account permit symbolic links.`,
      "SKILL_SYMLINK_UNAVAILABLE"
    );
  }
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
  const legacyByName = new Map(
    previousLock?.schemaVersion === 1 ? previousLock.skills.map((skill) => [skill.name, skill]) : []
  );
  const linkedByName = new Map(
    previousLock?.schemaVersion === 2 ? previousLock.skills.map((skill) => [skill.name, skill]) : []
  );
  const previouslyManaged = /* @__PURE__ */ new Set([
    ...legacyByName.keys(),
    ...linkedByName.keys()
  ]);
  const links = resolveSkillLinks(resolvedRoot, manifest);
  const skills = links.map(({ skill }) => skill);
  if (options.expectedSkills && JSON.stringify(skills) !== JSON.stringify(options.expectedSkills)) {
    throw new CoordinatorError(
      "Skill sources changed after dependent agent files were planned. Run synchronization again.",
      "SKILL_PLAN_STALE"
    );
  }
  const skillsRootStatus = lstatIfPresent2(skillsRoot);
  if (skillsRootStatus && !skillsRootStatus.isDirectory()) {
    throw new CoordinatorError(
      `Skill registry is not a directory: ${skillsRoot}.`,
      "SKILL_DESTINATION_INVALID"
    );
  }
  const desired = new Set(skills.map((skill) => skill.name));
  const mutations = [];
  const migrations = [];
  const force = options.force ?? false;
  for (const skill of skills) {
    const target = validateTarget(resolvedRoot, skill.name);
    const snapshot = destinationSnapshot(target);
    const legacy = legacyByName.get(skill.name);
    const linked = linkedByName.get(skill.name);
    let action = null;
    if (snapshot.kind === "missing") {
      action = "create-link";
    } else if (legacy) {
      if (snapshot.kind === "directory" && snapshot.digest === legacy.digest) {
        action = "migrate-copy";
        migrations.push(
          `${skill.name}: managed copy -> relative source symlink`
        );
      } else if (snapshot.kind === "symlink" && snapshot.linkTarget === skill.linkTarget) {
        action = "adopt-link";
      } else if (!force) {
        throw new CoordinatorError(
          `Managed skill copy '.agents/skills/${skill.name}' was modified or replaced and cannot be migrated safely. Preview forced adoption with 'coordinator agents check --force'.`,
          "SKILL_MANAGED_COPY_MODIFIED"
        );
      } else {
        action = "replace-link";
      }
    } else if (linked) {
      if (snapshot.kind === "symlink" && snapshot.linkTarget === skill.linkTarget) {
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
        "UNMANAGED_SKILL"
      );
    } else if (snapshot.kind === "symlink" && snapshot.linkTarget === skill.linkTarget) {
      action = "adopt-link";
    } else {
      action = "replace-link";
    }
    if (action) {
      mutations.push({
        action: { action, linkTarget: skill.linkTarget, name: skill.name },
        desired: skill,
        expected: snapshot,
        target
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
    const intact = legacy ? snapshot.kind === "directory" && snapshot.digest === legacy.digest : linked ? snapshot.kind === "symlink" && snapshot.linkTarget === linked.linkTarget : false;
    if (!intact && !force) throw managedDestinationChanged(oldName);
    mutations.push({
      action: { action: "delete-managed", linkTarget: null, name: oldName },
      desired: null,
      expected: snapshot,
      target
    });
  }
  const nextLock = {
    schemaVersion: 2,
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
      force,
      owned: (content) => parseLock(content) !== null
    }
  );
  const actions = mutations.map(({ action }) => action);
  const changed = actions.length > 0 || lockPlan.action !== "unchanged";
  const result2 = {
    actions,
    changed,
    migrations,
    names: skills.map((skill) => skill.name),
    skills
  };
  if (options.check) return result2;
  const skillsRootIdentity = ensureSkillRegistry(resolvedRoot);
  const refreshedLinks = resolveSkillLinks(resolvedRoot, manifest);
  if (sourcePlanSignature(refreshedLinks) !== sourcePlanSignature(links)) {
    throw new CoordinatorError(
      "Skill sources changed after planning; run synchronization again.",
      "SKILL_SOURCE_CHANGED"
    );
  }
  for (const mutation of mutations) {
    if (!snapshotsMatch(destinationSnapshot(mutation.target), mutation.expected)) {
      throw new CoordinatorError(
        `Skill destination '.agents/skills/${mutation.action.name}' changed after planning.`,
        "SKILL_DESTINATION_CHANGED"
      );
    }
  }
  const temporaryRoot = mkdtempSync(
    path2.join(skillsRoot, ".coordinator-staging-")
  );
  let preserveTemporaryRoot = false;
  try {
    const backupRoot = path2.join(temporaryRoot, "backup");
    const discardedRoot = path2.join(temporaryRoot, "discarded");
    mkdirSync2(backupRoot);
    mkdirSync2(discardedRoot);
    const applied = [];
    try {
      for (const mutation of mutations) {
        assertDirectoryIdentity(skillsRoot, skillsRootIdentity);
        if (!snapshotsMatch(
          destinationSnapshot(mutation.target),
          mutation.expected
        )) {
          throw new CoordinatorError(
            `Skill destination '.agents/skills/${mutation.action.name}' changed during publication.`,
            "SKILL_DESTINATION_CHANGED"
          );
        }
        if (mutation.action.action === "adopt-link") continue;
        const change = {
          backup: null,
          name: mutation.action.name,
          published: false,
          publishedSnapshot: null,
          target: mutation.target
        };
        applied.push(change);
        if (lstatIfPresent2(mutation.target)) {
          change.backup = path2.join(backupRoot, mutation.action.name);
          renameSync2(mutation.target, change.backup);
          if (!snapshotsMatch(
            destinationSnapshot(change.backup),
            mutation.expected
          )) {
            throw new CoordinatorError(
              `Skill destination '.agents/skills/${mutation.action.name}' changed while it was being backed up.`,
              "SKILL_DESTINATION_CHANGED"
            );
          }
        }
        if (mutation.desired) {
          assertDirectoryIdentity(skillsRoot, skillsRootIdentity);
          createSkillLink(
            mutation.desired.linkTarget,
            mutation.target,
            mutation.action.name
          );
          const publishedSnapshot = destinationSnapshot(mutation.target);
          if (publishedSnapshot.kind !== "symlink" || publishedSnapshot.linkTarget !== mutation.desired.linkTarget) {
            throw new CoordinatorError(
              `Published skill link '${mutation.action.name}' does not match its plan.`,
              "SKILL_DESTINATION_CHANGED"
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
          "SKILL_SOURCE_CHANGED"
        );
      }
      applyFilePlans([lockPlan, ...options.dependentFilePlans ?? []]);
    } catch (error) {
      const rollbackFailures = rollbackSkillChanges(
        resolvedRoot,
        skillsRoot,
        skillsRootIdentity,
        discardedRoot,
        applied
      );
      if (rollbackFailures.length) {
        preserveTemporaryRoot = true;
        throw new CoordinatorError(
          `Skill synchronization failed (${error instanceof Error ? error.message : String(error)}) and rollback was incomplete: ${rollbackFailures.join("; ")}. Recovery data was preserved at ${temporaryRoot}.`,
          "SKILL_ROLLBACK_FAILED"
        );
      }
      throw error;
    }
    return result2;
  } finally {
    if (!preserveTemporaryRoot && lstatIfPresent2(temporaryRoot)) {
      rmSync(temporaryRoot, { recursive: true });
    }
  }
}
function discoverSkillSources(repositoryDirectory) {
  const results = /* @__PURE__ */ new Map();
  let repositoryRealPath;
  try {
    repositoryRealPath = realpathSync(repositoryDirectory);
  } catch {
    return [];
  }
  const visit = (directory, exportedDirectory, depth, ancestors) => {
    if (depth > 9) return;
    let directoryRealPath;
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
      const absolute = path2.join(directory, entry.name);
      let candidateRealPath;
      try {
        if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
        candidateRealPath = realpathSync(absolute);
        if (!statSync(candidateRealPath).isDirectory()) continue;
      } catch {
        continue;
      }
      if (!isWithin(repositoryRealPath, candidateRealPath)) continue;
      const relative = gitPath(path2.relative(repositoryRealPath, candidateRealPath));
      const exported = gitPath(path2.join(exportedDirectory, entry.name));
      const exportMatch = /(^|\/)\.agents\/(skills|flows)\/[a-z0-9-]+$/.exec(exported);
      if (relative && existsSync2(path2.join(candidateRealPath, "SKILL.md")) && exportMatch) {
        const kind = exportMatch[2] === "flows" ? "flow" : "skill";
        results.set(`${kind}\0${relative}`, { source: relative, kind });
        continue;
      }
      visit(candidateRealPath, exported, depth + 1, nextAncestors);
    }
  };
  if (existsSync2(repositoryDirectory)) {
    visit(repositoryRealPath, "", 0, /* @__PURE__ */ new Set());
  }
  return [...results.values()].sort(
    (left, right) => left.source.localeCompare(right.source) || left.kind.localeCompare(right.kind)
  );
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
    return {
      changed: false,
      files: [],
      skillActions: [],
      skillMigrations: [],
      skills: []
    };
  }
  const force = options.force ?? false;
  const skillPreview = synchronizeSkills(root, manifest, generatorVersion, {
    check: true,
    force
  });
  const files = renderAgentFiles(root, manifest, skillPreview.names, force);
  const desiredPaths = new Set(files.map((file) => file.relativePath));
  for (const stalePath of generatedAgentPaths(root)) {
    if (!desiredPaths.has(stalePath)) {
      files.push(planFileDeletion(root, stalePath, owned));
    }
  }
  const changed = skillPreview.changed || changedPlans(files).length > 0;
  if (options.check) {
    return {
      changed,
      files,
      skillActions: skillPreview.actions,
      skillMigrations: skillPreview.migrations,
      skills: skillPreview.names
    };
  }
  const skillResult = synchronizeSkills(root, manifest, generatorVersion, {
    dependentFilePlans: files,
    expectedSkills: skillPreview.skills,
    force
  });
  return {
    changed,
    files,
    skillActions: skillResult.actions,
    skillMigrations: skillResult.migrations,
    skills: skillResult.names
  };
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

// src/core/repository-url.ts
var providers = {
  github: { host: "github.com" },
  bitbucket: { host: "bitbucket.org" }
};
function repositoryPath(value2) {
  const normalized = value2.replace(/\/+$/, "").replace(/\.git$/i, "");
  const segments = normalized.split("/");
  if (segments.length !== 2 || segments.some(
    (segment) => !segment || segment === "." || segment === ".." || /[\s\\?#@:%]/.test(segment)
  )) {
    return null;
  }
  return {
    namespace: segments[0].toLowerCase(),
    repository: segments[1].toLowerCase()
  };
}
function identity(provider, value2) {
  const parsedPath = repositoryPath(value2);
  if (!parsedPath) return null;
  return {
    provider,
    host: providers[provider].host,
    ...parsedPath
  };
}
function providerForHost(host) {
  const normalized = host.toLowerCase();
  if (normalized === providers.github.host) return "github";
  if (normalized === providers.bitbucket.host) return "bitbucket";
  return null;
}
function parsePrefixedIdentity(value2) {
  const match = /^(github|bitbucket):(.*)$/i.exec(value2);
  if (!match) return null;
  return identity(match[1].toLowerCase(), match[2]);
}
function parseScpIdentity(value2) {
  const match = /^(?:[^@/:]+@)?([^/:]+):(.+)$/.exec(value2);
  if (!match) return null;
  const provider = providerForHost(match[1]);
  return provider ? identity(provider, match[2]) : null;
}
function parseUrlIdentity(value2) {
  let parsed;
  try {
    parsed = new URL(value2);
  } catch {
    return null;
  }
  if (!["http:", "https:", "ssh:"].includes(parsed.protocol)) return null;
  if (parsed.search || parsed.hash) return null;
  const provider = providerForHost(parsed.hostname);
  if (!provider) return null;
  if (provider === "bitbucket" && (parsed.protocol === "http:" || parsed.protocol === "https:" && parsed.port && parsed.port !== "443" || parsed.protocol === "ssh:" && parsed.port && parsed.port !== "22")) {
    return null;
  }
  return identity(provider, parsed.pathname.replace(/^\/+/, ""));
}
function embeddedUrlCredentials(value2) {
  const scp = /^([^@/:]+)@(github\.com|bitbucket\.org):/i.exec(value2);
  if (scp && scp[1].toLowerCase() !== "git") return true;
  let parsed;
  try {
    parsed = new URL(value2);
  } catch {
    return false;
  }
  return Boolean(
    parsed.password || parsed.search || parsed.hash || ["http:", "https:"].includes(parsed.protocol) && parsed.username || parsed.protocol === "ssh:" && providerForHost(parsed.hostname) && parsed.username && parsed.username.toLowerCase() !== "git"
  );
}
function parseRepositoryIdentity(input) {
  const value2 = input.trim();
  const prefixed = parsePrefixedIdentity(value2);
  if (prefixed) return prefixed;
  const scp = parseScpIdentity(value2);
  if (scp) return scp;
  const url = parseUrlIdentity(value2);
  if (url) return url;
  return /^[^/:]+\/[^/]+$/.test(value2) ? identity("github", value2) : null;
}
function canonicalRepositorySshUrl(input) {
  const parsed = parseRepositoryIdentity(input);
  return parsed ? `git@${parsed.host}:${parsed.namespace}/${parsed.repository}.git` : null;
}
function repositoryCloneUrl(input) {
  const value2 = input.trim();
  let parsedUrl = null;
  try {
    parsedUrl = new URL(value2);
  } catch {
  }
  if (embeddedUrlCredentials(value2)) {
    throw new CoordinatorError(
      "Repository clone URLs must not embed credentials, query parameters, or fragments; configure Git credentials separately.",
      "REPOSITORY_URL_CREDENTIALS_FORBIDDEN"
    );
  }
  if (/^(?:github|bitbucket):/i.test(value2)) {
    const canonical = canonicalRepositorySshUrl(value2);
    if (!canonical) {
      throw new CoordinatorError(
        "Invalid provider shorthand; use github:owner/repository or bitbucket:workspace/repository.",
        "REPOSITORY_SHORTHAND_INVALID"
      );
    }
    return canonical;
  }
  if (/^[^/:]+\/[^/]+$/.test(value2)) {
    return canonicalRepositorySshUrl(value2) ?? value2;
  }
  const isBitbucketUrl = parsedUrl?.hostname.toLowerCase() === "bitbucket.org";
  const isBitbucketScp = /^(?:[^@/:]+@)?bitbucket\.org:/i.test(value2);
  if ((isBitbucketUrl || isBitbucketScp) && !parseRepositoryIdentity(value2)) {
    throw new CoordinatorError(
      "Invalid Bitbucket Cloud clone URL; use HTTPS or SSH on the standard port with workspace/repository.",
      "BITBUCKET_URL_INVALID"
    );
  }
  return value2;
}
function repositoryUrlsMatch(expected, actual) {
  if (embeddedUrlCredentials(expected) || embeddedUrlCredentials(actual)) {
    return false;
  }
  const expectedIdentity = parseRepositoryIdentity(expected);
  const actualIdentity = parseRepositoryIdentity(actual);
  if (expectedIdentity || actualIdentity) {
    return expectedIdentity !== null && actualIdentity !== null && expectedIdentity.host === actualIdentity.host && expectedIdentity.namespace === actualIdentity.namespace && expectedIdentity.repository === actualIdentity.repository;
  }
  return expected.replace(/\/+$/, "") === actual.replace(/\/+$/, "");
}
function redactRepositoryUrl(input) {
  const canonical = canonicalRepositorySshUrl(input);
  if (canonical) return canonical;
  try {
    const parsed = new URL(input);
    if (!parsed.username && !parsed.password && !parsed.search && !parsed.hash) {
      return input;
    }
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return input;
  }
}

// src/core/schema.ts
import path4 from "path";
import { z } from "zod";
var identifier = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "use lowercase kebab-case");
var singleLine = z.string().min(1).refine(
  (value2) => !/[\r\n]/.test(value2),
  "must be a single line"
);
var repositoryUrl = singleLine.superRefine((value2, context) => {
  try {
    repositoryCloneUrl(value2);
  } catch (error) {
    context.addIssue({
      code: "custom",
      message: error instanceof Error ? error.message : "invalid repository URL"
    });
  }
});
var relativePath = z.string().min(1).refine(
  (value2) => !path4.isAbsolute(value2) && !value2.split(/[\\/]/).includes("..") && value2 !== ".",
  "must be a safe relative path"
);
var relativeDirectoryPath = z.string().min(1).refine(
  (value2) => !path4.isAbsolute(value2) && !value2.split(/[\\/]/).includes(".."),
  "must be a safe relative directory path"
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
  name: identifier.optional(),
  kind: z.enum(["skill", "flow"]).optional()
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
  url: repositoryUrl,
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
  skillCollision: z.enum(["namespace", "error"]).default("error")
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
}).strict();
var workspaceManifestSchema = z.object({
  path: relativePath,
  coordinatorToken: z.string().min(1).default("$coordinator"),
  mirrorActiveInLinkedWorktrees: z.boolean().default(false)
});
var workspaceSelectionEntrySchema = z.object({
  branch: singleLine,
  mode: z.enum(["active", "pinned"])
}).strict();
var workspaceSchema = z.object({
  baseBranch: singleLine,
  coordinatorToken: z.literal("$coordinator").default("$coordinator"),
  mirrorActiveInLinkedWorktrees: z.boolean().default(false),
  selection: z.record(identifier, workspaceSelectionEntrySchema)
}).strict();
var localComposeSchema = z.object({
  projectDirectory: relativeDirectoryPath,
  files: z.array(relativePath).min(1).refine(
    (files) => new Set(files).size === files.length,
    "must not contain duplicate Compose files"
  ),
  override: z.string().min(1)
}).strict();
var localSchema = z.object({
  compose: localComposeSchema.optional()
}).strict();
var coordinatorManifestSchema = z.object({
  schemaVersion: z.union([z.literal(1), z.literal(2)]),
  name: identifier,
  remote: z.string().min(1).default("origin"),
  repositories: z.array(repositorySchema).min(1),
  workspaceManifest: workspaceManifestSchema.optional(),
  workspace: workspaceSchema.optional(),
  local: localSchema.optional(),
  agents: agentsSchema.default({
    tools: ["codex"],
    maxParallel: 4,
    skillCollision: "error"
  }),
  deployments: deploymentsSchema.optional()
}).superRefine((manifest, context) => {
  if (manifest.schemaVersion === 1) {
    if (manifest.workspace) {
      context.addIssue({
        code: "custom",
        path: ["workspace"],
        message: "requires schemaVersion 2"
      });
    }
    if (manifest.local) {
      context.addIssue({
        code: "custom",
        path: ["local"],
        message: "requires schemaVersion 2"
      });
    }
  } else if (manifest.workspaceManifest) {
    context.addIssue({
      code: "custom",
      path: ["workspaceManifest"],
      message: "is legacy schemaVersion 1 syntax; embed the selection in workspace"
    });
  }
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
  if (manifest.workspace) {
    const selectedIds = new Set(Object.keys(manifest.workspace.selection));
    for (const repositoryId of ids) {
      if (!selectedIds.has(repositoryId)) {
        context.addIssue({
          code: "custom",
          path: ["workspace", "selection"],
          message: `missing repository '${repositoryId}'`
        });
      }
    }
    for (const repositoryId of selectedIds) {
      if (!ids.has(repositoryId)) {
        context.addIssue({
          code: "custom",
          path: ["workspace", "selection", repositoryId],
          message: `unknown repository '${repositoryId}'`
        });
      }
    }
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
        continue;
      }
      const repository = manifest.repositories.find(
        (candidate) => candidate.id === component.repository
      );
      if (repository && parseRepositoryIdentity(repository.url)?.provider !== "github") {
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
          message: `repository '${component.repository}' must use a GitHub URL for coordinated deployments`
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
  const result2 = coordinatorManifestSchema.safeParse(raw);
  if (!result2.success) {
    const issues = result2.error.issues.map((issue) => `${issue.path.join(".") || MANIFEST_NAME}: ${issue.message}`).join("\n");
    throw new CoordinatorError(
      `${MANIFEST_NAME} is invalid:
${issues}`,
      "INVALID_MANIFEST"
    );
  }
  return { manifest: result2.data, path: manifestPath, root };
}
function renderManifest(manifest) {
  return `# ${GENERATED_MARKER}. This file is project-owned; generated outputs derive from it.
${stringify(
    manifest,
    { lineWidth: 100 }
  )}`;
}
function githubRepositoryName(url) {
  const identity2 = parseRepositoryIdentity(url);
  return identity2?.provider === "github" ? `${identity2.namespace}/${identity2.repository}` : null;
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
              const githubRepository = githubRepositoryName(repository.url);
              if (!githubRepository) {
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
                  githubRepository
                }
              ];
            })
          )
        }
      ])
    )
  };
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
          node .coordinator/runtime/deployment-plan.mjs ${shellQuote(environmentName)}
${triggerJobs}`;
}
var DEPLOYMENT_CONFIGURATION_PLACEHOLDER = "/* @agent-coordinator:deployment-configuration */ null";
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
function renderDeploymentPlanner(manifest) {
  const configuration = deploymentConfiguration(manifest);
  if (!configuration) return null;
  const template = loadPlannerTemplate();
  const first = template.indexOf(DEPLOYMENT_CONFIGURATION_PLACEHOLDER);
  if (first < 0 || first !== template.lastIndexOf(DEPLOYMENT_CONFIGURATION_PLACEHOLDER)) {
    throw new CoordinatorError(
      "Bundled deployment planner has an invalid configuration placeholder."
    );
  }
  return template.replace(
    DEPLOYMENT_CONFIGURATION_PLACEHOLDER,
    `/* @agent-coordinator:deployment-configuration */ ${JSON.stringify(configuration, null, 2)}`
  );
}

// src/ci/sync.ts
function workflowOwned(content) {
  return content.includes(CI_MARKER);
}
function plannerOwned(content) {
  return content.includes("export async function buildDeploymentPlan");
}
function legacyDeploymentConfigurationOwned(content) {
  try {
    const parsed = JSON.parse(content);
    return typeof parsed === "object" && parsed !== null && "generatedBy" in parsed && parsed.generatedBy === "agent-coordinator";
  } catch {
    return false;
  }
}
function generatedCiPaths(root) {
  const paths = [];
  for (const [relativePath2, isOwned] of [
    [".coordinator/deployments.json", legacyDeploymentConfigurationOwned],
    [".coordinator/runtime/deployment-plan.mjs", plannerOwned]
  ]) {
    const absolutePath = path7.join(root, relativePath2);
    if (existsSync6(absolutePath) && isOwned(readFileSync6(absolutePath, "utf8"))) {
      paths.push(relativePath2);
    }
  }
  const workflows = path7.join(root, ".github", "workflows");
  if (existsSync6(workflows)) {
    for (const entry of readdirSync3(workflows, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const relativePath2 = path7.posix.join(".github/workflows", entry.name);
      if (workflowOwned(readFileSync6(path7.join(root, relativePath2), "utf8"))) {
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
      ".coordinator/runtime/deployment-plan.mjs",
      renderDeploymentPlanner(manifest),
      { force, owned: plannerOwned }
    ),
    ...Object.keys(manifest.deployments.environments).map(
      (environment) => planFile(
        root,
        `.github/workflows/coordinator-deploy-${environment}.yml`,
        renderEnvironmentWorkflow(manifest, environment),
        { force, owned: workflowOwned }
      )
    )
  ] : [];
  const desiredPaths = new Set(files.map((file) => file.relativePath));
  for (const stalePath of generatedCiPaths(root)) {
    if (!desiredPaths.has(stalePath)) {
      const isOwned = stalePath === ".coordinator/deployments.json" ? legacyDeploymentConfigurationOwned : stalePath === ".coordinator/runtime/deployment-plan.mjs" ? plannerOwned : workflowOwned;
      files.push(planFileDeletion(root, stalePath, isOwned));
    }
  }
  const changed = changedPlans(files).length > 0;
  if (!options.check) applyFilePlans(files);
  return { changed, files };
}

// src/doctor/check.ts
import { existsSync as existsSync8, readFileSync as readFileSync8 } from "fs";
import path9 from "path";

// src/git/install.ts
import { randomUUID as randomUUID2 } from "crypto";
import {
  accessSync,
  chmodSync,
  constants,
  copyFileSync,
  existsSync as existsSync7,
  lstatSync as lstatSync3,
  mkdirSync as mkdirSync3,
  readFileSync as readFileSync7,
  readlinkSync as readlinkSync2,
  readdirSync as readdirSync4,
  realpathSync as realpathSync2,
  renameSync as renameSync3,
  rmdirSync,
  symlinkSync as symlinkSync2,
  unlinkSync as unlinkSync2,
  writeFileSync as writeFileSync2
} from "fs";
import os from "os";
import path8 from "path";
var MANAGED_MARKERS = [
  "agent-coordinator-git-wrapper-v1",
  "git-coordinator-wrapper-v1",
  "market-intel-coordinated-git-v1"
];
var COORDINATED_HOOKS = ["post-checkout", "pre-commit", "pre-push"];
var HOOK_DIRECTORY_MARKER = ".agent-coordinator-owned";
var HOOK_DIRECTORY_MARKER_CONTENT = "Managed by Agent Coordinator.\n";
function environmentFor(options) {
  return options?.environment ?? process.env;
}
function homeDirectory(environment) {
  return environment.HOME ? path8.resolve(environment.HOME) : os.homedir();
}
function agentCoordinatorHome(environment = process.env) {
  return path8.resolve(
    environment.AGENT_COORDINATOR_HOME ?? path8.join(homeDirectory(environment), ".local", "share", "agent-coordinator")
  );
}
function legacyGitCoordinatorHome(environment) {
  return path8.resolve(
    environment.GIT_COORDINATOR_HOME ?? path8.join(homeDirectory(environment), ".local", "share", "git-coordinator")
  );
}
function installedGitRuntimePath(environment = process.env) {
  return path8.join(agentCoordinatorHome(environment), "git-runtime", "git-wrapper.mjs");
}
function embeddedGitRuntimeSourcePath(_environment = process.env) {
  const candidates = [
    path8.resolve(import.meta.dirname, "git-wrapper.mjs"),
    path8.resolve(import.meta.dirname, "../../dist/git-wrapper.mjs")
  ];
  const source = candidates.find((candidate) => existsSync7(candidate));
  if (!source) {
    throw new CoordinatorError(
      "The embedded Git runtime is missing from this Agent Coordinator installation. Reinstall Agent Coordinator and retry.",
      "EMBEDDED_GIT_RUNTIME_MISSING"
    );
  }
  return source;
}
function realGit(environment) {
  return environment.GIT_COORDINATOR_REAL_GIT ?? environment.COORDINATED_GIT_REAL ?? "/usr/bin/git";
}
function canonicalPath(value2) {
  try {
    return realpathSync2(value2);
  } catch {
    return path8.resolve(value2);
  }
}
function pathPresent(value2) {
  try {
    lstatSync3(value2);
    return true;
  } catch {
    return false;
  }
}
function pathInside(candidate, parent) {
  const relative = path8.relative(canonicalPath(parent), canonicalPath(candidate));
  return relative === "" || !relative.startsWith("..") && !path8.isAbsolute(relative);
}
function fileHasManagedMarker(candidate) {
  try {
    const contents = readFileSync7(candidate, "utf8");
    return MANAGED_MARKERS.some((marker) => contents.includes(marker));
  } catch {
    return false;
  }
}
function isManagedExecutable(candidate, environment) {
  if (!pathPresent(candidate)) return false;
  const metadata = lstatSync3(candidate);
  if (metadata.isSymbolicLink()) {
    const target = path8.resolve(path8.dirname(candidate), readlinkSync2(candidate));
    if (pathInside(target, agentCoordinatorHome(environment)) || pathInside(target, legacyGitCoordinatorHome(environment))) {
      return true;
    }
    return fileHasManagedMarker(target);
  }
  return metadata.isFile() && fileHasManagedMarker(candidate);
}
function ensureManagedOrAbsent(candidate, environment) {
  if (pathPresent(candidate) && !isManagedExecutable(candidate, environment)) {
    throw new CoordinatorError(
      `Refusing to replace unmanaged executable: ${candidate}`,
      "UNMANAGED_GIT_EXECUTABLE"
    );
  }
}
function writableBinDirectory(environment) {
  const explicit = environment.AGENT_COORDINATOR_GIT_BIN_DIR ?? environment.GIT_COORDINATOR_BIN_DIR;
  if (explicit) {
    const resolved = path8.resolve(explicit);
    try {
      accessSync(resolved, constants.W_OK);
    } catch {
      throw new CoordinatorError(
        `Git shim directory is not writable: ${resolved}`,
        "GIT_BIN_DIRECTORY_UNAVAILABLE"
      );
    }
    return resolved;
  }
  const entries = (environment.PATH ?? "").split(path8.delimiter).filter(Boolean).map((entry) => path8.resolve(entry));
  const realGitDirectory = path8.dirname(canonicalPath(realGit(environment)));
  const beforeRealGit = [];
  for (const entry of entries) {
    if (canonicalPath(entry) === canonicalPath(realGitDirectory)) break;
    beforeRealGit.push(entry);
  }
  for (const preferred of ["/opt/homebrew/bin", "/usr/local/bin"]) {
    if (!beforeRealGit.some((entry) => canonicalPath(entry) === canonicalPath(preferred))) {
      continue;
    }
    try {
      accessSync(preferred, constants.W_OK);
      return preferred;
    } catch {
    }
  }
  for (const entry of beforeRealGit) {
    if (entry.includes("/node_modules/") || entry.includes("/.codex/") || entry.includes("/var/run/")) {
      continue;
    }
    try {
      accessSync(entry, constants.W_OK);
      return entry;
    } catch {
    }
  }
  throw new CoordinatorError(
    "No persistent writable PATH directory exists before the real Git binary.",
    "GIT_BIN_DIRECTORY_UNAVAILABLE"
  );
}
function result(message, options) {
  if ((options.stdio ?? "pipe") === "inherit") process.stdout.write(`${message}
`);
  return { status: 0, stdout: message, stderr: "" };
}
function failedResultOrThrow(error, options) {
  if (options.allowFailure) {
    return { status: 1, stdout: "", stderr: errorMessage(error) };
  }
  throw error;
}
function atomicCopyExecutable(source, destination) {
  mkdirSync3(path8.dirname(destination), { recursive: true });
  const temporary = path8.join(
    path8.dirname(destination),
    `.${path8.basename(destination)}.agent-coordinator-${randomUUID2()}`
  );
  try {
    copyFileSync(source, temporary);
    chmodSync(temporary, 493);
    renameSync3(temporary, destination);
  } finally {
    if (pathPresent(temporary)) unlinkSync2(temporary);
  }
}
function atomicSymlink(source, destination) {
  const temporary = path8.join(
    path8.dirname(destination),
    `.${path8.basename(destination)}.agent-coordinator-${randomUUID2()}`
  );
  try {
    symlinkSync2(source, temporary);
    if (pathPresent(destination)) unlinkSync2(destination);
    renameSync3(temporary, destination);
  } finally {
    if (pathPresent(temporary)) unlinkSync2(temporary);
  }
}
function installMachineGitRuntime(options = {}) {
  try {
    const environment = environmentFor(options);
    const source = embeddedGitRuntimeSourcePath(environment);
    if (!fileHasManagedMarker(source)) {
      throw new CoordinatorError(
        `Embedded Git runtime has no recognized ownership marker: ${source}`,
        "INVALID_EMBEDDED_GIT_RUNTIME"
      );
    }
    const destination = installedGitRuntimePath(environment);
    if (pathPresent(destination) && !fileHasManagedMarker(destination)) {
      throw new CoordinatorError(
        `Refusing to replace unmanaged runtime: ${destination}`,
        "UNMANAGED_GIT_RUNTIME"
      );
    }
    const binDirectory = writableBinDirectory(environment);
    const gitExecutable = path8.join(binDirectory, "git");
    const legacyCliExecutable = path8.join(binDirectory, "git-coordinator");
    ensureManagedOrAbsent(gitExecutable, environment);
    atomicCopyExecutable(source, destination);
    atomicSymlink(destination, gitExecutable);
    if (pathPresent(legacyCliExecutable) && isManagedExecutable(legacyCliExecutable, environment)) {
      unlinkSync2(legacyCliExecutable);
    }
    return result(
      `Agent Coordinator Git runtime installed in ${binDirectory}.`,
      options
    );
  } catch (error) {
    return failedResultOrThrow(error, options);
  }
}
function candidateBinDirectories(environment) {
  const explicit = environment.AGENT_COORDINATOR_GIT_BIN_DIR ?? environment.GIT_COORDINATOR_BIN_DIR;
  const entries = explicit ? [path8.resolve(explicit)] : (environment.PATH ?? "").split(path8.delimiter).filter(Boolean).map((entry) => path8.resolve(entry));
  return [...new Set(entries)];
}
function uninstallMachineGitRuntime(options = {}) {
  try {
    const environment = environmentFor(options);
    const removed = [];
    const runtime = installedGitRuntimePath(environment);
    if (pathPresent(runtime) && !fileHasManagedMarker(runtime)) {
      throw new CoordinatorError(
        `Refusing to remove unmanaged runtime: ${runtime}`,
        "UNMANAGED_GIT_RUNTIME"
      );
    }
    for (const directory of candidateBinDirectories(environment)) {
      for (const executable of ["git", "git-coordinator"]) {
        const candidate = path8.join(directory, executable);
        if (pathPresent(candidate) && isManagedExecutable(candidate, environment)) {
          unlinkSync2(candidate);
          removed.push(candidate);
        }
      }
    }
    if (pathPresent(runtime)) {
      unlinkSync2(runtime);
      removed.push(runtime);
    }
    const runtimeDirectory = path8.dirname(runtime);
    try {
      rmdirSync(runtimeDirectory);
    } catch {
    }
    return result(
      removed.length ? `Removed ${removed.length} managed Git runtime path${removed.length === 1 ? "" : "s"}.` : "No managed Git runtime was installed.",
      options
    );
  } catch (error) {
    return failedResultOrThrow(error, options);
  }
}
function git(environment, argumentsList, options = {}) {
  return runCommand(realGit(environment), argumentsList, {
    allowFailure: options.allowFailure,
    cwd: options.cwd,
    env: {
      ...environment,
      GIT_COORDINATOR_INTERNAL: "1",
      COORDINATED_GIT_INTERNAL: "1"
    }
  });
}
function workspaceRoot(directory, environment) {
  return canonicalPath(
    git(environment, ["-C", directory, "rev-parse", "--show-toplevel"]).stdout
  );
}
function configurationExists(root) {
  if (existsSync7(path8.join(root, "coordinator.yaml")) || existsSync7(path8.join(root, ".git-coordinator.json"))) {
    return true;
  }
  const packagePath = path8.join(root, "package.json");
  if (!existsSync7(packagePath)) return false;
  try {
    return Boolean(
      JSON.parse(readFileSync7(packagePath, "utf8")).coordinatedGit
    );
  } catch {
    return false;
  }
}
function manifestName(root) {
  if (existsSync7(path8.join(root, "coordinator.yaml"))) return "coordinator.yaml";
  if (existsSync7(path8.join(root, ".git-coordinator.json"))) {
    return ".git-coordinator.json";
  }
  return "package.json";
}
function primaryWorktree(root, environment) {
  const line = git(environment, ["-C", root, "worktree", "list", "--porcelain"]).stdout.split("\n").find((candidate) => candidate.startsWith("worktree "));
  if (!line) {
    throw new CoordinatorError(
      `Could not determine the primary worktree for ${root}.`,
      "GIT_WORKTREE_UNAVAILABLE"
    );
  }
  return canonicalPath(line.slice("worktree ".length));
}
function commonGitDirectory(root, environment) {
  const common = git(environment, [
    "-C",
    root,
    "rev-parse",
    "--git-common-dir"
  ]).stdout;
  return canonicalPath(path8.resolve(root, common));
}
function resolveHookPath(root, hookPath, environment) {
  if (!hookPath) return null;
  return path8.isAbsolute(hookPath) ? canonicalPath(hookPath) : path8.resolve(primaryWorktree(root, environment), hookPath);
}
function localConfig(root, key, environment) {
  const found = git(
    environment,
    ["-C", root, "config", "--local", "--get", key],
    { allowFailure: true }
  );
  return found.status === 0 ? found.stdout : null;
}
function setLocalConfig(root, key, value2, environment) {
  git(environment, ["-C", root, "config", "--local", "--replace-all", key, value2]);
}
function unsetLocalConfig(root, key, environment) {
  git(
    environment,
    ["-C", root, "config", "--local", "--unset-all", key],
    { allowFailure: true }
  );
}
function hookConfigurationName(hook) {
  return `git-coordinator-${hook}`;
}
function removeConfiguredHooks(root, environment) {
  for (const hook of COORDINATED_HOOKS) {
    const name = hookConfigurationName(hook);
    unsetLocalConfig(root, `hook.${name}.command`, environment);
    unsetLocalConfig(root, `hook.${name}.event`, environment);
  }
}
function supportsConfiguredHooks(root, environment) {
  const probe = git(
    environment,
    [
      "-C",
      root,
      "hook",
      "list",
      "--allow-unknown-hook-name",
      "agent-coordinator-capability-probe"
    ],
    { allowFailure: true }
  );
  const output = `${probe.stdout}
${probe.stderr}`;
  if (/not a git command|unknown subcommand|unknown option|usage:/i.test(output)) {
    return false;
  }
  return probe.status === 0 || /no hooks found/i.test(output);
}
function shellDoubleQuote(value2) {
  return value2.replace(/["\\$`]/g, "\\$&");
}
function installConfiguredHooks(root, runtime, environment) {
  removeConfiguredHooks(root, environment);
  for (const hook of COORDINATED_HOOKS) {
    const name = hookConfigurationName(hook);
    const command = `"${shellDoubleQuote(process.execPath)}" "${shellDoubleQuote(runtime)}" --hook ${hook}`;
    setLocalConfig(root, `hook.${name}.command`, command, environment);
    setLocalConfig(root, `hook.${name}.event`, hook, environment);
  }
}
function writeFileHook(hooksDirectory, runtime, hook) {
  const content = [
    "#!/bin/sh",
    "set -eu",
    `"${shellDoubleQuote(process.execPath)}" "${shellDoubleQuote(runtime)}" --hook ${hook} "$@"`,
    ""
  ].join("\n");
  writeFileSync2(path8.join(hooksDirectory, hook), content, { mode: 493 });
}
function hookPathIsManaged(root, hooksDirectory, configuredPath) {
  if (!configuredPath) return false;
  const resolved = path8.isAbsolute(configuredPath) ? configuredPath : path8.resolve(root, configuredPath);
  return canonicalPath(resolved) === canonicalPath(hooksDirectory);
}
function managedHookFile(candidate) {
  try {
    const contents = readFileSync7(candidate, "utf8");
    return contents.includes("git-wrapper.mjs") && contents.includes("--hook");
  } catch {
    return false;
  }
}
function hooksDirectoryOwned(root, hooksDirectory, currentHookPath, environment) {
  const marker = path8.join(hooksDirectory, HOOK_DIRECTORY_MARKER);
  if (existsSync7(marker) && readFileSync7(marker, "utf8") === HOOK_DIRECTORY_MARKER_CONTENT) {
    return true;
  }
  if (!hookPathIsManaged(root, hooksDirectory, currentHookPath)) return false;
  const mode = localConfig(root, "gitCoordinator.hookMode", environment);
  const manifest = localConfig(root, "gitCoordinator.manifest", environment);
  return mode === "configured" || mode === "files" || manifest !== null;
}
function prepareHooksDirectory(root, hooksDirectory, currentHookPath, environment) {
  if (!existsSync7(hooksDirectory)) {
    mkdirSync3(hooksDirectory, { recursive: true });
    return;
  }
  const owned2 = hooksDirectoryOwned(
    root,
    hooksDirectory,
    currentHookPath,
    environment
  );
  const removable = [];
  for (const entry of readdirSync4(hooksDirectory)) {
    const candidate = path8.join(hooksDirectory, entry);
    if (entry === HOOK_DIRECTORY_MARKER) {
      if (readFileSync7(candidate, "utf8") !== HOOK_DIRECTORY_MARKER_CONTENT) {
        throw new CoordinatorError(
          `Refusing to replace unmanaged ownership marker: ${candidate}`,
          "UNMANAGED_GIT_HOOKS_DIRECTORY"
        );
      }
      continue;
    }
    if (COORDINATED_HOOKS.includes(entry)) {
      if (!managedHookFile(candidate)) {
        throw new CoordinatorError(
          `Refusing to replace unmanaged hook: ${candidate}`,
          "UNMANAGED_GIT_HOOK"
        );
      }
      removable.push(candidate);
      continue;
    }
    if (!owned2) {
      throw new CoordinatorError(
        `Refusing to adopt non-empty unmanaged hooks directory: ${hooksDirectory}`,
        "UNMANAGED_GIT_HOOKS_DIRECTORY"
      );
    }
  }
  for (const candidate of removable) unlinkSync2(candidate);
}
function markHooksDirectory(hooksDirectory) {
  writeFileSync2(
    path8.join(hooksDirectory, HOOK_DIRECTORY_MARKER),
    HOOK_DIRECTORY_MARKER_CONTENT
  );
}
function cleanManagedHooksDirectory(root, hooksDirectory, currentHookPath, environment) {
  if (!existsSync7(hooksDirectory)) return;
  if (!hooksDirectoryOwned(root, hooksDirectory, currentHookPath, environment)) {
    return;
  }
  for (const hook of COORDINATED_HOOKS) {
    const candidate = path8.join(hooksDirectory, hook);
    if (existsSync7(candidate) && managedHookFile(candidate)) unlinkSync2(candidate);
  }
  const marker = path8.join(hooksDirectory, HOOK_DIRECTORY_MARKER);
  if (existsSync7(marker) && readFileSync7(marker, "utf8") === HOOK_DIRECTORY_MARKER_CONTENT) {
    unlinkSync2(marker);
  }
  try {
    rmdirSync(hooksDirectory);
  } catch {
  }
}
function installWorkspaceGitIntegration(directory = process.cwd(), options = {}) {
  try {
    const environment = environmentFor(options);
    const runtime = installedGitRuntimePath(environment);
    if (!existsSync7(runtime) || !fileHasManagedMarker(runtime)) {
      throw new CoordinatorError(
        "Agent Coordinator's Git runtime is not installed. Run 'coordinator install' and retry.",
        "GIT_RUNTIME_MISSING"
      );
    }
    const root = workspaceRoot(directory, environment);
    if (!configurationExists(root)) {
      throw new CoordinatorError(
        `${root} has no coordinator.yaml or supported legacy Git configuration.`,
        "GIT_CONFIGURATION_MISSING"
      );
    }
    const hooksDirectory = path8.join(
      commonGitDirectory(root, environment),
      "git-coordinator-hooks"
    );
    const currentHookPath = localConfig(root, "core.hooksPath", environment);
    const alreadyInstalled = hookPathIsManaged(
      root,
      hooksDirectory,
      currentHookPath
    );
    prepareHooksDirectory(root, hooksDirectory, currentHookPath, environment);
    let previousHooksPath;
    if (alreadyInstalled) {
      previousHooksPath = localConfig(
        root,
        "gitCoordinator.previousHooksPath",
        environment
      );
    } else {
      previousHooksPath = resolveHookPath(root, currentHookPath, environment);
      if (previousHooksPath) {
        setLocalConfig(
          root,
          "gitCoordinator.previousHooksPath",
          previousHooksPath,
          environment
        );
      } else {
        unsetLocalConfig(root, "gitCoordinator.previousHooksPath", environment);
      }
    }
    const configuredHooks = supportsConfiguredHooks(root, environment);
    if (configuredHooks) {
      installConfiguredHooks(root, runtime, environment);
    } else {
      removeConfiguredHooks(root, environment);
      for (const hook of COORDINATED_HOOKS) {
        writeFileHook(hooksDirectory, runtime, hook);
      }
    }
    setLocalConfig(root, "core.hooksPath", hooksDirectory, environment);
    setLocalConfig(
      root,
      "gitCoordinator.hookMode",
      configuredHooks ? "configured" : "files",
      environment
    );
    setLocalConfig(root, "gitCoordinator.manifest", manifestName(root), environment);
    markHooksDirectory(hooksDirectory);
    return result(
      previousHooksPath ? `Agent Coordinator Git integration installed; previous hooks remain preserved at ${previousHooksPath}.` : "Agent Coordinator Git integration installed.",
      options
    );
  } catch (error) {
    return failedResultOrThrow(error, options);
  }
}
function uninstallWorkspaceGitIntegration(directory = process.cwd(), options = {}) {
  try {
    const environment = environmentFor(options);
    const root = workspaceRoot(directory, environment);
    const hooksDirectory = path8.join(
      commonGitDirectory(root, environment),
      "git-coordinator-hooks"
    );
    const previousHooksPath = localConfig(
      root,
      "gitCoordinator.previousHooksPath",
      environment
    );
    const currentHookPath = localConfig(root, "core.hooksPath", environment);
    const managedHookPathActive = hookPathIsManaged(
      root,
      hooksDirectory,
      currentHookPath
    );
    removeConfiguredHooks(root, environment);
    cleanManagedHooksDirectory(
      root,
      hooksDirectory,
      currentHookPath,
      environment
    );
    if (managedHookPathActive) {
      if (previousHooksPath) {
        setLocalConfig(root, "core.hooksPath", previousHooksPath, environment);
      } else {
        unsetLocalConfig(root, "core.hooksPath", environment);
      }
    }
    unsetLocalConfig(root, "gitCoordinator.previousHooksPath", environment);
    unsetLocalConfig(root, "gitCoordinator.hookMode", environment);
    unsetLocalConfig(root, "gitCoordinator.manifest", environment);
    return result("Agent Coordinator workspace Git integration removed.", options);
  } catch (error) {
    return failedResultOrThrow(error, options);
  }
}
function invokeGitRuntime(mode, directory = process.cwd(), options = {}) {
  const environment = environmentFor(options);
  const runtime = installedGitRuntimePath(environment);
  if (!existsSync7(runtime) || !fileHasManagedMarker(runtime)) {
    const error = new CoordinatorError(
      "Agent Coordinator's Git runtime is not installed. Run 'coordinator install' and retry.",
      "GIT_RUNTIME_MISSING"
    );
    return failedResultOrThrow(error, options);
  }
  const execution2 = runCommand(process.execPath, [runtime, `--${mode}`], {
    allowFailure: true,
    cwd: path8.resolve(directory),
    env: environment
  });
  if ((options.stdio ?? "pipe") === "inherit") {
    if (execution2.stdout) process.stdout.write(`${execution2.stdout}
`);
    if (execution2.stderr) process.stderr.write(`${execution2.stderr}
`);
  }
  if (execution2.status !== 0 && !options.allowFailure) {
    throw new CoordinatorError(
      `Git runtime ${mode} failed: ${execution2.stderr || execution2.stdout || `exit ${execution2.status}`}`,
      "COMMAND_FAILED"
    );
  }
  return execution2;
}
function yamlNativeGitRuntimeActive(root) {
  const environment = process.env;
  const configured = git(
    environment,
    ["-C", root, "config", "--local", "--get", "gitCoordinator.manifest"],
    { allowFailure: true }
  );
  return configured.status === 0 && configured.stdout === "coordinator.yaml";
}

// src/git/configuration.ts
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
  const git5 = planFileDeletion(
    root,
    ".git-coordinator.json",
    (content) => yamlNativeGitRuntimeActive(root) && isOwnedGitConfiguration(content)
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
      git: git5,
      agents: previewAgents,
      ci: previewCi,
      changed: changedPlans([git5]).length > 0 || previewAgents.changed || previewCi.changed
    };
  }
  applyFilePlans([git5]);
  const agents2 = synchronizeAgents(root, manifest, generatorVersion, options);
  const ci2 = synchronizeCi(root, manifest, options);
  return {
    git: git5,
    agents: agents2,
    ci: ci2,
    changed: changedPlans([git5]).length > 0 || previewAgents.changed || previewCi.changed
  };
}

// src/doctor/check.ts
function check(label, operation) {
  try {
    const result2 = operation();
    return { label, detail: result2.detail, status: result2.status ?? "pass" };
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
        (repository) => !existsSync8(path9.join(root, repository.path, ".git"))
      );
      return missing.length ? {
        detail: `missing: ${missing.map((repository) => repository.id).join(", ")}`,
        status: "fail"
      } : { detail: `${manifest.repositories.length} initialized` };
    })
  );
  checks.push(
    check("Gitlinks", () => {
      const result2 = runCommand("git", ["-C", root, "submodule", "status", "--recursive"], {
        allowFailure: true,
        env: { GIT_COORDINATOR_INTERNAL: "1" }
      });
      if (result2.status !== 0) return { detail: result2.stderr || "unavailable", status: "warn" };
      const drift = result2.stdout.split("\n").filter((line) => /^(?:\+|-|U)/.test(line));
      return drift.length ? { detail: `${drift.length} submodule revisions differ from gitlinks`, status: "fail" } : { detail: "all initialized submodules match their gitlinks" };
    })
  );
  checks.push(
    check("Native Git manifest", () => {
      const legacyPath = path9.join(root, ".git-coordinator.json");
      if (!existsSync8(legacyPath)) {
        if (manifest.workspaceManifest) {
          return {
            detail: `coordinator.yaml still references legacy ${manifest.workspaceManifest.path}`,
            status: "warn"
          };
        }
        return { detail: "coordinator.yaml is the only Git configuration" };
      }
      const legacy = readFileSync8(legacyPath, "utf8");
      return isOwnedGitConfiguration(legacy) ? {
        detail: "owned legacy adapter remains; run coordinator sync",
        status: "fail"
      } : {
        detail: "unmanaged legacy adapter was preserved",
        status: "warn"
      };
    })
  );
  checks.push(
    check("Generated outputs", () => {
      const result2 = synchronizeWorkspace(root, manifest, version, { check: true });
      if (result2.changed) {
        const skillDetail = result2.agents.skillMigrations.length ? `; ${result2.agents.skillMigrations.length} managed skill ${result2.agents.skillMigrations.length === 1 ? "copy is ready" : "copies are ready"} to migrate` : result2.agents.skillActions.length ? `; ${result2.agents.skillActions.length} skill link ${result2.agents.skillActions.length === 1 ? "change is" : "changes are"} planned` : "";
        return {
          detail: `generated outputs are stale${skillDetail}; run coordinator sync`,
          status: "fail"
        };
      }
      return {
        detail: manifest.agents.manage === false ? "CI is synchronized; existing agent files are intentionally unmanaged" : "agents, skill links, and CI are synchronized"
      };
    })
  );
  checks.push(
    check("Git runtime", () => {
      if (!existsSync8(installedGitRuntimePath())) {
        return { detail: "runtime not installed", status: "fail" };
      }
      const result2 = invokeGitRuntime("check", root, { allowFailure: true });
      return result2.status === 0 ? { detail: result2.stdout || "invariant OK" } : { detail: result2.stderr || result2.stdout, status: "fail" };
    })
  );
  return {
    checks,
    healthy: !checks.some((item) => item.status === "fail")
  };
}

// src/status/inspect.ts
import { existsSync as existsSync9, readdirSync as readdirSync5, realpathSync as realpathSync3 } from "fs";
import path10 from "path";
function gitText2(directory, argumentsList) {
  const result2 = runCommand("git", ["-c", "core.hooksPath=/dev/null", "-C", directory, ...argumentsList], {
    allowFailure: true,
    env: { GIT_COORDINATOR_INTERNAL: "1" }
  });
  return result2.status === 0 ? result2.stdout : null;
}
function policyLabel(repository) {
  if (repository.branch.mode === "fixed") return `fixed:${repository.branch.name}`;
  if (repository.branch.mode === "map") return "mapped";
  return "mirror";
}
function isWithin2(base, candidate) {
  const relative = path10.relative(base, candidate);
  return relative === "" || !path10.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path10.sep}`);
}
function isReachableWorkspaceSkill(root, candidate) {
  try {
    const rootRealPath = realpathSync3(root);
    const candidateRealPath = realpathSync3(candidate);
    return isWithin2(rootRealPath, candidateRealPath) && existsSync9(path10.join(candidateRealPath, "SKILL.md"));
  } catch {
    return false;
  }
}
function inspectRepository(root, repository, selection) {
  const readOnly = selection?.mode === "pinned" || !selection && repository.branch.readOnly;
  const policy = selection ? `${selection.mode}:${selection.branch}` : policyLabel(repository);
  const directory = path10.join(root, repository.path);
  if (!existsSync9(directory)) {
    return {
      id: repository.id,
      branch: "\u2014",
      policy,
      readOnly,
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
    policy,
    readOnly,
    health: detached && !readOnly ? "attention" : "ready",
    state: dirty ? "modified" : readOnly ? "read-only" : "clean"
  };
}
function inspectWorkspace(root, manifest, version) {
  const repositories = manifest.repositories.map(
    (repository) => inspectRepository(
      root,
      repository,
      manifest.workspace?.selection[repository.id]
    )
  );
  const rootBranch = gitText2(root, ["symbolic-ref", "--quiet", "--short", "HEAD"]) ?? "unborn";
  const skillsDirectory = path10.join(root, ".agents", "skills");
  const skills = existsSync9(skillsDirectory) ? readdirSync5(skillsDirectory, { withFileTypes: true }).filter(
    (entry) => (entry.isDirectory() || entry.isSymbolicLink()) && isReachableWorkspaceSkill(
      root,
      path10.join(skillsDirectory, entry.name)
    )
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
    gitRuntime: existsSync9(installedGitRuntimePath()),
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
      status.agents.managed ? `${c.ready("\u25CF")} ${status.agents.tools.join("  ")}   ${c.accent(String(status.agents.skills))} skill links` : `${c.attention("\u25C6")} ${status.agents.tools.join("  ")}   existing agent files unmanaged`
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

// src/local/compose.ts
import { mkdtempSync as mkdtempSync2, rmSync as rmSync2, writeFileSync as writeFileSync3 } from "fs";
import os2 from "os";
import path11 from "path";
function runLocalCompose(root, manifest, argumentsList, options = {}) {
  const compose = manifest.local?.compose;
  if (!compose) {
    throw new CoordinatorError(
      "coordinator.yaml does not declare local.compose.",
      "COMPOSE_NOT_CONFIGURED"
    );
  }
  const resolvedRoot = path11.resolve(root);
  const temporaryDirectory = mkdtempSync2(
    path11.join(os2.tmpdir(), "agent-coordinator-compose-")
  );
  const overridePath = path11.join(temporaryDirectory, "compose.override.yaml");
  try {
    writeFileSync3(
      overridePath,
      compose.override.endsWith("\n") ? compose.override : `${compose.override}
`,
      { mode: 384 }
    );
    return runCommand(
      "docker",
      [
        "compose",
        "--project-directory",
        path11.resolve(resolvedRoot, compose.projectDirectory),
        ...compose.files.flatMap((file) => [
          "-f",
          path11.resolve(resolvedRoot, file)
        ]),
        "-f",
        overridePath,
        ...argumentsList
      ],
      {
        allowFailure: true,
        cwd: resolvedRoot,
        env: options.environment,
        stdio: options.stdio ?? "inherit"
      }
    );
  } finally {
    rmSync2(temporaryDirectory, { recursive: true, force: true });
  }
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
  password,
  select,
  text
} from "@clack/prompts";
import path12 from "path";
import pc2 from "picocolors";

// src/hosting/bitbucket.ts
import { Buffer as Buffer2 } from "buffer";
var DEFAULT_BASE_URL = "https://api.bitbucket.org";
var MAXIMUM_PAGES = 1e3;
function nonEmptySingleLine(value2, label) {
  const normalized = value2.trim();
  if (!normalized || /[\r\n]/.test(normalized)) {
    throw new CoordinatorError(
      `${label} must be a non-empty single line.`,
      "BITBUCKET_CONFIGURATION_INVALID"
    );
  }
  return normalized;
}
function authorizationHeader(authentication) {
  if (authentication.kind === "basic") {
    const email = nonEmptySingleLine(
      authentication.email,
      "Bitbucket Cloud email"
    );
    const token = nonEmptySingleLine(
      authentication.apiToken,
      "Bitbucket Cloud API token"
    );
    return `Basic ${Buffer2.from(`${email}:${token}`, "utf8").toString("base64")}`;
  }
  return `Bearer ${nonEmptySingleLine(authentication.token, "Bitbucket Cloud bearer token")}`;
}
function normalizedBaseUrl(input) {
  let result2;
  try {
    result2 = new URL(input?.toString() ?? DEFAULT_BASE_URL);
  } catch {
    throw new CoordinatorError(
      "Bitbucket Cloud API base URL is invalid.",
      "BITBUCKET_CONFIGURATION_INVALID"
    );
  }
  if (result2.protocol !== "https:" || result2.username || result2.password || result2.search || result2.hash) {
    throw new CoordinatorError(
      "Bitbucket Cloud API base URL must be an HTTPS URL without credentials, query parameters, or a fragment.",
      "BITBUCKET_CONFIGURATION_INVALID"
    );
  }
  result2.pathname = `${result2.pathname.replace(/\/+$/, "")}/`;
  return result2;
}
function initialPageUrl(baseUrl, workspace) {
  const url = new URL(
    `2.0/repositories/${encodeURIComponent(workspace)}`,
    baseUrl
  );
  url.searchParams.set("pagelen", "100");
  url.searchParams.set("sort", "name");
  return url;
}
function objectValue(value2) {
  return value2 !== null && typeof value2 === "object" && !Array.isArray(value2) ? value2 : null;
}
function invalidResponse(detail) {
  return new CoordinatorError(
    `Bitbucket Cloud returned an invalid repository response: ${detail}.`,
    "BITBUCKET_RESPONSE_INVALID"
  );
}
function repositoryFromApi(value2, index) {
  const label = `repository entry ${index + 1}`;
  const repository = objectValue(value2);
  if (!repository) throw invalidResponse(`${label} is not an object`);
  const { description: description2, full_name: fullName, is_private: isPrivate, name } = repository;
  if (typeof name !== "string" || !name) {
    throw invalidResponse(`${label} has no name`);
  }
  if (typeof fullName !== "string" || !fullName) {
    throw invalidResponse(`${label} has no full_name`);
  }
  if (description2 !== null && typeof description2 !== "string") {
    throw invalidResponse(`${label} has an invalid description`);
  }
  if (typeof isPrivate !== "boolean") {
    throw invalidResponse(`${label} has no is_private flag`);
  }
  const links = objectValue(repository.links);
  const clones = links?.clone;
  if (!Array.isArray(clones)) {
    throw invalidResponse(`${label} has no clone links`);
  }
  const sshClone = clones.map((clone) => objectValue(clone)).find((clone) => clone?.name === "ssh");
  if (!sshClone || typeof sshClone.href !== "string" || !sshClone.href) {
    throw invalidResponse(`${label} has no SSH clone URL`);
  }
  if (/[\r\n]/.test(sshClone.href)) {
    throw invalidResponse(`${label} has an invalid SSH clone URL`);
  }
  const expectedIdentity = parseRepositoryIdentity(`bitbucket:${fullName}`);
  const cloneIdentity = parseRepositoryIdentity(sshClone.href);
  if (!expectedIdentity || cloneIdentity?.provider !== "bitbucket" || cloneIdentity.namespace !== expectedIdentity.namespace || cloneIdentity.repository !== expectedIdentity.repository) {
    throw invalidResponse(`${label} has an SSH clone URL that does not match full_name`);
  }
  return {
    description: description2,
    fullName,
    isPrivate,
    name,
    slug: expectedIdentity.repository,
    sshUrl: sshClone.href
  };
}
function pageFromApi(value2) {
  const page = objectValue(value2);
  if (!page || !Array.isArray(page.values)) {
    throw invalidResponse("the page has no values array");
  }
  if (page.next !== void 0 && page.next !== null && typeof page.next !== "string") {
    throw invalidResponse("the page has an invalid next link");
  }
  return {
    next: typeof page.next === "string" ? page.next : null,
    repositories: page.values.map(repositoryFromApi)
  };
}
function safeNextPageUrl(value2, currentUrl, collectionUrl) {
  let next;
  try {
    next = new URL(value2, currentUrl);
  } catch {
    throw invalidResponse("the page has an invalid next link");
  }
  if (next.protocol !== "https:" || next.origin !== collectionUrl.origin || next.pathname !== collectionUrl.pathname || next.username || next.password || next.hash) {
    throw new CoordinatorError(
      "Bitbucket Cloud returned an unsafe pagination link.",
      "BITBUCKET_PAGINATION_UNSAFE"
    );
  }
  return next;
}
function httpError(status, workspace) {
  if (status === 401) {
    return new CoordinatorError(
      `Bitbucket Cloud authentication failed while listing workspace '${workspace}'.`,
      "BITBUCKET_AUTHENTICATION_FAILED"
    );
  }
  if (status === 403) {
    return new CoordinatorError(
      `Bitbucket Cloud denied access to workspace '${workspace}'.`,
      "BITBUCKET_ACCESS_DENIED"
    );
  }
  return new CoordinatorError(
    `Bitbucket Cloud could not list workspace '${workspace}' (HTTP ${status}).`,
    "BITBUCKET_REQUEST_FAILED"
  );
}
async function listBitbucketCloudRepositories(workspaceInput, options) {
  const workspace = workspaceInput.trim();
  if (!workspace || /[\r\n]/.test(workspace)) {
    throw new CoordinatorError(
      "Bitbucket Cloud workspace must be a non-empty single line.",
      "BITBUCKET_CONFIGURATION_INVALID"
    );
  }
  const baseUrl = normalizedBaseUrl(options.baseUrl);
  const collectionUrl = initialPageUrl(baseUrl, workspace);
  const authorization = authorizationHeader(options.authentication);
  const fetchPage = options.fetch ?? ((url, fetchOptions2) => globalThis.fetch(url, {
    headers: fetchOptions2.headers,
    method: fetchOptions2.method,
    ...fetchOptions2.signal ? { signal: fetchOptions2.signal } : {}
  }));
  const headers = {
    Accept: "application/json",
    Authorization: authorization
  };
  const fetchOptions = {
    headers,
    method: "GET",
    ...options.signal ? { signal: options.signal } : {}
  };
  const repositories = [];
  const visited = /* @__PURE__ */ new Set();
  let currentUrl = collectionUrl;
  while (currentUrl) {
    if (visited.size >= MAXIMUM_PAGES || visited.has(currentUrl.href)) {
      throw new CoordinatorError(
        "Bitbucket Cloud returned cyclic or excessive pagination.",
        "BITBUCKET_PAGINATION_UNSAFE"
      );
    }
    visited.add(currentUrl.href);
    let response;
    try {
      response = await fetchPage(currentUrl, fetchOptions);
    } catch {
      throw new CoordinatorError(
        `Could not reach Bitbucket Cloud while listing workspace '${workspace}'.`,
        "BITBUCKET_REQUEST_FAILED"
      );
    }
    if (!response.ok) throw httpError(response.status, workspace);
    let body;
    try {
      body = await response.json();
    } catch {
      throw invalidResponse("the response is not valid JSON");
    }
    const page = pageFromApi(body);
    repositories.push(...page.repositories);
    currentUrl = page.next ? safeNextPageUrl(page.next, currentUrl, collectionUrl) : null;
  }
  return repositories;
}

// src/ui/prompts.ts
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
function providerLabel(provider) {
  return provider === "github" ? "GitHub" : "Bitbucket Cloud";
}
function repositorySelectionOption(repository) {
  return {
    value: `${repository.provider}:${repository.fullName}`,
    label: `${providerLabel(repository.provider)} \xB7 ${repository.fullName}`,
    hint: `${repository.isPrivate ? "private" : "public"}${repository.description ? ` \xB7 ${repository.description}` : ""}`
  };
}
function uniqueRepositoryValue(base, provider, used) {
  if (!used.has(base)) return base;
  const prefixed = `${provider}-${base}`;
  if (!used.has(prefixed)) return prefixed;
  let suffix = 2;
  while (used.has(`${prefixed}-${suffix}`)) suffix += 1;
  return `${prefixed}-${suffix}`;
}
function currentGithubUser() {
  if (!commandAvailable("gh")) return void 0;
  const result2 = runCommand("gh", ["api", "user", "--jq", ".login"], {
    allowFailure: true
  });
  return result2.status === 0 ? result2.stdout : void 0;
}
function listGithubRepositories(owner) {
  const result2 = runCommand(
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
  if (result2.status !== 0) {
    throw new CoordinatorError(
      result2.stderr || `Could not list repositories for ${owner}.`
    );
  }
  return JSON.parse(result2.stdout).map(
    ({ nameWithOwner, ...repository }) => ({
      ...repository,
      directoryName: repository.name,
      fullName: nameWithOwner,
      provider: "github"
    })
  );
}
async function bitbucketAuthentication() {
  const configuredEmail = process.env.BITBUCKET_EMAIL?.trim() || void 0;
  const configuredToken = process.env.BITBUCKET_API_TOKEN?.trim() || void 0;
  const email = configuredEmail ?? value(
    await text({
      message: "Atlassian account email",
      placeholder: "you@example.com",
      validate: (input) => input?.trim() ? void 0 : "An email is required"
    })
  );
  const apiToken = configuredToken ?? value(
    await password({
      message: "Bitbucket API token (used only for this request)",
      validate: (input) => input?.trim() ? void 0 : "An API token is required"
    })
  );
  return { kind: "basic", email: email.trim(), apiToken: apiToken.trim() };
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
function repairCandidateLabel(candidate) {
  const shortRevision = candidate.revision.slice(0, 12);
  if (candidate.sources.includes("previous-reachable-pin")) {
    return `Restore previous reachable pin \xB7 ${shortRevision}`;
  }
  const branch = candidate.ref?.replace(/^refs\/heads\//, "") ?? "default branch";
  return `Use remote ${branch} \xB7 ${shortRevision}`;
}
async function promptNestedSubmoduleRepair(plan) {
  note(
    [
      `Repository: ${plan.repositoryId} (${plan.baseline.parentBranch})`,
      `Nested path: ${plan.nestedPath}`,
      `Unavailable pin: ${plan.baseline.pinnedRevision}`,
      `Remote: ${plan.remote.displayUrl}`,
      "The repair will create one local commit and update the coordinator gitlink.",
      "This repair does not push. A later coordinated git push can publish the commit."
    ].join("\n"),
    "Unavailable nested gitlink"
  );
  const selected = await select({
    message: "How should Agent Coordinator repair this gitlink?",
    options: [
      ...plan.candidates.map((candidate2) => ({
        value: candidate2.revision,
        label: repairCandidateLabel(candidate2),
        ...candidate2.subject ? { hint: candidate2.subject } : {}
      })),
      {
        value: "abort",
        label: "Keep the partial workspace",
        hint: "repair the remote or parent gitlink manually"
      }
    ]
  });
  if (isCancel(selected) || selected === "abort") {
    cancel(`Repair not applied. Partial workspace preserved at ${plan.root}.`);
    return null;
  }
  const candidate = plan.candidates.find(
    ({ revision }) => revision === selected
  );
  note(
    [
      `${plan.baseline.pinnedRevision} \u2192 ${candidate.revision}`,
      `Local commit in ${plan.repositoryId} on ${plan.baseline.parentBranch}`,
      `Stage updated coordinator gitlink at ${plan.repositoryPath}`,
      "Push during this repair: no (a later coordinated push may publish it)"
    ].join("\n"),
    "Automatic repair plan"
  );
  const approved = await confirm({
    message: "Create this local repair commit and retry initialization?",
    initialValue: false
  });
  if (isCancel(approved) || !approved) {
    cancel(`Repair not applied. Partial workspace preserved at ${plan.root}.`);
    return null;
  }
  return candidate.revision;
}
function reportNestedSubmoduleRepair(result2) {
  note(
    [
      `Local commit: ${result2.parentCommit}`,
      `Repository: ${result2.repositoryId}`,
      `Nested path: ${result2.nestedPath}`,
      "Coordinator gitlink updated",
      "No push was performed; a later coordinated push may publish the commit"
    ].join("\n"),
    "Repair applied"
  );
}
async function promptResumeWorkspace(root, name) {
  intro(pc2.bgMagenta(pc2.white(" Agent Coordinator \xB7 resume workspace ")));
  const discoverSkills = value(
    await confirm({
      message: "Discover and link committed skills while resuming?",
      initialValue: true
    })
  );
  const proceed = value(
    await confirm({
      message: `Resume ${name} in ${root}?`,
      initialValue: true
    })
  );
  if (!proceed) {
    cancel(`Partial workspace preserved at ${root}.`);
    throw new CoordinatorError(
      "Workspace initialization was not resumed.",
      "INCOMPLETE_INITIALIZATION"
    );
  }
  return discoverSkills;
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
  const providers2 = value(
    await multiselect({
      message: "Repository hosting providers",
      initialValues: ["github"],
      required: true,
      options: [
        { value: "github", label: "GitHub" },
        { value: "bitbucket", label: "Bitbucket Cloud" }
      ]
    })
  );
  const available = [];
  if (providers2.includes("github")) {
    const suggestedOwner = currentGithubUser();
    const owner = value(
      await text({
        message: "GitHub owner or organization",
        ...suggestedOwner ? { defaultValue: suggestedOwner } : {},
        placeholder: "your-organization",
        validate: (input) => input?.trim() ? void 0 : "An owner is required"
      })
    ).trim();
    const repositories2 = listGithubRepositories(owner);
    if (!repositories2.length) {
      throw new CoordinatorError(
        `No repositories were found for GitHub owner '${owner}'.`
      );
    }
    available.push(...repositories2);
  }
  if (providers2.includes("bitbucket")) {
    const workspace = value(
      await text({
        message: "Bitbucket Cloud workspace",
        placeholder: "your-workspace",
        validate: (input) => input?.trim() ? void 0 : "A workspace is required"
      })
    ).trim();
    const repositories2 = (await listBitbucketCloudRepositories(
      workspace,
      {
        authentication: await bitbucketAuthentication(),
        signal: AbortSignal.timeout(3e4)
      }
    )).map(({ slug: slug4, ...repository }) => ({
      ...repository,
      directoryName: slug4,
      provider: "bitbucket"
    }));
    if (!repositories2.length) {
      throw new CoordinatorError(
        `No repositories were found for Bitbucket Cloud workspace '${workspace}'.`
      );
    }
    available.push(...repositories2);
  }
  const availableByKey = new Map(
    available.map((repository) => [repositorySelectionOption(repository).value, repository])
  );
  const chosen = value(
    await multiselect({
      message: "Select the repositories that form this workspace",
      required: true,
      options: available.map(repositorySelectionOption)
    })
  );
  const selectedRepositories = chosen.map((selectionKey) => {
    const repository = availableByKey.get(selectionKey);
    if (!repository) {
      throw new CoordinatorError(
        `Unknown repository selection '${selectionKey}'.`,
        "INVALID_REPOSITORY_SELECTION"
      );
    }
    return repository;
  });
  const usedIds = /* @__PURE__ */ new Set();
  const usedPaths = /* @__PURE__ */ new Set();
  const repositories = [];
  for (const repository of selectedRepositories) {
    const suggestedId = uniqueRepositoryValue(
      roleSuggestion(repository.name),
      repository.provider,
      usedIds
    );
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
    const repositoryPath2 = uniqueRepositoryValue(
      repository.directoryName,
      repository.provider,
      usedPaths
    );
    usedPaths.add(repositoryPath2);
    repositories.push({
      id,
      path: repositoryPath2,
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
      message: "Discover and link committed skills from the selected repositories?",
      initialValue: true
    })
  );
  note(
    [
      `${repositories.length} repositories`,
      `${tools.length} agent runtimes`,
      discoverSkills ? "committed skills will be discovered and linked" : "skills can be added later",
      "Agent Coordinator will preserve ordinary git commands",
      "its embedded Git runtime may be installed machine-wide"
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
      schemaVersion: 2,
      name,
      remote: "origin",
      repositories,
      agents: {
        tools,
        maxParallel: Math.min(4, Math.max(1, repositories.length)),
        skillCollision: "error"
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
        { value: "sync", label: "Synchronize agents, skills, and CI" },
        { value: "doctor", label: "Run workspace doctor" },
        { value: "exit", label: "Exit" }
      ]
    })
  );
}

// package.json
var package_default = {
  name: "agent-coordinator",
  version: "0.4.2",
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
    "README.md",
    "LICENSE",
    "THIRD_PARTY_NOTICES.md"
  ],
  engines: {
    node: ">=20.12.0"
  },
  scripts: {
    compile: "tsup && npm run compile:git",
    "compile:git": "esbuild src/git/runtime/git-wrapper.mjs --bundle --platform=neutral --format=esm --target=node20 '--external:node:*' --banner:js='/* agent-coordinator-git-wrapper-v1 */' --outfile=dist/git-wrapper.mjs && chmod +x dist/git-wrapper.mjs",
    dev: "tsx src/cli.ts",
    typecheck: "tsc --noEmit",
    test: "npm run compile && npm run test:unit && npm run test:git",
    "test:unit": "tsx --test test/**/*.test.ts",
    "test:git": "AGENT_COORDINATOR_GIT_RUNTIME_UNDER_TEST=./dist/git-wrapper.mjs node --test test/git-runtime.test.mjs",
    "check:dist": "test -f dist/git-wrapper.mjs && git ls-files --error-unmatch dist/git-wrapper.mjs >/dev/null && git diff --exit-code -- dist",
    check: "npm run typecheck && npm test && npm run check:dist",
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
    esbuild: "^0.28.1",
    tsup: "^8.5.1",
    tsx: "^4.20.6",
    typescript: "^7.0.2"
  },
  overrides: {
    esbuild: "^0.28.1"
  },
  license: "Apache-2.0"
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
function commandFailure(result2) {
  return result2.stderr || result2.stdout || `exit ${result2.status}`;
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
  const result2 = runCommand(
    "gh",
    ["api", `repos/${PROJECT_REPOSITORY}/releases/latest`],
    { allowFailure: true }
  );
  if (result2.status !== 0) {
    if (/\bHTTP 404\b/i.test(`${result2.stderr}
${result2.stdout}`)) {
      return {
        current,
        latest: null,
        tag: null,
        updateAvailable: false,
        url: null
      };
    }
    throw new CoordinatorError(
      `Could not check private releases for '${PROJECT_REPOSITORY}': ${commandFailure(result2)}.`,
      "UPDATE_CHECK_FAILED"
    );
  }
  let release;
  try {
    release = JSON.parse(result2.stdout);
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
  const stdio = options.stdio ?? "inherit";
  const result2 = runCommand(
    "npm",
    [
      "install",
      "--global",
      `git+https://github.com/${PROJECT_REPOSITORY}.git#${tag}`
    ],
    { stdio }
  );
  runCommand("coordinator", ["install"], { stdio });
  return result2;
}

// src/workspace/initialize.ts
import {
  existsSync as existsSync11,
  lstatSync as lstatSync4,
  mkdirSync as mkdirSync4,
  readdirSync as readdirSync6,
  realpathSync as realpathSync5
} from "fs";
import path14 from "path";

// src/workspace/nested-repair.ts
import { createHash as createHash2 } from "crypto";
import { existsSync as existsSync10, realpathSync as realpathSync4 } from "fs";
import path13 from "path";
var privatePlanState = /* @__PURE__ */ new WeakMap();
function git2(cwd, argumentsList, allowFailure = false) {
  return runCommand("git", argumentsList, {
    allowFailure,
    cwd,
    env: { GIT_COORDINATOR_INTERNAL: "1" }
  });
}
function gitDirectory(directory, argumentsList, allowFailure = false) {
  return runCommand("git", ["--git-dir", directory, ...argumentsList], {
    allowFailure,
    env: { GIT_COORDINATOR_INTERNAL: "1" }
  });
}
function safeNestedPath(value2) {
  return Boolean(value2) && value2 !== "." && !/[\x00-\x1f\x7f]/.test(value2) && !path13.isAbsolute(value2) && !value2.split(/[\\/]/).includes("..");
}
function gitlinkRevision(directory, relativePath2) {
  const result2 = git2(
    directory,
    ["ls-files", "--stage", "-z", "--", relativePath2],
    true
  );
  const match = /^(160000) ([0-9a-f]{40,64}) 0\t([^\0]+)\0?$/.exec(
    result2.stdout
  );
  if (result2.status !== 0 || !match || match[3] !== relativePath2) {
    throw new CoordinatorError(
      `Automatic nested repair requires exactly one stage-0 gitlink at '${relativePath2}'.`,
      "NESTED_SUBMODULE_REPAIR_UNAVAILABLE"
    );
  }
  return match[2];
}
function configuredSubmodule(directory, nestedPath) {
  const configured = git2(
    directory,
    [
      "config",
      "--blob=HEAD:.gitmodules",
      "-z",
      "--get-regexp",
      "^submodule\\..*\\.path$"
    ],
    true
  );
  const matches = configured.stdout.split("\0").filter(Boolean).map((entry) => {
    const separator = entry.indexOf("\n");
    return separator < 0 ? { key: entry, value: "" } : { key: entry.slice(0, separator), value: entry.slice(separator + 1) };
  }).filter((entry) => entry.value === nestedPath);
  if (configured.status !== 0 || matches.length !== 1) {
    throw new CoordinatorError(
      `Automatic nested repair could not resolve '${nestedPath}' uniquely in the parent .gitmodules file.`,
      "NESTED_SUBMODULE_REPAIR_UNAVAILABLE"
    );
  }
  const key = matches[0].key.replace(/\.path$/, "");
  const name = key.replace(/^submodule\./, "");
  const initializedUrl = git2(
    directory,
    ["config", "--get", `${key}.url`],
    true
  );
  const declaredUrl = git2(
    directory,
    ["config", "--blob=HEAD:.gitmodules", "--get", `${key}.url`],
    true
  );
  if (initializedUrl.status === 0 && initializedUrl.stdout) {
    return { name, url: initializedUrl.stdout };
  }
  if (declaredUrl.status !== 0 || !declaredUrl.stdout) {
    throw new CoordinatorError(
      `Automatic nested repair could not resolve the remote for '${nestedPath}'.`,
      "NESTED_SUBMODULE_REPAIR_UNAVAILABLE"
    );
  }
  return {
    name,
    url: resolveDeclaredSubmoduleUrl(directory, declaredUrl.stdout)
  };
}
function defaultParentRemoteUrl(directory) {
  const branch = git2(
    directory,
    ["symbolic-ref", "--quiet", "--short", "HEAD"],
    true
  );
  const configuredRemote = branch.stdout ? git2(
    directory,
    ["config", "--get", `branch.${branch.stdout}.remote`],
    true
  ) : null;
  const remoteName = configuredRemote?.status === 0 && configuredRemote.stdout ? configuredRemote.stdout : "origin";
  if (remoteName === ".") return directory;
  const remoteUrl = git2(
    directory,
    ["config", "--get-all", `remote.${remoteName}.url`],
    true
  );
  return remoteUrl.status === 0 && remoteUrl.stdout ? remoteUrl.stdout.split("\n")[0] : directory;
}
function resolveRelativePath(base, relative) {
  return path13.posix.normalize(
    `${base.replace(/\/+$/, "")}/${relative}`
  );
}
function resolveDeclaredSubmoduleUrl(directory, declaredUrl) {
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
  }
  const scp = /^((?:[^@\s/:]+@)?(?:\[[^\]\s]+\]|[^/\s:]+):)(.*)$/.exec(
    upstream
  );
  if (scp) {
    return `${scp[1]}${resolveRelativePath(scp[2], declaredUrl)}`;
  }
  const absoluteUpstream = path13.isAbsolute(upstream) ? upstream : path13.resolve(directory, upstream);
  return path13.resolve(absoluteUpstream, declaredUrl);
}
function remoteSnapshot(parentDirectory, remoteUrl) {
  const result2 = git2(
    parentDirectory,
    [
      "ls-remote",
      "--symref",
      "--end-of-options",
      remoteUrl,
      "HEAD",
      "refs/heads/*"
    ],
    true
  );
  if (result2.status !== 0) {
    const detail = redactNestedSubmoduleDiagnostic(
      result2.stderr || result2.stdout || `exit ${result2.status}`
    );
    throw new CoordinatorError(
      `Automatic nested repair could not inspect ${redactNestedSubmoduleDiagnostic(remoteUrl)}: ${detail}.`,
      "NESTED_SUBMODULE_REPAIR_UNAVAILABLE"
    );
  }
  const lines = result2.stdout.split("\n").filter(Boolean);
  const symbolic = lines.map((line) => /^ref:\s+(refs\/heads\/[^\s]+)\s+HEAD$/.exec(line)).find(Boolean);
  const revision = lines.map((line) => /^([0-9a-f]{40,64})\s+HEAD$/.exec(line)).find(Boolean);
  if (!symbolic?.[1] || !revision?.[1]) {
    throw new CoordinatorError(
      `Automatic nested repair requires a symbolic default branch at ${redactNestedSubmoduleDiagnostic(remoteUrl)}.`,
      "NESTED_SUBMODULE_REPAIR_UNAVAILABLE"
    );
  }
  const refRevisions = [
    ...new Set(
      lines.map((line) => /^([0-9a-f]{40,64})\s+refs\/heads\/[^\s]+$/.exec(line)?.[1]).filter((value2) => Boolean(value2))
    )
  ];
  if (!refRevisions.includes(revision[1])) refRevisions.push(revision[1]);
  return {
    head: { ref: symbolic[1], revision: revision[1] },
    refRevisions
  };
}
function nestedGitDirectory(parentDirectory, nestedName) {
  if (!nestedName || /[\x00-\x1f\x7f]/.test(nestedName)) {
    throw new CoordinatorError(
      "Automatic nested repair refused an unsafe logical submodule name.",
      "NESTED_SUBMODULE_REPAIR_UNAVAILABLE"
    );
  }
  const modulesRootResult = git2(
    parentDirectory,
    ["rev-parse", "--git-path", "modules"],
    true
  );
  const result2 = git2(
    parentDirectory,
    ["rev-parse", "--git-path", `modules/${nestedName}`],
    true
  );
  const modulesRoot = path13.resolve(parentDirectory, modulesRootResult.stdout);
  const resolved = path13.resolve(parentDirectory, result2.stdout);
  if (modulesRootResult.status !== 0 || !modulesRootResult.stdout || result2.status !== 0 || !result2.stdout || !existsSync10(modulesRoot) || !existsSync10(resolved)) {
    throw new CoordinatorError(
      `Automatic nested repair could not inspect the failed clone for '${nestedName}'.`,
      "NESTED_SUBMODULE_REPAIR_UNAVAILABLE"
    );
  }
  let canonicalModulesRoot;
  let canonicalResolved;
  try {
    canonicalModulesRoot = realpathSync4(modulesRoot);
    canonicalResolved = realpathSync4(resolved);
  } catch {
    throw new CoordinatorError(
      "Automatic nested repair could not canonicalize the failed submodule cache.",
      "NESTED_SUBMODULE_REPAIR_UNAVAILABLE"
    );
  }
  const relative = path13.relative(canonicalModulesRoot, canonicalResolved);
  if (!relative || relative.startsWith(`..${path13.sep}`) || relative === ".." || path13.isAbsolute(relative)) {
    throw new CoordinatorError(
      "Automatic nested repair refused a submodule cache outside the parent Git modules directory.",
      "NESTED_SUBMODULE_REPAIR_UNAVAILABLE"
    );
  }
  return canonicalResolved;
}
function objectExists(gitDir, revision) {
  return gitDirectory(gitDir, ["cat-file", "-e", `${revision}^{commit}`], true).status === 0;
}
function reachableFromAdvertisedRef(gitDir, revision, refRevisions) {
  if (!objectExists(gitDir, revision)) return false;
  return refRevisions.some(
    (refRevision) => gitDirectory(
      gitDir,
      ["merge-base", "--is-ancestor", revision, refRevision],
      true
    ).status === 0
  );
}
function subject(gitDir, revision) {
  const result2 = gitDirectory(
    gitDir,
    ["show", "-s", "--format=%s", revision],
    true
  );
  return result2.status === 0 && result2.stdout ? result2.stdout.replace(/[\x00-\x1f\x7f]+/g, " ") : null;
}
function previousPinnedRevisions(parentDirectory, nestedPath, currentRevision) {
  const history = git2(
    parentDirectory,
    ["log", "--format=%H", "--max-count=100", "--", nestedPath],
    true
  );
  if (history.status !== 0) return [];
  const revisions = [];
  for (const commit of history.stdout.split("\n").filter(Boolean)) {
    const tree = git2(
      parentDirectory,
      ["ls-tree", commit, "--", nestedPath],
      true
    );
    const match = /^160000 commit ([0-9a-f]{40,64})\t/.exec(tree.stdout);
    if (match?.[1] && match[1] !== currentRevision && !revisions.includes(match[1])) {
      revisions.push(match[1]);
    }
  }
  return revisions;
}
function fingerprint(value2) {
  return createHash2("sha256").update(JSON.stringify(value2)).digest("hex");
}
function immutableClone(value2) {
  const clone = structuredClone(value2);
  const seen = /* @__PURE__ */ new WeakSet();
  const freeze = (candidate) => {
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
function requireCleanAttachedParent(parentDirectory) {
  const status = git2(
    parentDirectory,
    ["status", "--porcelain=v1", "--untracked-files=all"],
    true
  );
  if (status.status !== 0 || status.stdout) {
    throw new CoordinatorError(
      "Automatic nested repair requires a clean parent repository.",
      "NESTED_SUBMODULE_REPAIR_UNAVAILABLE"
    );
  }
  const branch = git2(
    parentDirectory,
    ["symbolic-ref", "--quiet", "--short", "HEAD"],
    true
  );
  const revision = git2(parentDirectory, ["rev-parse", "HEAD"], true);
  if (branch.status !== 0 || !branch.stdout || revision.status !== 0 || !revision.stdout) {
    throw new CoordinatorError(
      "Automatic nested repair requires the clean parent repository to be attached to a branch.",
      "NESTED_SUBMODULE_REPAIR_UNAVAILABLE"
    );
  }
  return { branch: branch.stdout, revision: revision.stdout };
}
function expectedRepositoryBranch(root, repository) {
  const rootBranch = git2(
    root,
    ["symbolic-ref", "--quiet", "--short", "HEAD"],
    true
  );
  if (rootBranch.status !== 0 || !rootBranch.stdout) {
    throw new CoordinatorError(
      "Automatic nested repair requires the coordinator to be attached to a branch.",
      "NESTED_SUBMODULE_REPAIR_UNAVAILABLE"
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
    "NESTED_SUBMODULE_REPAIR_UNAVAILABLE"
  );
}
function planNestedSubmoduleRepair(rootInput, repository, nestedPath) {
  const canonicalRepository = immutableClone(repository);
  const root = path13.resolve(rootInput);
  if (canonicalRepository.branch.readOnly) {
    throw new CoordinatorError(
      `Repository '${canonicalRepository.id}' is read-only; Agent Coordinator will not create a repair commit in it.`,
      "NESTED_SUBMODULE_REPAIR_UNAVAILABLE"
    );
  }
  if (!safeNestedPath(nestedPath)) {
    throw new CoordinatorError(
      "Automatic nested repair refused an unsafe nested path.",
      "NESTED_SUBMODULE_REPAIR_UNAVAILABLE"
    );
  }
  const parentDirectory = path13.resolve(root, canonicalRepository.path);
  const parent = requireCleanAttachedParent(parentDirectory);
  const expectedBranch = expectedRepositoryBranch(root, canonicalRepository);
  if (parent.branch !== expectedBranch) {
    throw new CoordinatorError(
      `Automatic nested repair expected repository '${canonicalRepository.id}' on branch '${expectedBranch}', but it is attached to '${parent.branch}'.`,
      "NESTED_SUBMODULE_REPAIR_UNAVAILABLE"
    );
  }
  const rootGitlinkRevision = gitlinkRevision(root, canonicalRepository.path);
  if (rootGitlinkRevision !== parent.revision) {
    throw new CoordinatorError(
      `Coordinator gitlink '${canonicalRepository.path}' does not match the parent repository HEAD.`,
      "NESTED_SUBMODULE_REPAIR_UNAVAILABLE"
    );
  }
  const pinnedRevision = gitlinkRevision(parentDirectory, nestedPath);
  const configured = configuredSubmodule(parentDirectory, nestedPath);
  const nestedGitDir = nestedGitDirectory(parentDirectory, configured.name);
  const remote = remoteSnapshot(parentDirectory, configured.url);
  if (reachableFromAdvertisedRef(
    nestedGitDir,
    pinnedRevision,
    remote.refRevisions
  )) {
    throw new CoordinatorError(
      `Pinned commit ${pinnedRevision} remains reachable from the nested remote; this is not a directly repairable unavailable gitlink.`,
      "NESTED_SUBMODULE_REPAIR_UNAVAILABLE"
    );
  }
  const defaultHead = remote.head;
  const byRevision = /* @__PURE__ */ new Map();
  for (const revision of previousPinnedRevisions(
    parentDirectory,
    nestedPath,
    pinnedRevision
  )) {
    if (!reachableFromAdvertisedRef(nestedGitDir, revision, remote.refRevisions)) {
      continue;
    }
    byRevision.set(revision, {
      ref: null,
      revision,
      sources: ["previous-reachable-pin"],
      subject: subject(nestedGitDir, revision)
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
      subject: subject(nestedGitDir, defaultHead.revision)
    });
  }
  const candidates = [...byRevision.values()];
  const baseline = {
    parentBranch: parent.branch,
    parentRevision: parent.revision,
    pinnedRevision,
    rootGitlinkRevision
  };
  const publicPlan = {
    baseline,
    candidates,
    nestedPath,
    parentDirectory,
    remote: {
      defaultRef: defaultHead.ref,
      displayUrl: redactNestedSubmoduleDiagnostic(configured.url)
    },
    repositoryId: canonicalRepository.id,
    repositoryPath: canonicalRepository.path,
    root
  };
  const planFingerprint = fingerprint(publicPlan);
  const plan = {
    ...publicPlan,
    effects: {
      createsLocalCommit: true,
      pushes: false,
      retriesInitialization: true,
      updatesCoordinatorGitlink: true
    },
    fingerprint: planFingerprint,
    id: planFingerprint.slice(0, 16)
  };
  privatePlanState.set(plan, {
    canonicalPlan: immutableClone(plan),
    planIntegrity: fingerprint(plan),
    repository: canonicalRepository
  });
  return plan;
}
function restoreBaseline(plan, parentCommitCreated, rootGitlinkUpdated) {
  const failures = [];
  const attempt = (cwd, argumentsList) => {
    const result2 = git2(cwd, argumentsList, true);
    if (result2.status !== 0) {
      failures.push(result2.stderr || result2.stdout || `git ${argumentsList[0]} exited ${result2.status}`);
    }
  };
  if (rootGitlinkUpdated) {
    attempt(plan.root, [
      "update-index",
      "--cacheinfo",
      "160000",
      plan.baseline.rootGitlinkRevision,
      plan.repositoryPath
    ]);
  }
  if (parentCommitCreated) {
    attempt(plan.parentDirectory, [
      "reset",
      "--soft",
      plan.baseline.parentRevision
    ]);
  }
  attempt(plan.parentDirectory, [
    "update-index",
    "--cacheinfo",
    "160000",
    plan.baseline.pinnedRevision,
    plan.nestedPath
  ]);
  attempt(plan.parentDirectory, [
    "submodule",
    "deinit",
    "-f",
    "--",
    plan.nestedPath
  ]);
  try {
    const parentRevision = git2(
      plan.parentDirectory,
      ["rev-parse", "HEAD"],
      true
    ).stdout;
    if (parentRevision !== plan.baseline.parentRevision) {
      failures.push(
        `parent HEAD remained at ${parentRevision || "an unreadable revision"}`
      );
    }
    if (gitlinkRevision(plan.parentDirectory, plan.nestedPath) !== plan.baseline.pinnedRevision) {
      failures.push("parent nested gitlink did not return to its baseline");
    }
    if (gitlinkRevision(plan.root, plan.repositoryPath) !== plan.baseline.rootGitlinkRevision) {
      failures.push("coordinator gitlink did not return to its baseline");
    }
    const status = git2(
      plan.parentDirectory,
      ["status", "--porcelain=v1", "--untracked-files=all"],
      true
    );
    if (status.status !== 0 || status.stdout) {
      failures.push("parent repository was not clean after rollback");
    }
  } catch (error) {
    failures.push(`could not verify rollback: ${errorMessage(error)}`);
  }
  return failures;
}
function validateCommitMessage(value2) {
  const message = value2.trim();
  if (!message || /[\r\n]/.test(message)) {
    throw new CoordinatorError(
      "Nested repair commit message must be a non-empty single line.",
      "NESTED_SUBMODULE_REPAIR_INVALID"
    );
  }
  return message;
}
function redactNestedSubmoduleDiagnostic(value2) {
  const urlsRedacted = value2.replace(
    /[a-z][a-z\d+.-]*:\/\/[^\s'"<>]+/gi,
    (url) => redactRepositoryUrl(url)
  );
  return urlsRedacted.replace(
    /(^|[\s'"(<])([^\s'"<>@]+)@((?:\[[^\]\s]+\]|[a-z\d._-]+)):(?!\/\/)([^\s'"<>]+)/gi,
    (_match, prefix, _credentials, host, repositoryPath2) => `${prefix}git@${host}:${repositoryPath2}`
  );
}
function applyNestedSubmoduleRepair(plan, options) {
  if (options.approveLocalCommit !== true) {
    throw new CoordinatorError(
      "Nested repair requires explicit approval to create a local parent commit.",
      "NESTED_SUBMODULE_REPAIR_APPROVAL_REQUIRED"
    );
  }
  const privateState = privatePlanState.get(plan);
  if (!privateState) {
    throw new CoordinatorError(
      "Nested repair accepts only an in-process verified plan.",
      "NESTED_SUBMODULE_REPAIR_PLAN_INVALID"
    );
  }
  try {
    if (fingerprint(plan) !== privateState.planIntegrity) {
      throw new Error("plan changed");
    }
  } catch {
    throw new CoordinatorError(
      "Nested repair plan changed after verification; inspect the repository again before applying it.",
      "NESTED_SUBMODULE_REPAIR_PLAN_INVALID"
    );
  }
  const executionPlan = privateState.canonicalPlan;
  const refreshed = planNestedSubmoduleRepair(
    executionPlan.root,
    privateState.repository,
    executionPlan.nestedPath
  );
  if (refreshed.fingerprint !== executionPlan.fingerprint) {
    throw new CoordinatorError(
      "Nested repair plan is stale; inspect the repository again before applying it.",
      "NESTED_SUBMODULE_REPAIR_PLAN_STALE"
    );
  }
  const candidate = refreshed.candidates.find(
    ({ revision }) => revision === options.candidateRevision
  );
  if (!candidate) {
    throw new CoordinatorError(
      `Revision '${options.candidateRevision}' is not a verified repair candidate.`,
      "NESTED_SUBMODULE_REPAIR_CANDIDATE_INVALID"
    );
  }
  const commitMessage = validateCommitMessage(
    options.commitMessage ?? `fix: repair unavailable ${path13.basename(executionPlan.nestedPath)} gitlink`
  );
  let parentCommitCreated = false;
  let rootGitlinkUpdated = false;
  try {
    git2(executionPlan.parentDirectory, [
      "update-index",
      "--cacheinfo",
      "160000",
      candidate.revision,
      executionPlan.nestedPath
    ]);
    git2(executionPlan.parentDirectory, [
      "submodule",
      "update",
      "--init",
      "--recursive",
      "--checkout",
      "--",
      executionPlan.nestedPath
    ]);
    const nestedDirectory = path13.resolve(
      executionPlan.parentDirectory,
      executionPlan.nestedPath
    );
    const nestedHead = git2(nestedDirectory, ["rev-parse", "HEAD"], true);
    if (nestedHead.status !== 0 || nestedHead.stdout !== candidate.revision) {
      throw new CoordinatorError(
        `Repaired nested checkout did not reach ${candidate.revision}.`,
        "NESTED_SUBMODULE_REPAIR_CHECKOUT_FAILED"
      );
    }
    git2(executionPlan.parentDirectory, [
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "commit.gpgSign=false",
      "commit",
      "--quiet",
      "-m",
      commitMessage,
      "--",
      executionPlan.nestedPath
    ]);
    parentCommitCreated = true;
    const parentCommit = git2(executionPlan.parentDirectory, ["rev-parse", "HEAD"]).stdout;
    git2(executionPlan.root, [
      "update-index",
      "--cacheinfo",
      "160000",
      parentCommit,
      executionPlan.repositoryPath
    ]);
    rootGitlinkUpdated = true;
    if (gitlinkRevision(executionPlan.root, executionPlan.repositoryPath) !== parentCommit) {
      throw new CoordinatorError(
        "Coordinator gitlink did not update to the local repair commit.",
        "NESTED_SUBMODULE_REPAIR_ROOT_UPDATE_FAILED"
      );
    }
    if (git2(
      executionPlan.parentDirectory,
      ["status", "--porcelain=v1"],
      true
    ).stdout) {
      throw new CoordinatorError(
        "Parent repository is not clean after the local repair commit.",
        "NESTED_SUBMODULE_REPAIR_PARENT_DIRTY"
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
      rootGitlinkUpdated: true
    };
  } catch (error) {
    const rollbackFailures = restoreBaseline(
      executionPlan,
      parentCommitCreated,
      rootGitlinkUpdated
    );
    const safeError = redactNestedSubmoduleDiagnostic(errorMessage(error));
    if (rollbackFailures.length) {
      const safeRollbackFailures = rollbackFailures.map(
        (failure) => redactNestedSubmoduleDiagnostic(failure)
      );
      throw new CoordinatorError(
        `Nested repair failed: ${safeError}. Rollback also failed: ${safeRollbackFailures.join("; ")}. Inspect '${executionPlan.parentDirectory}' before retrying.`,
        "NESTED_SUBMODULE_REPAIR_ROLLBACK_FAILED"
      );
    }
    throw new CoordinatorError(
      `Nested repair failed and its local changes were rolled back: ${safeError}`,
      "NESTED_SUBMODULE_REPAIR_FAILED"
    );
  }
}
var NestedSubmoduleRepairRequiredError = class extends CoordinatorError {
  plan;
  constructor(plan, gitDetail) {
    const safeDetail = redactNestedSubmoduleDiagnostic(gitDetail);
    super(
      `Could not initialize nested submodule '${plan.nestedPath}' for repository '${plan.repositoryId}': ${safeDetail}. The incomplete nested checkout was deinitialized; coordinator.yaml and top-level checkouts were preserved. A verified local repair is available, but it requires explicit approval because it creates one commit in '${plan.repositoryId}'. The repair itself will not push; a later coordinated push may publish the commit. Rerun 'coordinator init --resume' in an interactive terminal to review it.`,
      "NESTED_SUBMODULE_REPAIR_REQUIRED"
    );
    this.plan = plan;
  }
};

// src/workspace/initialize.ts
function gitResult(root, argumentsList, allowFailure = false) {
  return runCommand(
    "git",
    ["-c", "core.hooksPath=/dev/null", "-c", "protocol.file.allow=always", "-C", root, ...argumentsList],
    { allowFailure, env: { GIT_COORDINATOR_INTERNAL: "1" } }
  );
}
function git3(root, argumentsList) {
  gitResult(root, argumentsList);
}
function pathExists(value2) {
  try {
    lstatSync4(value2);
    return true;
  } catch {
    return false;
  }
}
function canonicalPath2(value2) {
  try {
    return realpathSync5(value2);
  } catch {
    return path14.resolve(value2);
  }
}
function isPathWithin(base, candidate) {
  const relative = path14.relative(base, candidate);
  return relative === "" || !path14.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path14.sep}`);
}
function repositoryUrlsMatch2(expectedInput, actualInput) {
  const expected = repositoryCloneUrl(expectedInput);
  if (parseRepositoryIdentity(expected) || parseRepositoryIdentity(actualInput)) {
    return repositoryUrlsMatch(expected, actualInput);
  }
  if (path14.isAbsolute(expected) && path14.isAbsolute(actualInput)) {
    return canonicalPath2(expected) === canonicalPath2(actualInput);
  }
  return repositoryUrlsMatch(expected, actualInput);
}
function existingRepositoryError(repository, detail) {
  return new CoordinatorError(
    `Existing path '${repository.path}' cannot be adopted for repository '${repository.id}': ${detail}. It must already be the declared Git submodule and gitlink; no files were changed.`,
    "EXISTING_PATH_NOT_DECLARED_SUBMODULE"
  );
}
function configuredSubmodule2(root, repository) {
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
  const absoluteRoot = path14.resolve(root);
  const repositoryDirectory = path14.resolve(root, repository.path);
  if (!isPathWithin(absoluteRoot, repositoryDirectory)) {
    throw existingRepositoryError(repository, "the destination escapes the coordinator root");
  }
  let cursor = absoluteRoot;
  for (const segment of path14.relative(absoluteRoot, repositoryDirectory).split(path14.sep)) {
    cursor = path14.join(cursor, segment);
    if (pathExists(cursor) && lstatSync4(cursor).isSymbolicLink()) {
      throw existingRepositoryError(
        repository,
        `the destination crosses symbolic link '${path14.relative(absoluteRoot, cursor)}'`
      );
    }
  }
  if (!pathExists(repositoryDirectory)) {
    throw new CoordinatorError(
      `Repository '${repository.id}' is not materialized at '${repository.path}'.`,
      "SUBMODULE_MISSING"
    );
  }
  const configured = configuredSubmodule2(root, repository);
  if (!repositoryUrlsMatch2(repository.url, configured.url)) {
    throw existingRepositoryError(
      repository,
      `.gitmodules URL '${redactRepositoryUrl(configured.url)}' does not match '${redactRepositoryUrl(repositoryCloneUrl(repository.url))}'`
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
  if (topLevel.status !== 0 || !topLevel.stdout || canonicalPath2(topLevel.stdout) !== canonicalPath2(repositoryDirectory)) {
    throw existingRepositoryError(repository, "the destination is not that submodule's Git worktree");
  }
  const superproject = gitResult(
    repositoryDirectory,
    ["rev-parse", "--show-superproject-working-tree"],
    true
  );
  if (superproject.status !== 0 || !superproject.stdout || canonicalPath2(superproject.stdout) !== canonicalPath2(root)) {
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
  if (origin.status !== 0 || !repositoryUrlsMatch2(repository.url, origin.stdout)) {
    throw existingRepositoryError(
      repository,
      `origin URL '${origin.stdout ? redactRepositoryUrl(origin.stdout) : "missing"}' does not match '${redactRepositoryUrl(repositoryCloneUrl(repository.url))}'`
    );
  }
}
function nestedCheckoutPath(directory, relativePath2, label) {
  const parent = path14.resolve(directory);
  const checkout = path14.resolve(directory, relativePath2);
  const relative = path14.relative(parent, checkout);
  if (!relative || path14.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path14.sep}`)) {
    throw new CoordinatorError(
      `${label} has unsafe nested gitlink path '${relativePath2}'.`,
      "NESTED_SUBMODULE_PATH_INVALID"
    );
  }
  let cursor = parent;
  for (const segment of relative.split(path14.sep)) {
    cursor = path14.join(cursor, segment);
    if (pathExists(cursor) && lstatSync4(cursor).isSymbolicLink()) {
      throw new CoordinatorError(
        `${label} nested gitlink '${relativePath2}' crosses symbolic link '${path14.relative(parent, cursor)}'.`,
        "NESTED_SUBMODULE_PATH_INVALID"
      );
    }
  }
  if (pathExists(checkout) && !isPathWithin(canonicalPath2(parent), canonicalPath2(checkout))) {
    throw new CoordinatorError(
      `${label} nested gitlink '${relativePath2}' resolves outside its parent repository.`,
      "NESTED_SUBMODULE_PATH_INVALID"
    );
  }
  return checkout;
}
function indexedSubmodules(directory) {
  const configured = gitResult(
    directory,
    [
      "config",
      "--blob=HEAD:.gitmodules",
      "-z",
      "--get-regexp",
      "^submodule\\..*\\.path$"
    ],
    true
  );
  if (configured.status !== 0) return [];
  const paths = configured.stdout.split("\0").filter(Boolean).map((entry) => entry.slice(entry.indexOf("\n") + 1)).filter(Boolean);
  if (!paths.length) return [];
  const result2 = gitResult(
    directory,
    ["ls-files", "--stage", "-z", "--", ...paths],
    true
  );
  if (result2.status !== 0) {
    throw new CoordinatorError(
      `Could not inspect nested gitlinks at '${directory}': ${result2.stderr || result2.stdout || `exit ${result2.status}`}.`,
      "NESTED_SUBMODULE_STATUS_FAILED"
    );
  }
  return result2.stdout.split("\0").filter(Boolean).map((entry) => /^(\d{6}) ([0-9a-f]{40,64}) ([0-3])\t([\s\S]+)$/.exec(entry)).filter((entry) => entry?.[1] === "160000").map((entry) => ({
    commit: entry[2],
    path: entry[4],
    stage: entry[3]
  }));
}
function planNestedSubmodules(root, repository) {
  const plans = [];
  const visited = /* @__PURE__ */ new Set();
  const inspect = (directory, label) => {
    const directoryRealPath = canonicalPath2(directory);
    if (visited.has(directoryRealPath)) return;
    visited.add(directoryRealPath);
    const missing = [];
    const initialized = [];
    for (const submodule of indexedSubmodules(directory)) {
      if (submodule.stage !== "0") {
        throw new CoordinatorError(
          `${label} has an unresolved nested gitlink at '${submodule.path}'. Resolve the index before rerunning init.`,
          "NESTED_SUBMODULE_CONFLICT"
        );
      }
      const checkout = nestedCheckoutPath(directory, submodule.path, label);
      const topLevel = gitResult(checkout, ["rev-parse", "--show-toplevel"], true);
      if (topLevel.status !== 0 || !topLevel.stdout || canonicalPath2(topLevel.stdout) !== canonicalPath2(checkout)) {
        if (pathExists(checkout) && (!lstatSync4(checkout).isDirectory() || readdirSync6(checkout).length > 0)) {
          throw new CoordinatorError(
            `${label} nested gitlink '${submodule.path}' is occupied by an unrecognized checkout or files. Init will not overwrite it.`,
            "NESTED_SUBMODULE_PATH_INVALID"
          );
        }
        missing.push(submodule);
        continue;
      }
      const superproject = gitResult(
        checkout,
        ["rev-parse", "--show-superproject-working-tree"],
        true
      );
      if (superproject.status !== 0 || !superproject.stdout || canonicalPath2(superproject.stdout) !== canonicalPath2(directory)) {
        throw new CoordinatorError(
          `${label} nested submodule '${submodule.path}' is not owned by its declared parent worktree.`,
          "NESTED_SUBMODULE_PATH_INVALID"
        );
      }
      const head = gitResult(checkout, ["rev-parse", "HEAD"], true);
      if (head.status !== 0 || head.stdout !== submodule.commit) {
        throw new CoordinatorError(
          `${label} nested submodule '${submodule.path}' is at ${head.stdout || "an unreadable HEAD"}, but its gitlink pins ${submodule.commit}. Init will not move an existing checkout; restore or commit its intended gitlink first.`,
          "NESTED_SUBMODULE_GITLINK_MISMATCH"
        );
      }
      initialized.push({
        directory: checkout,
        label: `${label} nested submodule '${submodule.path}'`
      });
    }
    if (missing.length) {
      plans.push({
        directory,
        repository,
        root,
        submodules: missing.sort(
          (left, right) => left.path.localeCompare(right.path)
        )
      });
    }
    for (const child of initialized) inspect(child.directory, child.label);
  };
  inspect(
    path14.join(root, repository.path),
    `Repository '${repository.id}'`
  );
  return plans;
}
function initializeNestedSubmodules(plans) {
  for (const plan of plans) {
    for (const submodule of plan.submodules) {
      const result2 = gitResult(
        plan.directory,
        [
          "submodule",
          "update",
          "--init",
          "--recursive",
          "--checkout",
          "--",
          submodule.path
        ],
        true
      );
      if (result2.status !== 0) {
        const detail = result2.stderr || result2.stdout || `exit ${result2.status}`;
        const safeDetail = redactNestedSubmoduleDiagnostic(detail);
        const rollback = gitResult(
          plan.directory,
          ["submodule", "deinit", "-f", "--", submodule.path],
          true
        );
        const rollbackDetail = rollback.stderr || rollback.stdout;
        if (rollback.status !== 0) {
          throw new CoordinatorError(
            `Could not initialize nested submodule '${submodule.path}' for repository '${plan.repository.id}': ${safeDetail}. Cleanup of the newly created nested checkout also failed: ${redactNestedSubmoduleDiagnostic(rollbackDetail || `exit ${rollback.status}`)}. Inspect that path before retrying.`,
            "NESTED_SUBMODULE_ROLLBACK_FAILED"
          );
        }
        let repairUnavailable = "";
        const topLevelParent = path14.join(
          plan.root,
          plan.repository.path
        );
        if (canonicalPath2(plan.directory) === canonicalPath2(topLevelParent)) {
          try {
            const repairPlan = planNestedSubmoduleRepair(
              plan.root,
              plan.repository,
              submodule.path
            );
            throw new NestedSubmoduleRepairRequiredError(repairPlan, safeDetail);
          } catch (error) {
            if (error instanceof NestedSubmoduleRepairRequiredError) throw error;
            repairUnavailable = ` Automatic repair is unavailable: ${errorMessage(error)}`;
          }
        }
        throw new CoordinatorError(
          `Could not initialize nested submodule '${submodule.path}' for repository '${plan.repository.id}': ${safeDetail}. The newly created checkout was rolled back by deinitializing that nested path; coordinator.yaml and top-level checkouts were preserved.${repairUnavailable} Resolve access or the parent gitlink and rerun init.`,
          "NESTED_SUBMODULE_INIT_FAILED"
        );
      }
    }
  }
}
function validateExistingDestinations(root, manifest) {
  const existing = manifest.repositories.filter(
    (repository) => pathExists(path14.join(root, repository.path))
  );
  if (!existing.length) return;
  const topLevel = gitResult(root, ["rev-parse", "--show-toplevel"], true);
  if (topLevel.status !== 0 || !topLevel.stdout || canonicalPath2(topLevel.stdout) !== canonicalPath2(root)) {
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
  if (!pathExists(path14.join(root, ".git"))) return "main";
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
function validateNativeConfiguration(root, manifest) {
  try {
    const loaded = loadManifest(root);
    if (JSON.stringify(loaded.manifest) !== JSON.stringify(manifest)) {
      throw new CoordinatorError(
        "Validated coordinator.yaml does not match the initialized workspace manifest.",
        "GIT_CONFIGURATION_INVALID"
      );
    }
  } catch (error) {
    if (error instanceof CoordinatorError) throw error;
    throw new CoordinatorError(
      `coordinator.yaml could not be validated as the native Git configuration: ${error instanceof Error ? error.message : String(error)}`,
      "GIT_CONFIGURATION_INVALID"
    );
  }
}
function initializeWorkspace(directory, input, generatorVersion, options = {}) {
  const manifest = coordinatorManifestSchema.parse(input);
  const root = path14.resolve(directory);
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
    (repository) => !pathExists(path14.join(root, repository.path))
  );
  if (!addSubmodules && installHooks && initiallyMissing.length) {
    throw new CoordinatorError(
      `Cannot install Git integration because these declared submodules are not materialized: ${initiallyMissing.map((repository) => repository.id).join(", ")}. Initialize them or combine --no-submodules with --no-hooks for configuration-only mode. No workspace files were changed.`,
      "SUBMODULES_REQUIRED_FOR_INTEGRATION"
    );
  }
  if (!existsSync11(root) && !dryRun) mkdirSync4(root, { recursive: true });
  const gitDirectory2 = path14.join(root, ".git");
  const createdGitRepository = !existsSync11(gitDirectory2);
  if (createdGitRepository && !dryRun) {
    mkdirSync4(root, { recursive: true });
    runCommand("git", ["init", "--initial-branch=main", root]);
  }
  if (!dryRun) applyFilePlans([manifestPlan]);
  const added = [];
  if (addSubmodules && !dryRun) {
    for (const repository of manifest.repositories) {
      const repositoryDirectory = path14.join(root, repository.path);
      if (pathExists(repositoryDirectory)) continue;
      const initialBranch = initialBranches.get(repository.id);
      const branchArguments = initialBranch.existsOnRemote ? ["-b", initialBranch.name] : [];
      git3(root, [
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
    (repository) => pathExists(path14.join(root, repository.path))
  );
  for (const repository of materialized) {
    validateMaterializedRepository(root, repository);
  }
  if (addSubmodules && !dryRun) {
    const nestedPlans = materialized.flatMap(
      (repository) => planNestedSubmodules(root, repository)
    );
    initializeNestedSubmodules(nestedPlans);
  }
  const missingSubmodules = manifest.repositories.filter((repository) => !pathExists(path14.join(root, repository.path))).map((repository) => repository.id);
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
        path14.join(root, repository.path)
      );
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
  if (!dryRun) validateNativeConfiguration(root, manifest);
  if (!dryRun && installHooks) {
    installMachineGitRuntime({ stdio: gitStdio });
    installWorkspaceGitIntegration(root, { stdio: gitStdio });
    invokeGitRuntime("attach", root, { stdio: gitStdio });
    invokeGitRuntime("check", root, { stdio: gitStdio });
  }
  const gitIntegration = dryRun ? {
    attached: false,
    configurationValidated: false,
    detail: "Dry run only; no Git integration, hooks, attach, or invariant check was applied.",
    hooksInstalled: false,
    invariantChecked: false,
    missingSubmodules: initiallyMissing.map((repository) => repository.id),
    mode: "dry-run",
    validatedSubmodules: []
  } : installHooks ? {
    attached: true,
    configurationValidated: true,
    detail: "Native coordinator.yaml Git configuration, submodule topology, branch attachment, and embedded Git runtime invariant validated.",
    hooksInstalled: true,
    invariantChecked: true,
    missingSubmodules: [],
    mode: "active",
    validatedSubmodules: materialized.map((repository) => repository.id)
  } : {
    attached: false,
    configurationValidated: true,
    detail: "Configuration-only mode (--no-hooks): native coordinator.yaml Git configuration and materialized submodules were validated; runtime installation, hooks, attach, and the runtime invariant check were intentionally skipped.",
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
import { existsSync as existsSync12, readFileSync as readFileSync10 } from "fs";
import path15 from "path";
function slug2(value2) {
  return value2.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}
function submoduleUrl(root, repositoryPath2) {
  const result2 = runCommand(
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
  const line = result2.stdout.split("\n").find((entry) => entry.trim().endsWith(` ${repositoryPath2}`));
  if (!line) return repositoryPath2;
  const key = line.split(/\s+/)[0].replace(/\.path$/, ".url");
  return runCommand("git", ["-C", root, "config", "-f", ".gitmodules", "--get", key], {
    allowFailure: true
  }).stdout || repositoryPath2;
}
function inlineWorkspace(root, legacy, repositories) {
  const settings = legacy.workspaceManifest;
  if (!settings || (settings.coordinatorToken ?? "$coordinator") !== "$coordinator") {
    return null;
  }
  if (typeof settings.path !== "string" || !settings.path || settings.path === "." || path15.isAbsolute(settings.path) || settings.path.split(/[\\/]/).includes("..")) {
    return null;
  }
  const normalizedWorkspacePath = path15.posix.normalize(
    settings.path.replaceAll("\\", "/")
  );
  if (["coordinator.yaml", ".git-coordinator.json"].includes(
    normalizedWorkspacePath
  )) {
    throw new CoordinatorError(
      `Legacy workspaceManifest.path '${settings.path}' collides with a reserved coordinator file.`,
      "INVALID_LEGACY_CONFIGURATION"
    );
  }
  const workspacePath = path15.join(root, settings.path);
  if (!existsSync12(workspacePath)) return null;
  let parsed;
  try {
    parsed = JSON.parse(readFileSync10(workspacePath, "utf8"));
  } catch {
    return null;
  }
  if (parsed.schemaVersion !== 1 || typeof parsed.baseBranch !== "string" || !parsed.baseBranch || !parsed.repositories || typeof parsed.repositories !== "object" || Array.isArray(parsed.repositories)) {
    return null;
  }
  const entries = parsed.repositories;
  const expectedIds = repositories.map((repository) => repository.id).sort();
  const actualIds = Object.keys(entries).sort();
  if (expectedIds.length !== actualIds.length || expectedIds.some((id, index) => id !== actualIds[index])) {
    return null;
  }
  const selection = {};
  for (const repository of repositories) {
    const entry = entries[repository.id];
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
    const candidate = entry;
    if (Object.keys(candidate).sort().join(",") !== "branch,mode,path" || candidate.path !== repository.path || typeof candidate.branch !== "string" || !candidate.branch || !["active", "pinned"].includes(String(candidate.mode))) {
      return null;
    }
    selection[repository.id] = {
      branch: candidate.branch,
      mode: candidate.mode
    };
  }
  return {
    embeddedWorkspacePath: settings.path,
    workspace: {
      baseBranch: parsed.baseBranch,
      coordinatorToken: "$coordinator",
      mirrorActiveInLinkedWorktrees: settings.mirrorActiveInLinkedWorktrees ?? false,
      selection
    }
  };
}
function migrateLegacyWorkspaceWithMetadata(rootInput) {
  const root = path15.resolve(rootInput);
  const configurationPath = path15.join(root, ".git-coordinator.json");
  if (!existsSync12(configurationPath)) {
    throw new CoordinatorError(`${configurationPath} does not exist.`);
  }
  let legacy;
  try {
    legacy = JSON.parse(readFileSync10(configurationPath, "utf8"));
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
  ].filter(([directory]) => existsSync12(path15.join(root, directory))).map(([, tool]) => tool);
  const repositories = legacy.repositories.map((repository) => {
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
  });
  const embedded = inlineWorkspace(root, legacy, repositories);
  const manifestInput = {
    schemaVersion: embedded || !legacy.workspaceManifest ? 2 : 1,
    name: slug2(path15.basename(root)),
    remote: legacy.remote ?? "origin",
    repositories,
    agents: {
      manage: false,
      tools: tools.length ? tools : ["codex"],
      maxParallel: 4,
      skillCollision: "error"
    }
  };
  const manifest = embedded ? { ...manifestInput, workspace: embedded.workspace } : legacy.workspaceManifest ? { ...manifestInput, workspaceManifest: legacy.workspaceManifest } : manifestInput;
  const validated = coordinatorManifestSchema.safeParse(manifest);
  if (!validated.success) {
    const issues = validated.error.issues.map((issue) => `${issue.path.join(".") || "coordinator.yaml"}: ${issue.message}`).join("\n");
    throw new CoordinatorError(
      `Legacy Git Coordinator configuration cannot be migrated without edits:
${issues}`,
      "INVALID_LEGACY_CONFIGURATION"
    );
  }
  return {
    embeddedWorkspacePath: embedded?.embeddedWorkspacePath ?? null,
    manifest: validated.data
  };
}

// src/cli.ts
function globals(program2) {
  return program2.optsWithGlobals();
}
function writeJson(value2) {
  process.stdout.write(`${JSON.stringify(value2, null, 2)}
`);
}
function renderSkillActions(actions, preview) {
  if (!actions.length) return "";
  const labels = preview ? {
    "adopt-link": "would adopt existing link",
    "create-link": "would create link",
    "delete-managed": "would remove managed entry",
    "migrate-copy": "would migrate managed copy",
    "replace-link": "would replace registry entry"
  } : {
    "adopt-link": "adopted existing link",
    "create-link": "created link",
    "delete-managed": "removed managed entry",
    "migrate-copy": "migrated managed copy",
    "replace-link": "replaced registry entry"
  };
  return [
    preview ? "Skill link plan:" : "Skill link changes:",
    ...actions.map((action) => {
      const destination = `.agents/skills/${action.name}`;
      const target = action.linkTarget ? ` -> ${action.linkTarget}` : "";
      return `  - ${labels[action.action]} ${destination}${target}`;
    })
  ].join("\n");
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
      `Invalid repository '${spec}'. Use role=owner/repository, role=bitbucket:workspace/repository, or role=clone-url.`
    );
  }
  const id = spec.slice(0, separator);
  const sourceAndPath = spec.slice(separator + 1);
  const comma = sourceAndPath.lastIndexOf(",");
  const source = comma > 0 ? sourceAndPath.slice(0, comma) : sourceAndPath;
  const repositoryPath2 = comma > 0 ? sourceAndPath.slice(comma + 1) : source.replace(/\.git$/, "").split(/[/:]/).at(-1);
  return {
    id,
    path: repositoryPath2,
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
function summarizeChanges(result2) {
  return {
    changed: result2.changed,
    git: result2.git.action,
    agents: changedPlans(result2.agents.files).map((file) => ({
      path: file.relativePath,
      action: file.action
    })),
    skills: result2.agents.skills,
    skillActions: result2.agents.skillActions,
    skillMigrations: result2.agents.skillMigrations,
    ci: changedPlans(result2.ci.files).map((file) => ({
      path: file.relativePath,
      action: file.action
    }))
  };
}
function renderDoctor(result2, color) {
  const style = {
    pass: (value2) => color ? pc3.green(value2) : value2,
    warn: (value2) => color ? pc3.yellow(value2) : value2,
    fail: (value2) => color ? pc3.red(value2) : value2
  };
  return result2.checks.map((item) => {
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
  const result2 = runDoctor(loaded.root, loaded.manifest, VERSION);
  const options = globals(program2);
  if (options.json) writeJson(result2);
  else {
    process.stdout.write(`${renderDoctor(result2, options.color)}
`);
    process.stdout.write(
      result2.healthy ? pc3.green("\nWorkspace ready.\n") : pc3.red("\nWorkspace needs attention.\n")
    );
  }
  if (!result2.healthy) process.exitCode = 1;
}
var MAX_NESTED_SUBMODULE_REPAIRS = 8;
async function initializeWorkspaceWithRepairs(directory, manifest, options, interactive) {
  const repairs = [];
  const appliedPlans = /* @__PURE__ */ new Set();
  while (true) {
    try {
      return {
        repairs,
        result: initializeWorkspace(directory, manifest, VERSION, options)
      };
    } catch (error) {
      if (!(error instanceof NestedSubmoduleRepairRequiredError) || !interactive) {
        throw error;
      }
      if (repairs.length >= MAX_NESTED_SUBMODULE_REPAIRS || appliedPlans.has(error.plan.id)) {
        throw new CoordinatorError(
          `Nested submodule repair could not make progress for plan '${error.plan.id}'. Partial workspace preserved at ${error.plan.root}.`,
          "NESTED_SUBMODULE_REPAIR_RETRY_EXHAUSTED"
        );
      }
      const candidateRevision = await promptNestedSubmoduleRepair(error.plan);
      if (!candidateRevision) {
        throw new CoordinatorError(
          `Nested repair was not applied. Partial workspace preserved at ${error.plan.root}. Rerun 'coordinator init --resume' after repairing the remote or when ready to approve a verified local repair.`,
          "INCOMPLETE_INITIALIZATION"
        );
      }
      const repair = applyNestedSubmoduleRepair(error.plan, {
        approveLocalCommit: true,
        candidateRevision
      });
      appliedPlans.add(error.plan.id);
      repairs.push(repair);
      reportNestedSubmoduleRepair(repair);
    }
  }
}
async function home(program2) {
  const root = findWorkspaceRoot();
  if (!root) {
    if (!process.stdin.isTTY) {
      program2.help();
      return;
    }
    const prompted = await promptWorkspaceManifest(process.cwd());
    await initializeWorkspaceWithRepairs(
      process.cwd(),
      prompted.manifest,
      { discoverSkills: prompted.discoverSkills },
      !globals(program2).json && Boolean(process.stdin.isTTY && process.stdout.isTTY)
    );
    finishWorkspacePrompt();
    await showStatus(program2);
    return;
  }
  await showStatus(program2);
  if (!process.stdin.isTTY) return;
  const action = await promptDashboardAction();
  if (action === "sync") {
    const loaded = loadManifest(root);
    const result2 = synchronizeWorkspace(loaded.root, loaded.manifest, VERSION);
    process.stdout.write(result2.changed ? "Workspace synchronized.\n" : "Workspace already synchronized.\n");
  } else if (action === "doctor") {
    await showDoctor(program2);
  } else if (action === "status") {
    await showStatus(program2);
  }
}
var directComposeArguments = process.argv[2] === "compose" ? process.argv.slice(3) : null;
var jsonRequested = directComposeArguments === null && process.argv.includes("--json");
var program = new Command();
if (jsonRequested) {
  program.configureOutput({ writeErr: () => {
  } });
}
program.exitOverride();
program.name("coordinator").description("Beautiful multi-repository Git, agent, and delivery coordination.").version(VERSION).option("--json", "print machine-readable JSON", false).option("--no-color", "disable terminal colors").showSuggestionAfterError().showHelpAfterError().action(async () => home(program));
program.command("init").description("initialize a coordinator in an empty or existing directory").argument("[directory]", "workspace directory", ".").option("-n, --name <name>", "workspace name").option(
  "-r, --repo <spec>",
  "repository role=owner/repo, role=bitbucket:workspace/repo, or role=clone-url[,path]",
  collect,
  []
).option("--tools <tools>", "comma-separated agent runtimes", "codex,claude").option("--discover-skills", "discover committed skills after cloning", false).option("--resume", "resume an interrupted initialization from coordinator.yaml").option("--no-submodules", "write configuration without cloning repositories").option("--no-hooks", "configuration only: skip runtime installation, hooks, attach, and check").option("--dry-run", "show the initialization contract without writing").option("--force", "adopt conflicting generated destinations").action(async (directory, options) => {
  let targetDirectory = directory;
  let manifest;
  let discoverSkills = options.discoverSkills;
  let interactive = false;
  if (options.resume) {
    if (options.repo.length || options.name) {
      throw new CoordinatorError(
        "--resume cannot be combined with --repo or --name; it uses the existing coordinator.yaml.",
        "INVALID_RESUME_OPTIONS"
      );
    }
    const loaded = loadManifest(directory);
    targetDirectory = loaded.root;
    manifest = loaded.manifest;
    interactive = !globals(program).json && Boolean(process.stdin.isTTY && process.stdout.isTTY);
    if (interactive) {
      discoverSkills = await promptResumeWorkspace(
        loaded.root,
        loaded.manifest.name
      );
    }
  } else if (!options.repo.length) {
    if (!process.stdin.isTTY) {
      throw new CoordinatorError("At least one --repo is required without an interactive terminal.");
    }
    interactive = true;
    const prompted = await promptWorkspaceManifest(directory);
    manifest = prompted.manifest;
    discoverSkills = prompted.discoverSkills;
  } else {
    manifest = coordinatorManifestSchema.parse({
      schemaVersion: 2,
      name: options.name ?? slug3(path16.basename(path16.resolve(directory))),
      remote: "origin",
      repositories: options.repo.map(repositoryFromSpec),
      agents: {
        tools: parseTools(options.tools),
        maxParallel: Math.min(4, options.repo.length),
        skillCollision: "error"
      }
    });
  }
  const initialized = await initializeWorkspaceWithRepairs(
    targetDirectory,
    manifest,
    {
      addSubmodules: options.submodules,
      dryRun: options.dryRun,
      discoverSkills,
      gitStdio: globals(program).json ? "pipe" : "inherit",
      installHooks: options.hooks,
      force: options.force
    },
    interactive && !globals(program).json && !options.dryRun && Boolean(process.stdout.isTTY)
  );
  const { repairs, result: result2 } = initialized;
  if (options.dryRun) {
    writeJson({
      directory: path16.resolve(targetDirectory),
      manifest,
      discoverSkills,
      repairs,
      result: result2
    });
    return;
  }
  if (interactive) finishWorkspacePrompt();
  if (globals(program).json) writeJson(result2);
  else {
    process.stdout.write(
      `Initialized ${manifest.name} with ${manifest.repositories.length} repositories.
`
    );
    process.stdout.write(`${result2.gitIntegration.detail}
`);
    if (repairs.length) {
      process.stdout.write(
        `${repairs.length} local nested-submodule repair commit${repairs.length === 1 ? "" : "s"} created; no push was performed. A later coordinated push can publish ${repairs.length === 1 ? "it" : "them"}.
`
      );
    }
    if (result2.gitIntegration.missingSubmodules.length) {
      process.stdout.write(
        "Next: rerun init with the same repositories and submodule cloning enabled before using ordinary Git.\n"
      );
    } else if (result2.gitIntegration.mode === "configuration-only") {
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
program.command("sync").description("synchronize agent, skill, and CI outputs and retire an owned legacy Git adapter").option("--check", "fail when generated outputs are stale").option("--force", "preview or adopt conflicting generated and skill destinations").action((options) => {
  const loaded = loadManifest();
  const result2 = synchronizeWorkspace(loaded.root, loaded.manifest, VERSION, options);
  const summary = summarizeChanges(result2);
  if (globals(program).json) writeJson(summary);
  else if (options.check) {
    const migrationDetail = result2.agents.skillMigrations.length ? ` ${result2.agents.skillMigrations.length} managed skill ${result2.agents.skillMigrations.length === 1 ? "copy would migrate" : "copies would migrate"} to relative source ${result2.agents.skillMigrations.length === 1 ? "link" : "links"}.` : "";
    process.stdout.write(
      `${result2.changed ? "Generated workspace outputs are stale" : "Generated workspace outputs are current"}.${migrationDetail}
`
    );
  } else {
    const migrationDetail = result2.agents.skillMigrations.length ? ` Migrated ${result2.agents.skillMigrations.length} managed skill ${result2.agents.skillMigrations.length === 1 ? "copy" : "copies"} to relative source ${result2.agents.skillMigrations.length === 1 ? "link" : "links"}.` : "";
    process.stdout.write(
      `${result2.changed ? "Workspace synchronized; generated outputs updated" : "Workspace already synchronized"}.${migrationDetail}
`
    );
  }
  const renderedSkillActions = renderSkillActions(
    result2.agents.skillActions,
    Boolean(options.check)
  );
  if (!globals(program).json && renderedSkillActions) {
    process.stdout.write(`${renderedSkillActions}
`);
  }
  if (options.check && result2.changed) process.exitCode = 1;
});
var agents = program.command("agents").description("manage tool-specific agents and portable skills");
for (const mode of ["sync", "check"]) {
  agents.command(mode).description(
    mode === "sync" ? "synchronize agents and relative source skill links" : "preview generated agents and relative source skill links"
  ).option(
    "--force",
    mode === "sync" ? "adopt or replace conflicting generated and skill destinations" : "preview adoption or replacement of conflicting skill destinations"
  ).action((options) => {
    const loaded = loadManifest();
    const result2 = synchronizeAgents(loaded.root, loaded.manifest, VERSION, {
      check: mode === "check",
      force: options.force
    });
    const summary = {
      managed: loaded.manifest.agents.manage !== false,
      changed: result2.changed,
      skills: result2.skills,
      skillActions: result2.skillActions,
      skillMigrations: result2.skillMigrations,
      files: changedPlans(result2.files).map((file) => file.relativePath)
    };
    if (globals(program).json) writeJson(summary);
    else if (loaded.manifest.agents.manage === false) {
      process.stdout.write(
        "Agent management is disabled; existing agent and skill files were left untouched.\n"
      );
    } else if (mode === "check") {
      const migrationDetail = result2.skillMigrations.length ? ` ${result2.skillMigrations.length} managed skill ${result2.skillMigrations.length === 1 ? "copy would migrate to a relative source link" : "copies would migrate to relative source links"}.` : "";
      process.stdout.write(
        `${result2.skills.length} skill links; ${result2.changed ? "generated agent and skill outputs are stale" : "generated agent and skill outputs are current"}.${migrationDetail}
`
      );
    } else {
      const migrationDetail = result2.skillMigrations.length ? ` Migrated ${result2.skillMigrations.length} managed skill ${result2.skillMigrations.length === 1 ? "copy to a relative source link" : "copies to relative source links"}.` : "";
      process.stdout.write(
        `${result2.skills.length} skill links; ${result2.changed ? "agent and skill outputs synchronized" : "agent and skill outputs already synchronized"}.${migrationDetail}
`
      );
    }
    const renderedSkillActions = renderSkillActions(
      result2.skillActions,
      mode === "check"
    );
    if (!globals(program).json && renderedSkillActions) {
      process.stdout.write(`${renderedSkillActions}
`);
    }
    if (mode === "check" && result2.changed) process.exitCode = 1;
  });
}
var ci = program.command("ci").description("generate coordinated GitHub Actions delivery workflows");
for (const mode of ["sync", "check"]) {
  ci.command(mode).description(mode === "sync" ? "generate CI/CD files" : "verify generated CI/CD files").option("--force", "adopt conflicting generated destinations").action((options) => {
    const loaded = loadManifest();
    const result2 = synchronizeCi(loaded.root, loaded.manifest, {
      check: mode === "check",
      force: options.force
    });
    if (globals(program).json) writeJson(result2);
    else if (mode === "check") {
      process.stdout.write(
        `${result2.changed ? "Generated CI/CD files are stale" : "Generated CI/CD files are current"}.
`
      );
    } else {
      process.stdout.write(
        `${result2.changed ? "CI/CD synchronized; generated files updated" : "CI/CD already synchronized"}.
`
      );
    }
    if (mode === "check" && result2.changed) process.exitCode = 1;
  });
}
var git4 = program.command("git").description("operate the embedded Git runtime");
for (const command of ["install", "uninstall", "attach", "check"]) {
  git4.command(command).description(
    command === "install" ? "install the embedded runtime and this workspace's Git integration" : command === "uninstall" ? "remove this workspace's Git integration" : `${command} the workspace Git integration`
  ).action(() => {
    const root = findWorkspaceRoot() ?? process.cwd();
    const json = globals(program).json;
    const runtime = command === "install" ? installMachineGitRuntime({ stdio: json ? "pipe" : "inherit" }) : null;
    const result2 = command === "install" ? installWorkspaceGitIntegration(root, {
      stdio: json ? "pipe" : "inherit"
    }) : command === "uninstall" ? uninstallWorkspaceGitIntegration(root, {
      stdio: json ? "pipe" : "inherit"
    }) : invokeGitRuntime(command, root, {
      stdio: json ? "pipe" : "inherit"
    });
    if (json) {
      writeJson({
        command,
        root,
        runtime,
        result: result2
      });
    }
    if ("status" in result2 && result2.status !== 0) {
      process.exitCode = result2.status;
    }
  });
}
program.command("compose").description("run Docker Compose from the local.compose manifest configuration").argument("[args...]", "arguments forwarded to docker compose").allowUnknownOption(true).allowExcessArguments(true).helpOption(false).action((argumentsList) => {
  const loaded = loadManifest();
  const result2 = runLocalCompose(loaded.root, loaded.manifest, argumentsList);
  if (result2.status !== 0) process.exitCode = result2.status;
});
program.command("install").description("install or refresh the transparent Git runtime on this machine").action(() => {
  const json = globals(program).json;
  const result2 = installMachineGitRuntime({
    stdio: json ? "pipe" : "inherit"
  });
  if (json) writeJson(result2);
});
program.command("uninstall").description("remove the managed transparent Git runtime from this machine").action(() => {
  const json = globals(program).json;
  const result2 = uninstallMachineGitRuntime({
    stdio: json ? "pipe" : "inherit"
  });
  if (json) writeJson(result2);
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
program.command("migrate").description("create coordinator.yaml from an existing .git-coordinator.json").argument("[directory]", "legacy workspace", ".").option("--write", "write coordinator.yaml instead of printing it").option("--adopt-git", "remove legacy Git files after absorbing their configuration").option("--force", "replace an existing project-owned manifest").action((directory, options) => {
  const root = path16.resolve(directory);
  const migration = migrateLegacyWorkspaceWithMetadata(root);
  const manifest = migration.manifest;
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
    if (!yamlNativeGitRuntimeActive(root)) {
      throw new CoordinatorError(
        "Refusing to remove legacy Git files before the YAML-native runtime is active. First run migrate --write, then coordinator git install, then retry with --write --adopt-git.",
        "GIT_COORDINATOR_YAML_RUNTIME_REQUIRED"
      );
    }
    plans.push(
      planFileDeletion(root, ".git-coordinator.json", () => true)
    );
    if (migration.embeddedWorkspacePath) {
      plans.push(
        planFileDeletion(root, migration.embeddedWorkspacePath, () => true)
      );
    }
  }
  applyFilePlans(plans);
  const result2 = plans.map((plan) => ({
    path: plan.path,
    action: plan.action
  }));
  if (globals(program).json) writeJson(result2);
  else {
    for (const plan of plans) process.stdout.write(`${plan.action}: ${plan.path}
`);
    process.stdout.write(
      "Agent management remains disabled; existing agent and skill files were left untouched.\n"
    );
    process.stdout.write(
      options.adoptGit ? "Next: run coordinator git attach and coordinator doctor.\n" : "Next: review coordinator.yaml, run coordinator git install, then rerun with --write --adopt-git to remove the absorbed legacy Git files.\n"
    );
  }
});
function handleCliError(error) {
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
      code: error instanceof CoordinatorError ? error.code : "UNEXPECTED_ERROR",
      ...error instanceof NestedSubmoduleRepairRequiredError ? { repairPlan: error.plan } : {}
    });
  } else {
    process.stderr.write(`${pc3.red("\xD7")} ${errorMessage(error)}
`);
  }
  process.exitCode = 1;
}
var execution = directComposeArguments ? Promise.resolve().then(() => {
  const loaded = loadManifest();
  const result2 = runLocalCompose(
    loaded.root,
    loaded.manifest,
    directComposeArguments
  );
  if (result2.status !== 0) process.exitCode = result2.status;
}) : program.parseAsync(process.argv);
execution.catch(handleCliError);
//# sourceMappingURL=cli.js.map