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

function runCommand(cmd: string, description: string): Promise<void> {
  return new Promise((resolve) => {
    exec(cmd, { timeout: 5000 }, (error, stdout, stderr) => {
      if (error) {
        log(`${description} error (will continue): ${error.message}`);
        if (stderr) { log(stderr); }
      } else {
        const out = stdout.trim();
        if (out) { log(`${description}: ${out}`); }
      }
      resolve();
    });
  });
}

function killGitAiProcesses(): Promise<void> {
  log("Killing all running git-ai processes...");
  // Use multiple approaches for maximum reliability on Windows 10:
  //   1. taskkill /IM — standard approach, may fail in some Windows configurations
  //   2. PowerShell Stop-Process — more robust, uses .NET Process.Kill() directly
  return runCommand(
    'taskkill /F /IM git-ai.exe /T 2>nul',
    "taskkill",
  ).then(() => runCommand(
    'powershell -NoProfile -NonInteractive -Command "Get-Process git-ai -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue"',
    "powershell Stop-Process",
  ));
}

function runBgShutdown(gitAiPath: string): Promise<void> {
  return new Promise((resolve) => {
    log("Gracefully shutting down git-ai daemon...");
    execFile(gitAiPath, ["bg", "shutdown", "--hard"], { timeout: 5000 })
      .on("error", (err) => {
        log(`bg shutdown error: ${err.message}`);
        resolve();
      })
      .on("exit", (code) => {
        if (code !== 0) {
          log(`bg shutdown exited with code ${code}`);
        }
        resolve();
      });
  });
}

async function run(): Promise<void> {
  const gitAiPath = findGitAi();

  // Step 1: Graceful daemon shutdown (before killing, so bg shutdown
  // can communicate with the running daemon process successfully)
  if (gitAiPath) {
    await runBgShutdown(gitAiPath);
  }

  // Step 2: Force-kill any remaining git-ai.exe processes as a safety net
  await killGitAiProcesses();

  log("git-ai uninstall cleanup completed");
}

run();
