import {
  cancel,
  confirm,
  intro,
  isCancel,
  multiselect,
  note,
  outro,
  password,
  select,
  text,
} from "@clack/prompts";
import path from "node:path";
import pc from "picocolors";
import { commandAvailable, runCommand } from "../core/command.js";
import { CoordinatorError } from "../core/errors.js";
import {
  listBitbucketCloudRepositories,
  type BitbucketCloudAuthentication,
} from "../hosting/bitbucket.js";
import type {
  AgentTool,
  BranchPolicy,
  CoordinatorManifest,
} from "../core/schema.js";
import type {
  NestedSubmoduleRepairPlan,
  NestedSubmoduleRepairResult,
} from "../workspace/nested-repair.js";

export type RepositoryProvider = "github" | "bitbucket";

export interface DiscoveredRepository {
  description: string | null;
  directoryName: string;
  fullName: string;
  isPrivate: boolean;
  name: string;
  provider: RepositoryProvider;
  sshUrl: string;
}

export interface RepositorySelectionOption {
  hint: string;
  label: string;
  value: string;
}

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

function providerLabel(provider: RepositoryProvider): string {
  return provider === "github" ? "GitHub" : "Bitbucket Cloud";
}

export function repositorySelectionOption(
  repository: DiscoveredRepository,
): RepositorySelectionOption {
  return {
    value: `${repository.provider}:${repository.fullName}`,
    label: `${providerLabel(repository.provider)} · ${repository.fullName}`,
    hint: `${repository.isPrivate ? "private" : "public"}${
      repository.description ? ` · ${repository.description}` : ""
    }`,
  };
}

export function uniqueRepositoryValue(
  base: string,
  provider: RepositoryProvider,
  used: ReadonlySet<string>,
): string {
  if (!used.has(base)) return base;
  const prefixed = `${provider}-${base}`;
  if (!used.has(prefixed)) return prefixed;
  let suffix = 2;
  while (used.has(`${prefixed}-${suffix}`)) suffix += 1;
  return `${prefixed}-${suffix}`;
}

function currentGithubUser(): string | undefined {
  if (!commandAvailable("gh")) return undefined;
  const result = runCommand("gh", ["api", "user", "--jq", ".login"], {
    allowFailure: true,
  });
  return result.status === 0 ? result.stdout : undefined;
}

function listGithubRepositories(owner: string): DiscoveredRepository[] {
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
  return (JSON.parse(result.stdout) as GithubRepository[]).map(
    ({ nameWithOwner, ...repository }) => ({
      ...repository,
      directoryName: repository.name,
      fullName: nameWithOwner,
      provider: "github" as const,
    }),
  );
}

