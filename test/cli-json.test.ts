import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { temporaryDirectory } from "./helpers.js";

const projectRoot = path.resolve(import.meta.dirname, "..");
const tsx = path.join(projectRoot, "node_modules", "tsx", "dist", "cli.mjs");
const cli = path.join(projectRoot, "src", "cli.ts");

function coordinator(argumentsList: string[]) {
  return spawnSync(process.execPath, [tsx, cli, ...argumentsList], {
    cwd: projectRoot,
    encoding: "utf8",
  });
}

test("Commander parsing errors honor the global JSON contract", () => {
  const result = coordinator(["--json", "not-a-command"]);
  assert.equal(result.status, 1);
  assert.equal(result.stderr, "");
  const parsed = JSON.parse(result.stdout) as { code: string; error: string };
  assert.match(parsed.code, /^commander\./);
  assert.match(parsed.error, /^error:/);
});

test("migration preview is structured when JSON output is requested", (context) => {
  const root = temporaryDirectory("agent-coordinator-json-migrate-");
  context.after(() => rmSync(root, { recursive: true }));
  writeFileSync(
    path.join(root, ".git-coordinator.json"),
    `${JSON.stringify({
      schemaVersion: 2,
      remote: "origin",
      repositories: [
        {
          id: "backend",
          path: "api",
          branch: { mode: "mirror", readOnly: false },
        },
      ],
    })}\n`,
  );

  const result = coordinator(["--json", "migrate", root]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  const parsed = JSON.parse(result.stdout) as {
    manifest: { agents: { manage?: boolean } };
    root: string;
    yaml: string;
  };
  assert.equal(parsed.root, root);
  assert.equal(parsed.manifest.agents.manage, false);
  assert.match(parsed.yaml, /Initialized by Agent Coordinator/);
});
