import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

export const REAL_GIT = "/usr/bin/git";

export function temporaryDirectory(prefix = "agent-coordinator-test-"): string {
  return mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function git(directory: string, ...argumentsList: string[]): string {
  return execFileSync(
    REAL_GIT,
    ["-c", "core.hooksPath=/dev/null", "-c", "protocol.file.allow=always", "-C", directory, ...argumentsList],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "Agent Coordinator Test",
        GIT_AUTHOR_EMAIL: "agent-coordinator@example.test",
        GIT_COMMITTER_NAME: "Agent Coordinator Test",
        GIT_COMMITTER_EMAIL: "agent-coordinator@example.test",
        GIT_COORDINATOR_INTERNAL: "1",
      },
    },
  ).trim();
}

export interface ChildFixture {
  remote: string;
  source: string;
}

export interface NestedAgentFixture extends ChildFixture {
  aliasFlowName: string;
  aliasName: string;
  flowName: string;
  runtimePath: string;
  runtimeRemote: string;
  runtimeSource: string;
  skillName: string;
  skillRemote: string;
  vendorPath: string;
  vendorRemote: string;
}

function cloneBare(source: string, destination: string): void {
  execFileSync(REAL_GIT, ["clone", "--bare", source, destination]);
}

function writeSkill(directory: string, name: string): void {
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    path.join(directory, "SKILL.md"),
    `---\nname: ${name}\ndescription: Test ${name}.\n---\n\n# ${name}\n`,
  );
}

export function createNestedAgentRemote(
  root: string,
  name: string,
): NestedAgentFixture {
  const skillName = `${name}-contracts`;
  const aliasName = `${name}-design`;
  const aliasFlowName = `${name}-vendor-flow`;
  const flowName = `${name}-review-flow`;

  const skillSource = path.join(root, `${name}-skill-source`);
  const skillRemote = path.join(root, `${name}-skill.git`);
  mkdirSync(skillSource, { recursive: true });
  execFileSync(REAL_GIT, ["init", "--initial-branch=main", skillSource]);
  writeSkill(skillSource, skillName);
  git(skillSource, "add", ".");
  git(skillSource, "commit", "-m", `Add ${skillName}`);
  cloneBare(skillSource, skillRemote);

  const vendorSource = path.join(root, `${name}-vendor-source`);
  const vendorRemote = path.join(root, `${name}-vendor.git`);
  mkdirSync(vendorSource, { recursive: true });
  execFileSync(REAL_GIT, ["init", "--initial-branch=main", vendorSource]);
  writeSkill(path.join(vendorSource, "skills", aliasName), aliasName);
  writeSkill(path.join(vendorSource, "flows", aliasFlowName), aliasFlowName);
  git(vendorSource, "add", ".");
  git(vendorSource, "commit", "-m", `Add ${aliasName}`);
  cloneBare(vendorSource, vendorRemote);

  const runtimeSource = path.join(root, `${name}-runtime-source`);
  const runtimeRemote = path.join(root, `${name}-runtime.git`);
  const vendorPath = `.agents/vendor/${name}-vendor`;
  mkdirSync(runtimeSource, { recursive: true });
  execFileSync(REAL_GIT, ["init", "--initial-branch=main", runtimeSource]);
  writeFileSync(
    path.join(runtimeSource, "AGENTS.md"),
    `# ${name} runtime\n\nUse the committed project skills.\n`,
  );
  writeSkill(
    path.join(runtimeSource, ".agents", "flows", flowName),
    flowName,
  );
  git(
    runtimeSource,
    "submodule",
    "add",
    skillRemote,
    `.agents/skills/${skillName}`,
  );
  git(
    runtimeSource,
    "submodule",
    "add",
    vendorRemote,
    vendorPath,
  );
  symlinkSync(
    `../vendor/${name}-vendor/skills/${aliasName}`,
    path.join(runtimeSource, ".agents", "skills", aliasName),
    "dir",
  );
  symlinkSync(
    `../vendor/${name}-vendor/flows/${aliasFlowName}`,
    path.join(runtimeSource, ".agents", "flows", aliasFlowName),
    "dir",
  );
  git(runtimeSource, "add", ".");
  git(runtimeSource, "commit", "-m", `Add ${name} agent runtime`);
  cloneBare(runtimeSource, runtimeRemote);

  const source = path.join(root, `${name}-source`);
  const remote = path.join(root, `${name}.git`);
  const runtimePath = `.agent-runtime/${name}-agent`;
  mkdirSync(source, { recursive: true });
  execFileSync(REAL_GIT, ["init", "--initial-branch=main", source]);
  writeFileSync(path.join(source, "README.md"), `# ${name}\n`);
  git(source, "submodule", "add", runtimeRemote, runtimePath);
  symlinkSync(`${runtimePath}/.agents`, path.join(source, ".agents"), "dir");
  symlinkSync(`${runtimePath}/AGENTS.md`, path.join(source, "AGENTS.md"), "file");
  git(source, "add", ".");
  git(source, "commit", "-m", `Add ${name} runtime`);
  cloneBare(source, remote);

  return {
    aliasFlowName,
    aliasName,
    flowName,
    remote,
    runtimePath,
    runtimeRemote,
    runtimeSource,
    skillName,
    skillRemote,
    source,
    vendorPath,
    vendorRemote,
  };
}

export function createChildRemote(
  root: string,
  name: string,
  skillName?: string,
): ChildFixture {
  const source = path.join(root, `${name}-source`);
  const remote = path.join(root, `${name}.git`);
  mkdirSync(source, { recursive: true });
  execFileSync(REAL_GIT, ["init", "--initial-branch=main", source]);
  writeFileSync(path.join(source, "README.md"), `# ${name}\n`);
  writeFileSync(
    path.join(source, "AGENTS.md"),
    `# ${name} guide\n\nKeep work inside this repository.\n`,
  );
  if (skillName) {
    const skillDirectory = path.join(source, ".agents", "skills", skillName);
    mkdirSync(skillDirectory, { recursive: true });
    writeFileSync(
      path.join(skillDirectory, "SKILL.md"),
      `---\nname: ${skillName}\ndescription: Test ${skillName}.\n---\n\n# ${skillName}\n`,
    );
    writeFileSync(path.join(skillDirectory, "reference.md"), `${name} reference\n`);
  }
  git(source, "add", ".");
  git(source, "commit", "-m", "Initial child repository");
  cloneBare(source, remote);
  return { source, remote };
}
