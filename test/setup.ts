import { readFileSync } from "node:fs";

// Fixtures select their own temporary homes, not the operator's Claude profile.
delete process.env.CLAUDE_CONFIG_DIR;

/**
 * Waits for a hook process to publish its pid. Cancellation tests synchronize on
 * this real signal instead of sleeping for a guessed duration.
 */
export async function readPidFile(file: string, deadlineMs = 3_000): Promise<number> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    try {
      const pid = Number.parseInt(readFileSync(file, "utf8").trim(), 10);
      if (Number.isInteger(pid) && pid > 0) return pid;
    } catch {
      // Not written yet.
    }
    await Bun.sleep(10);
  }
  throw new Error(`hook process never started: ${file}`);
}

/**
 * Polls the OS until the target is gone. A negative pid addresses the process
 * group, so callers can assert that no descendant survived cancellation.
 */
export async function processGone(target: number, deadlineMs = 3_000): Promise<boolean> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    try {
      process.kill(target, 0);
    } catch {
      return true;
    }
    await Bun.sleep(10);
  }
  return false;
}
