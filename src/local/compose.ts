import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { runCommand, type CommandResult } from "../core/command.js";
import { CoordinatorError } from "../core/errors.js";
import type { CoordinatorManifest } from "../core/schema.js";

export interface LocalComposeOptions {
  environment?: NodeJS.ProcessEnv | undefined;
  stdio?: "pipe" | "inherit" | undefined;
}

export function runLocalCompose(
  root: string,
  manifest: CoordinatorManifest,
  argumentsList: string[],
  options: LocalComposeOptions = {},
): CommandResult {
  const compose = manifest.local?.compose;
  if (!compose) {
    throw new CoordinatorError(
      "coordinator.yaml does not declare local.compose.",
      "COMPOSE_NOT_CONFIGURED",
    );
  }

  const resolvedRoot = path.resolve(root);
  const temporaryDirectory = mkdtempSync(
    path.join(os.tmpdir(), "agent-coordinator-compose-"),
  );
  const overridePath = path.join(temporaryDirectory, "compose.override.yaml");
  try {
    writeFileSync(
      overridePath,
      compose.override.endsWith("\n")
        ? compose.override
        : `${compose.override}\n`,
      { mode: 0o600 },
    );
    return runCommand(
      "docker",
      [
        "compose",
        "--project-directory",
        path.resolve(resolvedRoot, compose.projectDirectory),
        ...compose.files.flatMap((file) => [
          "-f",
          path.resolve(resolvedRoot, file),
        ]),
        "-f",
        overridePath,
        ...argumentsList,
      ],
      {
        allowFailure: true,
        cwd: resolvedRoot,
        env: options.environment,
        stdio: options.stdio ?? "inherit",
      },
    );
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}
