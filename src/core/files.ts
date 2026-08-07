import {
  closeSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { CoordinatorError } from "./errors.js";

export type FileAction = "create" | "update" | "delete" | "unchanged";

export interface FilePlan {
  action: FileAction;
  content: string;
  path: string;
  relativePath: string;
}

export interface PlanFileOptions {
  force?: boolean | undefined;
  owned?: (content: string) => boolean;
}

const planRoots = new WeakMap<FilePlan, string>();

type PlannedPathState =
  | { kind: "missing" }
  | {
      content: string;
      dev: number;
      ino: number;
      kind: "file";
      mode: number;
    };

const planPathStates = new WeakMap<FilePlan, PlannedPathState>();

function pathStatesMatch(
  left: PlannedPathState,
  right: PlannedPathState,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function lstatIfPresent(value: string): ReturnType<typeof lstatSync> | null {
  try {
    return lstatSync(value);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function plannedPathState(value: string): PlannedPathState {
  const status = lstatIfPresent(value);
  if (!status) return { kind: "missing" };
  if (!status.isFile()) {
    throw new CoordinatorError(
      `Generated-file destination is not a regular file: ${value}.`,
      "UNSAFE_FILE_PATH",
    );
  }
  return {
    content: readFileSync(value, "utf8"),
    dev: Number(status.dev),
    ino: Number(status.ino),
    kind: "file",
    mode: Number(status.mode),
  };
}

export function safeGeneratedPath(root: string, relativePath: string): string {
  if (
    !relativePath ||
    path.isAbsolute(relativePath) ||
    relativePath.split(/[\\/]/).includes("..") ||
    relativePath === "."
  ) {
    throw new CoordinatorError(
      `Unsafe generated file path '${relativePath}'.`,
      "UNSAFE_FILE_PATH",
    );
  }
  const resolvedRoot = path.resolve(root);
  const absolutePath = path.resolve(resolvedRoot, relativePath);
  if (
    absolutePath !== resolvedRoot &&
    !absolutePath.startsWith(`${resolvedRoot}${path.sep}`)
  ) {
    throw new CoordinatorError(
      `Generated file '${relativePath}' escapes the workspace.`,
      "UNSAFE_FILE_PATH",
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
        `Refusing generated file '${relativePath}' because '${path.relative(resolvedRoot, current)}' is a symlink.`,
        "UNSAFE_FILE_PATH",
      );
    }
    if (status && !status.isDirectory()) {
      throw new CoordinatorError(
        `Refusing generated file '${relativePath}' because '${path.relative(resolvedRoot, current)}' is not a directory.`,
        "UNSAFE_FILE_PATH",
      );
    }
  }
  if (lstatIfPresent(absolutePath)?.isSymbolicLink()) {
    throw new CoordinatorError(
      `Refusing to follow generated-file symlink '${relativePath}'.`,
      "UNSAFE_FILE_PATH",
    );
  }
  return absolutePath;
}

function registerPlan(
  root: string,
  plan: FilePlan,
  state: PlannedPathState = plannedPathState(plan.path),
): FilePlan {
  planRoots.set(plan, path.resolve(root));
  planPathStates.set(plan, state);
  return plan;
}

function revalidatePlan(plan: FilePlan): void {
  const root = planRoots.get(plan);
  if (!root) {
    throw new CoordinatorError(
      `Refusing untrusted generated-file plan '${plan.relativePath}'.`,
      "UNSAFE_FILE_PLAN",
    );
  }
  const currentPath = safeGeneratedPath(root, plan.relativePath);
  if (currentPath !== plan.path) {
    throw new CoordinatorError(
      `Generated-file plan '${plan.relativePath}' changed destination before publication.`,
      "UNSAFE_FILE_PLAN",
    );
  }
  const expectedState = planPathStates.get(plan);
  if (
    !expectedState ||
    !pathStatesMatch(plannedPathState(currentPath), expectedState)
  ) {
    throw new CoordinatorError(
      `Generated-file destination '${plan.relativePath}' changed after planning. Run the command again.`,
      "FILE_PLAN_STALE",
    );
  }
}

function ensurePlanParent(plan: FilePlan): void {
  const root = planRoots.get(plan);
  if (!root) {
    throw new CoordinatorError(
      `Refusing untrusted generated-file plan '${plan.relativePath}'.`,
      "UNSAFE_FILE_PLAN",
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
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const status = lstatSync(current);
    if (!status.isDirectory() || status.isSymbolicLink()) {
      throw new CoordinatorError(
        `Refusing generated file '${plan.relativePath}' because '${path.relative(root, current)}' is not a safe directory.`,
        "UNSAFE_FILE_PATH",
      );
    }
  }
  revalidatePlan(plan);
}

export function planFile(
  root: string,
  relativePath: string,
  content: string,
  options: PlanFileOptions = {},
): FilePlan {
  const absolutePath = safeGeneratedPath(root, relativePath);
  const state = plannedPathState(absolutePath);
  if (state.kind === "missing") {
    return registerPlan(root, {
      action: "create",
      content,
      path: absolutePath,
      relativePath,
    }, state);
  }
  const current = state.content;
  if (current === content) {
    return registerPlan(root, {
      action: "unchanged",
      content,
      path: absolutePath,
      relativePath,
    }, state);
  }
  if (!options.force && options.owned && !options.owned(current)) {
    throw new CoordinatorError(
      `Refusing to overwrite unmanaged file '${relativePath}'. Move it, adopt it explicitly, or use --force.`,
      "UNMANAGED_FILE",
    );
  }
  return registerPlan(root, {
    action: "update",
    content,
    path: absolutePath,
    relativePath,
  }, state);
}

interface FileTransactionChange {
  backupPath: string | null;
  discardPath: string | null;
  expectedState: PlannedPathState;
  plan: FilePlan;
  publishedState: PlannedPathState | null;
  stagedPath: string | null;
  stagedState: PlannedPathState | null;
}

function randomSibling(plan: FilePlan, purpose: string): string {
  return path.join(
    path.dirname(plan.path),
    `.${path.basename(plan.path)}.coordinator-${purpose}-${randomUUID()}`,
  );
}

function cleanupTransactionFiles(changes: FileTransactionChange[]): void {
  for (const change of changes) {
    for (const [candidate, expected] of [
      [change.stagedPath, change.stagedState],
      [change.backupPath, change.expectedState],
      [change.discardPath, change.publishedState],
    ] as Array<[string | null, PlannedPathState | null]>) {
      if (!candidate || !expected) continue;
      try {
        const current = plannedPathState(candidate);
        if (pathStatesMatch(current, expected) && current.kind !== "missing") {
          unlinkSync(candidate);
        }
      } catch {
        // Unpredictable recovery paths are preserved if their identity changed.
      }
    }
  }
}

function rollbackFileChanges(changes: FileTransactionChange[]): string[] {
  const failures: string[] = [];
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
            "FILE_ROLLBACK_DESTINATION_CHANGED",
          );
        }
        change.discardPath = randomSibling(change.plan, "discard");
        renameSync(change.plan.path, change.discardPath);
        if (
          !pathStatesMatch(
            plannedPathState(change.discardPath),
            change.publishedState,
          )
        ) {
          if (plannedPathState(change.plan.path).kind === "missing") {
            renameSync(change.discardPath, change.plan.path);
            change.discardPath = null;
          }
          throw new CoordinatorError(
            "published destination changed while rollback captured it",
            "FILE_ROLLBACK_DESTINATION_CHANGED",
          );
        }
      }
      if (change.backupPath) {
        if (plannedPathState(change.plan.path).kind !== "missing") {
          throw new CoordinatorError(
            "destination is occupied; backup preserved",
            "FILE_ROLLBACK_DESTINATION_CHANGED",
          );
        }
        try {
          linkSync(change.backupPath, change.plan.path);
        } catch (error) {
          throw new CoordinatorError(
            `could not restore backup: ${error instanceof Error ? error.message : String(error)}`,
            "FILE_ROLLBACK_FAILED",
          );
        }
        if (
          !pathStatesMatch(
            plannedPathState(change.plan.path),
            change.expectedState,
          )
        ) {
          throw new CoordinatorError(
            "restored backup does not match the planned original",
            "FILE_ROLLBACK_FAILED",
          );
        }
        unlinkSync(change.backupPath);
        change.backupPath = null;
      }
    } catch (error) {
      failures.push(
        `${change.plan.relativePath}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return failures;
}

export function applyFilePlans(plans: FilePlan[]): void {
  const paths = new Set<string>();
  for (const plan of plans) {
    if (paths.has(plan.path)) {
      throw new CoordinatorError(
        `Generated-file destination '${plan.relativePath}' was planned more than once.`,
        "DUPLICATE_FILE_PLAN",
      );
    }
    paths.add(plan.path);
    revalidatePlan(plan);
  }

  const changes: FileTransactionChange[] = [];
  const applied: FileTransactionChange[] = [];
  try {
    for (const plan of plans) {
      if (plan.action === "unchanged") continue;
      ensurePlanParent(plan);
      revalidatePlan(plan);
      const expectedState = planPathStates.get(plan);
      if (!expectedState) {
        throw new CoordinatorError(
          `Missing expected state for '${plan.relativePath}'.`,
          "UNSAFE_FILE_PLAN",
        );
      }
      const change: FileTransactionChange = {
        backupPath: null,
        discardPath: null,
        expectedState,
        plan,
        publishedState: null,
        stagedPath: null,
        stagedState: null,
      };
      if (plan.action !== "delete") {
        change.stagedPath = randomSibling(plan, "staged");
        let descriptor: number | null = null;
        try {
          descriptor = openSync(change.stagedPath, "wx", 0o644);
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
        if (
          !pathStatesMatch(
            plannedPathState(change.backupPath),
            change.expectedState,
          )
        ) {
          throw new CoordinatorError(
            `Generated-file destination '${plan.relativePath}' changed while it was being backed up.`,
            "FILE_PLAN_STALE",
          );
        }
      }
      if (plan.action !== "delete") {
        if (!change.stagedPath || !change.stagedState) {
          throw new CoordinatorError(
            `Generated file '${plan.relativePath}' was not staged.`,
            "UNSAFE_FILE_PLAN",
          );
        }
        try {
          linkSync(change.stagedPath, plan.path);
        } catch (error) {
          throw new CoordinatorError(
            `Generated-file destination '${plan.relativePath}' changed during publication: ${error instanceof Error ? error.message : String(error)}.`,
            "FILE_PLAN_STALE",
          );
        }
        change.publishedState = change.stagedState;
        if (
          !pathStatesMatch(
            plannedPathState(plan.path),
            change.publishedState,
          )
        ) {
          throw new CoordinatorError(
            `Generated-file destination '${plan.relativePath}' changed during publication.`,
            "FILE_PLAN_STALE",
          );
        }
      }
    }

    for (const change of changes) {
      const root = planRoots.get(change.plan)!;
      safeGeneratedPath(root, change.plan.relativePath);
      const finalState = plannedPathState(change.plan.path);
      const expectedFinal = change.publishedState ?? { kind: "missing" };
      if (!pathStatesMatch(finalState, expectedFinal)) {
        throw new CoordinatorError(
          `Generated-file destination '${change.plan.relativePath}' changed before commit.`,
          "FILE_PLAN_STALE",
        );
      }
    }
  } catch (error) {
    const rollbackFailures = rollbackFileChanges(applied);
    if (!rollbackFailures.length) cleanupTransactionFiles(changes);
    if (rollbackFailures.length) {
      const recoveryPaths = changes
        .flatMap((change) => [change.stagedPath, change.backupPath, change.discardPath])
        .filter((value): value is string => Boolean(value));
      throw new CoordinatorError(
        `Generated-file publication failed (${error instanceof Error ? error.message : String(error)}) and rollback was incomplete: ${rollbackFailures.join("; ")}. Recovery files were preserved: ${recoveryPaths.join(", ")}.`,
        "FILE_ROLLBACK_FAILED",
      );
    }
    throw error;
  }
  cleanupTransactionFiles(changes);
}

export function planFileDeletion(
  root: string,
  relativePath: string,
  owned: (content: string) => boolean,
): FilePlan {
  const absolutePath = safeGeneratedPath(root, relativePath);
  const state = plannedPathState(absolutePath);
  if (state.kind === "missing") {
    return registerPlan(root, {
      action: "unchanged",
      content: "",
      path: absolutePath,
      relativePath,
    }, state);
  }
  const current = state.content;
  return registerPlan(root, {
    action: owned(current) ? "delete" : "unchanged",
    content: current,
    path: absolutePath,
    relativePath,
  }, state);
}

export function changedPlans(plans: FilePlan[]): FilePlan[] {
  return plans.filter((plan) => plan.action !== "unchanged");
}
