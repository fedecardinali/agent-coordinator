import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import test from "node:test";
import { CoordinatorError } from "../src/core/errors.js";
import { loadManifest } from "../src/core/manifest.js";
import { initializeWorkspace } from "../src/workspace/initialize.js";
import { migrateLegacyWorkspace } from "../src/workspace/migrate.js";
import { createChildRemote, temporaryDirectory } from "./helpers.js";

test("migration can adopt only Git while preserving existing agent files", (context) => {
  const temporary = temporaryDirectory("agent-coordinator-migrate-");
  context.after(() => rmSync(temporary, { recursive: true }));
  const child = createChildRemote(temporary, "api");
  const root = path.join(temporary, "legacy-coordinator");
  initializeWorkspace(
    root,
    {
      schemaVersion: 1,
      name: "legacy-coordinator",
      remote: "origin",
      repositories: [
        {
          id: "backend",
          path: "api",
          url: child.remote,
          branch: { mode: "mirror", readOnly: false },
          agent: { instructions: [], verify: [], skills: [] },
        },
      ],
      agents: {
        tools: ["codex"],
        maxParallel: 1,
        skillCollision: "namespace",
      },
    },
    "0.1.0",
    { installHooks: false },
  );
  const agentsPath = path.join(root, "AGENTS.md");
  const agentsBefore = readFileSync(agentsPath, "utf8");
  unlinkSync(path.join(root, "coordinator.yaml"));
  const gitConfigurationPath = path.join(root, ".git-coordinator.json");
  const legacy = JSON.parse(readFileSync(gitConfigurationPath, "utf8"));
  delete legacy.generatedBy;
  writeFileSync(gitConfigurationPath, `${JSON.stringify(legacy, null, 2)}\n`);

  const projectRoot = path.resolve(import.meta.dirname, "..");
  const tsx = path.join(projectRoot, "node_modules", "tsx", "dist", "cli.mjs");
  execFileSync(
    process.execPath,
    [
      tsx,
      path.join(projectRoot, "src", "cli.ts"),
      "--json",
      "migrate",
      root,
      "--write",
      "--adopt-git",
    ],
    { cwd: projectRoot, encoding: "utf8" },
  );

  const migrated = loadManifest(root).manifest;
  assert.equal(migrated.agents.manage, false);
  assert.equal(
    JSON.parse(readFileSync(gitConfigurationPath, "utf8")).generatedBy,
    "agent-coordinator",
  );
  assert.equal(readFileSync(agentsPath, "utf8"), agentsBefore);
});

test("migration refuses to write a manifest that the current schema cannot load", (context) => {
  const root = temporaryDirectory("agent-coordinator-invalid-migrate-");
  context.after(() => rmSync(root, { recursive: true }));
  writeFileSync(
    path.join(root, ".git-coordinator.json"),
    `${JSON.stringify({
      schemaVersion: 2,
      repositories: [
        {
          id: "api_core",
          path: "api",
          branch: { mode: "mirror", readOnly: false },
        },
      ],
    })}\n`,
  );

  assert.throws(
    () => migrateLegacyWorkspace(root),
    (error: unknown) => {
      assert.ok(error instanceof CoordinatorError);
      assert.equal(error.code, "INVALID_LEGACY_CONFIGURATION");
      assert.match(error.message, /repositories\.0\.id/);
      return true;
    },
  );
});
