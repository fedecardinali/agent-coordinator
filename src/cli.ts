import path from "node:path";
import { Command, CommanderError } from "commander";
import pc from "picocolors";
import { synchronizeAgents } from "./agents/sync.js";
import type { SkillLinkAction } from "./agents/skills.js";
import { synchronizeCi } from "./ci/sync.js";
import { errorMessage, CoordinatorError } from "./core/errors.js";
import {
  applyFilePlans,
  changedPlans,
  planFile,
  planFileDeletion,
} from "./core/files.js";
import {
  findWorkspaceRoot,
  loadManifest,
  renderManifest,
} from "./core/manifest.js";
import {
  coordinatorManifestSchema,
  type AgentTool,
  type CoordinatorManifest,
} from "./core/schema.js";
import { runDoctor, type DoctorResult } from "./doctor/check.js";
import {
  installMachineGitRuntime,
  installWorkspaceGitIntegration,
  invokeGitRuntime,
  uninstallMachineGitRuntime,
  uninstallWorkspaceGitIntegration,
  yamlNativeGitRuntimeActive,
} from "./git/install.js";
import { inspectWorkspace, demoWorkspaceStatus } from "./status/inspect.js";
import { renderDashboard } from "./ui/dashboard.js";
import { runLocalCompose } from "./local/compose.js";
import {
  finishWorkspacePrompt,
  promptNestedSubmoduleRepair,
  promptDashboardAction,
  promptResumeWorkspace,
  promptWorkspaceManifest,
  reportNestedSubmoduleRepair,
} from "./ui/prompts.js";
import { VERSION } from "./version.js";
import { applyUpdate, checkForUpdate } from "./update/check.js";
import {
  initializeWorkspace,
  repositoryCloneUrl,
  type InitializeOptions,
  type InitializeResult,
} from "./workspace/initialize.js";
import { migrateLegacyWorkspaceWithMetadata } from "./workspace/migrate.js";
import {
  applyNestedSubmoduleRepair,
  NestedSubmoduleRepairRequiredError,
  type NestedSubmoduleRepairResult,
} from "./workspace/nested-repair.js";
import { synchronizeWorkspace } from "./workspace/sync.js";

interface GlobalOptions {
  color: boolean;
  json: boolean;
}

function globals(program: Command): GlobalOptions {
  return program.optsWithGlobals<GlobalOptions>();
}

function writeJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function renderSkillActions(
  actions: SkillLinkAction[],
  preview: boolean,
): string {
  if (!actions.length) return "";
  const labels = preview
    ? {
        "adopt-link": "would adopt existing link",
        "create-link": "would create link",
        "delete-managed": "would remove managed entry",
        "migrate-copy": "would migrate managed copy",
        "replace-link": "would replace registry entry",
      }
    : {
        "adopt-link": "adopted existing link",
        "create-link": "created link",
        "delete-managed": "removed managed entry",
        "migrate-copy": "migrated managed copy",
        "replace-link": "replaced registry entry",
      };
  return [
    preview ? "Skill link plan:" : "Skill link changes:",
    ...actions.map((action) => {
      const destination = `.agents/skills/${action.name}`;
      const target = action.linkTarget ? ` -> ${action.linkTarget}` : "";
      return `  - ${labels[action.action]} ${destination}${target}`;
    }),
  ].join("\n");
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function repositoryFromSpec(
  spec: string,
): CoordinatorManifest["repositories"][number] {
  const separator = spec.indexOf("=");
  if (separator <= 0 || separator === spec.length - 1) {
    throw new CoordinatorError(
      `Invalid repository '${spec}'. Use role=owner/repository, role=bitbucket:workspace/repository, or role=clone-url.`,
    );
  }
  const id = spec.slice(0, separator);
  const sourceAndPath = spec.slice(separator + 1);
  const comma = sourceAndPath.lastIndexOf(",");
  const source = comma > 0 ? sourceAndPath.slice(0, comma) : sourceAndPath;
  const repositoryPath =
    comma > 0
      ? sourceAndPath.slice(comma + 1)
      : source.replace(/\.git$/, "").split(/[/:]/).at(-1)!;
  return {
    id,
    path: repositoryPath,
    url: repositoryCloneUrl(source),
    branch: { mode: "mirror", readOnly: false },
    agent: { instructions: [], verify: [], skills: [] },
  };
}

function parseTools(value: string): AgentTool[] {
  const tools = value
    .split(",")
    .map((tool) => tool.trim())
    .filter(Boolean);
  const valid = new Set(["codex", "claude", "cursor", "opencode"]);
  const invalid = tools.filter((tool) => !valid.has(tool));
  if (invalid.length) throw new CoordinatorError(`Unknown agent tools: ${invalid.join(", ")}`);
  return tools as AgentTool[];
}

function summarizeChanges(result: ReturnType<typeof synchronizeWorkspace>): object {
  return {
    changed: result.changed,
    git: result.git.action,
    agents: changedPlans(result.agents.files).map((file) => ({
      path: file.relativePath,
      action: file.action,
    })),
    skills: result.agents.skills,
    skillActions: result.agents.skillActions,
    skillMigrations: result.agents.skillMigrations,
    ci: changedPlans(result.ci.files).map((file) => ({
      path: file.relativePath,
      action: file.action,
    })),
  };
}

function renderDoctor(result: DoctorResult, color: boolean): string {
  const style = {
    pass: (value: string) => (color ? pc.green(value) : value),
    warn: (value: string) => (color ? pc.yellow(value) : value),
    fail: (value: string) => (color ? pc.red(value) : value),
  };
  return result.checks
    .map((item) => {
      const icon = item.status === "pass" ? "●" : item.status === "warn" ? "◆" : "×";
      return `${style[item.status](icon)} ${item.label.padEnd(24)} ${item.detail}`;
    })
    .join("\n");
}

async function showStatus(program: Command): Promise<void> {
  const loaded = loadManifest();
  const status = inspectWorkspace(loaded.root, loaded.manifest, VERSION);
  const options = globals(program);
  if (options.json) writeJson(status);
  else process.stdout.write(`${renderDashboard(status, { color: options.color })}\n`);
}

async function showDoctor(program: Command): Promise<void> {
  const loaded = loadManifest();
  const result = runDoctor(loaded.root, loaded.manifest, VERSION);
  const options = globals(program);
  if (options.json) writeJson(result);
  else {
    process.stdout.write(`${renderDoctor(result, options.color)}\n`);
    process.stdout.write(
      result.healthy
        ? pc.green("\nWorkspace ready.\n")
        : pc.red("\nWorkspace needs attention.\n"),
    );
  }
  if (!result.healthy) process.exitCode = 1;
}

const MAX_NESTED_SUBMODULE_REPAIRS = 8;

async function initializeWorkspaceWithRepairs(
  directory: string,
  manifest: CoordinatorManifest,
  options: InitializeOptions,
  interactive: boolean,
): Promise<{
  repairs: NestedSubmoduleRepairResult[];
  result: InitializeResult;
}> {
  const repairs: NestedSubmoduleRepairResult[] = [];
  const appliedPlans = new Set<string>();
  while (true) {
    try {
      return {
        repairs,
        result: initializeWorkspace(directory, manifest, VERSION, options),
      };
    } catch (error) {
      if (!(error instanceof NestedSubmoduleRepairRequiredError) || !interactive) {
        throw error;
      }
      if (
        repairs.length >= MAX_NESTED_SUBMODULE_REPAIRS ||
        appliedPlans.has(error.plan.id)
      ) {
        throw new CoordinatorError(
          `Nested submodule repair could not make progress for plan '${error.plan.id}'. Partial workspace preserved at ${error.plan.root}.`,
          "NESTED_SUBMODULE_REPAIR_RETRY_EXHAUSTED",
        );
      }
      const candidateRevision = await promptNestedSubmoduleRepair(error.plan);
      if (!candidateRevision) {
        throw new CoordinatorError(
          `Nested repair was not applied. Partial workspace preserved at ${error.plan.root}. Rerun 'coordinator init --resume' after repairing the remote or when ready to approve a verified local repair.`,
          "INCOMPLETE_INITIALIZATION",
        );
      }
      const repair = applyNestedSubmoduleRepair(error.plan, {
        approveLocalCommit: true,
        candidateRevision,
      });
      appliedPlans.add(error.plan.id);
      repairs.push(repair);
      reportNestedSubmoduleRepair(repair);
    }
  }
}

async function home(program: Command): Promise<void> {
  const root = findWorkspaceRoot();
  if (!root) {
    if (!process.stdin.isTTY) {
      program.help();
      return;
    }
    const prompted = await promptWorkspaceManifest(process.cwd());
    await initializeWorkspaceWithRepairs(
      process.cwd(),
      prompted.manifest,
      { discoverSkills: prompted.discoverSkills },
      !globals(program).json && Boolean(process.stdin.isTTY && process.stdout.isTTY),
    );
    finishWorkspacePrompt();
    await showStatus(program);
    return;
  }
  await showStatus(program);
  if (!process.stdin.isTTY) return;
  const action = await promptDashboardAction();
  if (action === "sync") {
    const loaded = loadManifest(root);
    const result = synchronizeWorkspace(loaded.root, loaded.manifest, VERSION);
    process.stdout.write(result.changed ? "Workspace synchronized.\n" : "Workspace already synchronized.\n");
  } else if (action === "doctor") {
    await showDoctor(program);
  } else if (action === "status") {
    await showStatus(program);
  }
}

const directComposeArguments =
  process.argv[2] === "compose" ? process.argv.slice(3) : null;
const jsonRequested =
  directComposeArguments === null && process.argv.includes("--json");
const program = new Command();
if (jsonRequested) {
  program.configureOutput({ writeErr: () => {} });
}
program.exitOverride();
program
  .name("coordinator")
  .description("Beautiful multi-repository Git, agent, and delivery coordination.")
  .version(VERSION)
  .option("--json", "print machine-readable JSON", false)
  .option("--no-color", "disable terminal colors")
  .showSuggestionAfterError()
  .showHelpAfterError()
  .action(async () => home(program));

program
  .command("init")
  .description("initialize a coordinator in an empty or existing directory")
  .argument("[directory]", "workspace directory", ".")
  .option("-n, --name <name>", "workspace name")
  .option(
    "-r, --repo <spec>",
    "repository role=owner/repo, role=bitbucket:workspace/repo, or role=clone-url[,path]",
    collect,
    [],
  )
  .option("--tools <tools>", "comma-separated agent runtimes", "codex,claude")
  .option("--discover-skills", "discover committed skills after cloning", false)
  .option("--resume", "resume an interrupted initialization from coordinator.yaml")
  .option("--no-submodules", "write configuration without cloning repositories")
  .option("--no-hooks", "configuration only: skip runtime installation, hooks, attach, and check")
  .option("--dry-run", "show the initialization contract without writing")
  .option("--force", "adopt conflicting generated destinations")
  .action(async (directory: string, options: {
    name?: string;
    repo: string[];
    tools: string;
    discoverSkills: boolean;
    submodules: boolean;
    hooks: boolean;
    resume?: boolean;
    dryRun?: boolean;
    force?: boolean;
  }) => {
    let targetDirectory = directory;
    let manifest: CoordinatorManifest;
    let discoverSkills = options.discoverSkills;
    let interactive = false;
    if (options.resume) {
      if (options.repo.length || options.name) {
        throw new CoordinatorError(
          "--resume cannot be combined with --repo or --name; it uses the existing coordinator.yaml.",
          "INVALID_RESUME_OPTIONS",
        );
      }
      const loaded = loadManifest(directory);
      targetDirectory = loaded.root;
      manifest = loaded.manifest;
      interactive =
        !globals(program).json &&
        Boolean(process.stdin.isTTY && process.stdout.isTTY);
      if (interactive) {
        discoverSkills = await promptResumeWorkspace(
          loaded.root,
          loaded.manifest.name,
        );
      }
    } else if (!options.repo.length) {
      if (!process.stdin.isTTY) {
        throw new CoordinatorError("At least one --repo is required without an interactive terminal.");
      }
      interactive = true;
      const prompted = await promptWorkspaceManifest(directory);
      manifest = prompted.manifest;
      discoverSkills = prompted.discoverSkills;
    } else {
      manifest = coordinatorManifestSchema.parse({
        schemaVersion: 2,
        name: options.name ?? slug(path.basename(path.resolve(directory))),
        remote: "origin",
        repositories: options.repo.map(repositoryFromSpec),
        agents: {
          tools: parseTools(options.tools),
          maxParallel: Math.min(4, options.repo.length),
          skillCollision: "error",
        },
      });
    }
    const initialized = await initializeWorkspaceWithRepairs(
      targetDirectory,
      manifest,
      {
        addSubmodules: options.submodules,
        dryRun: options.dryRun,
        discoverSkills,
        gitStdio: globals(program).json ? "pipe" : "inherit",
        installHooks: options.hooks,
        force: options.force,
      },
      interactive &&
        !globals(program).json &&
        !options.dryRun &&
        Boolean(process.stdout.isTTY),
    );
    const { repairs, result } = initialized;
    if (options.dryRun) {
      writeJson({
        directory: path.resolve(targetDirectory),
        manifest,
        discoverSkills,
        repairs,
        result,
      });
      return;
    }
    if (interactive) finishWorkspacePrompt();
    if (globals(program).json) writeJson(result);
    else {
      process.stdout.write(
        `Initialized ${manifest.name} with ${manifest.repositories.length} repositories.\n`,
      );
      process.stdout.write(`${result.gitIntegration.detail}\n`);
      if (repairs.length) {
        process.stdout.write(
          `${repairs.length} local nested-submodule repair commit${repairs.length === 1 ? "" : "s"} created; no push was performed. A later coordinated push can publish ${repairs.length === 1 ? "it" : "them"}.\n`,
        );
      }
      if (result.gitIntegration.missingSubmodules.length) {
        process.stdout.write(
          "Next: rerun init with the same repositories and submodule cloning enabled before using ordinary Git.\n",
        );
      } else if (result.gitIntegration.mode === "configuration-only") {
        process.stdout.write(
          "Next: coordinator git install && coordinator git attach && coordinator git check\n",
        );
      } else {
        process.stdout.write("Next: git add . && git commit -m \"Initialize coordinator\"\n");
      }
    }
  });

program.command("status").description("show the workspace dashboard").action(() => showStatus(program));

program
  .command("demo")
  .description("render a deterministic product dashboard")
  .action(() => {
    const options = globals(program);
    const status = demoWorkspaceStatus(VERSION);
    if (options.json) writeJson(status);
    else process.stdout.write(`${renderDashboard(status, { color: options.color })}\n`);
  });

program.command("doctor").description("validate the complete workspace contract").action(() => showDoctor(program));

program
  .command("sync")
  .description("synchronize agent, skill, and CI outputs and retire an owned legacy Git adapter")
  .option("--check", "fail when generated outputs are stale")
  .option("--force", "preview or adopt conflicting generated and skill destinations")
  .action((options: { check?: boolean; force?: boolean }) => {
    const loaded = loadManifest();
    const result = synchronizeWorkspace(loaded.root, loaded.manifest, VERSION, options);
    const summary = summarizeChanges(result);
    if (globals(program).json) writeJson(summary);
    else if (options.check) {
      const migrationDetail = result.agents.skillMigrations.length
        ? ` ${result.agents.skillMigrations.length} managed skill ${result.agents.skillMigrations.length === 1 ? "copy would migrate" : "copies would migrate"} to relative source ${result.agents.skillMigrations.length === 1 ? "link" : "links"}.`
        : "";
      process.stdout.write(
        `${result.changed ? "Generated workspace outputs are stale" : "Generated workspace outputs are current"}.${migrationDetail}\n`,
      );
    } else {
      const migrationDetail = result.agents.skillMigrations.length
        ? ` Migrated ${result.agents.skillMigrations.length} managed skill ${result.agents.skillMigrations.length === 1 ? "copy" : "copies"} to relative source ${result.agents.skillMigrations.length === 1 ? "link" : "links"}.`
        : "";
      process.stdout.write(
        `${result.changed ? "Workspace synchronized; generated outputs updated" : "Workspace already synchronized"}.${migrationDetail}\n`,
      );
    }
    const renderedSkillActions = renderSkillActions(
      result.agents.skillActions,
      Boolean(options.check),
    );
    if (!globals(program).json && renderedSkillActions) {
      process.stdout.write(`${renderedSkillActions}\n`);
    }
    if (options.check && result.changed) process.exitCode = 1;
  });

const agents = program.command("agents").description("manage tool-specific agents and portable skills");
for (const mode of ["sync", "check"] as const) {
  agents
    .command(mode)
    .description(
      mode === "sync"
        ? "synchronize agents and relative source skill links"
        : "preview generated agents and relative source skill links",
    )
    .option(
      "--force",
      mode === "sync"
        ? "adopt or replace conflicting generated and skill destinations"
        : "preview adoption or replacement of conflicting skill destinations",
    )
    .action((options: { force?: boolean }) => {
      const loaded = loadManifest();
      const result = synchronizeAgents(loaded.root, loaded.manifest, VERSION, {
        check: mode === "check",
        force: options.force,
      });
      const summary = {
        managed: loaded.manifest.agents.manage !== false,
        changed: result.changed,
        skills: result.skills,
        skillActions: result.skillActions,
        skillMigrations: result.skillMigrations,
        files: changedPlans(result.files).map((file) => file.relativePath),
      };
      if (globals(program).json) writeJson(summary);
      else if (loaded.manifest.agents.manage === false) {
        process.stdout.write(
          "Agent management is disabled; existing agent and skill files were left untouched.\n",
        );
      }
      else if (mode === "check") {
        const migrationDetail = result.skillMigrations.length
          ? ` ${result.skillMigrations.length} managed skill ${result.skillMigrations.length === 1 ? "copy would migrate to a relative source link" : "copies would migrate to relative source links"}.`
          : "";
        process.stdout.write(
          `${result.skills.length} skill links; ${result.changed ? "generated agent and skill outputs are stale" : "generated agent and skill outputs are current"}.${migrationDetail}\n`,
        );
      } else {
        const migrationDetail = result.skillMigrations.length
          ? ` Migrated ${result.skillMigrations.length} managed skill ${result.skillMigrations.length === 1 ? "copy to a relative source link" : "copies to relative source links"}.`
          : "";
        process.stdout.write(
          `${result.skills.length} skill links; ${result.changed ? "agent and skill outputs synchronized" : "agent and skill outputs already synchronized"}.${migrationDetail}\n`,
        );
      }
      const renderedSkillActions = renderSkillActions(
        result.skillActions,
        mode === "check",
      );
      if (!globals(program).json && renderedSkillActions) {
        process.stdout.write(`${renderedSkillActions}\n`);
      }
      if (mode === "check" && result.changed) process.exitCode = 1;
    });
}

const ci = program.command("ci").description("generate coordinated GitHub Actions delivery workflows");
for (const mode of ["sync", "check"] as const) {
  ci.command(mode)
    .description(mode === "sync" ? "generate CI/CD files" : "verify generated CI/CD files")
    .option("--force", "adopt conflicting generated destinations")
    .action((options: { force?: boolean }) => {
      const loaded = loadManifest();
      const result = synchronizeCi(loaded.root, loaded.manifest, {
        check: mode === "check",
        force: options.force,
      });
      if (globals(program).json) writeJson(result);
      else if (mode === "check") {
        process.stdout.write(
          `${result.changed ? "Generated CI/CD files are stale" : "Generated CI/CD files are current"}.\n`,
        );
      } else {
        process.stdout.write(
          `${result.changed ? "CI/CD synchronized; generated files updated" : "CI/CD already synchronized"}.\n`,
        );
      }
      if (mode === "check" && result.changed) process.exitCode = 1;
    });
}

const git = program.command("git").description("operate the embedded Git runtime");
for (const command of ["install", "uninstall", "attach", "check"] as const) {
  git.command(command)
    .description(
      command === "install"
        ? "install the embedded runtime and this workspace's Git integration"
        : command === "uninstall"
          ? "remove this workspace's Git integration"
          : `${command} the workspace Git integration`,
    )
    .action(() => {
      const root = findWorkspaceRoot() ?? process.cwd();
      const json = globals(program).json;
      const runtime =
        command === "install"
          ? installMachineGitRuntime({ stdio: json ? "pipe" : "inherit" })
          : null;
      const result = command === "install"
        ? installWorkspaceGitIntegration(root, {
            stdio: json ? "pipe" : "inherit",
          })
        : command === "uninstall"
          ? uninstallWorkspaceGitIntegration(root, {
              stdio: json ? "pipe" : "inherit",
            })
          : invokeGitRuntime(command, root, {
              stdio: json ? "pipe" : "inherit",
            });
      if (json) {
        writeJson({
          command,
          root,
          runtime,
          result,
        });
      }
      if ("status" in result && result.status !== 0) {
        process.exitCode = result.status;
      }
    });
}

program
  .command("compose")
  .description("run Docker Compose from the local.compose manifest configuration")
  .argument("[args...]", "arguments forwarded to docker compose")
  .allowUnknownOption(true)
  .allowExcessArguments(true)
  .helpOption(false)
  .action((argumentsList: string[]) => {
    const loaded = loadManifest();
    const result = runLocalCompose(loaded.root, loaded.manifest, argumentsList);
    if (result.status !== 0) process.exitCode = result.status;
  });

program
  .command("install")
  .description("install or refresh the transparent Git runtime on this machine")
  .action(() => {
    const json = globals(program).json;
    const result = installMachineGitRuntime({
      stdio: json ? "pipe" : "inherit",
    });
    if (json) writeJson(result);
  });

program
  .command("uninstall")
  .description("remove the managed transparent Git runtime from this machine")
  .action(() => {
    const json = globals(program).json;
    const result = uninstallMachineGitRuntime({
      stdio: json ? "pipe" : "inherit",
    });
    if (json) writeJson(result);
  });

program
  .command("update")
  .description("check for or install the latest private release")
  .option("--apply", "install the latest release")
  .action((options: { apply?: boolean }) => {
    const status = checkForUpdate(VERSION);
    let applied = false;
    if (options.apply && status.tag && status.updateAvailable) {
      applyUpdate(status.tag, {
        stdio: globals(program).json ? "pipe" : "inherit",
      });
      applied = true;
    }
    if (globals(program).json) writeJson({ ...status, applied });
    else if (!status.latest) {
      process.stdout.write("No published release is available yet.\n");
    } else if (status.updateAvailable) {
      process.stdout.write(
        options.apply
          ? `Updated Agent Coordinator to ${status.latest}.\n`
          : `Agent Coordinator ${status.latest} is available. Run coordinator update --apply.\n`,
      );
    } else {
      process.stdout.write(`Agent Coordinator ${VERSION} is current.\n`);
    }
  });

program
  .command("migrate")
  .description("create coordinator.yaml from an existing .git-coordinator.json")
  .argument("[directory]", "legacy workspace", ".")
  .option("--write", "write coordinator.yaml instead of printing it")
  .option("--adopt-git", "remove legacy Git files after absorbing their configuration")
  .option("--force", "replace an existing project-owned manifest")
  .action((directory: string, options: {
    adoptGit?: boolean;
    write?: boolean;
    force?: boolean;
  }) => {
    const root = path.resolve(directory);
    const migration = migrateLegacyWorkspaceWithMetadata(root);
    const manifest = migration.manifest;
    const content = renderManifest(manifest);
    if (!options.write) {
      if (options.adoptGit) {
        throw new CoordinatorError("--adopt-git requires --write after reviewing the preview.");
      }
      if (globals(program).json) writeJson({ root, manifest, yaml: content });
      else process.stdout.write(content);
      return;
    }
    const plans = [
      planFile(root, "coordinator.yaml", content, {
        force: options.force,
        owned: () => false,
      }),
    ];
    if (options.adoptGit) {
      if (!yamlNativeGitRuntimeActive(root)) {
        throw new CoordinatorError(
          "Refusing to remove legacy Git files before the YAML-native runtime is active. First run migrate --write, then coordinator git install, then retry with --write --adopt-git.",
          "GIT_COORDINATOR_YAML_RUNTIME_REQUIRED",
        );
      }
      plans.push(
        planFileDeletion(root, ".git-coordinator.json", () => true),
      );
      if (migration.embeddedWorkspacePath) {
        plans.push(
          planFileDeletion(root, migration.embeddedWorkspacePath, () => true),
        );
      }
    }
    applyFilePlans(plans);
    const result = plans.map((plan) => ({
      path: plan.path,
      action: plan.action,
    }));
    if (globals(program).json) writeJson(result);
    else {
      for (const plan of plans) process.stdout.write(`${plan.action}: ${plan.path}\n`);
      process.stdout.write(
        "Agent management remains disabled; existing agent and skill files were left untouched.\n",
      );
      process.stdout.write(
        options.adoptGit
          ? "Next: run coordinator git attach and coordinator doctor.\n"
          : "Next: review coordinator.yaml, run coordinator git install, then rerun with --write --adopt-git to remove the absorbed legacy Git files.\n",
      );
    }
  });

function handleCliError(error: unknown): void {
  if (error instanceof CommanderError) {
    if (error.exitCode === 0) return;
    if (jsonRequested) writeJson({ error: error.message, code: error.code });
    process.exitCode = error.exitCode || 1;
    return;
  }
  if (error instanceof CoordinatorError && error.code === "CANCELLED") {
    process.exitCode = 0;
    return;
  }
  const options = program.opts<GlobalOptions>();
  if (options.json || jsonRequested) {
    writeJson({
      error: errorMessage(error),
      code: error instanceof CoordinatorError ? error.code : "UNEXPECTED_ERROR",
      ...(error instanceof NestedSubmoduleRepairRequiredError
        ? { repairPlan: error.plan }
        : {}),
    });
  } else {
    process.stderr.write(`${pc.red("×")} ${errorMessage(error)}\n`);
  }
  process.exitCode = 1;
}

const execution = directComposeArguments
  ? Promise.resolve().then(() => {
      const loaded = loadManifest();
      const result = runLocalCompose(
        loaded.root,
        loaded.manifest,
        directComposeArguments,
      );
      if (result.status !== 0) process.exitCode = result.status;
    })
  : program.parseAsync(process.argv);

execution.catch(handleCliError);
