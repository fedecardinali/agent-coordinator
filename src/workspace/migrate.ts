import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { runCommand } from "../core/command.js";
import { CoordinatorError } from "../core/errors.js";
import {
  coordinatorManifestSchema,
  type CoordinatorManifest,
} from "../core/schema.js";

interface LegacyConfiguration {
  remote?: string;
  repositories?: Array<{
    branch?: CoordinatorManifest["repositories"][number]["branch"];
    id?: string;
    path?: string;
  }>;
  schemaVersion?: number;
  workspaceManifest?: CoordinatorManifest["workspaceManifest"];
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function submoduleUrl(root: string, repositoryPath: string): string {
  const result = runCommand(
    "git",
    [
      "-C",
      root,
      "config",
      "-f",
      ".gitmodules",
      "--get-regexp",
      "^submodule\\..*\\.path$",
    ],
    { allowFailure: true },
  );
  const line = result.stdout
    .split("\n")
    .find((entry) => entry.trim().endsWith(` ${repositoryPath}`));
  if (!line) return repositoryPath;
  const key = line.split(/\s+/)[0]!.replace(/\.path$/, ".url");
  return runCommand("git", ["-C", root, "config", "-f", ".gitmodules", "--get", key], {
    allowFailure: true,
  }).stdout || repositoryPath;
}

export function migrateLegacyWorkspace(rootInput: string): CoordinatorManifest {
  const root = path.resolve(rootInput);
  const configurationPath = path.join(root, ".git-coordinator.json");
  if (!existsSync(configurationPath)) {
    throw new CoordinatorError(`${configurationPath} does not exist.`);
  }
  let legacy: LegacyConfiguration;
  try {
    legacy = JSON.parse(readFileSync(configurationPath, "utf8")) as LegacyConfiguration;
  } catch (error) {
    throw new CoordinatorError(
      `.git-coordinator.json is invalid: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (![1, 2].includes(legacy.schemaVersion ?? 0) || !legacy.repositories?.length) {
    throw new CoordinatorError("Unsupported Git Coordinator configuration.");
  }
  const tools = ([
    [".codex", "codex"],
    [".claude", "claude"],
    [".cursor", "cursor"],
    [".opencode", "opencode"],
  ] as const)
    .filter(([directory]) => existsSync(path.join(root, directory)))
    .map(([, tool]) => tool);
  const manifest: CoordinatorManifest = {
    schemaVersion: 1,
    name: slug(path.basename(root)),
    remote: legacy.remote ?? "origin",
    repositories: legacy.repositories.map((repository) => {
      if (!repository.id || !repository.path) {
        throw new CoordinatorError("Legacy repository entry is missing id or path.");
      }
      return {
        id: repository.id,
        path: repository.path,
        url: submoduleUrl(root, repository.path),
        branch:
          legacy.schemaVersion === 1
            ? { mode: "mirror" as const, readOnly: false }
            : (repository.branch ?? { mode: "mirror" as const, readOnly: false }),
        agent: { instructions: [], verify: [], skills: [] },
      };
    }),
    agents: {
      manage: false,
      tools: tools.length ? tools : ["codex"],
      maxParallel: 4,
      skillCollision: "namespace",
    },
  };
  if (legacy.workspaceManifest) manifest.workspaceManifest = legacy.workspaceManifest;
  const validated = coordinatorManifestSchema.safeParse(manifest);
  if (!validated.success) {
    const issues = validated.error.issues
      .map((issue) => `${issue.path.join(".") || "coordinator.yaml"}: ${issue.message}`)
      .join("\n");
    throw new CoordinatorError(
      `Legacy Git Coordinator configuration cannot be migrated without edits:\n${issues}`,
      "INVALID_LEGACY_CONFIGURATION",
    );
  }
  return validated.data;
}
