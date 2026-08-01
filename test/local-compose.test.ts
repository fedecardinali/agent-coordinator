import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { renderManifest } from "../src/core/manifest.js";
import { coordinatorManifestSchema } from "../src/core/schema.js";
import { runLocalCompose } from "../src/local/compose.js";
import { temporaryDirectory } from "./helpers.js";

test("local Compose uses resolved base files and removes its temporary override", (context) => {
  const root = temporaryDirectory("agent-coordinator-compose-");
  context.after(() => rmSync(root, { recursive: true }));
  const bin = path.join(root, "bin");
  const app = path.join(root, "services", "api");
  const base = path.join(app, "compose.yaml");
  const log = path.join(root, "docker-arguments.txt");
  const captured = path.join(root, "captured-override.yaml");
  mkdirSync(bin);
  mkdirSync(app, { recursive: true });
  writeFileSync(base, "services: {}\n");
  const docker = path.join(bin, "docker");
  writeFileSync(
    docker,
    [
      "#!/bin/sh",
      "set -eu",
      ': > "$AGENT_COORDINATOR_COMPOSE_LOG"',
      "previous=",
      "last_file=",
      "for argument in \"$@\"; do",
      '  printf \'%s\\n\' "$argument" >> "$AGENT_COORDINATOR_COMPOSE_LOG"',
      '  if [ "$previous" = "-f" ]; then last_file=$argument; fi',
      "  previous=$argument",
      "done",
      'cp "$last_file" "$AGENT_COORDINATOR_COMPOSE_CAPTURE"',
    ].join("\n"),
    { mode: 0o755 },
  );
  chmodSync(docker, 0o755);

  const manifest = coordinatorManifestSchema.parse({
    schemaVersion: 2,
    name: "compose-product",
    repositories: [{ id: "backend", path: "services/api", url: "org/api" }],
    local: {
      compose: {
        projectDirectory: "services/api",
        files: ["services/api/compose.yaml"],
        override: "services:\n  app:\n    ports: !override\n      - '4000:3000'\n",
      },
    },
  });

  runLocalCompose(root, manifest, ["config", "--quiet"], {
    environment: {
      ...process.env,
      PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
      AGENT_COORDINATOR_COMPOSE_LOG: log,
      AGENT_COORDINATOR_COMPOSE_CAPTURE: captured,
    },
    stdio: "pipe",
  });

  const argumentsList = readFileSync(log, "utf8").trim().split("\n");
  assert.deepEqual(argumentsList.slice(0, 6), [
    "compose",
    "--project-directory",
    app,
    "-f",
    base,
    "-f",
  ]);
  assert.deepEqual(argumentsList.slice(-2), ["config", "--quiet"]);
  const temporaryOverride = argumentsList.at(-3)!;
  assert.equal(existsSync(temporaryOverride), false);
  assert.equal(readFileSync(captured, "utf8"), manifest.local?.compose?.override);
});

test("coordinator compose forwards options that belong to Docker", (context) => {
  const root = temporaryDirectory("agent-coordinator-compose-cli-");
  context.after(() => rmSync(root, { recursive: true }));
  const bin = path.join(root, "bin");
  const log = path.join(root, "docker-arguments.txt");
  mkdirSync(bin);
  writeFileSync(path.join(root, "compose.yaml"), "services: {}\n");
  const docker = path.join(bin, "docker");
  writeFileSync(
    docker,
    "#!/bin/sh\nprintf '%s\\n' \"$@\" > \"$AGENT_COORDINATOR_COMPOSE_LOG\"\n",
    { mode: 0o755 },
  );
  chmodSync(docker, 0o755);
  const manifest = coordinatorManifestSchema.parse({
    schemaVersion: 2,
    name: "compose-cli",
    repositories: [{ id: "backend", path: "api", url: "org/api" }],
    local: {
      compose: {
        projectDirectory: "api",
        files: ["compose.yaml"],
        override: "services: {}\n",
      },
    },
  });
  writeFileSync(path.join(root, "coordinator.yaml"), renderManifest(manifest));

  const projectRoot = path.resolve(import.meta.dirname, "..");
  const result = spawnSync(
    process.execPath,
    [
      path.join(projectRoot, "node_modules", "tsx", "dist", "cli.mjs"),
      path.join(projectRoot, "src", "cli.ts"),
      "compose",
      "config",
      "--quiet",
      "--profiles",
      "--help",
      "--version",
    ],
    {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
        AGENT_COORDINATOR_COMPOSE_LOG: log,
      },
    },
  );

  assert.equal(result.status, 0, result.stderr);
  const argumentsList = readFileSync(log, "utf8").trim().split("\n");
  assert.deepEqual(argumentsList.slice(-5), [
    "config",
    "--quiet",
    "--profiles",
    "--help",
    "--version",
  ]);

  writeFileSync(
    docker,
    "#!/bin/sh\nprintf '%s\\n' \"$@\" > \"$AGENT_COORDINATOR_COMPOSE_LOG\"\nexit 23\n",
    { mode: 0o755 },
  );
  const failure = spawnSync(
    process.execPath,
    [
      path.join(projectRoot, "node_modules", "tsx", "dist", "cli.mjs"),
      path.join(projectRoot, "src", "cli.ts"),
      "compose",
      "config",
    ],
    {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
        AGENT_COORDINATOR_COMPOSE_LOG: log,
      },
    },
  );
  assert.equal(failure.status, 23, failure.stderr);
  const failedArguments = readFileSync(log, "utf8").trim().split("\n");
  const lastFileFlag = failedArguments.lastIndexOf("-f");
  assert.ok(lastFileFlag >= 0);
  assert.equal(existsSync(failedArguments[lastFileFlag + 1]!), false);
});
