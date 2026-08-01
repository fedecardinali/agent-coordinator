import assert from "node:assert/strict";
import test from "node:test";
import { renderCodexAgent, renderRootAgents } from "../src/agents/renderers.js";
import { coordinatorManifestSchema } from "../src/core/schema.js";

test("generated agents honor branch-scoped active and pinned workspace modes", () => {
  const manifest = coordinatorManifestSchema.parse({
    schemaVersion: 1,
    name: "product",
    repositories: [{ id: "backend", path: "api", url: "org/api" }],
    workspaceManifest: {
      path: "product.workspace.json",
      mirrorActiveInLinkedWorktrees: true,
    },
  });

  const root = renderRootAgents(manifest);
  const agent = renderCodexAgent(manifest, manifest.repositories[0]!);
  assert.match(root, /product\.workspace\.json/);
  assert.match(root, /Only repositories marked active/);
  assert.match(agent, /confirm `backend` is active/);
  assert.match(agent, /pinned, read-only, or absent/);
});
