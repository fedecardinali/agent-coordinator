import pc from "picocolors";
import type { Health, WorkspaceStatus } from "../status/inspect.js";

const WIDTH = 78;

function truncate(value: string, width: number): string {
  if (value.length <= width) return value.padEnd(width);
  return `${value.slice(0, Math.max(0, width - 1))}…`;
}

function colorize(enabled: boolean) {
  return {
    accent: (value: string) => (enabled ? pc.cyan(value) : value),
    brand: (value: string) => (enabled ? pc.magenta(value) : value),
    dim: (value: string) => (enabled ? pc.dim(value) : value),
    ready: (value: string) => (enabled ? pc.green(value) : value),
    attention: (value: string) => (enabled ? pc.yellow(value) : value),
    blocked: (value: string) => (enabled ? pc.red(value) : value),
  };
}

function indicator(health: Health): string {
  if (health === "ready") return "●";
  if (health === "attention") return "◆";
  return "×";
}

function section(title: string): string {
  const left = `─ ${title} `;
  return `├${left}${"─".repeat(Math.max(0, WIDTH - left.length - 2))}┤`;
}

function row(content: string): string {
  const plain = content.replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "");
  const padding = " ".repeat(Math.max(0, WIDTH - 3 - plain.length));
  return `│ ${content}${padding}│`;
}

export interface DashboardOptions {
  color?: boolean;
  footer?: boolean;
}

export function renderDashboard(
  status: WorkspaceStatus,
  options: DashboardOptions = {},
): string {
  const useColor = options.color ?? !process.env.NO_COLOR;
  const c = colorize(useColor);
  const lines: string[] = [];
  const title = ` Agent Coordinator · ${status.name} `;
  const version = `v${status.version} `;
  const fill = Math.max(1, WIDTH - title.length - version.length - 2);
  lines.push(c.brand(`╭${title}${"─".repeat(fill)}${version}╮`));
  lines.push(row(`${c.accent("branch")}  ${status.branch}`));
  lines.push(section("Repositories"));
  for (const repository of status.repositories) {
    const healthColor = c[repository.health];
    const id = repository.id.padEnd(12);
    const policy = repository.policy.padEnd(13);
    const branch = truncate(repository.branch, 27);
    lines.push(
      row(
        `${healthColor(indicator(repository.health))} ${id} ${c.dim(policy)} ${branch} ${c.dim(repository.state)}`,
      ),
    );
  }
  lines.push(section("Agent tooling"));
  lines.push(
    row(
      status.agents.managed
        ? `${c.ready("●")} ${status.agents.tools.join("  ")}   ${c.accent(String(status.agents.skills))} skills synced`
        : `${c.attention("◆")} ${status.agents.tools.join("  ")}   existing agent files unmanaged`,
    ),
  );
  lines.push(section("Delivery"));
  lines.push(
    row(
      `${status.gitRuntime ? c.ready("● Git runtime ready") : c.blocked("× Git runtime missing")}   ${c.accent(String(status.ci.environments))} environments   ${c.accent(String(status.ci.components))} component routes`,
    ),
  );
  if (options.footer !== false) {
    lines.push(section("Actions"));
    lines.push(
      row(
        `${c.accent("[s]")} synchronize   ${c.accent("[d]")} doctor   ${c.accent("[q]")} exit`,
      ),
    );
  }
  lines.push(c.brand(`╰${"─".repeat(WIDTH - 2)}╯`));
  return lines.join("\n");
}
