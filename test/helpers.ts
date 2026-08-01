import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
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
  execFileSync(REAL_GIT, ["clone", "--bare", source, remote]);
  return { source, remote };
}
