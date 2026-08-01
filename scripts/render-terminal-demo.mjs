import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = execFileSync(
  process.execPath,
  [path.join(root, "dist", "cli.js"), "--no-color", "demo"],
  { encoding: "utf8" },
).trimEnd();
const lines = ["$ coordinator", ...output.split("\n")];

function escape(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function lineColor(line, index) {
  if (index === 0) return "#67e8f9";
  if (line.startsWith("╭") || line.startsWith("╰")) return "#c084fc";
  if (line.startsWith("├")) return "#64748b";
  if (line.includes("●")) return "#d8dee9";
  return "#d8dee9";
}

const text = lines
  .map(
    (line, index) =>
      `<text x="80" y="${112 + index * 27}" fill="${lineColor(line, index)}" xml:space="preserve">${escape(line)}</text>`,
  )
  .join("\n    ");
const height = 152 + lines.length * 27;
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="${height}" viewBox="0 0 1280 ${height}" role="img" aria-labelledby="title description">
  <title id="title">Agent Coordinator terminal dashboard</title>
  <desc id="description">A real dashboard showing coordinated repositories, coding-agent runtimes, skills, and delivery routes.</desc>
  <defs>
    <linearGradient id="background" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#11131b"/>
      <stop offset="1" stop-color="#181322"/>
    </linearGradient>
    <filter id="shadow" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="18" stdDeviation="24" flood-color="#000" flood-opacity=".45"/>
    </filter>
  </defs>
  <rect width="1280" height="${height}" rx="32" fill="#0b0c12"/>
  <g filter="url(#shadow)">
    <rect x="32" y="32" width="1216" height="${height - 64}" rx="20" fill="url(#background)" stroke="#3b334a"/>
    <path d="M32 86h1216" stroke="#302b3b"/>
    <circle cx="68" cy="59" r="7" fill="#ff5f57"/>
    <circle cx="92" cy="59" r="7" fill="#febc2e"/>
    <circle cx="116" cy="59" r="7" fill="#28c840"/>
    <text x="640" y="65" text-anchor="middle" fill="#8b91a7" font-family="-apple-system, BlinkMacSystemFont, sans-serif" font-size="14">agent-coordinator — zsh</text>
  </g>
  <g font-family="Menlo, Monaco, Consolas, monospace" font-size="17">
    ${text}
  </g>
</svg>
`;

const destination = path.join(root, "docs", "assets", "terminal-demo.svg");
mkdirSync(path.dirname(destination), { recursive: true });
writeFileSync(destination, svg);
process.stdout.write(`${destination}\n`);
