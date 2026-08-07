import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  discoverSkillSources,
  synchronizeSkills,
} from "../src/agents/skills.js";
import { CoordinatorError } from "../src/core/errors.js";
import { coordinatorManifestSchema } from "../src/core/schema.js";
import { git, REAL_GIT, temporaryDirectory } from "./helpers.js";

function initializeRepository(directory: string): void {
  mkdirSync(directory, { recursive: true });
  execFileSync(REAL_GIT, ["init", "--initial-branch=main", directory]);
}

function cloneBare(source: string, destination: string): void {
  execFileSync(REAL_GIT, ["clone", "--bare", source, destination]);
}

function writeSkill(directory: string, name: string, body: string): void {
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    path.join(directory, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${name} fixture.\n---\n\n# ${name}\n\n${body}\n`,
  );
}

function assertCoordinatorError(
  operation: () => unknown,
  code: string,
  message: RegExp,
): void {
  assert.throws(operation, (error: unknown) => {
    assert.ok(error instanceof CoordinatorError);
    assert.equal(error.code, code);
    assert.match(error.message, message);
    return true;
  });
}

function assertRelativeSkillLink(
  root: string,
  name: string,
  sourceWorkspacePath: string,
): string {
  const destination = path.join(root, ".agents", "skills", name);
  assert.equal(lstatSync(destination).isSymbolicLink(), true);
  const linkTarget = readlinkSync(destination);
  assert.equal(path.isAbsolute(linkTarget), false);
  assert.equal(
    linkTarget,
    path.posix.relative(
      ".agents/skills",
      sourceWorkspacePath.split(path.sep).join("/"),
    ),
  );
  assert.equal(
    path.resolve(path.dirname(destination), linkTarget),
    path.resolve(root, sourceWorkspacePath),
  );
  return linkTarget;
}

test("skill discovery preserves logical exports while returning safe canonical paths", (context) => {
  const temporary = temporaryDirectory("agent-coordinator-skill-discovery-");
  context.after(() => rmSync(temporary, { recursive: true }));
  const repository = path.join(temporary, "repository");
  const external = path.join(temporary, "external");
  const canonicalSkill = path.join(
    repository,
    "vendor",
    "runtime",
    "skills",
    "demo",
  );
  const canonicalFlow = path.join(
    repository,
    "vendor",
    "runtime",
    "flows",
    "review",
  );
  initializeRepository(repository);
  writeSkill(canonicalSkill, "demo", "canonical export");
  writeSkill(canonicalFlow, "review", "canonical flow export");
  mkdirSync(path.join(repository, ".agents"), { recursive: true });
  symlinkSync(
    path.join("..", "vendor", "runtime", "skills"),
    path.join(repository, ".agents", "skills"),
    "dir",
  );
  symlinkSync(
    path.join("..", "vendor", "runtime", "flows"),
    path.join(repository, ".agents", "flows"),
    "dir",
  );
  writeSkill(path.join(external, "escape"), "escape", "external export");
  symlinkSync(external, path.join(repository, ".agents", "external"), "dir");

  assert.deepEqual(discoverSkillSources(repository), [
    { kind: "flow", source: "vendor/runtime/flows/review" },
    { kind: "skill", source: "vendor/runtime/skills/demo" },
  ]);
});

