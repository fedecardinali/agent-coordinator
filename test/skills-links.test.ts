import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import test from "node:test";
import { synchronizeAgents } from "../src/agents/sync.js";
import { synchronizeSkills } from "../src/agents/skills.js";
import { CoordinatorError } from "../src/core/errors.js";
import {
  coordinatorManifestSchema,
  type CoordinatorManifest,
} from "../src/core/schema.js";
import { git, REAL_GIT, temporaryDirectory } from "./helpers.js";

const generatorVersion = "0.4.0";
const repositoryId = "api";
const repositoryPath = "api";
const skillName = "api-contracts";
const skillSource = `.agents/skills/${skillName}`;

type LinkSyncResult = ReturnType<typeof synchronizeSkills> & {
  migrations: string[];
};

interface SkillLinkFixture {
  checkout: string;
  manifest: CoordinatorManifest;
  root: string;
  source: string;
  target: string;
}

function cloneBare(source: string, destination: string): void {
  execFileSync(REAL_GIT, ["clone", "--quiet", "--bare", source, destination]);
}

function writeSkill(directory: string, name: string, body: string): void {
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    path.join(directory, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${name} fixture.\n---\n\n# ${name}\n\n${body}\n`,
  );
  writeFileSync(path.join(directory, "reference.md"), `${body} reference\n`);
}

function createFixture(
  context: test.TestContext,
  options: { exportName?: string; declaredName?: string } = {},
): SkillLinkFixture {
  const temporary = temporaryDirectory("agent-coordinator-skill-links-");
  context.after(() => rmSync(temporary, { recursive: true }));

  const declaredName = options.declaredName ?? skillName;
  const sourceRepository = path.join(temporary, "api-source");
  const remote = path.join(temporary, "api.git");
  mkdirSync(sourceRepository);
  git(sourceRepository, "init", "--initial-branch=main");
  writeSkill(
    path.join(sourceRepository, skillSource),
    declaredName,
    "committed source",
  );
  git(sourceRepository, "add", ".");
  git(sourceRepository, "commit", "-m", "Add linked skill");
  cloneBare(sourceRepository, remote);

  const root = path.join(temporary, "workspace");
  mkdirSync(root);
  git(root, "init", "--initial-branch=main");
  git(root, "submodule", "add", remote, repositoryPath);
  const checkout = path.join(root, repositoryPath);
  const exportEntry: { name?: string; source: string } = {
    source: skillSource,
  };
  if (options.exportName) exportEntry.name = options.exportName;
  const manifest = coordinatorManifestSchema.parse({
    schemaVersion: 1,
    name: "skill-links",
    repositories: [
      {
        id: repositoryId,
        path: repositoryPath,
        url: remote,
        agent: { skills: [exportEntry] },
      },
    ],
    agents: {
      tools: ["codex"],
      maxParallel: 1,
      skillCollision: "namespace",
    },
  });
  return {
    checkout,
    manifest,
    root,
    source: path.join(checkout, skillSource),
    target: path.join(root, ".agents", "skills", options.exportName ?? skillName),
  };
}

function synchronize(
  fixture: SkillLinkFixture,
  options: { check?: boolean; force?: boolean } = {},
): LinkSyncResult {
  return synchronizeSkills(
    fixture.root,
    fixture.manifest,
    generatorVersion,
    options,
  ) as LinkSyncResult;
}

function lockPath(fixture: SkillLinkFixture): string {
  return path.join(fixture.root, ".coordinator", "agents.lock.json");
}

function relativeLinkTarget(fixture: SkillLinkFixture): string {
  return path.relative(path.dirname(fixture.target), fixture.source);
}

function assertRelativeSourceLink(fixture: SkillLinkFixture): void {
  const status = lstatSync(fixture.target);
  assert.equal(status.isSymbolicLink(), true);
  const linkTarget = readlinkSync(fixture.target);
  assert.equal(path.isAbsolute(linkTarget), false);
  assert.equal(linkTarget, relativeLinkTarget(fixture));
  assert.equal(
    path.resolve(path.dirname(fixture.target), linkTarget),
    fixture.source,
  );
}

