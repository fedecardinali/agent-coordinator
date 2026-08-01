import assert from "node:assert/strict";
import test from "node:test";
import { parse } from "yaml";
import { renderGitConfiguration } from "../src/git/configuration.js";
import { coordinatorManifestSchema } from "../src/core/schema.js";
import { renderManifest } from "../src/core/manifest.js";

test("one manifest renders the compatible Git Coordinator contract", () => {
  const manifest = coordinatorManifestSchema.parse({
    schemaVersion: 1,
    name: "example-workspace",
    repositories: [
      {
        id: "backend",
        path: "api",
        url: "org/api",
        branch: { mode: "mirror" },
      },
      {
        id: "infra",
        path: "infra",
        url: "org/infra",
        branch: { mode: "fixed", name: "main" },
      },
    ],
  });

  assert.equal(manifest.repositories[0]!.branch.readOnly, false);
  assert.equal(manifest.repositories[1]!.branch.readOnly, true);
  const git = JSON.parse(renderGitConfiguration(manifest));
  assert.equal(git.schemaVersion, 2);
  assert.equal(git.generatedBy, "agent-coordinator");
  assert.deepEqual(git.repositories[1].branch, {
    mode: "fixed",
    name: "main",
    readOnly: true,
  });
  assert.deepEqual(parse(renderManifest(manifest)).repositories, manifest.repositories);
});

test("deployment components must reference declared repositories", () => {
  const result = coordinatorManifestSchema.safeParse({
    schemaVersion: 1,
    name: "broken",
    repositories: [{ id: "backend", path: "api", url: "org/api" }],
    deployments: {
      environments: {
        staging: {
          githubEnvironment: "staging",
          components: {
            frontend: {
              repository: "frontend",
              workflow: "deploy.yml",
              state: { provider: "workflow-runs" },
            },
          },
        },
      },
    },
  });
  assert.equal(result.success, false);
  if (!result.success) assert.match(result.error.message, /unknown repository 'frontend'/);
});

test("deployment names cannot escape generated workflow paths", () => {
  const result = coordinatorManifestSchema.safeParse({
    schemaVersion: 1,
    name: "safe",
    repositories: [{ id: "backend", path: "api", url: "org/api" }],
    deployments: {
      environments: {
        "../outside": {
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
  assert.equal(result.success, false);
});

test("resolved repository agent names must be unique", () => {
  const result = coordinatorManifestSchema.safeParse({
    schemaVersion: 1,
    name: "duplicate-agents",
    repositories: [
      { id: "frontend", path: "web", url: "org/web" },
      {
        id: "backend",
        path: "api",
        url: "org/api",
        agent: { name: "frontend" },
      },
    ],
  });

  assert.equal(result.success, false);
  if (!result.success) {
    assert.match(result.error.message, /duplicate resolved agent name 'frontend'/);
  }
});

test("mapped branch policies require at least one mapping", () => {
  const result = coordinatorManifestSchema.safeParse({
    schemaVersion: 1,
    name: "empty-map",
    repositories: [
      {
        id: "backend",
        path: "api",
        url: "org/api",
        branch: { mode: "map", branches: {} },
      },
    ],
  });

  assert.equal(result.success, false);
  if (!result.success) assert.match(result.error.message, /branch mapping/);
});

test("deployment collections cannot be empty", () => {
  const emptyEnvironments = coordinatorManifestSchema.safeParse({
    schemaVersion: 1,
    name: "empty-environments",
    repositories: [{ id: "backend", path: "api", url: "org/api" }],
    deployments: { environments: {} },
  });
  assert.equal(emptyEnvironments.success, false);

  const emptyComponents = coordinatorManifestSchema.safeParse({
    schemaVersion: 1,
    name: "empty-components",
    repositories: [{ id: "backend", path: "api", url: "org/api" }],
    deployments: {
      environments: {
        staging: {
          githubEnvironment: "staging",
          components: {},
        },
      },
    },
  });
  assert.equal(emptyComponents.success, false);
});

test("obsolete deployment triggerMode is rejected", () => {
  const result = coordinatorManifestSchema.safeParse({
    schemaVersion: 1,
    name: "obsolete-trigger-mode",
    repositories: [{ id: "backend", path: "api", url: "org/api" }],
    deployments: {
      environments: {
        staging: {
          githubEnvironment: "staging",
          components: {
            backend: {
              repository: "backend",
              workflow: "deploy.yml",
              state: { provider: "workflow-runs" },
              triggerMode: "push-or-dispatch",
            },
          },
        },
      },
    },
  });

  assert.equal(result.success, false);
  if (!result.success) assert.match(result.error.message, /triggerMode/);
});
