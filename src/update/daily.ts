import { randomUUID } from "node:crypto";
import {
  closeSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { agentCoordinatorHome } from "../git/install.js";
import { applyUpdate, type UpdateStatus } from "./check.js";

const CACHE_OWNER = "Agent Coordinator";
const CACHE_SCHEMA_VERSION = 1;
export const DAILY_UPDATE_TIMEOUT_MS = 3_000;

interface DailyUpdateCache {
  lastAttemptDate: string;
  owner: typeof CACHE_OWNER;
  schemaVersion: typeof CACHE_SCHEMA_VERSION;
}

export interface DailyUpdateContext {
  argv: readonly string[];
  environment: NodeJS.ProcessEnv;
  stdinIsTTY: boolean;
  stdoutIsTTY: boolean;
}

export type DailyUpdateOutcome =
  | "applied"
  | "apply-failed"
  | "cache-unavailable"
  | "check-failed"
  | "current"
  | "declined"
  | "skipped";

export interface DailyUpdateOptions {
  apply?: ((tag: string) => unknown) | undefined;
  cachePath?: string | undefined;
  check?:
    | ((current: string, timeoutMs: number) => Promise<UpdateStatus>)
    | undefined;
  confirmUpdate: (status: UpdateStatus) => Promise<boolean>;
  context?: DailyUpdateContext | undefined;
  currentVersion: string;
  now?: (() => Date) | undefined;
  timeoutMs?: number | undefined;
}

function enabledEnvironmentValue(value: string | undefined): boolean {
  return Boolean(value && value !== "0" && value.toLowerCase() !== "false");
}

export function shouldCheckForDailyUpdate(context: DailyUpdateContext): boolean {
  if (!context.stdinIsTTY || !context.stdoutIsTTY) return false;
  if (enabledEnvironmentValue(context.environment.CI)) return false;
  if (
    enabledEnvironmentValue(
      context.environment.AGENT_COORDINATOR_DAILY_UPDATE_CHILD,
    )
  ) {
    return false;
  }

  const excludedOptions = new Set([
    "--json",
    "--help",
    "-h",
    "--version",
    "-V",
  ]);
  if (context.argv.some((argument) => excludedOptions.has(argument))) return false;

  const excludedModes = new Set([
    "completion",
    "completions",
    "install",
    "recover",
    "uninstall",
    "update",
  ]);
  return !context.argv.some((argument) => excludedModes.has(argument));
}

export function dailyUpdateCachePath(
  environment: NodeJS.ProcessEnv = process.env,
): string {
  return path.join(
    agentCoordinatorHome(environment),
    "cache",
    "daily-update.json",
  );
}

function localDate(now: Date): string {
  const year = String(now.getFullYear()).padStart(4, "0");
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

type CacheState = "available" | "attempted" | "unsafe";

function cacheState(cachePath: string, date: string): CacheState {
  try {
    const status = lstatSync(cachePath);
    if (!status.isFile() || status.isSymbolicLink()) return "unsafe";
    const parsed = JSON.parse(
      readFileSync(cachePath, "utf8"),
    ) as Partial<DailyUpdateCache>;
    if (
      parsed.owner !== CACHE_OWNER ||
      parsed.schemaVersion !== CACHE_SCHEMA_VERSION ||
      typeof parsed.lastAttemptDate !== "string"
    ) {
      return "unsafe";
    }
    return parsed.lastAttemptDate === date ? "attempted" : "available";
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT"
      ? "available"
      : "unsafe";
  }
}

function recordAttempt(
  cachePath: string,
  date: string,
): "attempted" | "recorded" | "unavailable" {
  const lockPath = `${cachePath}.lock`;
  const lockToken = randomUUID();
  const temporaryPath = path.join(
    path.dirname(cachePath),
    `.${path.basename(cachePath)}.${randomUUID()}`,
  );
  let lock: number | undefined;
  try {
    mkdirSync(path.dirname(cachePath), { recursive: true });
    try {
      lock = openSync(lockPath, "wx", 0o600);
      writeFileSync(
        lock,
        JSON.stringify({
          owner: CACHE_OWNER,
          schemaVersion: CACHE_SCHEMA_VERSION,
          token: lockToken,
        }),
      );
    } catch {
      if (lock !== undefined) {
        closeSync(lock);
        lock = undefined;
      }
      return "unavailable";
    }
    closeSync(lock);
    lock = undefined;

    const current = cacheState(cachePath, date);
    if (current === "attempted") return "attempted";
    if (current === "unsafe") return "unavailable";
    try {
      const status = lstatSync(cachePath);
      if (!status.isFile() || status.isSymbolicLink()) return "unavailable";
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return "unavailable";
    }
    const cache: DailyUpdateCache = {
      lastAttemptDate: date,
      owner: CACHE_OWNER,
      schemaVersion: CACHE_SCHEMA_VERSION,
    };
    writeFileSync(temporaryPath, `${JSON.stringify(cache, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    renameSync(temporaryPath, cachePath);
    return "recorded";
  } catch {
    try {
      unlinkSync(temporaryPath);
    } catch {
      // A best-effort cache must never break the user's command.
    }
    return "unavailable";
  } finally {
    if (lock !== undefined) closeSync(lock);
    try {
      const parsed = JSON.parse(readFileSync(lockPath, "utf8")) as {
        owner?: unknown;
        token?: unknown;
      };
      if (parsed.owner === CACHE_OWNER && parsed.token === lockToken) {
        unlinkSync(lockPath);
      }
    } catch {
      // Never remove a lock that this invocation cannot prove it owns.
    }
  }
}

export function boundedUpdateCheck(
  currentVersion: string,
  timeoutMs = DAILY_UPDATE_TIMEOUT_MS,
): Promise<UpdateStatus> {
  return new Promise((resolve, reject) => {
    const entrypoint = process.argv[1];
    if (!entrypoint) {
      reject(new Error("Agent Coordinator CLI entrypoint is unavailable."));
      return;
    }

    const nodeArguments = entrypoint.endsWith(".ts")
      ? ["--import", "tsx", entrypoint, "--json", "update"]
      : [entrypoint, "--json", "update"];
    const child = spawn(process.execPath, nodeArguments, {
      env: {
        ...process.env,
        AGENT_COORDINATOR_DAILY_UPDATE_CHILD: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (operation: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      operation();
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(() => reject(new Error(`Update check exceeded ${timeoutMs}ms.`)));
    }, timeoutMs);
    timer.unref();
    child.stdout?.on("data", (chunk: Buffer | string) => {
      if (stdout.length < 64 * 1024) stdout += String(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      if (stderr.length < 8 * 1024) stderr += String(chunk);
    });
    child.once("error", (error) => finish(() => reject(error)));
    child.once("close", (code) => {
      finish(() => {
        if (code !== 0) {
          reject(new Error(stderr.trim() || `Update check exited with status ${code}.`));
          return;
        }
        try {
          const status = JSON.parse(stdout) as UpdateStatus;
          if (
            status.current !== currentVersion ||
            typeof status.updateAvailable !== "boolean"
          ) {
            throw new Error("Update check returned an unexpected response.");
          }
          resolve(status);
        } catch (error) {
          reject(error);
        }
      });
    });
  });
}

export async function runDailyUpdatePrompt(
  options: DailyUpdateOptions,
): Promise<DailyUpdateOutcome> {
  const context = options.context ?? {
    argv: process.argv.slice(2),
    environment: process.env,
    stdinIsTTY: Boolean(process.stdin.isTTY),
    stdoutIsTTY: Boolean(process.stdout.isTTY),
  };
  if (!shouldCheckForDailyUpdate(context)) return "skipped";

  const date = localDate((options.now ?? (() => new Date()))());
  const cachePath = options.cachePath ?? dailyUpdateCachePath(context.environment);
  const current = cacheState(cachePath, date);
  if (current === "attempted") return "skipped";
  if (current === "unsafe") return "cache-unavailable";
  const recorded = recordAttempt(cachePath, date);
  if (recorded === "attempted") return "skipped";
  if (recorded === "unavailable") return "cache-unavailable";

  let status: UpdateStatus;
  try {
    status = await (options.check ?? boundedUpdateCheck)(
      options.currentVersion,
      options.timeoutMs ?? DAILY_UPDATE_TIMEOUT_MS,
    );
  } catch {
    return "check-failed";
  }
  if (!status.updateAvailable || !status.tag) return "current";

  let accepted: boolean;
  try {
    accepted = await options.confirmUpdate(status);
  } catch {
    return "declined";
  }
  if (!accepted) return "declined";

  try {
    (options.apply ?? ((tag) => applyUpdate(tag)))(status.tag);
    return "applied";
  } catch {
    return "apply-failed";
  }
}
