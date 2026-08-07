import assert from "node:assert/strict";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { renderRootAgents } from "../src/agents/renderers.js";
import { coordinatorManifestSchema } from "../src/core/schema.js";
import { inspectWorkspace } from "../src/status/inspect.js";
import { git, temporaryDirectory } from "./helpers.js";

function manifest(root: string) {
  return coordinatorManifestSchema.parse({
    schemaVersion: 1,
    name: "linked-skills",
    repositories: [
      {
        id: "api",
        path: "api",
        url: path.join(root, "api.git"),
        agent: { skills: [{ source: ".agents/skills/api-contracts" }] },
      },
    ],
    agents: {
      tools: ["codex"],
      maxParallel: 1,
      skillCollision: "namespace",
    },
  });
}

test("workspace status counts linked skills with a reachable SKILL.md", (context) => {
  const root = temporaryDirectory("agent-coordinator-status-skill-links-");
  context.after(() => rmSync(root, { recursive: true }));
  const external = temporaryDirectory("agent-coordinator-status-external-skill-");
  context.after(() => rmSync(external, { recursive: true }));
  git(root, "init", "--initial-branch=main");
  const source = path.join(
    root,
    "api",
    ".agents",
    "skills",
    "api-contracts",
  );
  mkdirSync(source, { recursive: true });
  writeFileSync(
    path.join(source, "SKILL.md"),
    "---\nname: api-contracts\ndescription: fixture\n---\n",
  );
  const registry = path.join(root, ".agents", "skills");
  mkdirSync(registry, { recursive: true });
  symlinkSync(
    path.relative(registry, source),
    path.join(registry, "api-contracts"),
    "dir",
  );
  symlinkSync(
    "../../api/.agents/skills/missing",
    path.join(registry, "dangling"),
    "dir",
  );
  writeFileSync(
    path.join(external, "SKILL.md"),
    "---\nname: external\ndescription: external fixture\n---\n",
  );
  symlinkSync(external, path.join(registry, "external"), "dir");

  const status = inspectWorkspace(root, manifest(root), "0.4.0");

  assert.equal(status.agents.skills, 1);
});

test("generated root guidance describes linked skills instead of copies", () => {
  const rendered = renderRootAgents(manifest("/tmp/linked-skills-fixture"));

  assert.match(rendered, /Linked skills live at/);
  assert.match(rendered, /relative symlink/);
  assert.match(rendered, /pinned child checkout/);
  assert.doesNotMatch(rendered, /Materialized skills|generated copies/);
});