async function bitbucketAuthentication(): Promise<BitbucketCloudAuthentication> {
  const configuredEmail = process.env.BITBUCKET_EMAIL?.trim() || undefined;
  const configuredToken = process.env.BITBUCKET_API_TOKEN?.trim() || undefined;
  const email = configuredEmail ?? value(
    await text({
      message: "Atlassian account email",
      placeholder: "you@example.com",
      validate: (input) => input?.trim() ? undefined : "An email is required",
    }),
  );
  const apiToken = configuredToken ?? value(
    await password({
      message: "Bitbucket API token (used only for this request)",
      validate: (input) => input?.trim() ? undefined : "An API token is required",
    }),
  );
  return { kind: "basic", email: email.trim(), apiToken: apiToken.trim() };
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

function repairCandidateLabel(
  candidate: NestedSubmoduleRepairPlan["candidates"][number],
): string {
  const shortRevision = candidate.revision.slice(0, 12);
  if (candidate.sources.includes("previous-reachable-pin")) {
    return `Restore previous reachable pin · ${shortRevision}`;
  }
  const branch = candidate.ref?.replace(/^refs\/heads\//, "") ?? "default branch";
  return `Use remote ${branch} · ${shortRevision}`;
}

export async function promptNestedSubmoduleRepair(
  plan: NestedSubmoduleRepairPlan,
): Promise<string | null> {
  note(
    [
      `Repository: ${plan.repositoryId} (${plan.baseline.parentBranch})`,
      `Nested path: ${plan.nestedPath}`,
      `Unavailable pin: ${plan.baseline.pinnedRevision}`,
      `Remote: ${plan.remote.displayUrl}`,
      "The repair will create one local commit and update the coordinator gitlink.",
      "This repair does not push. A later coordinated git push can publish the commit.",
    ].join("\n"),
    "Unavailable nested gitlink",
  );
  const selected = await select<string>({
    message: "How should Agent Coordinator repair this gitlink?",
    options: [
      ...plan.candidates.map((candidate) => ({
        value: candidate.revision,
        label: repairCandidateLabel(candidate),
        ...(candidate.subject ? { hint: candidate.subject } : {}),
      })),
      {
        value: "abort",
        label: "Keep the partial workspace",
        hint: "repair the remote or parent gitlink manually",
      },
    ],
  });
  if (isCancel(selected) || selected === "abort") {
    cancel(`Repair not applied. Partial workspace preserved at ${plan.root}.`);
    return null;
  }
  const candidate = plan.candidates.find(
    ({ revision }) => revision === selected,
  )!;
  note(
    [
      `${plan.baseline.pinnedRevision} → ${candidate.revision}`,
      `Local commit in ${plan.repositoryId} on ${plan.baseline.parentBranch}`,
      `Stage updated coordinator gitlink at ${plan.repositoryPath}`,
      "Push during this repair: no (a later coordinated push may publish it)",
    ].join("\n"),
    "Automatic repair plan",
  );
  const approved = await confirm({
    message: "Create this local repair commit and retry initialization?",
    initialValue: false,
  });
  if (isCancel(approved) || !approved) {
    cancel(`Repair not applied. Partial workspace preserved at ${plan.root}.`);
    return null;
  }
  return candidate.revision;
}

export function reportNestedSubmoduleRepair(
  result: NestedSubmoduleRepairResult,
): void {
  note(
    [
      `Local commit: ${result.parentCommit}`,
      `Repository: ${result.repositoryId}`,
      `Nested path: ${result.nestedPath}`,
      "Coordinator gitlink updated",
      "No push was performed; a later coordinated push may publish the commit",
    ].join("\n"),
    "Repair applied",
  );
}

export async function promptResumeWorkspace(
  root: string,
  name: string,
): Promise<boolean> {
  intro(pc.bgMagenta(pc.white(" Agent Coordinator · resume workspace ")));
  const discoverSkills = value(
    await confirm({
      message: "Discover and link committed skills while resuming?",
      initialValue: true,
    }),
  );
  const proceed = value(
    await confirm({
      message: `Resume ${name} in ${root}?`,
      initialValue: true,
    }),
  );
  if (!proceed) {
    cancel(`Partial workspace preserved at ${root}.`);
    throw new CoordinatorError(
      "Workspace initialization was not resumed.",
      "INCOMPLETE_INITIALIZATION",
    );
  }
  return discoverSkills;
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
  const providers = value(
    await multiselect<RepositoryProvider>({
      message: "Repository hosting providers",
      initialValues: ["github"],
      required: true,
      options: [
        { value: "github", label: "GitHub" },
        { value: "bitbucket", label: "Bitbucket Cloud" },
      ],
    }),
  );
  const available: DiscoveredRepository[] = [];
  if (providers.includes("github")) {
    const suggestedOwner = currentGithubUser();
    const owner = value(
      await text({
        message: "GitHub owner or organization",
        ...(suggestedOwner ? { defaultValue: suggestedOwner } : {}),
        placeholder: "your-organization",
        validate: (input) => (input?.trim() ? undefined : "An owner is required"),
      }),
    ).trim();
    const repositories = listGithubRepositories(owner);
    if (!repositories.length) {
      throw new CoordinatorError(
        `No repositories were found for GitHub owner '${owner}'.`,
      );
    }
    available.push(...repositories);
  }
  if (providers.includes("bitbucket")) {
    const workspace = value(
      await text({
        message: "Bitbucket Cloud workspace",
        placeholder: "your-workspace",
        validate: (input) => input?.trim() ? undefined : "A workspace is required",
      }),
    ).trim();
    const repositories = (await listBitbucketCloudRepositories(
      workspace,
      {
        authentication: await bitbucketAuthentication(),
        signal: AbortSignal.timeout(30_000),
      },
    )).map(({ slug, ...repository }) => ({
      ...repository,
      directoryName: slug,
      provider: "bitbucket" as const,
    }));
    if (!repositories.length) {
      throw new CoordinatorError(
        `No repositories were found for Bitbucket Cloud workspace '${workspace}'.`,
      );
    }
    available.push(...repositories);
  }
  const availableByKey = new Map(
    available.map((repository) => [repositorySelectionOption(repository).value, repository]),
  );
  const chosen = value(
    await multiselect({
      message: "Select the repositories that form this workspace",
      required: true,
      options: available.map(repositorySelectionOption),
    }),
  );
  const selectedRepositories = chosen.map((selectionKey) => {
    const repository = availableByKey.get(selectionKey);
    if (!repository) {
      throw new CoordinatorError(
        `Unknown repository selection '${selectionKey}'.`,
        "INVALID_REPOSITORY_SELECTION",
      );
    }
    return repository;
  });
  const usedIds = new Set<string>();
  const usedPaths = new Set<string>();
  const repositories: CoordinatorManifest["repositories"] = [];
  for (const repository of selectedRepositories) {
    const suggestedId = uniqueRepositoryValue(
      roleSuggestion(repository.name),
      repository.provider,
      usedIds,
    );
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
    const repositoryPath = uniqueRepositoryValue(
      repository.directoryName,
      repository.provider,
      usedPaths,
    );
    usedPaths.add(repositoryPath);
    repositories.push({
      id,
      path: repositoryPath,
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
      message: "Discover and link committed skills from the selected repositories?",
      initialValue: true,
    }),
  );
  note(
    [
      `${repositories.length} repositories`,
      `${tools.length} agent runtimes`,
      discoverSkills ? "committed skills will be discovered and linked" : "skills can be added later",
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
        skillCollision: "error",
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