function directoryDigest(directory: string): string {
  const pieces: Buffer[] = [];
  const walk = (current: string, prefix: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort(
      (left, right) => left.name.localeCompare(right.name),
    )) {
      const absolute = path.join(current, entry.name);
      const relative = path.posix.join(prefix, entry.name);
      assert.equal(entry.isSymbolicLink(), false);
      if (entry.isDirectory()) {
        walk(absolute, relative);
      } else if (entry.isFile()) {
        pieces.push(Buffer.from(`${relative}\0`));
        pieces.push(readFileSync(absolute));
        pieces.push(Buffer.from("\0"));
      }
    }
  };
  walk(directory, "");
  return createHash("sha256").update(Buffer.concat(pieces)).digest("hex");
}

function writeLegacyManagedCopy(fixture: SkillLinkFixture): string {
  mkdirSync(path.dirname(fixture.target), { recursive: true });
  cpSync(fixture.source, fixture.target, { recursive: true });
  const sourceCommit = git(fixture.root, "rev-parse", `:${repositoryPath}`);
  const treeOid = git(
    fixture.checkout,
    "rev-parse",
    `${sourceCommit}:${skillSource}`,
  );
  const legacyLock = {
    schemaVersion: 1,
    generatedBy: "agent-coordinator",
    generatorVersion,
    skills: [
      {
        name: skillName,
        repository: repositoryId,
        source: skillSource,
        sourceCommit,
        treeOid,
        digest: directoryDigest(fixture.target),
      },
    ],
  };
  mkdirSync(path.dirname(lockPath(fixture)), { recursive: true });
  const rendered = `${JSON.stringify(legacyLock, null, 2)}\n`;
  writeFileSync(lockPath(fixture), rendered);
  return rendered;
}

function assertCoordinatorError(
  operation: () => unknown,
  code: string,
  message?: RegExp,
): void {
  assert.throws(operation, (error: unknown) => {
    assert.ok(error instanceof CoordinatorError);
    assert.equal(error.code, code);
    if (message) assert.match(error.message, message);
    return true;
  });
}

test("skills are relative links to committed sources and check mode never mutates", (context) => {
  const fixture = createFixture(context);
  const statusBefore = git(fixture.root, "status", "--porcelain=v1");

  const preview = synchronize(fixture, { check: true });

  assert.equal(preview.changed, true);
  assert.deepEqual(preview.names, [skillName]);
  assert.deepEqual(preview.migrations, []);
  assert.equal(existsSync(path.join(fixture.root, ".agents")), false);
  assert.equal(existsSync(path.join(fixture.root, ".coordinator")), false);
  assert.equal(git(fixture.root, "status", "--porcelain=v1"), statusBefore);

  const applied = synchronize(fixture);
  assert.equal(applied.changed, true);
  assert.deepEqual(applied.migrations, []);
  assertRelativeSourceLink(fixture);
  assert.match(readFileSync(path.join(fixture.target, "SKILL.md"), "utf8"), /committed source/);

  const lock = JSON.parse(readFileSync(lockPath(fixture), "utf8")) as {
    generatedBy: string;
    generatorVersion: string;
    schemaVersion: number;
    skills: Array<Record<string, unknown>>;
  };
  assert.equal(lock.schemaVersion, 2);
  assert.equal(lock.generatedBy, "agent-coordinator");
  assert.equal(lock.generatorVersion, generatorVersion);
  assert.equal(lock.skills.length, 1);
  assert.deepEqual(Object.keys(lock.skills[0]!).sort(), [
    "linkTarget",
    "materialization",
    "name",
    "repository",
    "source",
    "sourceCommit",
    "treeOid",
  ]);
  assert.equal(lock.skills[0]!.materialization, "relative-symlink");
  assert.equal(lock.skills[0]!.linkTarget, relativeLinkTarget(fixture));
  assert.equal("digest" in lock.skills[0]!, false);

  const linkBefore = readlinkSync(fixture.target);
  const lockBefore = readFileSync(lockPath(fixture), "utf8");
  const stablePreview = synchronize(fixture, { check: true });
  assert.equal(stablePreview.changed, false);
  assert.deepEqual(stablePreview.migrations, []);
  assert.equal(readlinkSync(fixture.target), linkBefore);
  assert.equal(readFileSync(lockPath(fixture), "utf8"), lockBefore);
});

