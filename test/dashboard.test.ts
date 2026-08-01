import assert from "node:assert/strict";
import test from "node:test";
import { demoWorkspaceStatus } from "../src/status/inspect.js";
import { renderDashboard } from "../src/ui/dashboard.js";

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
