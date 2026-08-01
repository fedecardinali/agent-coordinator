import assert from "node:assert/strict";
import test from "node:test";
import { parse } from "yaml";
import { coordinatorManifestSchema } from "../src/core/schema.js";
import { renderManifest } from "../src/core/manifest.js";

test("schemaVersion 2 keeps Git and local development in one manifest", () => {
  const manifest = coordinatorManifestSchema.parse({
    schemaVersion: 2,
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
    workspace: {
      baseBranch: "main",
      mirrorActiveInLinkedWorktrees: true,
      selection: {
        backend: { branch: "$coordinator", mode: "active" },
        infra: { branch: "main", mode: "pinned" },
      },
    },
    local: {
      compose: {
        projectDirectory: "api",
        files: ["api/compose.yaml"],
        override: "services:\n  app:\n    ports: !override\n      - '4000:3000'\n",
      },
    },
  });

  assert.equal(manifest.repositories[0]!.branch.readOnly, false);
  assert.equal(manifest.repositories[1]!.branch.readOnly, true);
  assert.equal(manifest.workspace?.coordinatorToken, "$coordinator");
  const rendered = parse(renderManifest(manifest));
  assert.deepEqual(rendered.repositories, manifest.repositories);
  assert.deepEqual(rendered.workspace, manifest.workspace);
  assert.equal(rendered.local.compose.override, manifest.local?.compose?.override);
});

test("inline workspace selection must contain exactly every repository id", () => {
  const missing = coordinatorManifestSchema.safeParse({
    schemaVersion: 2,
    name: "missing-selection",
    repositories: [
      { id: "backend", path: "api", url: "org/api" },
      { id: "frontend", path: "web", url: "org/web" },
    ],
    workspace: {
      baseBranch: "main",
      selection: {
        backend: { branch: "$coordinator", mode: "active" },
      },
    },
  });
  assert.equal(missing.success, false);
  if (!missing.success) assert.match(missing.error.message, /missing repository 'frontend'/);

  const unknown = coordinatorManifestSchema.safeParse({
    schemaVersion: 2,
    name: "unknown-selection",
    repositories: [{ id: "backend", path: "api", url: "org/api" }],
    workspace: {
      baseBranch: "main",
      selection: {
        backend: { branch: "$coordinator", mode: "active" },
        frontend: { branch: "main", mode: "pinned" },
      },
    },
  });
  assert.equal(unknown.success, false);
  if (!unknown.success) assert.match(unknown.error.message, /unknown repository 'frontend'/);
});

test("legacy workspaceManifest remains readable only in schemaVersion 1", () => {
  const legacy = coordinatorManifestSchema.safeParse({
    schemaVersion: 1,
    name: "legacy",
    repositories: [{ id: "backend", path: "api", url: "org/api" }],
    workspaceManifest: { path: "legacy.workspace.json" },
  });
  assert.equal(legacy.success, true);

  const mixed = coordinatorManifestSchema.safeParse({
    schemaVersion: 2,
    name: "mixed",
    repositories: [{ id: "backend", path: "api", url: "org/api" }],
    workspaceManifest: { path: "legacy.workspace.json" },
  });
  assert.equal(mixed.success, false);
  if (!mixed.success) assert.match(mixed.error.message, /legacy schemaVersion 1/);
});

test("local Compose paths must remain inside the workspace", () => {
  const result = coordinatorManifestSchema.safeParse({
    schemaVersion: 2,
    name: "unsafe-compose",
    repositories: [{ id: "backend", path: "api", url: "org/api" }],
    local: {
      compose: {
        projectDirectory: "api",
        files: ["../compose.yaml"],
        override: "services: {}\n",
      },
    },
  });
  assert.equal(result.success, false);
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
