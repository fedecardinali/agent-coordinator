import { spawnSync } from "node:child_process";
import { CoordinatorError } from "./errors.js";

export interface CommandResult {
  status: number;
  stdout: string;
  stderr: string;
}

export interface RunCommandOptions {
  cwd?: string | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  allowFailure?: boolean | undefined;
  input?: string | undefined;
  stdio?: "pipe" | "inherit" | undefined;
}

export function runCommand(
  command: string,
  argumentsList: string[],
  options: RunCommandOptions = {},
): CommandResult {
  const stdio = options.stdio ?? "pipe";
  const result = spawnSync(command, argumentsList, {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    encoding: "utf8",
    input: options.input,
    stdio,
  });
  if (result.error) {
    throw new CoordinatorError(
      `Could not execute '${command}': ${result.error.message}`,
      "COMMAND_NOT_FOUND",
    );
  }
  const status = result.status ?? 1;
  const output: CommandResult = {
    status,
    stdout: typeof result.stdout === "string" ? result.stdout.trim() : "",
    stderr: typeof result.stderr === "string" ? result.stderr.trim() : "",
  };
  if (status !== 0 && !options.allowFailure) {
    const detail = output.stderr || output.stdout || `exit ${status}`;
    throw new CoordinatorError(
      `'${command} ${argumentsList.join(" ")}' failed: ${detail}`,
      "COMMAND_FAILED",
    );
  }
  return output;
}

export function commandAvailable(command: string): boolean {
  return runCommand("sh", ["-c", "command -v -- \"$1\" >/dev/null 2>&1", "sh", command], {
    allowFailure: true,
  }).status === 0;
}
