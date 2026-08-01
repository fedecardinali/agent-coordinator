import {
  closeSync,
  existsSync,
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

function lstatIfPresent(value: string): ReturnType<typeof lstatSync> | null {
  try {
    return lstatSync(value);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
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

function registerPlan(root: string, plan: FilePlan): FilePlan {
  planRoots.set(plan, path.resolve(root));
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
}

export function planFile(
  root: string,
  relativePath: string,
  content: string,
  options: PlanFileOptions = {},
): FilePlan {
  const absolutePath = safeGeneratedPath(root, relativePath);
  if (!existsSync(absolutePath)) {
    return registerPlan(root, {
      action: "create",
      content,
      path: absolutePath,
      relativePath,
    });
  }
  const current = readFileSync(absolutePath, "utf8");
  if (current === content) {
    return registerPlan(root, {
      action: "unchanged",
      content,
      path: absolutePath,
      relativePath,
    });
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
  });
}

export function applyFilePlans(plans: FilePlan[]): void {
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
      `.${path.basename(plan.path)}.coordinator-${randomUUID()}`,
    );
    let descriptor: number | null = null;
    try {
      descriptor = openSync(temporaryPath, "wx", 0o644);
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

export function planFileDeletion(
  root: string,
  relativePath: string,
  owned: (content: string) => boolean,
): FilePlan {
  const absolutePath = safeGeneratedPath(root, relativePath);
  if (!existsSync(absolutePath)) {
    return registerPlan(root, {
      action: "unchanged",
      content: "",
      path: absolutePath,
      relativePath,
    });
  }
  const current = readFileSync(absolutePath, "utf8");
  return registerPlan(root, {
    action: owned(current) ? "delete" : "unchanged",
    content: current,
    path: absolutePath,
    relativePath,
  });
}

export function changedPlans(plans: FilePlan[]): FilePlan[] {
  return plans.filter((plan) => plan.action !== "unchanged");
}
