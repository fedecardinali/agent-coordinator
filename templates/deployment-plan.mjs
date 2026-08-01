import { appendFile, readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";

const ACTIVE_STATES = new Set([
  "requested",
  "pending",
  "queued",
  "waiting",
  "in_progress",
]);

function assertSha(value, label) {
  if (!/^[0-9a-f]{40}$/.test(value ?? "")) {
    throw new Error(`${label} must be a full Git commit SHA`);
  }
}

function parseBoolean(value) {
  return value === true || value === "true" || value === "1";
}

function outputKey(value) {
  return value.replaceAll("-", "_");
}

function branchMatches(pattern, branch) {
  const expression = `^${pattern
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replaceAll("*", ".*")}$`;
  return new RegExp(expression).test(branch);
}

export function resolveBranch(policy, coordinatorBranch) {
  if (!policy || policy.mode === "mirror") return coordinatorBranch;
  if (policy.mode === "fixed") return policy.name;
  const mapped = policy.branches?.[coordinatorBranch];
  if (mapped) return mapped;
  if (policy.fallback?.mode === "mirror") return coordinatorBranch;
  if (policy.fallback?.mode === "fixed") return policy.fallback.name;
  throw new Error(
    `No branch mapping exists for coordinator branch '${coordinatorBranch}'`,
  );
}

export async function githubRequest(path, token = process.env.GH_TOKEN) {
  if (!token) throw new Error("GH_TOKEN is required");
  const url = path.startsWith("https://") ? path : `https://api.github.com${path}`;
  const response = await fetch(url, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2026-03-10",
    },
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`GitHub API ${response.status} for ${path}: ${body}`);
  }
  return response.json();
}

export async function observeWorkflowRuns(component, request) {
  const response = await request(
    `/repos/${component.githubRepository}/actions/workflows/${encodeURIComponent(component.workflow)}/runs?per_page=100`,
  );
  const runs = Array.isArray(response.workflow_runs)
    ? response.workflow_runs.slice(0, 100)
    : [];
  const run = runs.find((candidate) => ACTIVE_STATES.has(candidate.status)) ?? runs[0];
  if (!run) return null;
  return {
    sha: run.head_sha,
    state: run.status === "completed" ? (run.conclusion ?? "unknown") : run.status,
    url: run.html_url ?? null,
  };
}

async function observeDeployment(component, request) {
  const environment = component.state.environment;
  const deployments = await request(
    `/repos/${component.githubRepository}/deployments?environment=${encodeURIComponent(environment)}&per_page=1`,
  );
  const deployment = deployments[0];
  if (!deployment) return null;
  const separator = deployment.statuses_url.includes("?") ? "&" : "?";
  const statuses = await request(`${deployment.statuses_url}${separator}per_page=1`);
  const status = statuses[0];
  return {
    sha: deployment.sha,
    state: status?.state ?? "unknown",
    url: status?.log_url ?? null,
  };
}

export function evaluateState(observed, desiredSha, { force = false } = {}) {
  assertSha(desiredSha, "desiredSha");
  if (!observed) {
    return {
      current: false,
      required: true,
      blocked: false,
      observedSha: null,
      observedStatus: "missing",
      observedUrl: null,
      reason: "no deployment history exists",
    };
  }
  if (ACTIVE_STATES.has(observed.state)) {
    const desiredIsRunning = observed.sha === desiredSha;
    return {
      current: false,
      required: false,
      blocked: !desiredIsRunning,
      observedSha: observed.sha ?? null,
      observedStatus: observed.state,
      observedUrl: observed.url ?? null,
      reason: desiredIsRunning
        ? "desired revision is already running"
        : "another revision is still running",
    };
  }
  if (!observed.state || observed.state === "unknown") {
    return {
      current: false,
      required: false,
      blocked: true,
      observedSha: observed.sha ?? null,
      observedStatus: "unknown",
      observedUrl: observed.url ?? null,
      reason: "latest deployment state is unknown",
    };
  }
  const current = observed.state === "success" && observed.sha === desiredSha;
  return {
    current: current && !force,
    required: force || !current,
    blocked: false,
    observedSha: observed.sha ?? null,
    observedStatus: observed.state,
    observedUrl: observed.url ?? null,
    reason: force
      ? "component force requested"
      : current
        ? "desired revision is already deployed"
        : observed.state === "success"
          ? "a different revision is deployed"
          : "latest deployment did not succeed",
  };
}

async function preferredRef(repository, desiredSha, ref, request) {
  const branches = await request(
    `/repos/${repository}/commits/${desiredSha}/branches-where-head`,
  );
  if (!branches.some((branch) => branch.name === ref)) {
    const available = branches.map((branch) => branch.name).join(", ") || "none";
    throw new Error(
      `${repository}@${desiredSha} is not the head of ${ref}; available heads: ${available}`,
    );
  }
  return ref;
}

