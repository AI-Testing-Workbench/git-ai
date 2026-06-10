/**
 * Uninstall hook for git-ai VS Code extension.
 *
 * Called by VS Code when the extension is uninstalled (via `__uninstall` in
 * package.json).  Stops any running git-ai processes (daemon + proxy shim).
 *
 * This script runs as a standalone Node.js process with no VS Code API access.
 */

import { execFile, exec } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const log = (msg: string) => process.stderr.write(`[git-ai] ${msg}\n`);

function findGitAi(): string | null {
  const pathEnv = process.env.PATH || "";
  for (const dir of pathEnv.split(";")) {
    const candidate = join(dir.trim(), "git-ai.exe");
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  const installed = join(homedir(), ".git-ai", "bin", "git-ai.exe");
  if (existsSync(installed)) {
    return installed;
  }
  return null;
}

function killGitAiProcesses(): Promise<void> {
  return new Promise((resolve) => {
    log("Killing all running git-ai processes...");
    exec(
      'taskkill /F /IM git-ai.exe /T 2>nul',
      { timeout: 5000 },
      () => resolve(),
    );
  });
}

function runBgShutdown(gitAiPath: string): Promise<void> {
  return new Promise((resolve) => {
    execFile(gitAiPath, ["bg", "shutdown", "--hard"], { timeout: 5000 })
      .on("error", () => resolve())
      .on("exit", () => resolve());
  });
}

async function run(): Promise<void> {
  const gitAiPath = findGitAi();

  // Step 1: Kill all git-ai.exe processes in Task Manager
  await killGitAiProcesses();

  // Step 2: Graceful daemon shutdown
  if (gitAiPath) {
    await runBgShutdown(gitAiPath);
  }

  log("git-ai uninstall cleanup completed");
}

run();
