import { existsSync } from "node:fs";
import path from "node:path";
import { commandAvailable, runCommand } from "../core/command.js";
import { errorMessage } from "../core/errors.js";
import type { CoordinatorManifest } from "../core/schema.js";
import { findGitCoordinator, invokeGitCoordinator } from "../git/adapter.js";
import { synchronizeWorkspace } from "../workspace/sync.js";

export type CheckStatus = "pass" | "warn" | "fail";

export interface DoctorCheck {
  detail: string;
  label: string;
  status: CheckStatus;
}

export interface DoctorResult {
  checks: DoctorCheck[];
  healthy: boolean;
}

function check(
  label: string,
  operation: () => { detail: string; status?: CheckStatus },
): DoctorCheck {
  try {
    const result = operation();
    return { label, detail: result.detail, status: result.status ?? "pass" };
  } catch (error) {
    return { label, detail: errorMessage(error), status: "fail" };
  }
}

export function runDoctor(
  root: string,
  manifest: CoordinatorManifest,
  version: string,
): DoctorResult {
  const checks: DoctorCheck[] = [];
  checks.push(
    check("Node.js", () => {
      const [major, minor] = process.versions.node.split(".").map(Number);
      const supported = major! > 20 || (major === 20 && minor! >= 12);
      return {
        detail: `Node ${process.versions.node}`,
        status: supported ? "pass" : "fail",
      };
    }),
  );
  checks.push(
    check("Git", () => ({
      detail: runCommand("git", ["--version"]).stdout,
    })),
  );
  checks.push(
    check("GitHub CLI", () => {
      if (!commandAvailable("gh")) return { detail: "gh is not installed", status: "warn" };
      const auth = runCommand("gh", ["auth", "status"], { allowFailure: true });
      return {
        detail: auth.status === 0 ? "authenticated" : "installed, not authenticated",
        status: auth.status === 0 ? "pass" : "warn",
      };
    }),
  );
  checks.push(
    check("Repositories", () => {
      const missing = manifest.repositories.filter(
        (repository) => !existsSync(path.join(root, repository.path, ".git")),
      );
      return missing.length
        ? {
            detail: `missing: ${missing.map((repository) => repository.id).join(", ")}`,
            status: "fail",
          }
        : { detail: `${manifest.repositories.length} initialized` };
    }),
  );
  checks.push(
    check("Gitlinks", () => {
      const result = runCommand("git", ["-C", root, "submodule", "status", "--recursive"], {
        allowFailure: true,
        env: { GIT_COORDINATOR_INTERNAL: "1" },
      });
      if (result.status !== 0) return { detail: result.stderr || "unavailable", status: "warn" };
      const drift = result.stdout
        .split("\n")
        .filter((line) => /^(?:\+|-|U)/.test(line));
      return drift.length
        ? { detail: `${drift.length} submodule revisions differ from gitlinks`, status: "fail" }
        : { detail: "all initialized submodules match their gitlinks" };
    }),
  );
  checks.push(
    check("Generated configuration", () => {
      const result = synchronizeWorkspace(root, manifest, version, { check: true });
      return result.changed
        ? { detail: "generated files are stale; run coordinator sync", status: "fail" }
        : {
            detail:
              manifest.agents.manage === false
                ? "Git and CI are synchronized; existing agent files are intentionally unmanaged"
                : "Git, agents, skills, and CI are synchronized",
          };
    }),
  );
  checks.push(
    check("Git Coordinator", () => {
      if (!findGitCoordinator(root)) {
        return { detail: "runtime not installed", status: "fail" };
      }
      const result = invokeGitCoordinator("check", root, { allowFailure: true });
      return result.status === 0
        ? { detail: result.stdout || "invariant OK" }
        : { detail: result.stderr || result.stdout, status: "fail" };
    }),
  );
  return {
    checks,
    healthy: !checks.some((item) => item.status === "fail"),
  };
}