test("agent-file conflicts are planned before any skill link is published", (context) => {
  const fixture = createFixture(context);
  const unmanagedAgents = "# Project-owned instructions\n";
  writeFileSync(path.join(fixture.root, "AGENTS.md"), unmanagedAgents);

  assertCoordinatorError(
    () =>
      synchronizeAgents(
        fixture.root,
        fixture.manifest,
        generatorVersion,
      ),
    "UNMANAGED_FILE",
    /AGENTS\.md/,
  );

  assert.equal(readFileSync(path.join(fixture.root, "AGENTS.md"), "utf8"), unmanagedAgents);
  assert.equal(existsSync(path.join(fixture.root, ".agents")), false);
  assert.equal(existsSync(path.join(fixture.root, ".coordinator")), false);
});

test("a dependent agent-file publication failure rolls skill links and lock back", (context) => {
  const fixture = createFixture(context);
  const dependentPath = path.join(fixture.root, "dependent-agent.md");

  assertCoordinatorError(
    () =>
      synchronizeSkills(
        fixture.root,
        fixture.manifest,
        generatorVersion,
        {
          dependentFilePlans: [
            {
              action: "create",
              content: "untrusted\n",
              path: dependentPath,
              relativePath: "dependent-agent.md",
            },
          ],
        },
      ),
    "UNSAFE_FILE_PLAN",
    /untrusted generated-file plan/i,
  );

  assert.equal(existsSync(fixture.target), false);
  assert.equal(existsSync(lockPath(fixture)), false);
  assert.equal(existsSync(dependentPath), false);
});

test("stale skill expectations stop publication before dependent files can diverge", (context) => {
  const fixture = createFixture(context);
  const preview = synchronize(fixture, { check: true });
  const staleSkills = preview.skills.map((skill) => ({
    ...skill,
    treeOid: "0".repeat(40),
  }));

  assertCoordinatorError(
    () =>
      synchronizeSkills(
        fixture.root,
        fixture.manifest,
        generatorVersion,
        { expectedSkills: staleSkills },
      ),
    "SKILL_PLAN_STALE",
    /changed after dependent agent files were planned/i,
  );

  assert.equal(existsSync(fixture.target), false);
  assert.equal(existsSync(lockPath(fixture)), false);
  assert.equal(existsSync(path.join(fixture.root, ".agents")), false);
});

test("a schema-1 managed copy previews and applies an automatic migration to a link", (context) => {
  const fixture = createFixture(context);
  const legacyLock = writeLegacyManagedCopy(fixture);
  const copyInode = lstatSync(fixture.target).ino;

  const preview = synchronize(fixture, { check: true });

  assert.equal(preview.changed, true);
  assert.equal(preview.migrations.length, 1);
  assert.match(preview.migrations[0]!, /api-contracts.*(?:symlink|link)/i);
  assert.equal(lstatSync(fixture.target).isDirectory(), true);
  assert.equal(lstatSync(fixture.target).ino, copyInode);
  assert.equal(readFileSync(lockPath(fixture), "utf8"), legacyLock);

  const applied = synchronize(fixture);
  assert.equal(applied.changed, true);
  assert.deepEqual(applied.migrations, preview.migrations);
  assertRelativeSourceLink(fixture);
  const migratedLock = JSON.parse(readFileSync(lockPath(fixture), "utf8")) as {
    schemaVersion: number;
    skills: Array<{ digest?: string; materialization: string; linkTarget: string }>;
  };
  assert.equal(migratedLock.schemaVersion, 2);
  assert.equal(migratedLock.skills[0]!.materialization, "relative-symlink");
  assert.equal(migratedLock.skills[0]!.linkTarget, relativeLinkTarget(fixture));
  assert.equal("digest" in migratedLock.skills[0]!, false);
});

test("unmanaged skill copies and links require force before adoption", (context) => {
  const fixture = createFixture(context);
  mkdirSync(path.dirname(fixture.target), { recursive: true });
  cpSync(fixture.source, fixture.target, { recursive: true });

  assertCoordinatorError(
    () => synchronize(fixture),
    "UNMANAGED_SKILL",
    /Refusing to replace unmanaged skill/,
  );
  assert.equal(lstatSync(fixture.target).isDirectory(), true);

  synchronize(fixture, { force: true });
  assertRelativeSourceLink(fixture);
  unlinkSync(lockPath(fixture));
  const unmanagedLink = readlinkSync(fixture.target);

  assertCoordinatorError(
    () => synchronize(fixture),
    "UNMANAGED_SKILL",
    /unmanaged skill/,
  );
  assert.equal(readlinkSync(fixture.target), unmanagedLink);

  synchronize(fixture, { force: true });
  assertRelativeSourceLink(fixture);
  assert.equal(existsSync(lockPath(fixture)), true);
});

