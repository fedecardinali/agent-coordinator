import { randomUUID } from "node:crypto";
import {
  accessSync,
  chmodSync,
  constants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmdirSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { runCommand, type CommandResult } from "../core/command.js";
import { CoordinatorError, errorMessage } from "../core/errors.js";

const MANAGED_MARKERS = [
  "agent-coordinator-git-wrapper-v1",
  "git-coordinator-wrapper-v1",
  "market-intel-coordinated-git-v1",
];
const COORDINATED_HOOKS = ["post-checkout", "pre-commit", "pre-push"] as const;
const HOOK_DIRECTORY_MARKER = ".agent-coordinator-owned";
const HOOK_DIRECTORY_MARKER_CONTENT = "Managed by Agent Coordinator.\n";

export interface GitRuntimeOptions {
  allowFailure?: boolean | undefined;
  environment?: NodeJS.ProcessEnv | undefined;
  stdio?: "pipe" | "inherit" | undefined;
}

function environmentFor(options?: GitRuntimeOptions): NodeJS.ProcessEnv {
  return options?.environment ?? process.env;
}

function homeDirectory(environment: NodeJS.ProcessEnv): string {
  return environment.HOME ? path.resolve(environment.HOME) : os.homedir();
}

export function agentCoordinatorHome(
  environment: NodeJS.ProcessEnv = process.env,
): string {
  return path.resolve(
    environment.AGENT_COORDINATOR_HOME ??
      path.join(homeDirectory(environment), ".local", "share", "agent-coordinator"),
  );
}

function legacyGitCoordinatorHome(environment: NodeJS.ProcessEnv): string {
  return path.resolve(
    environment.GIT_COORDINATOR_HOME ??
      path.join(homeDirectory(environment), ".local", "share", "git-coordinator"),
  );
}

export function installedGitRuntimePath(
  environment: NodeJS.ProcessEnv = process.env,
): string {
  return path.join(agentCoordinatorHome(environment), "git-runtime", "git-wrapper.mjs");
}

export function embeddedGitRuntimeSourcePath(
  _environment: NodeJS.ProcessEnv = process.env,
): string {
  const candidates = [
    path.resolve(import.meta.dirname, "git-wrapper.mjs"),
    path.resolve(import.meta.dirname, "../../dist/git-wrapper.mjs"),
  ];
  const source = candidates.find((candidate) => existsSync(candidate));
  if (!source) {
    throw new CoordinatorError(
      "The embedded Git runtime is missing from this Agent Coordinator installation. Reinstall Agent Coordinator and retry.",
      "EMBEDDED_GIT_RUNTIME_MISSING",
    );
  }
  return source;
}

function realGit(environment: NodeJS.ProcessEnv): string {
  return (
    environment.GIT_COORDINATOR_REAL_GIT ??
    environment.COORDINATED_GIT_REAL ??
    "/usr/bin/git"
  );
}

function canonicalPath(value: string): string {
  try {
    return realpathSync(value);
  } catch {
    return path.resolve(value);
  }
}

function pathPresent(value: string): boolean {
  try {
    lstatSync(value);
    return true;
  } catch {
    return false;
  }
}

function pathInside(candidate: string, parent: string): boolean {
  const relative = path.relative(canonicalPath(parent), canonicalPath(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function fileHasManagedMarker(candidate: string): boolean {
  try {
    const contents = readFileSync(candidate, "utf8");
    return MANAGED_MARKERS.some((marker) => contents.includes(marker));
  } catch {
    return false;
  }
}

function isManagedExecutable(
  candidate: string,
  environment: NodeJS.ProcessEnv,
): boolean {
  if (!pathPresent(candidate)) return false;
  const metadata = lstatSync(candidate);
  if (metadata.isSymbolicLink()) {
    const target = path.resolve(path.dirname(candidate), readlinkSync(candidate));
    if (
      pathInside(target, agentCoordinatorHome(environment)) ||
      pathInside(target, legacyGitCoordinatorHome(environment))
    ) {
      return true;
    }
    return fileHasManagedMarker(target);
  }
  return metadata.isFile() && fileHasManagedMarker(candidate);
}

function ensureManagedOrAbsent(
  candidate: string,
  environment: NodeJS.ProcessEnv,
): void {
  if (pathPresent(candidate) && !isManagedExecutable(candidate, environment)) {
    throw new CoordinatorError(
      `Refusing to replace unmanaged executable: ${candidate}`,
      "UNMANAGED_GIT_EXECUTABLE",
    );
  }
}

function writableBinDirectory(environment: NodeJS.ProcessEnv): string {
  const explicit =
    environment.AGENT_COORDINATOR_GIT_BIN_DIR ??
    environment.GIT_COORDINATOR_BIN_DIR;
  if (explicit) {
    const resolved = path.resolve(explicit);
    try {
      accessSync(resolved, constants.W_OK);
    } catch {
      throw new CoordinatorError(
        `Git shim directory is not writable: ${resolved}`,
        "GIT_BIN_DIRECTORY_UNAVAILABLE",
      );
    }
    return resolved;
  }

  const entries = (environment.PATH ?? "")
    .split(path.delimiter)
    .filter(Boolean)
    .map((entry) => path.resolve(entry));
  const realGitDirectory = path.dirname(canonicalPath(realGit(environment)));
  const beforeRealGit: string[] = [];
  for (const entry of entries) {
    if (canonicalPath(entry) === canonicalPath(realGitDirectory)) break;
    beforeRealGit.push(entry);
  }

  for (const preferred of ["/opt/homebrew/bin", "/usr/local/bin"]) {
    if (!beforeRealGit.some((entry) => canonicalPath(entry) === canonicalPath(preferred))) {
      continue;
    }
    try {
      accessSync(preferred, constants.W_OK);
      return preferred;
    } catch {
      // Try another persistent PATH entry.
    }
  }

  for (const entry of beforeRealGit) {
    if (
      entry.includes("/node_modules/") ||
      entry.includes("/.codex/") ||
      entry.includes("/var/run/")
    ) {
      continue;
    }
    try {
      accessSync(entry, constants.W_OK);
      return entry;
    } catch {
      // Try the next entry.
    }
  }
  throw new CoordinatorError(
    "No persistent writable PATH directory exists before the real Git binary.",
    "GIT_BIN_DIRECTORY_UNAVAILABLE",
  );
}

function result(
  message: string,
  options: GitRuntimeOptions,
): CommandResult {
  if ((options.stdio ?? "pipe") === "inherit") process.stdout.write(`${message}\n`);
  return { status: 0, stdout: message, stderr: "" };
}

function failedResultOrThrow(
  error: unknown,
  options: GitRuntimeOptions,
): CommandResult {
  if (options.allowFailure) {
    return { status: 1, stdout: "", stderr: errorMessage(error) };
  }
  throw error;
}

function atomicCopyExecutable(source: string, destination: string): void {
  mkdirSync(path.dirname(destination), { recursive: true });
  const temporary = path.join(
    path.dirname(destination),
    `.${path.basename(destination)}.agent-coordinator-${randomUUID()}`,
  );
  try {
    copyFileSync(source, temporary);
    chmodSync(temporary, 0o755);
    renameSync(temporary, destination);
  } finally {
    if (pathPresent(temporary)) unlinkSync(temporary);
  }
}

function atomicSymlink(source: string, destination: string): void {
  const temporary = path.join(
    path.dirname(destination),
    `.${path.basename(destination)}.agent-coordinator-${randomUUID()}`,
  );
  try {
    symlinkSync(source, temporary);
    if (pathPresent(destination)) unlinkSync(destination);
    renameSync(temporary, destination);
  } finally {
    if (pathPresent(temporary)) unlinkSync(temporary);
  }
}

export function installMachineGitRuntime(
  options: GitRuntimeOptions = {},
): CommandResult {
  try {
    const environment = environmentFor(options);
    const source = embeddedGitRuntimeSourcePath(environment);
    if (!fileHasManagedMarker(source)) {
      throw new CoordinatorError(
        `Embedded Git runtime has no recognized ownership marker: ${source}`,
        "INVALID_EMBEDDED_GIT_RUNTIME",
      );
    }
    const destination = installedGitRuntimePath(environment);
    if (pathPresent(destination) && !fileHasManagedMarker(destination)) {
      throw new CoordinatorError(
        `Refusing to replace unmanaged runtime: ${destination}`,
        "UNMANAGED_GIT_RUNTIME",
      );
    }

    const binDirectory = writableBinDirectory(environment);
    const gitExecutable = path.join(binDirectory, "git");
    const legacyCliExecutable = path.join(binDirectory, "git-coordinator");
    ensureManagedOrAbsent(gitExecutable, environment);

    atomicCopyExecutable(source, destination);
    atomicSymlink(destination, gitExecutable);
    if (
      pathPresent(legacyCliExecutable) &&
      isManagedExecutable(legacyCliExecutable, environment)
    ) {
      unlinkSync(legacyCliExecutable);
    }
    return result(
      `Agent Coordinator Git runtime installed in ${binDirectory}.`,
      options,
    );
  } catch (error) {
    return failedResultOrThrow(error, options);
  }
}

function candidateBinDirectories(environment: NodeJS.ProcessEnv): string[] {
  const explicit =
    environment.AGENT_COORDINATOR_GIT_BIN_DIR ??
    environment.GIT_COORDINATOR_BIN_DIR;
  const entries = explicit
    ? [path.resolve(explicit)]
    : (environment.PATH ?? "")
        .split(path.delimiter)
        .filter(Boolean)
        .map((entry) => path.resolve(entry));
  return [...new Set(entries)];
}

export function uninstallMachineGitRuntime(
  options: GitRuntimeOptions = {},
): CommandResult {
  try {
    const environment = environmentFor(options);
    const removed: string[] = [];
    const runtime = installedGitRuntimePath(environment);
    if (pathPresent(runtime) && !fileHasManagedMarker(runtime)) {
      throw new CoordinatorError(
        `Refusing to remove unmanaged runtime: ${runtime}`,
        "UNMANAGED_GIT_RUNTIME",
      );
    }
    for (const directory of candidateBinDirectories(environment)) {
      for (const executable of ["git", "git-coordinator"]) {
        const candidate = path.join(directory, executable);
        if (pathPresent(candidate) && isManagedExecutable(candidate, environment)) {
          unlinkSync(candidate);
          removed.push(candidate);
        }
      }
    }

    if (pathPresent(runtime)) {
      unlinkSync(runtime);
      removed.push(runtime);
    }
    const runtimeDirectory = path.dirname(runtime);
    try {
      rmdirSync(runtimeDirectory);
    } catch {
      // Preserve a non-empty directory rather than deleting unrelated files.
    }
    return result(
      removed.length
        ? `Removed ${removed.length} managed Git runtime path${removed.length === 1 ? "" : "s"}.`
        : "No managed Git runtime was installed.",
      options,
    );
  } catch (error) {
    return failedResultOrThrow(error, options);
  }
}

function git(
  environment: NodeJS.ProcessEnv,
  argumentsList: string[],
  options: { allowFailure?: boolean | undefined; cwd?: string | undefined } = {},
): CommandResult {
  return runCommand(realGit(environment), argumentsList, {
    allowFailure: options.allowFailure,
    cwd: options.cwd,
    env: {
      ...environment,
      GIT_COORDINATOR_INTERNAL: "1",
      COORDINATED_GIT_INTERNAL: "1",
    },
  });
}

function workspaceRoot(
  directory: string,
  environment: NodeJS.ProcessEnv,
): string {
  return canonicalPath(
    git(environment, ["-C", directory, "rev-parse", "--show-toplevel"]).stdout,
  );
}

function configurationExists(root: string): boolean {
  if (
    existsSync(path.join(root, "coordinator.yaml")) ||
    existsSync(path.join(root, ".git-coordinator.json"))
  ) {
    return true;
  }
  const packagePath = path.join(root, "package.json");
  if (!existsSync(packagePath)) return false;
  try {
    return Boolean(
      (JSON.parse(readFileSync(packagePath, "utf8")) as { coordinatedGit?: unknown })
        .coordinatedGit,
    );
  } catch {
    return false;
  }
}

function manifestName(root: string): string {
  if (existsSync(path.join(root, "coordinator.yaml"))) return "coordinator.yaml";
  if (existsSync(path.join(root, ".git-coordinator.json"))) {
    return ".git-coordinator.json";
  }
  return "package.json";
}

function primaryWorktree(root: string, environment: NodeJS.ProcessEnv): string {
  const line = git(environment, ["-C", root, "worktree", "list", "--porcelain"])
    .stdout.split("\n")
    .find((candidate) => candidate.startsWith("worktree "));
  if (!line) {
    throw new CoordinatorError(
      `Could not determine the primary worktree for ${root}.`,
      "GIT_WORKTREE_UNAVAILABLE",
    );
  }
  return canonicalPath(line.slice("worktree ".length));
}

function commonGitDirectory(root: string, environment: NodeJS.ProcessEnv): string {
  const common = git(environment, [
    "-C",
    root,
    "rev-parse",
    "--git-common-dir",
  ]).stdout;
  return canonicalPath(path.resolve(root, common));
}

function resolveHookPath(
  root: string,
  hookPath: string | null,
  environment: NodeJS.ProcessEnv,
): string | null {
  if (!hookPath) return null;
  return path.isAbsolute(hookPath)
    ? canonicalPath(hookPath)
    : path.resolve(primaryWorktree(root, environment), hookPath);
}

function localConfig(
  root: string,
  key: string,
  environment: NodeJS.ProcessEnv,
): string | null {
  const found = git(
    environment,
    ["-C", root, "config", "--local", "--get", key],
    { allowFailure: true },
  );
  return found.status === 0 ? found.stdout : null;
}

function setLocalConfig(
  root: string,
  key: string,
  value: string,
  environment: NodeJS.ProcessEnv,
): void {
  git(environment, ["-C", root, "config", "--local", "--replace-all", key, value]);
}

function unsetLocalConfig(
  root: string,
  key: string,
  environment: NodeJS.ProcessEnv,
): void {
  git(
    environment,
    ["-C", root, "config", "--local", "--unset-all", key],
    { allowFailure: true },
  );
}

function hookConfigurationName(hook: (typeof COORDINATED_HOOKS)[number]): string {
  return `git-coordinator-${hook}`;
}

function removeConfiguredHooks(root: string, environment: NodeJS.ProcessEnv): void {
  for (const hook of COORDINATED_HOOKS) {
    const name = hookConfigurationName(hook);
    unsetLocalConfig(root, `hook.${name}.command`, environment);
    unsetLocalConfig(root, `hook.${name}.event`, environment);
  }
}

function supportsConfiguredHooks(root: string, environment: NodeJS.ProcessEnv): boolean {
  const probe = git(
    environment,
    [
      "-C",
      root,
      "hook",
      "list",
      "--allow-unknown-hook-name",
      "agent-coordinator-capability-probe",
    ],
    { allowFailure: true },
  );
  const output = `${probe.stdout}\n${probe.stderr}`;
  if (/not a git command|unknown subcommand|unknown option|usage:/i.test(output)) {
    return false;
  }
  return probe.status === 0 || /no hooks found/i.test(output);
}

function shellDoubleQuote(value: string): string {
  return value.replace(/["\\$`]/g, "\\$&");
}

function installConfiguredHooks(
  root: string,
  runtime: string,
  environment: NodeJS.ProcessEnv,
): void {
  removeConfiguredHooks(root, environment);
  for (const hook of COORDINATED_HOOKS) {
    const name = hookConfigurationName(hook);
    const command =
      `"${shellDoubleQuote(process.execPath)}" ` +
      `"${shellDoubleQuote(runtime)}" --hook ${hook}`;
    setLocalConfig(root, `hook.${name}.command`, command, environment);
    setLocalConfig(root, `hook.${name}.event`, hook, environment);
  }
}

function writeFileHook(
  hooksDirectory: string,
  runtime: string,
  hook: (typeof COORDINATED_HOOKS)[number],
): void {
  const content = [
    "#!/bin/sh",
    "set -eu",
    `"${shellDoubleQuote(process.execPath)}" "${shellDoubleQuote(runtime)}" --hook ${hook} "$@"`,
    "",
  ].join("\n");
  writeFileSync(path.join(hooksDirectory, hook), content, { mode: 0o755 });
}

function hookPathIsManaged(
  root: string,
  hooksDirectory: string,
  configuredPath: string | null,
): boolean {
  if (!configuredPath) return false;
  const resolved = path.isAbsolute(configuredPath)
    ? configuredPath
    : path.resolve(root, configuredPath);
  return canonicalPath(resolved) === canonicalPath(hooksDirectory);
}

function managedHookFile(candidate: string): boolean {
  try {
    const contents = readFileSync(candidate, "utf8");
    return (
      contents.includes("git-wrapper.mjs") &&
      contents.includes("--hook")
    );
  } catch {
    return false;
  }
}

function hooksDirectoryOwned(
  root: string,
  hooksDirectory: string,
  currentHookPath: string | null,
  environment: NodeJS.ProcessEnv,
): boolean {
  const marker = path.join(hooksDirectory, HOOK_DIRECTORY_MARKER);
  if (
    existsSync(marker) &&
    readFileSync(marker, "utf8") === HOOK_DIRECTORY_MARKER_CONTENT
  ) {
    return true;
  }
  if (!hookPathIsManaged(root, hooksDirectory, currentHookPath)) return false;
  const mode = localConfig(root, "gitCoordinator.hookMode", environment);
  const manifest = localConfig(root, "gitCoordinator.manifest", environment);
  return mode === "configured" || mode === "files" || manifest !== null;
}

function prepareHooksDirectory(
  root: string,
  hooksDirectory: string,
  currentHookPath: string | null,
  environment: NodeJS.ProcessEnv,
): void {
  if (!existsSync(hooksDirectory)) {
    mkdirSync(hooksDirectory, { recursive: true });
    return;
  }
  const owned = hooksDirectoryOwned(
    root,
    hooksDirectory,
    currentHookPath,
    environment,
  );
  const removable: string[] = [];
  for (const entry of readdirSync(hooksDirectory)) {
    const candidate = path.join(hooksDirectory, entry);
    if (entry === HOOK_DIRECTORY_MARKER) {
      if (readFileSync(candidate, "utf8") !== HOOK_DIRECTORY_MARKER_CONTENT) {
        throw new CoordinatorError(
          `Refusing to replace unmanaged ownership marker: ${candidate}`,
          "UNMANAGED_GIT_HOOKS_DIRECTORY",
        );
      }
      continue;
    }
    if ((COORDINATED_HOOKS as readonly string[]).includes(entry)) {
      if (!managedHookFile(candidate)) {
        throw new CoordinatorError(
          `Refusing to replace unmanaged hook: ${candidate}`,
          "UNMANAGED_GIT_HOOK",
        );
      }
      removable.push(candidate);
      continue;
    }
    if (!owned) {
      throw new CoordinatorError(
        `Refusing to adopt non-empty unmanaged hooks directory: ${hooksDirectory}`,
        "UNMANAGED_GIT_HOOKS_DIRECTORY",
      );
    }
  }
  for (const candidate of removable) unlinkSync(candidate);
}

function markHooksDirectory(hooksDirectory: string): void {
  writeFileSync(
    path.join(hooksDirectory, HOOK_DIRECTORY_MARKER),
    HOOK_DIRECTORY_MARKER_CONTENT,
  );
}

function cleanManagedHooksDirectory(
  root: string,
  hooksDirectory: string,
  currentHookPath: string | null,
  environment: NodeJS.ProcessEnv,
): void {
  if (!existsSync(hooksDirectory)) return;
  if (!hooksDirectoryOwned(root, hooksDirectory, currentHookPath, environment)) {
    return;
  }
  for (const hook of COORDINATED_HOOKS) {
    const candidate = path.join(hooksDirectory, hook);
    if (existsSync(candidate) && managedHookFile(candidate)) unlinkSync(candidate);
  }
  const marker = path.join(hooksDirectory, HOOK_DIRECTORY_MARKER);
  if (
    existsSync(marker) &&
    readFileSync(marker, "utf8") === HOOK_DIRECTORY_MARKER_CONTENT
  ) {
    unlinkSync(marker);
  }
  try {
    rmdirSync(hooksDirectory);
  } catch {
    // Preserve unrelated files added to an otherwise managed directory.
  }
}

export function installWorkspaceGitIntegration(
  directory = process.cwd(),
  options: GitRuntimeOptions = {},
): CommandResult {
  try {
    const environment = environmentFor(options);
    const runtime = installedGitRuntimePath(environment);
    if (!existsSync(runtime) || !fileHasManagedMarker(runtime)) {
      throw new CoordinatorError(
        "Agent Coordinator's Git runtime is not installed. Run 'coordinator install' and retry.",
        "GIT_RUNTIME_MISSING",
      );
    }
    const root = workspaceRoot(directory, environment);
    if (!configurationExists(root)) {
      throw new CoordinatorError(
        `${root} has no coordinator.yaml or supported legacy Git configuration.`,
        "GIT_CONFIGURATION_MISSING",
      );
    }

    const hooksDirectory = path.join(
      commonGitDirectory(root, environment),
      "git-coordinator-hooks",
    );
    const currentHookPath = localConfig(root, "core.hooksPath", environment);
    const alreadyInstalled = hookPathIsManaged(
      root,
      hooksDirectory,
      currentHookPath,
    );
    prepareHooksDirectory(root, hooksDirectory, currentHookPath, environment);

    let previousHooksPath: string | null;
    if (alreadyInstalled) {
      previousHooksPath = localConfig(
        root,
        "gitCoordinator.previousHooksPath",
        environment,
      );
    } else {
      previousHooksPath = resolveHookPath(root, currentHookPath, environment);
      if (previousHooksPath) {
        setLocalConfig(
          root,
          "gitCoordinator.previousHooksPath",
          previousHooksPath,
          environment,
        );
      } else {
        unsetLocalConfig(root, "gitCoordinator.previousHooksPath", environment);
      }
    }

    const configuredHooks = supportsConfiguredHooks(root, environment);
    if (configuredHooks) {
      installConfiguredHooks(root, runtime, environment);
    } else {
      removeConfiguredHooks(root, environment);
      for (const hook of COORDINATED_HOOKS) {
        writeFileHook(hooksDirectory, runtime, hook);
      }
    }
    setLocalConfig(root, "core.hooksPath", hooksDirectory, environment);
    setLocalConfig(
      root,
      "gitCoordinator.hookMode",
      configuredHooks ? "configured" : "files",
      environment,
    );
    setLocalConfig(root, "gitCoordinator.manifest", manifestName(root), environment);
    markHooksDirectory(hooksDirectory);

    return result(
      previousHooksPath
        ? `Agent Coordinator Git integration installed; previous hooks remain preserved at ${previousHooksPath}.`
        : "Agent Coordinator Git integration installed.",
      options,
    );
  } catch (error) {
    return failedResultOrThrow(error, options);
  }
}

export function uninstallWorkspaceGitIntegration(
  directory = process.cwd(),
  options: GitRuntimeOptions = {},
): CommandResult {
  try {
    const environment = environmentFor(options);
    const root = workspaceRoot(directory, environment);
    const hooksDirectory = path.join(
      commonGitDirectory(root, environment),
      "git-coordinator-hooks",
    );
    const previousHooksPath = localConfig(
      root,
      "gitCoordinator.previousHooksPath",
      environment,
    );
    const currentHookPath = localConfig(root, "core.hooksPath", environment);
    const managedHookPathActive = hookPathIsManaged(
      root,
      hooksDirectory,
      currentHookPath,
    );

    removeConfiguredHooks(root, environment);
    cleanManagedHooksDirectory(
      root,
      hooksDirectory,
      currentHookPath,
      environment,
    );
    if (managedHookPathActive) {
      if (previousHooksPath) {
        setLocalConfig(root, "core.hooksPath", previousHooksPath, environment);
      } else {
        unsetLocalConfig(root, "core.hooksPath", environment);
      }
    }
    unsetLocalConfig(root, "gitCoordinator.previousHooksPath", environment);
    unsetLocalConfig(root, "gitCoordinator.hookMode", environment);
    unsetLocalConfig(root, "gitCoordinator.manifest", environment);
    return result("Agent Coordinator workspace Git integration removed.", options);
  } catch (error) {
    return failedResultOrThrow(error, options);
  }
}

export function invokeGitRuntime(
  mode: "check" | "attach",
  directory = process.cwd(),
  options: GitRuntimeOptions = {},
): CommandResult {
  const environment = environmentFor(options);
  const runtime = installedGitRuntimePath(environment);
  if (!existsSync(runtime) || !fileHasManagedMarker(runtime)) {
    const error = new CoordinatorError(
      "Agent Coordinator's Git runtime is not installed. Run 'coordinator install' and retry.",
      "GIT_RUNTIME_MISSING",
    );
    return failedResultOrThrow(error, options);
  }
  const execution = runCommand(process.execPath, [runtime, `--${mode}`], {
    allowFailure: true,
    cwd: path.resolve(directory),
    env: environment,
  });
  if ((options.stdio ?? "pipe") === "inherit") {
    if (execution.stdout) process.stdout.write(`${execution.stdout}\n`);
    if (execution.stderr) process.stderr.write(`${execution.stderr}\n`);
  }
  if (execution.status !== 0 && !options.allowFailure) {
    throw new CoordinatorError(
      `Git runtime ${mode} failed: ${execution.stderr || execution.stdout || `exit ${execution.status}`}`,
      "COMMAND_FAILED",
    );
  }
  return execution;
}

export function yamlNativeGitRuntimeActive(root: string): boolean {
  const environment = process.env;
  const configured = git(
    environment,
    ["-C", root, "config", "--local", "--get", "gitCoordinator.manifest"],
    { allowFailure: true },
  );
  return configured.status === 0 && configured.stdout === "coordinator.yaml";
}
