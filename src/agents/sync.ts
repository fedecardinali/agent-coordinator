import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { CoordinatorError } from "../core/errors.js";
import {
  changedPlans,
  planFile,
  planFileDeletion,
  type FilePlan,
} from "../core/files.js";
import type { CoordinatorManifest } from "../core/schema.js";
import {
  AGENT_FILE_MARKER,
  renderClaudeAgent,
  renderClaudeCommand,
  renderClaudeRoot,
  renderCodexAgent,
  renderCodexConfig,
  renderCursorAgent,
  renderOpenCodeAgent,
  renderRootAgents,
} from "./renderers.js";
import {
  synchronizeSkills,
  type SkillLinkAction,
} from "./skills.js";

export interface AgentSyncResult {
  changed: boolean;
  files: FilePlan[];
  skillActions: SkillLinkAction[];
  skillMigrations: string[];
  skills: string[];
}

function owned(content: string): boolean {
  return content.includes(AGENT_FILE_MARKER);
}

function generatedAgentPaths(root: string): string[] {
  const paths: string[] = [];
  const direct = [".codex/config.toml", ".claude/CLAUDE.md"];
  for (const relativePath of direct) {
    const absolutePath = path.join(root, relativePath);
    if (existsSync(absolutePath) && owned(readFileSync(absolutePath, "utf8"))) {
      paths.push(relativePath);
    }
  }
  const visit = (relativeDirectory: string): void => {
    const absoluteDirectory = path.join(root, relativeDirectory);
    if (!existsSync(absoluteDirectory)) return;
    for (const entry of readdirSync(absoluteDirectory, { withFileTypes: true })) {
      const relativePath = path.posix.join(relativeDirectory, entry.name);
      if (entry.isDirectory()) visit(relativePath);
      else if (
        entry.isFile() &&
        owned(readFileSync(path.join(root, relativePath), "utf8"))
      ) {
        paths.push(relativePath);
      }
    }
  };
  for (const directory of [
    ".codex/agents",
    ".cursor/agents",
    ".claude/agents",
    ".claude/commands",
    ".opencode/agents",
  ]) {
    visit(directory);
  }
  return paths.sort();
}

function renderAgentFiles(
  root: string,
  manifest: CoordinatorManifest,
  skillNames: string[],
  force: boolean,
): FilePlan[] {
  const plans: FilePlan[] = [
    planFile(root, "AGENTS.md", renderRootAgents(manifest), { force, owned }),
  ];
  const tools = new Set(manifest.agents.tools);
  if (tools.has("codex")) {
    plans.push(
      planFile(root, ".codex/config.toml", renderCodexConfig(manifest), {
        force,
        owned,
      }),
    );
  }
  if (tools.has("claude")) {
    const claudeSkills = path.join(root, ".claude", "skills");
    if (existsSync(claudeSkills)) {
      throw new CoordinatorError(
        ".claude/skills would duplicate the canonical .agents/skills registry. Move it before syncing.",
        "DUPLICATE_SKILLS",
      );
    }
    plans.push(
      planFile(root, ".claude/CLAUDE.md", renderClaudeRoot(manifest), {
        force,
        owned,
      }),
    );
  }
  for (const repository of manifest.repositories) {
    const name = repository.agent.name ?? repository.id;
    if (tools.has("codex")) {
      plans.push(
        planFile(
          root,
          `.codex/agents/${name}.toml`,
          renderCodexAgent(manifest, repository),
          { force, owned },
        ),
      );
    }
    if (tools.has("cursor")) {
      plans.push(
        planFile(
          root,
          `.cursor/agents/${name}.md`,
          renderCursorAgent(manifest, repository),
          { force, owned },
        ),
      );
    }
    if (tools.has("claude")) {
      plans.push(
        planFile(
          root,
          `.claude/agents/${name}.md`,
          renderClaudeAgent(manifest, repository),
          { force, owned },
        ),
      );
    }
    if (tools.has("opencode")) {
      plans.push(
        planFile(
          root,
          `.opencode/agents/${name}.md`,
          renderOpenCodeAgent(manifest, repository),
          { force, owned },
        ),
      );
    }
  }
  if (tools.has("claude")) {
    for (const skillName of skillNames) {
      plans.push(
        planFile(
          root,
          `.claude/commands/${manifest.name}/${skillName}.md`,
          renderClaudeCommand(manifest, skillName),
          { force, owned },
        ),
      );
    }
  }
  return plans;
}

export function synchronizeAgents(
  root: string,
  manifest: CoordinatorManifest,
  generatorVersion: string,
  options: { check?: boolean | undefined; force?: boolean | undefined } = {},
): AgentSyncResult {
  if (manifest.agents.manage === false) {
    return {
      changed: false,
      files: [],
      skillActions: [],
      skillMigrations: [],
      skills: [],
    };
  }
  const force = options.force ?? false;
  const skillPreview = synchronizeSkills(root, manifest, generatorVersion, {
    check: true,
    force,
  });
  const files = renderAgentFiles(root, manifest, skillPreview.names, force);
  const desiredPaths = new Set(files.map((file) => file.relativePath));
  for (const stalePath of generatedAgentPaths(root)) {
    if (!desiredPaths.has(stalePath)) {
      files.push(planFileDeletion(root, stalePath, owned));
    }
  }
  const changed = skillPreview.changed || changedPlans(files).length > 0;
  if (options.check) {
    return {
      changed,
      files,
      skillActions: skillPreview.actions,
      skillMigrations: skillPreview.migrations,
      skills: skillPreview.names,
    };
  }
  const skillResult = synchronizeSkills(root, manifest, generatorVersion, {
    dependentFilePlans: files,
    expectedSkills: skillPreview.skills,
    force,
  });
  return {
    changed,
    files,
    skillActions: skillResult.actions,
    skillMigrations: skillResult.migrations,
    skills: skillResult.names,
  };
}