function gitlinkSha(repositoryPath) {
  const output = execFileSync("git", ["ls-tree", "HEAD", repositoryPath], {
    encoding: "utf8",
  }).trim();
  const sha = output.split(/\s+/)[2];
  assertSha(sha, `gitlink ${repositoryPath}`);
  return sha;
}

export async function buildDeploymentPlan({
  config,
  environment,
  force = {},
  ref,
  refType,
  request = githubRequest,
}) {
  const environmentConfig = config.environments?.[environment];
  if (!environmentConfig) throw new Error(`Unknown environment: ${environment}`);
  if (!ref) throw new Error("A preferred branch ref is required");
  if (refType !== "branch") {
    throw new Error(
      `Deployment dispatch only accepts branch refs; received '${refType ?? "unknown"}'`,
    );
  }
  if (
    environmentConfig.allowedBranches?.length &&
    !environmentConfig.allowedBranches.some((pattern) => branchMatches(pattern, ref))
  ) {
    throw new Error(
      `${environment} does not accept branch '${ref}'. Allowed: ${environmentConfig.allowedBranches.join(", ")}`,
    );
  }

  const entries = await Promise.all(
    Object.entries(environmentConfig.components).map(async ([name, component]) => {
      const desiredSha = gitlinkSha(component.path);
      const observed =
        component.state.provider === "github-deployment"
          ? await observeDeployment(component, request)
          : await observeWorkflowRuns(component, request);
      const decision = evaluateState(observed, desiredSha, {
        force: parseBoolean(force[name]),
      });
      const desiredRef = resolveBranch(component.branch, ref);
      const dispatchRef = decision.required
        ? await preferredRef(component.githubRepository, desiredSha, desiredRef, request)
        : null;
      return [
        name,
        {
          ...component,
          desiredSha,
          ref: dispatchRef,
          ...decision,
        },
      ];
    }),
  );
  return {
    schemaVersion: 1,
    environment,
    components: Object.fromEntries(entries),
  };
}

async function writeGithubFiles(plan) {
  if (!process.env.GITHUB_OUTPUT) return;
  const outputs = [];
  for (const [name, component] of Object.entries(plan.components)) {
    const key = outputKey(name);
    outputs.push(`${key}_required=${component.required}`);
    outputs.push(`${key}_blocked=${component.blocked}`);
    outputs.push(`${key}_reason=${component.reason}`);
    outputs.push(`${key}_repository=${component.githubRepository}`);
    outputs.push(`${key}_workflow=${component.workflow}`);
    outputs.push(`${key}_ref=${component.ref ?? ""}`);
    outputs.push(`${key}_sha=${component.desiredSha}`);
    outputs.push(`${key}_dispatch_inputs=${JSON.stringify(component.dispatchInputs ?? {})}`);
  }
  await appendFile(process.env.GITHUB_OUTPUT, `${outputs.join("\n")}\n`);
  if (!process.env.GITHUB_STEP_SUMMARY) return;
  const rows = Object.entries(plan.components).map(([name, component]) => {
    const decision = component.blocked
      ? "blocked"
      : component.required
        ? "trigger"
        : component.current
          ? "skipped — current"
          : "skipped — running";
    const pipeline = component.observedUrl
      ? `[open](${component.observedUrl})`
      : "—";
    return `| ${name} | \`${component.desiredSha}\` | \`${component.observedSha ?? "none"}\` | ${component.observedStatus} | ${decision} | ${pipeline} |`;
  });
  await appendFile(
    process.env.GITHUB_STEP_SUMMARY,
    `## Deployment trigger plan\n\n| Component | Desired SHA | Observed SHA | Status | Decision | Pipeline |\n|---|---|---|---|---|---|\n${rows.join("\n")}\n`,
  );
}

async function main() {
  const configPath = process.argv[2];
  const environment = process.argv[3];
  if (!configPath || !environment) {
    throw new Error("Usage: deployment-plan.mjs <config.json> <environment>");
  }
  const config = JSON.parse(await readFile(configPath, "utf8"));
  const force = Object.fromEntries(
    Object.keys(config.environments[environment].components).map((name) => [
      name,
      process.env[`FORCE_${outputKey(name).toUpperCase()}`],
    ]),
  );
  const plan = await buildDeploymentPlan({
    config,
    environment,
    force,
    ref: process.env.PREFERRED_REF,
    refType: process.env.PREFERRED_REF_TYPE,
  });
  await writeGithubFiles(plan);
  process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
}

if (process.argv[1]?.endsWith("deployment-plan.mjs")) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
