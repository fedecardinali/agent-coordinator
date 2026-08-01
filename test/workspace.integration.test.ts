import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import test from "node:test";
import { loadManifest } from "../src/core/manifest.js";
import { coordinatorManifestSchema } from "../src/core/schema.js";
import { initializeWorkspace } from "../src/workspace/initialize.js";
import { synchronizeWorkspace } from "../src/workspace/sync.js";
import { migrateLegacyWorkspace } from "../src/workspace/migrate.js";
import { createChildRemote, git, temporaryDirectory } from "./helpers.js";

test("init creates a Git-compatible workspace and materializes committed skills", (context) => {
  const temporary = temporaryDirectory();
  context.after(() => rmSync(temporary, { recursive: true }));
  const backend = createChildRemote(temporary, "backend", "api-testing");
  const frontend = createChildRemote(temporary, "frontend", "ui-testing");
  const root = path.join(temporary, "product-coordinator");

  const result = initializeWorkspace(
    root,
    {
      schemaVersion: 1,
      name: "product",
      remote: "origin",
      repositories: [
        {
          id: "backend",
          path: "backend",
          url: backend.remote,
          branch: { mode: "mirror", readOnly: false },
          agent: { instructions: [], verify: ["npm test"], skills: [] },
        },
        {
          id: "frontend",
          path: "frontend",
          url: frontend.remote,
          branch: { mode: "mirror", readOnly: false },
          agent: { instructions: [], verify: [], skills: [] },
        },
      ],
      agents: {
        tools: ["codex", "claude", "cursor", "opencode"],
        maxParallel: 2,
        skillCollision: "namespace",
      },
    },
    "0.1.0",
    { discoverSkills: true, installHooks: false },
  );

  assert.deepEqual(result.submodules, ["backend", "frontend"]);
  assert.ok(existsSync(path.join(root, ".git-coordinator.json")));
  assert.ok(existsSync(path.join(root, ".codex", "agents", "backend.toml")));
  assert.ok(existsSync(path.join(root, ".claude", "agents", "frontend.md")));
  assert.ok(existsSync(path.join(root, ".agents", "skills", "api-testing", "SKILL.md")));
  assert.ok(existsSync(path.join(root, ".agents", "skills", "ui-testing", "SKILL.md")));
  const loaded = loadManifest(root);
  assert.equal(loaded.manifest.repositories[0]!.agent.skills.length, 1);
  const check = synchronizeWorkspace(root, loaded.manifest, "0.1.0", { check: true });
  assert.equal(check.changed, false);
  const skillPath = path.join(root, ".agents", "skills", "api-testing", "SKILL.md");
  const skillInode = statSync(skillPath).ino;
  assert.equal(synchronizeWorkspace(root, loaded.manifest, "0.1.0").changed, false);
  assert.equal(statSync(skillPath).ino, skillInode);

  git(root, "add", ".");
  git(root, "commit", "-m", "Initialize coordinated workspace");
  assert.match(git(root, "submodule", "status"), /^[0-9a-f]{40} backend/m);

  const engine = path.resolve(import.meta.dirname, "../../git-coordinator/src/cli.mjs");
  if (existsSync(engine)) {
    execFileSync(process.execPath, [engine, "install", root]);
    const invariant = execFileSync(process.execPath, [engine, "check", root], {
      encoding: "utf8",
    });
    assert.match(invariant, /invariant OK/);
  }
});

test("legacy Git Coordinator configuration migrates without changing it", (context) => {
  const temporary = temporaryDirectory();
  context.after(() => rmSync(temporary, { recursive: true }));
  const child = createChildRemote(temporary, "api");
  const root = path.join(temporary, "legacy-product");
  initializeWorkspace(
    root,
    {
      schemaVersion: 1,
      name: "legacy-product",
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
      agents: { tools: ["codex"], maxParallel: 1, skillCollision: "namespace" },
    },
    "0.1.0",
    { installHooks: false },
  );
  const before = readFileSync(path.join(root, ".git-coordinator.json"), "utf8");
  const migrated = migrateLegacyWorkspace(root);
  assert.equal(migrated.repositories[0]!.id, "backend");
  assert.equal(migrated.repositories[0]!.url, child.remote);
  assert.equal(readFileSync(path.join(root, ".git-coordinator.json"), "utf8"), before);
});

test("agent sync removes stale generated adapters but preserves manual files", (context) => {
  const temporary = temporaryDirectory();
  context.after(() => rmSync(temporary, { recursive: true }));
  const child = createChildRemote(temporary, "api");
  const root = path.join(temporary, "agent-cleanup");
  const manifest = coordinatorManifestSchema.parse({
    schemaVersion: 1,
    name: "agent-cleanup",
    repositories: [{ id: "backend", path: "api", url: child.remote }],
    agents: {
      tools: ["codex", "claude", "cursor", "opencode"],
      maxParallel: 1,
      skillCollision: "namespace",
    },
  });
  initializeWorkspace(root, manifest, "0.1.0", { installHooks: false });
  const manualAgent = path.join(root, ".cursor/agents/manual.md");
  mkdirSync(path.dirname(manualAgent), { recursive: true });
  writeFileSync(manualAgent, "# Keep me\n");

  const codexOnly = coordinatorManifestSchema.parse({
    ...manifest,
    agents: { ...manifest.agents, tools: ["codex"] },
  });
  const result = synchronizeWorkspace(root, codexOnly, "0.1.0");
  assert.equal(result.changed, true);
  assert.equal(existsSync(path.join(root, ".claude/CLAUDE.md")), false);
  assert.equal(existsSync(path.join(root, ".cursor/agents/backend.md")), false);
  assert.equal(existsSync(path.join(root, ".opencode/agents/backend.md")), false);
  assert.equal(existsSync(manualAgent), true);
  assert.equal(
    synchronizeWorkspace(root, codexOnly, "0.1.0", { check: true }).changed,
    false,
  );
});

test("workspace sync preflights unmanaged files before writing other outputs", (context) => {
  const root = temporaryDirectory();
  context.after(() => rmSync(root, { recursive: true }));
  writeFileSync(path.join(root, "AGENTS.md"), "# User-owned guide\n");
  const manifest = coordinatorManifestSchema.parse({
    schemaVersion: 1,
    name: "preflight",
    repositories: [{ id: "backend", path: "api", url: "org/api" }],
  });

  assert.throws(
    () => synchronizeWorkspace(root, manifest, "0.1.0"),
    /Refusing to overwrite unmanaged file 'AGENTS\.md'/,
  );
  assert.equal(existsSync(path.join(root, ".git-coordinator.json")), false);
});
