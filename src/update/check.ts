import {
  commandAvailable,
  runCommand,
  type CommandResult,
} from "../core/command.js";
import { CoordinatorError } from "../core/errors.js";

export const PROJECT_REPOSITORY = "fedecardinali/agent-coordinator";

export interface UpdateStatus {
  current: string;
  latest: string | null;
  tag: string | null;
  updateAvailable: boolean;
  url: string | null;
}

interface SemanticVersion {
  core: [number, number, number];
  normalized: string;
  prerelease: string[];
  tag: string;
}

const SEMVER_TAG = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export function parseReleaseTag(tag: string): SemanticVersion {
  const match = SEMVER_TAG.exec(tag);
  if (!match) {
    throw new CoordinatorError(
      `Latest release tag '${tag}' is not a supported semantic version.`,
      "INVALID_RELEASE_TAG",
    );
  }
  const prerelease = match[4]?.split(".") ?? [];
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    normalized: `${match[1]}.${match[2]}.${match[3]}${match[4] ? `-${match[4]}` : ""}`,
    prerelease,
    tag,
  };
}

function comparePrerelease(left: string[], right: string[]): number {
  if (!left.length && !right.length) return 0;
  if (!left.length) return 1;
  if (!right.length) return -1;
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const leftPart = left[index];
    const rightPart = right[index];
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;
    if (leftPart === rightPart) continue;
    const leftNumeric = /^\d+$/.test(leftPart);
    const rightNumeric = /^\d+$/.test(rightPart);
    if (leftNumeric && rightNumeric) return Number(leftPart) - Number(rightPart);
    if (leftNumeric) return -1;
    if (rightNumeric) return 1;
    return leftPart.localeCompare(rightPart);
  }
  return 0;
}

export function newer(candidate: string, current: string): boolean {
  const left = parseReleaseTag(candidate);
  const right = parseReleaseTag(current);
  for (let index = 0; index < left.core.length; index += 1) {
    const difference = left.core[index]! - right.core[index]!;
    if (difference !== 0) return difference > 0;
  }
  return comparePrerelease(left.prerelease, right.prerelease) > 0;
}

function commandFailure(result: CommandResult): string {
  return result.stderr || result.stdout || `exit ${result.status}`;
}

export function checkForUpdate(current: string): UpdateStatus {
  if (!commandAvailable("gh")) {
    throw new CoordinatorError("GitHub CLI is required to check private releases.");
  }
  const authentication = runCommand(
    "gh",
    ["auth", "status", "--hostname", "github.com"],
    { allowFailure: true },
  );
  if (authentication.status !== 0) {
    throw new CoordinatorError(
      "GitHub CLI is not authenticated for github.com. Run 'gh auth login' and retry.",
      "GITHUB_AUTH_REQUIRED",
    );
  }
  const repository = runCommand(
    "gh",
    ["api", `repos/${PROJECT_REPOSITORY}`, "--jq", ".full_name"],
    { allowFailure: true },
  );
  if (repository.status !== 0) {
    throw new CoordinatorError(
      `Cannot access private update repository '${PROJECT_REPOSITORY}': ${commandFailure(repository)}.`,
      "UPDATE_REPOSITORY_UNAVAILABLE",
    );
  }
  const result = runCommand(
    "gh",
    ["api", `repos/${PROJECT_REPOSITORY}/releases/latest`],
    { allowFailure: true },
  );
  if (result.status !== 0) {
    if (/\bHTTP 404\b/i.test(`${result.stderr}\n${result.stdout}`)) {
      return {
        current,
        latest: null,
        tag: null,
        updateAvailable: false,
        url: null,
      };
    }
    throw new CoordinatorError(
      `Could not check private releases for '${PROJECT_REPOSITORY}': ${commandFailure(result)}.`,
      "UPDATE_CHECK_FAILED",
    );
  }
  let release: { html_url?: unknown; tag_name?: unknown };
  try {
    release = JSON.parse(result.stdout) as {
      html_url?: unknown;
      tag_name?: unknown;
    };
  } catch {
    throw new CoordinatorError(
      "GitHub returned an invalid latest-release response.",
      "INVALID_RELEASE_RESPONSE",
    );
  }
  if (typeof release.tag_name !== "string") {
    throw new CoordinatorError(
      "GitHub's latest release has no valid tag_name.",
      "INVALID_RELEASE_RESPONSE",
    );
  }
  const parsed = parseReleaseTag(release.tag_name);
  return {
    current,
    latest: parsed.normalized,
    tag: parsed.tag,
    updateAvailable: newer(parsed.tag, current),
    url: typeof release.html_url === "string" ? release.html_url : null,
  };
}

export function applyUpdate(
  tag: string,
  options: { stdio?: "pipe" | "inherit" | undefined } = {},
): CommandResult {
  parseReleaseTag(tag);
  const stdio = options.stdio ?? "inherit";
  const result = runCommand(
    "npm",
    [
      "install",
      "--global",
      `git+https://github.com/${PROJECT_REPOSITORY}.git#${tag}`,
    ],
    { stdio },
  );
  runCommand("coordinator", ["install"], { stdio });
  return result;
}
