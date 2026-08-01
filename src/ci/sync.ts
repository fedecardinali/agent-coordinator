import {
  applyFilePlans,
  changedPlans,
  planFile,
  planFileDeletion,
  type FilePlan,
} from "../core/files.js";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import type { CoordinatorManifest } from "../core/schema.js";
import {
  CI_MARKER,
  loadPlannerTemplate,
  renderDeploymentConfiguration,
  renderEnvironmentWorkflow,
} from "./render.js";

export interface CiSyncResult {
  changed: boolean;
  files: FilePlan[];
}

function owned(content: string): boolean {
  return (
    content.includes(CI_MARKER) ||
    content.includes('"generatedBy": "agent-coordinator"') ||
    content.includes("export async function buildDeploymentPlan")
  );
}

function generatedCiPaths(root: string): string[] {
  const paths: string[] = [];
  for (const relativePath of [
    ".coordinator/deployments.json",
    ".coordinator/runtime/deployment-plan.mjs",
  ]) {
    const absolutePath = path.join(root, relativePath);
    if (existsSync(absolutePath) && owned(readFileSync(absolutePath, "utf8"))) {
      paths.push(relativePath);
    }
  }
  const workflows = path.join(root, ".github", "workflows");
  if (existsSync(workflows)) {
    for (const entry of readdirSync(workflows, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const relativePath = path.posix.join(".github/workflows", entry.name);
      if (owned(readFileSync(path.join(root, relativePath), "utf8"))) {
        paths.push(relativePath);
      }
    }
  }
  return paths.sort();
}

export function synchronizeCi(
  root: string,
  manifest: CoordinatorManifest,
  options: { check?: boolean | undefined; force?: boolean | undefined } = {},
): CiSyncResult {
  const force = options.force ?? false;
  const files: FilePlan[] = manifest.deployments
    ? [
        planFile(
          root,
          ".coordinator/deployments.json",
          renderDeploymentConfiguration(manifest)!,
          { force, owned },
        ),
        planFile(
          root,
          ".coordinator/runtime/deployment-plan.mjs",
          loadPlannerTemplate(),
          { force, owned: (content) => content.includes("buildDeploymentPlan") },
        ),
        ...Object.keys(manifest.deployments.environments).map((environment) =>
          planFile(
            root,
            `.github/workflows/coordinator-deploy-${environment}.yml`,
            renderEnvironmentWorkflow(manifest, environment),
            { force, owned },
          ),
        ),
      ]
    : [];
  const desiredPaths = new Set(files.map((file) => file.relativePath));
  for (const stalePath of generatedCiPaths(root)) {
    if (!desiredPaths.has(stalePath)) {
      files.push(planFileDeletion(root, stalePath, owned));
    }
  }
  const changed = changedPlans(files).length > 0;
  if (!options.check) applyFilePlans(files);
  return { changed, files };
}
