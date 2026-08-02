import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import test from "node:test";
import { CoordinatorError } from "../src/core/errors.js";
import {
  applyUpdate,
  checkForUpdate,
  newer,
  parseReleaseTag,
} from "../src/update/check.js";
import { temporaryDirectory } from "./helpers.js";

function withEnvironment<T>(
  values: Record<string, string | undefined>,
  operation: () => T,
): T {
  const previous = new Map(
    Object.keys(values).map((key) => [key, process.env[key]]),
  );
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return operation();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function fakeExecutables(directory: string): void {
  mkdirSync(directory, { recursive: true });
  const gh = path.join(directory, "gh");
  writeFileSync(
    gh,
    `#!/usr/bin/env node
const [command, first] = process.argv.slice(2);
const mode = process.env.AGENT_COORDINATOR_UPDATE_FIXTURE;
if (command === "auth") {
  if (mode === "auth-failure") {
    process.stderr.write("not authenticated\\n");
    process.exit(1);
  }
  process.exit(0);
}
if (command !== "api") process.exit(2);
if (first === "repos/fedecardinali/agent-coordinator") {
  if (mode === "access-failure") {
    process.stderr.write("gh: Not Found (HTTP 404)\\n");
    process.exit(1);
  }
  process.stdout.write("fedecardinali/agent-coordinator\\n");
  process.exit(0);
}
if (mode === "no-release") {
  process.stderr.write("gh: Not Found (HTTP 404)\\n");
  process.exit(1);
}
if (mode === "invalid-tag") {
  process.stdout.write(JSON.stringify({ tag_name: "latest" }));
  process.exit(0);
}
process.stdout.write(JSON.stringify({
  tag_name: "v0.2.0",
  html_url: "https://github.com/fedecardinali/agent-coordinator/releases/tag/v0.2.0"
}));
`,
  );
  chmodSync(gh, 0o755);

  const npm = path.join(directory, "npm");
  writeFileSync(
    npm,
    `#!/usr/bin/env node
const { writeFileSync } = require("node:fs");
writeFileSync(process.env.AGENT_COORDINATOR_NPM_LOG, JSON.stringify(process.argv.slice(2)));
`,
  );
  chmodSync(npm, 0o755);

  const coordinator = path.join(directory, "coordinator");
  writeFileSync(
    coordinator,
    `#!/usr/bin/env node
const { writeFileSync } = require("node:fs");
writeFileSync(process.env.AGENT_COORDINATOR_INSTALL_LOG, JSON.stringify(process.argv.slice(2)));
`,
  );
  chmodSync(coordinator, 0o755);
}

test("release tags use strict semantic versions and precedence", () => {
  assert.equal(parseReleaseTag("v1.2.3").normalized, "1.2.3");
  assert.equal(newer("v1.2.3", "1.2.2"), true);
  assert.equal(newer("v1.2.3", "1.2.3"), false);
  assert.equal(newer("v1.2.3", "1.2.3-rc.1"), true);
  assert.throws(
    () => parseReleaseTag("latest"),
    (error: unknown) =>
      error instanceof CoordinatorError && error.code === "INVALID_RELEASE_TAG",
  );
});

test("private update checks distinguish access errors from an empty release list", (context) => {
  const temporary = temporaryDirectory("agent-coordinator-update-");
  context.after(() => rmSync(temporary, { recursive: true }));
  const binaries = path.join(temporary, "bin");
  fakeExecutables(binaries);
  const environment = {
    PATH: `${binaries}:${process.env.PATH ?? ""}`,
  };

  const available = withEnvironment(
    { ...environment, AGENT_COORDINATOR_UPDATE_FIXTURE: "release" },
    () => checkForUpdate("0.1.0"),
  );
  assert.equal(available.latest, "0.2.0");
  assert.equal(available.tag, "v0.2.0");
  assert.equal(available.updateAvailable, true);

  const empty = withEnvironment(
    { ...environment, AGENT_COORDINATOR_UPDATE_FIXTURE: "no-release" },
    () => checkForUpdate("0.1.0"),
  );
  assert.equal(empty.latest, null);
  assert.equal(empty.tag, null);

  assert.throws(
    () =>
      withEnvironment(
        { ...environment, AGENT_COORDINATOR_UPDATE_FIXTURE: "access-failure" },
        () => checkForUpdate("0.1.0"),
      ),
    (error: unknown) =>
      error instanceof CoordinatorError &&
      error.code === "UPDATE_REPOSITORY_UNAVAILABLE",
  );
});

test("updates install the exact validated release tag", (context) => {
  const temporary = temporaryDirectory("agent-coordinator-update-apply-");
  context.after(() => rmSync(temporary, { recursive: true }));
  const binaries = path.join(temporary, "bin");
  const log = path.join(temporary, "npm.json");
  const installLog = path.join(temporary, "coordinator.json");
  fakeExecutables(binaries);

  withEnvironment(
    {
      AGENT_COORDINATOR_NPM_LOG: log,
      AGENT_COORDINATOR_INSTALL_LOG: installLog,
      PATH: `${binaries}:${process.env.PATH ?? ""}`,
    },
    () => applyUpdate("0.2.0", { stdio: "pipe" }),
  );

  assert.deepEqual(JSON.parse(readFileSync(log, "utf8")), [
    "install",
    "--global",
    "git+https://github.com/fedecardinali/agent-coordinator.git#0.2.0",
  ]);
  assert.deepEqual(JSON.parse(readFileSync(installLog, "utf8")), ["install"]);
});
