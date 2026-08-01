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
import { applyFilePlans, planFile } from "../src/core/files.js";
import { temporaryDirectory } from "./helpers.js";

test("generated files never follow workspace symlinks", (context) => {
  const temporary = temporaryDirectory("agent-coordinator-files-");
  context.after(() => rmSync(temporary, { recursive: true }));
  const root = path.join(temporary, "workspace");
  const outside = path.join(temporary, "outside");
  mkdirSync(root);
  mkdirSync(outside);
  symlinkSync(outside, path.join(root, ".codex"));

  assert.throws(
    () => planFile(root, ".codex/config.toml", "managed\n"),
    /is a symlink/,
  );
  assert.equal(existsSync(path.join(outside, "config.toml")), false);
});

test("generated files reject dangling symlink ancestors", (context) => {
  const root = temporaryDirectory("agent-coordinator-dangling-");
  context.after(() => rmSync(root, { recursive: true }));
  symlinkSync(path.join(root, "missing-target"), path.join(root, ".codex"));

  assert.throws(
    () => planFile(root, ".codex/config.toml", "managed\n"),
    /'.codex' is a symlink/,
  );
});

test("generated plans revalidate ancestors immediately before publication", (context) => {
  const temporary = temporaryDirectory("agent-coordinator-plan-swap-");
  context.after(() => rmSync(temporary, { recursive: true }));
  const root = path.join(temporary, "workspace");
  const outside = path.join(temporary, "outside");
  mkdirSync(path.join(root, ".codex"), { recursive: true });
  mkdirSync(outside);
  const plan = planFile(root, ".codex/config.toml", "managed\n");
  rmSync(path.join(root, ".codex"), { recursive: true });
  symlinkSync(outside, path.join(root, ".codex"), "dir");

  assert.throws(() => applyFilePlans([plan]), /'.codex' is a symlink/);
  assert.equal(existsSync(path.join(outside, "config.toml")), false);
});

test("atomic writes do not reuse a predictable temporary symlink", (context) => {
  const root = temporaryDirectory("agent-coordinator-atomic-");
  context.after(() => rmSync(root, { recursive: true }));
  const destination = path.join(root, "managed.txt");
  const outside = path.join(root, "outside.txt");
  const predictable = `${destination}.coordinator-new`;
  writeFileSync(outside, "outside\n");
  symlinkSync(outside, predictable);

  applyFilePlans([planFile(root, "managed.txt", "inside\n")]);

  assert.equal(readFileSync(destination, "utf8"), "inside\n");
  assert.equal(readFileSync(outside, "utf8"), "outside\n");
  assert.equal(existsSync(predictable), true);
});
