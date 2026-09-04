import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  dailyUpdateCachePath,
  runDailyUpdatePrompt,
  shouldCheckForDailyUpdate,
  type DailyUpdateContext,
} from "../src/update/daily.js";
import type { UpdateStatus } from "../src/update/check.js";
import { temporaryDirectory } from "./helpers.js";

const NOW = new Date(2026, 8, 4, 10, 30);
const AVAILABLE: UpdateStatus = {
  current: "0.4.6",
  latest: "0.5.0",
  tag: "v0.5.0",
  updateAvailable: true,
  url: "https://github.com/fedecardinali/agent-coordinator/releases/tag/v0.5.0",
};

function interactiveContext(
  argv: readonly string[] = ["status"],
  environment: NodeJS.ProcessEnv = {},
): DailyUpdateContext {
  return { argv, environment, stdinIsTTY: true, stdoutIsTTY: true };
}

test("daily checks are limited to ordinary interactive commands", () => {
  assert.equal(shouldCheckForDailyUpdate(interactiveContext()), true);
  assert.equal(
    shouldCheckForDailyUpdate({ ...interactiveContext(), stdinIsTTY: false }),
    false,
  );
  for (const argv of [
    ["--json", "status"],
    ["--help"],
    ["-V"],
    ["completion", "zsh"],
    ["update"],
    ["update", "--apply"],
    ["install"],
    ["git", "uninstall"],
    ["git", "recover"],
  ]) {
    assert.equal(
      shouldCheckForDailyUpdate(interactiveContext(argv)),
      false,
      argv.join(" "),
    );
  }
  assert.equal(
    shouldCheckForDailyUpdate(interactiveContext(["status"], { CI: "true" })),
    false,
  );
});

test("declining records the day and prevents another check", async (context) => {
  const root = temporaryDirectory("agent-coordinator-daily-decline-");
  context.after(() => rmSync(root, { recursive: true }));
  const cachePath = path.join(root, "daily-update.json");
  let checks = 0;
  let prompts = 0;
  let applies = 0;
  const options = {
    apply: () => { applies += 1; },
    cachePath,
    check: async () => { checks += 1; return AVAILABLE; },
    confirmUpdate: async () => { prompts += 1; return false; },
    context: interactiveContext(),
    currentVersion: "0.4.6",
    now: () => NOW,
  };

  assert.equal(await runDailyUpdatePrompt(options), "declined");
  assert.equal(await runDailyUpdatePrompt(options), "skipped");
  assert.deepEqual({ checks, prompts, applies }, { checks: 1, prompts: 1, applies: 0 });
  assert.deepEqual(JSON.parse(readFileSync(cachePath, "utf8")), {
    lastAttemptDate: "2026-09-04",
    owner: "Agent Coordinator",
    schemaVersion: 1,
  });
});

test("failed checks are nonfatal and are not retried until the next day", async (context) => {
  const root = temporaryDirectory("agent-coordinator-daily-failure-");
  context.after(() => rmSync(root, { recursive: true }));
  const cachePath = path.join(root, "daily-update.json");
  let checks = 0;
  const options = {
    cachePath,
    check: async () => { checks += 1; throw new Error("offline"); },
    confirmUpdate: async () => true,
    context: interactiveContext(),
    currentVersion: "0.4.6",
    now: () => NOW,
  };

  assert.equal(await runDailyUpdatePrompt(options), "check-failed");
  assert.equal(await runDailyUpdatePrompt(options), "skipped");
  assert.equal(checks, 1);
});

test("an accepted update applies the checked tag only once", async (context) => {
  const root = temporaryDirectory("agent-coordinator-daily-apply-");
  context.after(() => rmSync(root, { recursive: true }));
  const applied: string[] = [];
  const options = {
    apply: (tag: string) => applied.push(tag),
    cachePath: path.join(root, "daily-update.json"),
    check: async () => AVAILABLE,
    confirmUpdate: async () => true,
    context: interactiveContext(),
    currentVersion: "0.4.6",
    now: () => NOW,
  };

  assert.equal(await runDailyUpdatePrompt(options), "applied");
  assert.equal(await runDailyUpdatePrompt(options), "skipped");
  assert.deepEqual(applied, ["v0.5.0"]);
});

test("an unrecognized cache is preserved and the home convention is reused", async (context) => {
  const root = temporaryDirectory("agent-coordinator-daily-corrupt-");
  context.after(() => rmSync(root, { recursive: true }));
  const cachePath = path.join(root, "cache", "daily-update.json");
  mkdirSync(path.dirname(cachePath), { recursive: true });
  writeFileSync(cachePath, "not json\n");

  assert.equal(
    dailyUpdateCachePath({ AGENT_COORDINATOR_HOME: root }),
    cachePath,
  );
  let checked = false;
  assert.equal(
    await runDailyUpdatePrompt({
      cachePath,
      check: async () => {
        checked = true;
        return { ...AVAILABLE, updateAvailable: false };
      },
      confirmUpdate: async () => { throw new Error("must not prompt"); },
      context: interactiveContext(),
      currentVersion: "0.4.6",
      now: () => NOW,
    }),
    "cache-unavailable",
  );
  assert.equal(checked, false);
  assert.equal(readFileSync(cachePath, "utf8"), "not json\n");
});

test("an unsafe or unwritable cache prevents the network attempt", async (context) => {
  const root = temporaryDirectory("agent-coordinator-daily-cache-");
  context.after(() => rmSync(root, { recursive: true }));
  const cachePath = path.join(root, "daily-update.json");
  mkdirSync(cachePath);
  let checked = false;

  assert.equal(
    await runDailyUpdatePrompt({
      cachePath,
      check: async () => { checked = true; return AVAILABLE; },
      confirmUpdate: async () => true,
      context: interactiveContext(),
      currentVersion: "0.4.6",
      now: () => NOW,
    }),
    "cache-unavailable",
  );
  assert.equal(checked, false);
});

test("a concurrent lock prevents a second daily check without clobbering state", async (context) => {
  const root = temporaryDirectory("agent-coordinator-daily-lock-");
  context.after(() => rmSync(root, { recursive: true }));
  const cachePath = path.join(root, "daily-update.json");
  const lockPath = `${cachePath}.lock`;
  writeFileSync(lockPath, "another invocation\n");
  let checked = false;

  assert.equal(
    await runDailyUpdatePrompt({
      cachePath,
      check: async () => { checked = true; return AVAILABLE; },
      confirmUpdate: async () => true,
      context: interactiveContext(),
      currentVersion: "0.4.6",
      now: () => NOW,
    }),
    "cache-unavailable",
  );
  assert.equal(checked, false);
  assert.equal(readFileSync(lockPath, "utf8"), "another invocation\n");
});
