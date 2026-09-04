import { confirm, isCancel } from "@clack/prompts";
import type { UpdateStatus } from "../update/check.js";

export async function promptForDailyUpdate(
  status: UpdateStatus,
): Promise<boolean> {
  const answer = await confirm({
    message: `Agent Coordinator ${status.latest} is available. Update now?`,
    initialValue: true,
  });
  return !isCancel(answer) && answer;
}
