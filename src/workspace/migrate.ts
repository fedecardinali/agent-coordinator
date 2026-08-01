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

interface LegacyWorkspaceManifest {
  baseBranch?: unknown;
  repositories?: unknown;
  schemaVersion?: unknown;
}

export interface LegacyWorkspaceMigration {
  embeddedWorkspacePath: string | null;
  manifest: CoordinatorManifest;
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

function inlineWorkspace(
  root: string,
  legacy: LegacyConfiguration,
  repositories: CoordinatorManifest["repositories"],
): {
  embeddedWorkspacePath: string;
  workspace: NonNullable<CoordinatorManifest["workspace"]>;
} | null {
  const settings = legacy.workspaceManifest;
  if (!settings || (settings.coordinatorToken ?? "$coordinator") !== "$coordinator") {
    return null;
  }
  if (
    typeof settings.path !== "string" ||
    !settings.path ||
    settings.path === "." ||
    path.isAbsolute(settings.path) ||
    settings.path.split(/[\\/]/).includes("..")
  ) {
    return null;
  }
  const normalizedWorkspacePath = path.posix.normalize(
    settings.path.replaceAll("\\", "/"),
  );
  if (
    ["coordinator.yaml", ".git-coordinator.json"].includes(
      normalizedWorkspacePath,
    )
  ) {
    throw new CoordinatorError(
      `Legacy workspaceManifest.path '${settings.path}' collides with a reserved coordinator file.`,
      "INVALID_LEGACY_CONFIGURATION",
    );
  }
  const workspacePath = path.join(root, settings.path);
  if (!existsSync(workspacePath)) return null;

  let parsed: LegacyWorkspaceManifest;
  try {
    parsed = JSON.parse(readFileSync(workspacePath, "utf8")) as LegacyWorkspaceManifest;
  } catch {
    return null;
  }
  if (
    parsed.schemaVersion !== 1 ||
    typeof parsed.baseBranch !== "string" ||
    !parsed.baseBranch ||
    !parsed.repositories ||
    typeof parsed.repositories !== "object" ||
    Array.isArray(parsed.repositories)
  ) {
    return null;
  }

  const entries = parsed.repositories as Record<string, unknown>;
  const expectedIds = repositories.map((repository) => repository.id).sort();
  const actualIds = Object.keys(entries).sort();
  if (
    expectedIds.length !== actualIds.length ||
    expectedIds.some((id, index) => id !== actualIds[index])
  ) {
    return null;
  }

  const selection: Record<string, { branch: string; mode: "active" | "pinned" }> = {};
  for (const repository of repositories) {
    const entry = entries[repository.id];
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
    const candidate = entry as Record<string, unknown>;
    if (
      Object.keys(candidate).sort().join(",") !== "branch,mode,path" ||
      candidate.path !== repository.path ||
      typeof candidate.branch !== "string" ||
      !candidate.branch ||
      !["active", "pinned"].includes(String(candidate.mode))
    ) {
      return null;
    }
    selection[repository.id] = {
      branch: candidate.branch,
      mode: candidate.mode as "active" | "pinned",
    };
  }

  return {
    embeddedWorkspacePath: settings.path,
    workspace: {
      baseBranch: parsed.baseBranch,
      coordinatorToken: "$coordinator",
      mirrorActiveInLinkedWorktrees:
        settings.mirrorActiveInLinkedWorktrees ?? false,
      selection,
    },
  };
}

export function migrateLegacyWorkspaceWithMetadata(
  rootInput: string,
): LegacyWorkspaceMigration {
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
  const repositories: CoordinatorManifest["repositories"] = legacy.repositories.map((repository) => {
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
  });
  const embedded = inlineWorkspace(root, legacy, repositories);
  const manifestInput = {
    schemaVersion: embedded || !legacy.workspaceManifest ? 2 : 1,
    name: slug(path.basename(root)),
    remote: legacy.remote ?? "origin",
    repositories,
    agents: {
      manage: false,
      tools: tools.length ? tools : ["codex"],
      maxParallel: 4,
      skillCollision: "namespace",
    },
  };
  const manifest = embedded
    ? { ...manifestInput, workspace: embedded.workspace }
    : legacy.workspaceManifest
      ? { ...manifestInput, workspaceManifest: legacy.workspaceManifest }
      : manifestInput;
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
  return {
    embeddedWorkspacePath: embedded?.embeddedWorkspacePath ?? null,
    manifest: validated.data,
  };
}

export function migrateLegacyWorkspace(rootInput: string): CoordinatorManifest {
  return migrateLegacyWorkspaceWithMetadata(rootInput).manifest;
}
