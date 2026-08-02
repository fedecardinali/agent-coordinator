import {
  cancel,
  confirm,
  intro,
  isCancel,
  multiselect,
  note,
  outro,
  select,
  text,
} from "@clack/prompts";
import path from "node:path";
import pc from "picocolors";
import { commandAvailable, runCommand } from "../core/command.js";
import { CoordinatorError } from "../core/errors.js";
import type {
  AgentTool,
  BranchPolicy,
  CoordinatorManifest,
} from "../core/schema.js";

interface GithubRepository {
  description: string | null;
  isPrivate: boolean;
  name: string;
  nameWithOwner: string;
  sshUrl: string;
}

function value<T>(input: T | symbol): T {
  if (isCancel(input)) {
    cancel("No changes were made.");
    throw new CoordinatorError("Operation cancelled.", "CANCELLED");
  }
  return input;
}

function slug(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function roleSuggestion(repositoryName: string): string {
  const name = repositoryName.toLowerCase();
  if (/(back-?end|api-core|server)$/.test(name)) return "backend";
  if (/(front-?end|web-admin|client|web)$/.test(name)) return "frontend";
  if (/(infra|infrastructure|terraform)$/.test(name)) return "infra";
  if (/(e2e|end-to-end)$/.test(name)) return "e2e";
  if (/api-tests?$/.test(name)) return "api-tests";
  return slug(repositoryName);
}

function currentGithubUser(): string | undefined {
  if (!commandAvailable("gh")) return undefined;
  const result = runCommand("gh", ["api", "user", "--jq", ".login"], {
    allowFailure: true,
  });
  return result.status === 0 ? result.stdout : undefined;
}

function listGithubRepositories(owner: string): GithubRepository[] {
  const result = runCommand(
    "gh",
    [
      "repo",
      "list",
      owner,
      "--limit",
      "200",
      "--json",
      "name,nameWithOwner,description,sshUrl,isPrivate",
    ],
    { allowFailure: true },
  );
  if (result.status !== 0) {
    throw new CoordinatorError(
      result.stderr || `Could not list repositories for ${owner}.`,
    );
  }
  return JSON.parse(result.stdout) as GithubRepository[];
}

async function branchPolicy(repository: string): Promise<BranchPolicy> {
  const mode = value(
    await select({
      message: `How should ${repository} follow coordinator branches?`,
      options: [
        {
          value: "mirror",
          label: "Mirror",
          hint: "same branch name as the coordinator",
        },
        {
          value: "fixed",
          label: "Fixed writable",
          hint: "always use one branch",
        },
        {
          value: "read-only",
          label: "Fixed read-only",
          hint: "pin a stable repository such as infrastructure",
        },
      ],
    }),
  );
  if (mode === "mirror") return { mode: "mirror", readOnly: false };
  const name = value(
    await text({
      message: `Fixed branch for ${repository}`,
      defaultValue: "main",
      placeholder: "main",
      validate: (input) => (input?.trim() ? undefined : "A branch is required"),
    }),
  );
  return { mode: "fixed", name, readOnly: mode === "read-only" };
}

export interface PromptedWorkspace {
  discoverSkills: boolean;
  manifest: CoordinatorManifest;
}

export async function promptWorkspaceManifest(
  directory: string,
): Promise<PromptedWorkspace> {
  intro(pc.bgMagenta(pc.white(" Agent Coordinator · new workspace ")));
  const suggestedName = slug(path.basename(path.resolve(directory))) || "workspace";
  const name = value(
    await text({
      message: "Workspace name",
      defaultValue: suggestedName,
      placeholder: suggestedName,
      validate: (input) =>
        /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(input ?? "")
          ? undefined
          : "Use lowercase kebab-case",
    }),
  );
  const suggestedOwner = currentGithubUser();
  const owner = value(
    await text({
      message: "GitHub owner or organization",
      ...(suggestedOwner ? { defaultValue: suggestedOwner } : {}),
      placeholder: "your-organization",
      validate: (input) => (input?.trim() ? undefined : "An owner is required"),
    }),
  );
  const available = listGithubRepositories(owner);
  const chosen = value(
    await multiselect({
      message: "Select the repositories that form this workspace",
      required: true,
      options: available.map((repository) => ({
        value: repository.nameWithOwner,
        label: repository.name,
        hint: `${repository.isPrivate ? "private" : "public"}${
          repository.description ? ` · ${repository.description}` : ""
        }`,
      })),
    }),
  );
  const selectedRepositories = chosen.map(
    (nameWithOwner) => available.find((repository) => repository.nameWithOwner === nameWithOwner)!,
  );
  const usedIds = new Set<string>();
  const repositories: CoordinatorManifest["repositories"] = [];
  for (const repository of selectedRepositories) {
    const suggestedId = roleSuggestion(repository.name);
    const id = value(
      await text({
        message: `Role id for ${repository.name}`,
        defaultValue: suggestedId,
        placeholder: suggestedId,
        validate: (input) => {
          if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(input ?? "")) {
            return "Use lowercase kebab-case";
          }
          if (usedIds.has(input!)) return "That role id is already used";
          return undefined;
        },
      }),
    );
    usedIds.add(id);
    const policy = await branchPolicy(id);
    repositories.push({
      id,
      path: repository.name,
      url: repository.sshUrl,
      branch: policy,
      agent: { instructions: [], verify: [], skills: [] },
    });
  }
  const tools = value(
    await multiselect<AgentTool>({
      message: "Generate project agents for",
      initialValues: ["codex", "claude"],
      required: true,
      options: [
        { value: "codex", label: "Codex" },
        { value: "claude", label: "Claude Code" },
        { value: "cursor", label: "Cursor" },
        { value: "opencode", label: "OpenCode" },
      ],
    }),
  );
  const discoverSkills = value(
    await confirm({
      message: "Discover and materialize committed skills from the selected repositories?",
      initialValue: true,
    }),
  );
  note(
    [
      `${repositories.length} repositories`,
      `${tools.length} agent runtimes`,
      discoverSkills ? "committed skills will be discovered" : "skills can be added later",
      "Agent Coordinator will preserve ordinary git commands",
      "its embedded Git runtime may be installed machine-wide",
    ].join("\n"),
    "Plan",
  );
  const proceed = value(
    await confirm({
      message: `Initialize ${name} in ${path.resolve(directory)}?`,
      initialValue: true,
    }),
  );
  if (!proceed) {
    cancel("No changes were made.");
    throw new CoordinatorError("Operation cancelled.", "CANCELLED");
  }
  return {
    discoverSkills,
    manifest: {
      schemaVersion: 2,
      name,
      remote: "origin",
      repositories,
      agents: {
        tools,
        maxParallel: Math.min(4, Math.max(1, repositories.length)),
        skillCollision: "namespace",
      },
    },
  };
}

export function finishWorkspacePrompt(): void {
  outro("Workspace verified. Ready to coordinate.");
}

export async function promptDashboardAction(): Promise<
  "status" | "sync" | "doctor" | "exit"
> {
  return value(
    await select({
      message: "What would you like to do?",
      options: [
        { value: "status", label: "Refresh status" },
        { value: "sync", label: "Synchronize agents, skills, and CI" },
        { value: "doctor", label: "Run workspace doctor" },
        { value: "exit", label: "Exit" },
      ],
    }),
  );
}
