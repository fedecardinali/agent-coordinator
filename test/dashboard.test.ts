import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import test from "node:test";
import { coordinatorManifestSchema } from "../src/core/schema.js";
import { demoWorkspaceStatus, inspectWorkspace } from "../src/status/inspect.js";
import { renderDashboard } from "../src/ui/dashboard.js";
import { temporaryDirectory } from "./helpers.js";

test("dashboard renders repositories, agents, and delivery in one view", () => {
  const dashboard = renderDashboard(demoWorkspaceStatus("0.1.0"), {
    color: false,
  });
  assert.match(dashboard, /Agent Coordinator · market-intel/);
  assert.match(dashboard, /backend\s+mirror/);
  assert.match(dashboard, /infra\s+fixed:main/);
  assert.match(dashboard, /Codex\s+Claude\s+Cursor\s+OpenCode/);
  assert.match(dashboard, /Git runtime ready/);
});

test("workspace status presents the inline branch selection", (context) => {
  const root = temporaryDirectory("agent-coordinator-status-");
  context.after(() => rmSync(root, { recursive: true }));
  const manifest = coordinatorManifestSchema.parse({
    schemaVersion: 2,
    name: "inline-status",
    repositories: [
      {
        id: "infra",
        path: "infra",
        url: "org/infra",
        branch: { mode: "fixed", name: "main", readOnly: true },
      },
    ],
    workspace: {
      baseBranch: "feature/local",
      selection: {
        infra: { branch: "$coordinator", mode: "active" },
      },
    },
  });

  const status = inspectWorkspace(root, manifest, "0.2.0");
  assert.equal(status.repositories[0]?.policy, "active:$coordinator");
  assert.equal(status.repositories[0]?.readOnly, false);
});
