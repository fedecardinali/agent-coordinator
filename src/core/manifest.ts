import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parse, stringify } from "yaml";
import { CoordinatorError } from "./errors.js";
import { parseRepositoryIdentity } from "./repository-url.js";
import {
  coordinatorManifestSchema,
  type CoordinatorManifest,
} from "./schema.js";

export const MANIFEST_NAME = "coordinator.yaml";
export const GENERATED_MARKER = "Initialized by Agent Coordinator";

export interface LoadedManifest {
  manifest: CoordinatorManifest;
  path: string;
  root: string;
}

export function findWorkspaceRoot(start = process.cwd()): string | null {
  let current = path.resolve(start);
  while (true) {
    if (existsSync(path.join(current, MANIFEST_NAME))) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

export function loadManifest(start = process.cwd()): LoadedManifest {
  const root = findWorkspaceRoot(start);
  if (!root) {
    throw new CoordinatorError(
      `No ${MANIFEST_NAME} found from ${path.resolve(start)}. Run 'coordinator init'.`,
      "WORKSPACE_NOT_FOUND",
    );
  }
  const manifestPath = path.join(root, MANIFEST_NAME);
  let raw: unknown;
  try {
    raw = parse(readFileSync(manifestPath, "utf8"));
  } catch (error) {
    throw new CoordinatorError(
      `${MANIFEST_NAME} could not be parsed: ${error instanceof Error ? error.message : String(error)}`,
      "INVALID_MANIFEST",
    );
  }
  const result = coordinatorManifestSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join(".") || MANIFEST_NAME}: ${issue.message}`)
      .join("\n");
    throw new CoordinatorError(
      `${MANIFEST_NAME} is invalid:\n${issues}`,
      "INVALID_MANIFEST",
    );
  }
  return { manifest: result.data, path: manifestPath, root };
}

export function renderManifest(manifest: CoordinatorManifest): string {
  return `# ${GENERATED_MARKER}. This file is project-owned; generated outputs derive from it.\n${stringify(
    manifest,
    { lineWidth: 100 },
  )}`;
}

export function githubRepositoryName(url: string): string | null {
  const identity = parseRepositoryIdentity(url);
  return identity?.provider === "github"
    ? `${identity.namespace}/${identity.repository}`
    : null;
}
