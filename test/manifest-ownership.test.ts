import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import test from "node:test";
import { coordinatorManifestSchema } from "../src/core/schema.js";
import { initializeWorkspace } from "../src/workspace/initialize.js";
import { temporaryDirectory } from "./helpers.js";

test("reinitialization never overwrites a project-owned manifest implicitly", (context) => {
  const temporary = temporaryDirectory("agent-coordinator-manifest-");
  context.after(() => rmSync(temporary, { recursive: true }));
  const root = path.join(temporary, "workspace");
  const manifestPath = path.join(root, "coordinator.yaml");
  mkdirSync(root);
  writeFileSync(manifestPath, "# Project decision\ncustom: true\n");
  const manifest = coordinatorManifestSchema.parse({
    schemaVersion: 1,
    name: "workspace",
    repositories: [{ id: "backend", path: "api", url: "org/api" }],
  });

  assert.throws(
    () =>
      initializeWorkspace(root, manifest, "0.1.0", {
        addSubmodules: false,
        installHooks: false,
      }),
    /Refusing to overwrite unmanaged file 'coordinator\.yaml'/,
  );
  assert.equal(readFileSync(manifestPath, "utf8"), "# Project decision\ncustom: true\n");
  assert.equal(existsSync(path.join(root, ".git")), false);
});
