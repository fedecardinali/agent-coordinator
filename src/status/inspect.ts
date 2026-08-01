import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { runCommand } from "../core/command.js";
import type { CoordinatorManifest, Repository } from "../core/schema.js";
import { findGitCoordinator } from "../git/adapter.js";

export type Health = "ready" | "attention" | "blocked";

export interface RepositoryStatus {
  branch: string;
  health: Health;
  id: string;
  policy: string;
  readOnly: boolean;
  state: string;
}

export interface WorkspaceStatus {
  agents: {
    managed: boolean;
    skills: number;
    tools: string[];
  };
  branch: string;
  ci: {
    components: number;
    environments: number;
  };
  gitRuntime: boolean;
  health: Health;
  name: string;
  repositories: RepositoryStatus[];
  root: string;
  version: string;
}

function gitText(directory: string, argumentsList: string[]): string | null {
  const result = runCommand("git", ["-c", "core.hooksPath=/dev/null", "-C", directory, ...argumentsList], {
    allowFailure: true,
    env: { GIT_COORDINATOR_INTERNAL: "1" },
  });
  return result.status === 0 ? result.stdout : null;
}

function policyLabel(repository: Repository): string {
  if (repository.branch.mode === "fixed") return `fixed:${repository.branch.name}`;
  if (repository.branch.mode === "map") return "mapped";
  return "mirror";
}

function inspectRepository(
  root: string,
  repository: Repository,
  selection?: { branch: string; mode: "active" | "pinned" },
): RepositoryStatus {
  const readOnly = selection?.mode === "pinned" ||
    (!selection && repository.branch.readOnly);
  const policy = selection
    ? `${selection.mode}:${selection.branch}`
    : policyLabel(repository);
  const directory = path.join(root, repository.path);
  if (!existsSync(directory)) {
    return {
      id: repository.id,
      branch: "—",
      policy,
      readOnly,
      health: "blocked",
      state: "missing",
    };
  }
  const branch = gitText(directory, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  const dirty = gitText(directory, ["status", "--porcelain"]);
  const detached = !branch;
  return {
    id: repository.id,
    branch: branch ?? "detached",
    policy,
    readOnly,
    health: detached && !readOnly ? "attention" : "ready",
    state: dirty ? "modified" : readOnly ? "read-only" : "clean",
  };
}

export function inspectWorkspace(
  root: string,
  manifest: CoordinatorManifest,
  version: string,
): WorkspaceStatus {
  const repositories = manifest.repositories.map((repository) =>
    inspectRepository(
      root,
      repository,
      manifest.workspace?.selection[repository.id],
    ),
  );
  const rootBranch =
    gitText(root, ["symbolic-ref", "--quiet", "--short", "HEAD"]) ?? "unborn";
  const skillsDirectory = path.join(root, ".agents", "skills");
  const skills = existsSync(skillsDirectory)
    ? readdirSync(skillsDirectory, { withFileTypes: true }).filter(
        (entry) => entry.isDirectory() && existsSync(path.join(skillsDirectory, entry.name, "SKILL.md")),
      ).length
    : 0;
  const environments = Object.values(manifest.deployments?.environments ?? {});
  const health = repositories.some((repository) => repository.health === "blocked")
    ? "blocked"
    : repositories.some((repository) => repository.health === "attention") ||
        manifest.agents.manage === false
      ? "attention"
      : "ready";
  return {
    name: manifest.name,
    root,
    branch: rootBranch,
    repositories,
    agents: {
      managed: manifest.agents.manage !== false,
      tools: manifest.agents.tools,
      skills,
    },
    ci: {
      environments: environments.length,
      components: environments.reduce(
        (total, environment) => total + Object.keys(environment.components).length,
        0,
      ),
    },
    gitRuntime: findGitCoordinator(root) !== null,
    health,
    version,
  };
}

export function demoWorkspaceStatus(version: string): WorkspaceStatus {
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
        state: "clean",
      },
      {
        id: "frontend",
        branch: "feature/MIQ-8-sentry-feedback",
        policy: "mirror",
        readOnly: false,
        health: "ready",
        state: "clean",
      },
      {
        id: "infra",
        branch: "main",
        policy: "fixed:main",
        readOnly: true,
        health: "ready",
        state: "read-only",
      },
    ],
    agents: {
      managed: true,
      tools: ["Codex", "Claude", "Cursor", "OpenCode"],
      skills: 29,
    },
    ci: { environments: 2, components: 4 },
  };
}
