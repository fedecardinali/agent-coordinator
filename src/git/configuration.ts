export function isOwnedGitConfiguration(content: string): boolean {
  try {
    const parsed = JSON.parse(content) as { generatedBy?: string };
    return parsed.generatedBy === "agent-coordinator";
  } catch {
    return false;
  }
}