test("a modified schema-1 managed copy is preserved unless migration is forced", (context) => {
  const fixture = createFixture(context);
  writeLegacyManagedCopy(fixture);
  const referencePath = path.join(fixture.target, "reference.md");
  writeFileSync(referencePath, "locally modified legacy copy\n");

  assert.throws(
    () => synchronize(fixture),
    (error: unknown) => {
      assert.ok(error instanceof CoordinatorError);
      assert.match(error.message, /modified|digest|does not match|migrat/i);
      return true;
    },
  );
  assert.equal(lstatSync(fixture.target).isDirectory(), true);
  assert.equal(readFileSync(referencePath, "utf8"), "locally modified legacy copy\n");

  synchronize(fixture, { force: true });
  assertRelativeSourceLink(fixture);
});

test("a wrong managed link is previewed without mutation and then repaired", (context) => {
  const fixture = createFixture(context);
  synchronize(fixture);
  const lockBefore = readFileSync(lockPath(fixture), "utf8");
  const wrongSource = path.join(fixture.root, "wrong-skill");
  writeSkill(wrongSource, skillName, "wrong source");
  rmSync(fixture.target, { recursive: true });
  const wrongLink = path.relative(path.dirname(fixture.target), wrongSource);
  symlinkSync(wrongLink, fixture.target, "dir");

  const preview = synchronize(fixture, { check: true });

  assert.equal(preview.changed, true);
  assert.equal(readlinkSync(fixture.target), wrongLink);
  assert.equal(readFileSync(lockPath(fixture), "utf8"), lockBefore);

  synchronize(fixture);
  assertRelativeSourceLink(fixture);
  assert.match(readFileSync(path.join(fixture.target, "SKILL.md"), "utf8"), /committed source/);
});

test("direct skill links reject aliases whose target differs from frontmatter", (context) => {
  const fixture = createFixture(context, { exportName: "api-alias" });

  assert.throws(
    () => synchronize(fixture, { check: true }),
    (error: unknown) => {
      assert.ok(error instanceof CoordinatorError);
      assert.match(error.message, /api-alias.*api-contracts|api-contracts.*api-alias/i);
      return true;
    },
  );
  assert.equal(existsSync(path.join(fixture.root, ".agents")), false);
});

test("direct skill links reject every divergent source collision", (context) => {
  const temporary = temporaryDirectory("agent-coordinator-skill-link-collision-");
  context.after(() => rmSync(temporary, { recursive: true }));
  const root = path.join(temporary, "workspace");
  mkdirSync(root);
  git(root, "init", "--initial-branch=main");
  const repositories = ["api", "web"].map((id) => {
    const sourceRepository = path.join(temporary, `${id}-source`);
    const remote = path.join(temporary, `${id}.git`);
    mkdirSync(sourceRepository);
    git(sourceRepository, "init", "--initial-branch=main");
    writeSkill(
      path.join(sourceRepository, ".agents", "skills", "shared-contracts"),
      "shared-contracts",
      `${id} divergent source`,
    );
    git(sourceRepository, "add", ".");
    git(sourceRepository, "commit", "-m", `Add ${id} skill`);
    cloneBare(sourceRepository, remote);
    git(root, "submodule", "add", remote, id);
    return {
      id,
      path: id,
      url: remote,
      agent: { skills: [{ source: ".agents/skills/shared-contracts" }] },
    };
  });
  const manifest = coordinatorManifestSchema.parse({
    schemaVersion: 1,
    name: "skill-link-collision",
    repositories,
    agents: {
      tools: ["codex"],
      maxParallel: 1,
      skillCollision: "namespace",
    },
  });

  assertCoordinatorError(
    () => synchronizeSkills(root, manifest, generatorVersion, { check: true }),
    "SKILL_COLLISION",
    /shared-contracts.*divergent sources/i,
  );
  assert.equal(existsSync(path.join(root, ".agents")), false);
});
