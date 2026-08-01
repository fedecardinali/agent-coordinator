import assert from "node:assert/strict";
import test from "node:test";
import { renderCodexAgent, renderRootAgents } from "../src/agents/renderers.js";
import { coordinatorManifestSchema } from "../src/core/schema.js";

test("generated agents honor branch-scoped active and pinned workspace modes", () => {
  const manifest = coordinatorManifestSchema.parse({
    schemaVersion: 2,
    name: "product",
    repositories: [{ id: "backend", path: "api", url: "org/api" }],
    workspace: {
      baseBranch: "main",
      mirrorActiveInLinkedWorktrees: true,
      selection: {
        backend: { branch: "$coordinator", mode: "active" },
      },
    },
  });

  const root = renderRootAgents(manifest);
  const agent = renderCodexAgent(manifest, manifest.repositories[0]!);
  assert.match(root, /workspace\.selection/);
  assert.match(root, /coordinator\.yaml/);
  assert.match(root, /Only repositories marked active/);
  assert.match(agent, /workspace\.selection\.backend/);
  assert.match(agent, /pinned, read-only, or absent/);
});
