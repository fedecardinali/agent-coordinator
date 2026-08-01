import type { CoordinatorManifest } from "../core/schema.js";

export interface GitCoordinatorConfiguration {
  schemaVersion: 2;
  generatedBy: "agent-coordinator";
  remote: string;
  repositories: Array<{
    id: string;
    path: string;
    branch: CoordinatorManifest["repositories"][number]["branch"];
  }>;
  workspaceManifest?: {
    path: string;
    coordinatorToken: string;
    mirrorActiveInLinkedWorktrees: boolean;
  };
}

export function gitConfiguration(
  manifest: CoordinatorManifest,
): GitCoordinatorConfiguration {
  const configuration: GitCoordinatorConfiguration = {
    schemaVersion: 2,
    generatedBy: "agent-coordinator",
    remote: manifest.remote,
    repositories: manifest.repositories.map((repository) => ({
      id: repository.id,
      path: repository.path,
      branch: repository.branch,
    })),
  };
  if (manifest.workspaceManifest) {
    configuration.workspaceManifest = manifest.workspaceManifest;
  }
  return configuration;
}

export function renderGitConfiguration(manifest: CoordinatorManifest): string {
  return `${JSON.stringify(gitConfiguration(manifest), null, 2)}\n`;
}

export function isOwnedGitConfiguration(content: string): boolean {
  try {
    const parsed = JSON.parse(content) as { generatedBy?: string };
    return parsed.generatedBy === "agent-coordinator";
  } catch {
    return false;
  }
}