test("skills follow recursive coordinator gitlinks and reject dirty or mismatched checkouts", (context) => {
  const temporary = temporaryDirectory("agent-coordinator-skill-pinning-");
  context.after(() => rmSync(temporary, { recursive: true }));

  const nestedSource = path.join(temporary, "shared-source");
  const nestedRemote = path.join(temporary, "shared.git");
  const nestedSkillSource = path.join(
    nestedSource,
    ".agents",
    "skills",
    "nested-contracts",
  );
  initializeRepository(nestedSource);
  writeSkill(nestedSkillSource, "nested-contracts", "nested-v1");
  git(nestedSource, "add", ".");
  git(nestedSource, "commit", "-m", "Add nested skill");
  cloneBare(nestedSource, nestedRemote);

  const childSource = path.join(temporary, "api-source");
  const childRemote = path.join(temporary, "api.git");
  initializeRepository(childSource);
  writeSkill(
    path.join(childSource, ".agents", "skills", "api-contracts"),
    "api-contracts",
    "api-v1",
  );
  git(childSource, "submodule", "add", nestedRemote, "vendor/shared");
  git(childSource, "add", ".");
  git(childSource, "commit", "-m", "Add top-level and nested skills");
  cloneBare(childSource, childRemote);

  const root = path.join(temporary, "coordinator");
  initializeRepository(root);
  git(root, "submodule", "add", childRemote, "api");
  git(root, "submodule", "update", "--init", "--recursive");

  const manifest = coordinatorManifestSchema.parse({
    schemaVersion: 1,
    name: "skill-pinning",
    repositories: [
      {
        id: "api",
        path: "api",
        url: childRemote,
        agent: {
          instructions: [],
          verify: [],
          skills: [
            { source: ".agents/skills/api-contracts" },
            { source: "vendor/shared/.agents/skills/nested-contracts" },
          ],
        },
      },
    ],
    agents: { tools: ["codex"], maxParallel: 1, skillCollision: "namespace" },
  });

  const first = synchronizeSkills(root, manifest, "0.1.0");
  assert.equal(first.changed, true);
  const topLevelLinkTarget = assertRelativeSkillLink(
    root,
    "api-contracts",
    "api/.agents/skills/api-contracts",
  );
  const nestedLinkTarget = assertRelativeSkillLink(
    root,
    "nested-contracts",
    "api/vendor/shared/.agents/skills/nested-contracts",
  );
  assert.match(
    readFileSync(
      path.join(root, ".agents", "skills", "api-contracts", "SKILL.md"),
      "utf8",
    ),
    /api-v1/,
  );
  assert.match(
    readFileSync(
      path.join(root, ".agents", "skills", "nested-contracts", "SKILL.md"),
      "utf8",
    ),
    /nested-v1/,
  );

  const childCheckout = path.join(root, "api");
  const nestedCheckout = path.join(childCheckout, "vendor", "shared");
  const childCommit = git(root, "rev-parse", ":api");
  const nestedCommit = git(
    childCheckout,
    "rev-parse",
    `${childCommit}:vendor/shared`,
  );
  const lock = JSON.parse(
    readFileSync(path.join(root, ".coordinator", "agents.lock.json"), "utf8"),
  ) as {
    generatedBy: string;
    schemaVersion: number;
    skills: Array<{
      linkTarget: string;
      materialization: string;
      name: string;
      repository: string;
      source: string;
      sourceCommit: string;
      treeOid: string;
    }>;
  };
  assert.equal(lock.schemaVersion, 2);
  assert.equal(lock.generatedBy, "agent-coordinator");
  const topLevel = lock.skills.find((skill) => skill.name === "api-contracts");
  const nested = lock.skills.find((skill) => skill.name === "nested-contracts");
  assert.deepEqual(
    topLevel && {
      linkTarget: topLevel.linkTarget,
      materialization: topLevel.materialization,
      repository: topLevel.repository,
      source: topLevel.source,
    },
    {
      linkTarget: topLevelLinkTarget,
      materialization: "relative-symlink",
      repository: "api",
      source: ".agents/skills/api-contracts",
    },
  );
  assert.deepEqual(
    nested && {
      linkTarget: nested.linkTarget,
      materialization: nested.materialization,
      repository: nested.repository,
      source: nested.source,
    },
    {
      linkTarget: nestedLinkTarget,
      materialization: "relative-symlink",
      repository: "api",
      source: "vendor/shared/.agents/skills/nested-contracts",
    },
  );
  assert.equal(topLevel?.sourceCommit, childCommit);
  assert.equal(
    topLevel?.treeOid,
    git(childCheckout, "rev-parse", `${childCommit}:.agents/skills/api-contracts`),
  );
  assert.equal(nested?.sourceCommit, nestedCommit);
  assert.equal(
    nested?.treeOid,
    git(
      nestedCheckout,
      "rev-parse",
      `${nestedCommit}:.agents/skills/nested-contracts`,
    ),
  );

  const nestedSkillPath = path.join(
    nestedCheckout,
    ".agents",
    "skills",
    "nested-contracts",
    "SKILL.md",
  );
  const pristineNestedSkill = readFileSync(nestedSkillPath, "utf8");
  writeFileSync(nestedSkillPath, `${pristineNestedSkill}\nlocal edit\n`);
  assertCoordinatorError(
    () => synchronizeSkills(root, manifest, "0.1.0", { check: true }),
    "SKILL_SOURCE_DIRTY",
    /nested submodule.*uncommitted or untracked changes/,
  );
  writeFileSync(nestedSkillPath, pristineNestedSkill);

  writeFileSync(nestedSkillPath, pristineNestedSkill.replace("nested-v1", "nested-v2"));
  git(nestedCheckout, "add", ".");
  git(nestedCheckout, "commit", "-m", "Advance nested skill locally");
  assertCoordinatorError(
    () => synchronizeSkills(root, manifest, "0.1.0", { check: true }),
    "SKILL_GITLINK_MISMATCH",
    /nested submodule.*parent gitlink pins/,
  );

  git(childCheckout, "add", "vendor/shared");
  git(childCheckout, "commit", "-m", "Advance nested gitlink locally");
  assertCoordinatorError(
    () => synchronizeSkills(root, manifest, "0.1.0", { check: true }),
    "SKILL_GITLINK_MISMATCH",
    /Repository 'api'.*parent gitlink pins/,
  );
});

test("skills reject a committed source symlink that escapes its repository", (context) => {
  const temporary = temporaryDirectory("agent-coordinator-skill-symlink-");
  context.after(() => rmSync(temporary, { recursive: true }));

  const externalSkill = path.join(temporary, "external-skill");
  writeSkill(externalSkill, "external", "must-not-be-copied");

  const childSource = path.join(temporary, "api-source");
  const childRemote = path.join(temporary, "api.git");
  initializeRepository(childSource);
  mkdirSync(path.join(childSource, ".agents", "skills"), { recursive: true });
  symlinkSync(
    externalSkill,
    path.join(childSource, ".agents", "skills", "escape"),
    "dir",
  );
  git(childSource, "add", ".");
  git(childSource, "commit", "-m", "Add escaping skill symlink");
  cloneBare(childSource, childRemote);

  const root = path.join(temporary, "coordinator");
  initializeRepository(root);
  git(root, "submodule", "add", childRemote, "api");
  const manifest = coordinatorManifestSchema.parse({
    schemaVersion: 1,
    name: "skill-symlink",
    repositories: [
      {
        id: "api",
        path: "api",
        url: childRemote,
        agent: { skills: [{ source: ".agents/skills/escape" }] },
      },
    ],
  });

  assertCoordinatorError(
    () => synchronizeSkills(root, manifest, "0.1.0", { check: true }),
    "SKILL_SOURCE_SYMLINK",
    /crosses symbolic link '.agents\/skills\/escape'/,
  );
});
