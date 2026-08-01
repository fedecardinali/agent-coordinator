import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { coordinatorManifestSchema } from "../src/core/schema.js";
import { runDoctor } from "../src/doctor/check.js";
import { initializeWorkspace } from "../src/workspace/initialize.js";
import { createChildRemote, git, temporaryDirectory } from "./helpers.js";

test("doctor accepts a clean first submodule whose SHA starts with a digit", (context) => {
  const temporary = temporaryDirectory("agent-coordinator-doctor-");
  context.after(() => rmSync(temporary, { recursive: true }));
  const child = createChildRemote(temporary, "api");
  const root = path.join(temporary, "product-coordinator");
  const manifest = coordinatorManifestSchema.parse({
    schemaVersion: 1,
    name: "product-coordinator",
    repositories: [
      {
        id: "backend",
        path: "api",
        url: child.remote,
      },
    ],
    agents: {
      manage: false,
      tools: ["codex"],
      maxParallel: 1,
      skillCollision: "namespace",
    },
  });

  initializeWorkspace(root, manifest, "0.1.3", { installHooks: false });
  git(root, "add", ".");
  git(root, "commit", "-m", "Initialize coordinator");

  const result = runDoctor(root, manifest, "0.1.3");
  const gitlinks = result.checks.find((item) => item.label === "Gitlinks");

  assert.deepEqual(gitlinks, {
    label: "Gitlinks",
    detail: "all initialized submodules match their gitlinks",
    status: "pass",
  });
});
