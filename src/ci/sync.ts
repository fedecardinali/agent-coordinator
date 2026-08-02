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
  renderDeploymentPlanner,
  renderEnvironmentWorkflow,
} from "./render.js";

export interface CiSyncResult {
  changed: boolean;
  files: FilePlan[];
}

function workflowOwned(content: string): boolean {
  return content.includes(CI_MARKER);
}

function plannerOwned(content: string): boolean {
  return content.includes("export async function buildDeploymentPlan");
}

function legacyDeploymentConfigurationOwned(content: string): boolean {
  try {
    const parsed: unknown = JSON.parse(content);
    return (
      typeof parsed === "object" &&
      parsed !== null &&
      "generatedBy" in parsed &&
      parsed.generatedBy === "agent-coordinator"
    );
  } catch {
    return false;
  }
}

function generatedCiPaths(root: string): string[] {
  const paths: string[] = [];
  for (const [relativePath, isOwned] of [
    [".coordinator/deployments.json", legacyDeploymentConfigurationOwned],
    [".coordinator/runtime/deployment-plan.mjs", plannerOwned],
  ] as const) {
    const absolutePath = path.join(root, relativePath);
    if (existsSync(absolutePath) && isOwned(readFileSync(absolutePath, "utf8"))) {
      paths.push(relativePath);
    }
  }
  const workflows = path.join(root, ".github", "workflows");
  if (existsSync(workflows)) {
    for (const entry of readdirSync(workflows, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const relativePath = path.posix.join(".github/workflows", entry.name);
      if (workflowOwned(readFileSync(path.join(root, relativePath), "utf8"))) {
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
          ".coordinator/runtime/deployment-plan.mjs",
          renderDeploymentPlanner(manifest)!,
          { force, owned: plannerOwned },
        ),
        ...Object.keys(manifest.deployments.environments).map((environment) =>
          planFile(
            root,
            `.github/workflows/coordinator-deploy-${environment}.yml`,
            renderEnvironmentWorkflow(manifest, environment),
            { force, owned: workflowOwned },
          ),
        ),
      ]
    : [];
  const desiredPaths = new Set(files.map((file) => file.relativePath));
  for (const stalePath of generatedCiPaths(root)) {
    if (!desiredPaths.has(stalePath)) {
      const isOwned =
        stalePath === ".coordinator/deployments.json"
          ? legacyDeploymentConfigurationOwned
          : stalePath === ".coordinator/runtime/deployment-plan.mjs"
            ? plannerOwned
            : workflowOwned;
      files.push(planFileDeletion(root, stalePath, isOwned));
    }
  }
  const changed = changedPlans(files).length > 0;
  if (!options.check) applyFilePlans(files);
  return { changed, files };
}
