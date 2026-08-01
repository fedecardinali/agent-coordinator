import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import test from "node:test";
import { synchronizeSkills } from "../src/agents/skills.js";
import { CoordinatorError } from "../src/core/errors.js";
import { coordinatorManifestSchema } from "../src/core/schema.js";
import { git, temporaryDirectory } from "./helpers.js";

function emptyManifest() {
  return coordinatorManifestSchema.parse({
    schemaVersion: 1,
    name: "skill-safety",
    repositories: [
      {
        id: "api",
        path: "api",
        url: "https://example.test/api.git",
        agent: { skills: [] },
      },
    ],
  });
}

test("skill destinations never follow workspace symlinks", (context) => {
  const temporary = temporaryDirectory("agent-coordinator-skill-target-");
  context.after(() => rmSync(temporary, { recursive: true }));
  const root = path.join(temporary, "workspace");
  const outside = path.join(temporary, "outside");
  mkdirSync(root);
  mkdirSync(outside);
  git(root, "init", "--initial-branch=main");
  symlinkSync(outside, path.join(root, ".agents"), "dir");

  assert.throws(
    () => synchronizeSkills(root, emptyManifest(), "0.1.0"),
    /'.agents' is a symlink/,
  );
  assert.equal(existsSync(path.join(outside, "skills")), false);
});

test("skill synchronization refuses an unmanaged lock", (context) => {
  const root = temporaryDirectory("agent-coordinator-skill-lock-");
  context.after(() => rmSync(root, { recursive: true }));
  git(root, "init", "--initial-branch=main");
  mkdirSync(path.join(root, ".coordinator"));
  const lockPath = path.join(root, ".coordinator", "agents.lock.json");
  writeFileSync(lockPath, '{"owner":"project"}\n');

  assert.throws(
    () => synchronizeSkills(root, emptyManifest(), "0.1.0"),
    (error: unknown) => {
      assert.ok(error instanceof CoordinatorError);
      assert.equal(error.code, "UNMANAGED_FILE");
      return true;
    },
  );
  assert.equal(readFileSync(lockPath, "utf8"), '{"owner":"project"}\n');
});
