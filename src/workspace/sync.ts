import {
  applyFilePlans,
  changedPlans,
  planFileDeletion,
  type FilePlan,
} from "../core/files.js";
import type { CoordinatorManifest } from "../core/schema.js";
import { yamlNativeGitRuntimeActive } from "../git/adapter.js";
import { synchronizeAgents, type AgentSyncResult } from "../agents/sync.js";
import { synchronizeCi, type CiSyncResult } from "../ci/sync.js";
import {
  isOwnedGitConfiguration,
} from "../git/configuration.js";

export interface WorkspaceSyncResult {
  agents: AgentSyncResult;
  changed: boolean;
  ci: CiSyncResult;
  git: FilePlan;
}

export function synchronizeWorkspace(
  root: string,
  manifest: CoordinatorManifest,
  generatorVersion: string,
  options: { check?: boolean | undefined; force?: boolean | undefined } = {},
): WorkspaceSyncResult {
  const git = planFileDeletion(root, ".git-coordinator.json", (content) =>
    yamlNativeGitRuntimeActive(root) && isOwnedGitConfiguration(content),
  );
  const previewOptions = { ...options, check: true };
  const previewAgents = synchronizeAgents(
    root,
    manifest,
    generatorVersion,
    previewOptions,
  );
  const previewCi = synchronizeCi(root, manifest, previewOptions);
  if (options.check) {
    return {
      git,
      agents: previewAgents,
      ci: previewCi,
      changed:
        changedPlans([git]).length > 0 ||
        previewAgents.changed ||
        previewCi.changed,
    };
  }

  applyFilePlans([git]);
  const agents = synchronizeAgents(root, manifest, generatorVersion, options);
  const ci = synchronizeCi(root, manifest, options);
  return {
    git,
    agents,
    ci,
    changed:
      changedPlans([git]).length > 0 ||
      previewAgents.changed ||
      previewCi.changed,
  };
}
