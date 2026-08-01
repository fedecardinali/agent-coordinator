import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { parse } from "yaml";
import { coordinatorManifestSchema } from "../src/core/schema.js";
import {
  deploymentConfiguration,
  renderEnvironmentWorkflow,
} from "../src/ci/render.js";
import { synchronizeCi } from "../src/ci/sync.js";
import { temporaryDirectory } from "./helpers.js";

test("CI generator emits one skippable job per configured component", () => {
  const manifest = coordinatorManifestSchema.parse({
    schemaVersion: 1,
    name: "product",
    repositories: [
      { id: "backend", path: "api", url: "consultr-inc/api" },
      { id: "frontend", path: "web", url: "git@github.com:consultr-inc/web.git" },
    ],
    deployments: {
      tokenSecret: "SUBREPO_ACTIONS_TOKEN",
      environments: {
        staging: {
          githubEnvironment: "staging: blue # canary",
          allowedBranches: ["main"],
          components: {
            backend: {
              repository: "backend",
              workflow: "deploy.yml",
              state: { provider: "workflow-runs" },
            },
            frontend: {
              repository: "frontend",
              workflow: "deploy.yml",
              state: {
                provider: "github-deployment",
                environment: "staging",
              },
            },
          },
        },
      },
    },
  });
  const config = deploymentConfiguration(manifest) as any;
  assert.equal(
    config.environments.staging.components.frontend.githubRepository,
    "consultr-inc/web",
  );
  const workflow = renderEnvironmentWorkflow(manifest, "staging");
  assert.match(workflow, /trigger_backend:/);
  assert.match(workflow, /trigger_frontend:/);
  assert.match(workflow, /if: needs\.plan\.outputs\.backend_required == 'true'/);
  assert.doesNotMatch(workflow, /return_run_details/);
  assert.match(workflow, /blocked_backend:/);
  assert.match(workflow, /backend_blocked == 'true'/);
  assert.doesNotMatch(workflow, /aws|railway/i);
  const parsed = parse(workflow);
  assert.equal(parsed.jobs.trigger_backend.needs, "plan");
  assert.equal(parsed.jobs.plan.environment.name, "staging: blue # canary");
  assert.equal(parsed.jobs.trigger_backend.environment, "staging: blue # canary");
  assert.equal(
    parsed.jobs.plan.steps[2].env.PREFERRED_REF_TYPE,
    "${{ github.ref_type }}",
  );

  const actionlint = "/opt/homebrew/bin/actionlint";
  if (existsSync(actionlint)) {
    const temporary = temporaryDirectory("agent-coordinator-actionlint-");
    try {
      const workflowPath = path.join(temporary, "deploy.yml");
      writeFileSync(workflowPath, workflow);
      execFileSync(actionlint, [workflowPath]);
    } finally {
      rmSync(temporary, { recursive: true });
    }
  }
});

test("deployment planner distinguishes current, running, and blocked states", async () => {
  // @ts-expect-error The generated runtime is intentionally dependency-free JavaScript.
  const planner = await import("../templates/deployment-plan.mjs");
  const sha = "a".repeat(40);
  assert.equal(planner.evaluateState({ sha, state: "success" }, sha).current, true);
  assert.equal(planner.evaluateState({ sha, state: "in_progress" }, sha).required, false);
  assert.equal(planner.evaluateState({ sha, state: "requested" }, sha).required, false);
  assert.equal(
    planner.evaluateState({ sha: "b".repeat(40), state: "queued" }, sha).blocked,
    true,
  );
  assert.equal(planner.resolveBranch({ mode: "mirror" }, "feature/demo"), "feature/demo");
  assert.equal(
    planner.resolveBranch({ mode: "fixed", name: "main" }, "feature/demo"),
    "main",
  );
  assert.equal(
    planner.resolveBranch(
      {
        mode: "map",
        branches: { "feature/demo": "feature/api-demo" },
      },
      "feature/demo",
    ),
    "feature/api-demo",
  );
});

test("workflow observation scans 100 runs and prioritizes an active run", async () => {
  // @ts-expect-error The generated runtime is intentionally dependency-free JavaScript.
  const planner = await import("../templates/deployment-plan.mjs");
  const desiredSha = "a".repeat(40);
  const completedRuns = Array.from({ length: 99 }, (_, index) => ({
    head_sha: `${index.toString(16).padStart(40, "0")}`,
    status: "completed",
    conclusion: "success",
    html_url: `https://example.test/runs/${index}`,
  }));
  const activeRun = {
    head_sha: desiredSha,
    status: "requested",
    html_url: "https://example.test/runs/active",
  };

  const observed = await planner.observeWorkflowRuns(
    { githubRepository: "org/backend", workflow: "deploy.yml" },
    async (requestPath: string) => {
      assert.match(requestPath, /runs\?per_page=100$/);
      return { workflow_runs: [...completedRuns, activeRun] };
    },
  );

  assert.deepEqual(observed, {
    sha: desiredSha,
    state: "requested",
    url: "https://example.test/runs/active",
  });
  assert.equal(planner.evaluateState(observed, desiredSha).required, false);
});

test("deployment planning rejects tag dispatch refs before repository work", async () => {
  // @ts-expect-error The generated runtime is intentionally dependency-free JavaScript.
  const planner = await import("../templates/deployment-plan.mjs");

  await assert.rejects(
    planner.buildDeploymentPlan({
      config: {
        environments: {
          staging: {
            components: {},
          },
        },
      },
      environment: "staging",
      ref: "v1.2.3",
      refType: "tag",
      request: async () => {
        throw new Error("GitHub must not be queried for a tag dispatch");
      },
    }),
    /only accepts branch refs/,
  );
});

test("CI sync removes stale generated files but preserves manual workflows", (context) => {
  const root = temporaryDirectory("agent-coordinator-ci-cleanup-");
  context.after(() => rmSync(root, { recursive: true }));
  const base = {
    schemaVersion: 1 as const,
    name: "product",
    repositories: [{ id: "backend", path: "api", url: "consultr-inc/api" }],
  };
  const configured = coordinatorManifestSchema.parse({
    ...base,
    deployments: {
      environments: {
        staging: {
          githubEnvironment: "staging",
          components: {
            backend: {
              repository: "backend",
              workflow: "deploy.yml",
              state: { provider: "workflow-runs" },
            },
          },
        },
      },
    },
  });
  synchronizeCi(root, configured);
  const generatedWorkflow = path.join(
    root,
    ".github/workflows/coordinator-deploy-staging.yml",
  );
  const manualWorkflow = path.join(root, ".github/workflows/manual.yml");
  mkdirSync(path.dirname(manualWorkflow), { recursive: true });
  writeFileSync(manualWorkflow, "name: Manual\n");

  const removed = synchronizeCi(root, coordinatorManifestSchema.parse(base));
  assert.equal(removed.changed, true);
  assert.equal(existsSync(generatedWorkflow), false);
  assert.equal(existsSync(path.join(root, ".coordinator/deployments.json")), false);
  assert.equal(
    existsSync(path.join(root, ".coordinator/runtime/deployment-plan.mjs")),
    false,
  );
  assert.equal(existsSync(manualWorkflow), true);
});
