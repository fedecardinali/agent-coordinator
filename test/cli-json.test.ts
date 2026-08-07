import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import test from "node:test";
import { renderManifest } from "../src/core/manifest.js";
import { coordinatorManifestSchema } from "../src/core/schema.js";
import {
  createChildRemote,
  git,
  temporaryDirectory,
} from "./helpers.js";

const projectRoot = path.resolve(import.meta.dirname, "..");
const tsx = path.join(projectRoot, "node_modules", "tsx", "dist", "cli.mjs");
const cli = path.join(projectRoot, "src", "cli.ts");

function coordinator(
  argumentsList: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
) {
  return spawnSync(process.execPath, [tsx, cli, ...argumentsList], {
    cwd: options.cwd ?? projectRoot,
    encoding: "utf8",
    env: { ...process.env, ...options.env },
  });
}

test("skill-link check exposes an explicit non-mutating human and JSON plan", (context) => {
  const temporary = temporaryDirectory("agent-coordinator-cli-skill-links-");
  context.after(() => rmSync(temporary, { recursive: true }));
  const child = createChildRemote(temporary, "api", "api-contracts");
  const root = path.join(temporary, "workspace");
  mkdirSync(root);
  git(root, "init", "--initial-branch=main");
  git(root, "submodule", "add", child.remote, "api");
  const manifest = coordinatorManifestSchema.parse({
    schemaVersion: 2,
    name: "skill-link-cli",
    repositories: [
      {
        id: "api",
        path: "api",
        url: child.remote,
        agent: {
          skills: [{ source: ".agents/skills/api-contracts" }],
        },
      },
    ],
  });
  writeFileSync(path.join(root, "coordinator.yaml"), renderManifest(manifest));

  const human = coordinator(["agents", "check"], { cwd: root });
  assert.equal(human.status, 1, human.stderr || human.stdout);
  assert.equal(human.stderr, "");
  assert.match(human.stdout, /Skill link plan:/);
  assert.match(
    human.stdout,
    /would create link \.agents\/skills\/api-contracts -> \.\.\/\.\.\/api\/\.agents\/skills\/api-contracts/,
  );
  assert.equal(existsSync(path.join(root, ".agents")), false);
  assert.equal(existsSync(path.join(root, ".coordinator")), false);

  const json = coordinator(["--json", "agents", "check"], { cwd: root });
  assert.equal(json.status, 1, json.stderr || json.stdout);
  assert.equal(json.stderr, "");
  const parsed = JSON.parse(json.stdout) as {
    skillActions: Array<{
      action: string;
      linkTarget: string;
      name: string;
    }>;
  };
  assert.deepEqual(parsed.skillActions, [
    {
      action: "create-link",
      linkTarget: "../../api/.agents/skills/api-contracts",
      name: "api-contracts",
    },
  ]);
  assert.equal(existsSync(path.join(root, ".agents")), false);
  assert.equal(existsSync(path.join(root, ".coordinator")), false);
});

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

test("non-interactive init accepts GitHub and Bitbucket repositories together", (context) => {
  const root = temporaryDirectory("agent-coordinator-json-mixed-hosts-");
  context.after(() => rmSync(root, { recursive: true }));
  const executableDirectory = path.join(root, "bin");
  mkdirSync(executableDirectory);
  const fakeGit = path.join(executableDirectory, "git");
  writeFileSync(
    fakeGit,
    [
      "#!/bin/sh",
      "if [ \"$1\" = \"check-ref-format\" ]; then exit 0; fi",
      "if [ \"$1\" = \"ls-remote\" ]; then exit 2; fi",
      "echo \"unexpected git invocation: $*\" >&2",
      "exit 1",
      "",
    ].join("\n"),
  );
  chmodSync(fakeGit, 0o755);

  const workspace = path.join(root, "workspace");
  const result = coordinator(
    [
      "--json",
      "init",
      workspace,
      "--name",
      "mixed-hosts",
      "--repo",
      "backend=github:acme/api",
      "--repo",
      "frontend=bitbucket:acme/web",
      "--no-submodules",
      "--no-hooks",
      "--dry-run",
    ],
    { env: { PATH: `${executableDirectory}:${process.env.PATH ?? ""}` } },
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.stderr, "");
  const parsed = JSON.parse(result.stdout) as {
    directory: string;
    manifest: {
      repositories: Array<{ id: string; path: string; url: string }>;
    };
    result: { gitIntegration: { mode: string } };
  };
  assert.equal(parsed.directory, workspace);
  assert.deepEqual(parsed.manifest.repositories.map(({ id, path, url }) => ({
    id,
    path,
    url,
  })), [
    {
      id: "backend",
      path: "api",
      url: "git@github.com:acme/api.git",
    },
    {
      id: "frontend",
      path: "web",
      url: "git@bitbucket.org:acme/web.git",
    },
  ]);
  assert.equal(parsed.result.gitIntegration.mode, "dry-run");
});

test("resume loads an interrupted manifest without repository flags", (context) => {
  const root = temporaryDirectory("agent-coordinator-json-resume-");
  context.after(() => rmSync(root, { recursive: true }));
  const workspace = path.join(root, "workspace");
  mkdirSync(workspace);
  const manifest = coordinatorManifestSchema.parse({
    schemaVersion: 2,
    name: "interrupted-workspace",
    repositories: [
      {
        id: "backend",
        path: "api",
        url: "bitbucket:acme/api",
      },
    ],
  });
  writeFileSync(
    path.join(workspace, "coordinator.yaml"),
    renderManifest(manifest),
  );
  const executableDirectory = path.join(root, "bin");
  mkdirSync(executableDirectory);
  const fakeGit = path.join(executableDirectory, "git");
  writeFileSync(
    fakeGit,
    [
      "#!/bin/sh",
      "if [ \"$1\" = \"check-ref-format\" ]; then exit 0; fi",
      "if [ \"$1\" = \"ls-remote\" ]; then exit 2; fi",
      "echo \"unexpected git invocation: $*\" >&2",
      "exit 1",
      "",
    ].join("\n"),
  );
  chmodSync(fakeGit, 0o755);

  const result = coordinator(
    [
      "--json",
      "init",
      workspace,
      "--resume",
      "--discover-skills",
      "--no-submodules",
      "--no-hooks",
      "--dry-run",
    ],
    { env: { PATH: `${executableDirectory}:${process.env.PATH ?? ""}` } },
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const parsed = JSON.parse(result.stdout) as {
    discoverSkills: boolean;
    manifest: { name: string; repositories: Array<{ url: string }> };
    repairs: unknown[];
  };
  assert.equal(parsed.discoverSkills, true);
  assert.equal(parsed.manifest.name, "interrupted-workspace");
  assert.equal(
    parsed.manifest.repositories[0]!.url,
    "bitbucket:acme/api",
  );
  assert.deepEqual(parsed.repairs, []);
});
