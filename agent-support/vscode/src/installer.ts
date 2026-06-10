/**
 * Offline installer for git-ai on Windows.
 *
 * Replicates the key steps of install.ps1 without requiring PowerShell or network
 * access.  The bundled binary lives at `resources/git-ai-windows-x64.exe` inside
 * the VSIX and is made available via `context.extensionUri`.
 *
 * Steps (mirroring install.ps1):
 *  1. Detect whether a usable git-ai binary is already present and up-to-date.
 *  2. Detect the standard git.exe path (fail-fast if git is not installed).
 *  3. Create the install directory  %USERPROFILE%\.git-ai\bin\
 *  4. Copy the bundled binary → git-ai.exe, then copy that → git.exe (proxy shim).
 *  5. Create the git-og.cmd wrapper that calls the real git.exe.
 *  6. Write ~/.git-ai/config.json  (only when it does not yet exist).
 *  7. Prepend the install directory to the User PATH (before any existing git entry).
 *  8. Run  git-ai install-hooks.
 *  9. Optionally configure Git Bash shell profile (~/.bashrc / ~/.bash_profile).
 */

import * as vscode from "vscode";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFile, exec } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const execAsync = promisify(exec);

// ─── constants ────────────────────────────────────────────────────────────────

/** Where git-ai installs itself on Windows (same as install.ps1). */
function getInstallDir(): string {
  return path.join(os.homedir(), ".git-ai", "bin");
}

// ─── public entry point ───────────────────────────────────────────────────────

/**
 * Called from `extension.ts` activate().
 * Silently skips on non-Windows platforms or when git-ai is already up-to-date.
 * Shows progress notifications while working and surfaces errors as VS Code
 * warning messages (non-blocking).
 */
export async function runOfflineInstallIfNeeded(
  context: vscode.ExtensionContext
): Promise<void> {
  if (process.platform !== "win32") {
    return;
  }

  // Only proceed when a bundled binary exists for this platform.
  const bundledExe = getBundledBinaryPath(context);
  if (!bundledExe) {
    console.log("[git-ai] installer: no bundled binary found for this platform – skipping");
    return;
  }

  // Check whether installation is required.
  const extensionVersion = context.extension.packageJSON.version as string;
  const needsInstall = await installationRequired(extensionVersion);
  if (!needsInstall) {
    console.log("[git-ai] installer: git-ai is already installed and up-to-date");
    return;
  }

  // Run the installation with a progress indicator.
  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "git-ai: Setting up offline installation…",
      cancellable: false,
    },
    async (progress) => {
      try {
        await performInstall(bundledExe, extensionVersion, progress);
        vscode.window.showInformationMessage(
          "git-ai installed successfully. Please restart your terminal and IDE for PATH changes to take effect."
        );
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error("[git-ai] installer: installation failed:", msg);
        vscode.window.showWarningMessage(
          `git-ai offline installation failed: ${msg}. ` +
            "You can install manually by running install.ps1."
        );
      }
    }
  );
}

// ─── helpers ──────────────────────────────────────────────────────────────────

/**
 * Returns the path of the bundled binary inside the VSIX resources folder,
 * or null when no suitable binary exists for the current OS/arch.
 */
function getBundledBinaryPath(context: vscode.ExtensionContext): string | null {
  // Only Windows x64 / arm64 are bundled.
  if (process.platform !== "win32") {
    return null;
  }

  const arch = process.arch === "arm64" ? "arm64" : "x64";
  const name = `git-ai-windows-${arch}.exe`;
  const candidate = path.join(context.extensionUri.fsPath, "resources", name);

  if (!fs.existsSync(candidate)) {
    console.log(`[git-ai] installer: bundled binary not found at ${candidate}`);
    return null;
  }

  return candidate;
}

/**
 * Returns true when git-ai needs to be (re-)installed.
 * Compares the last successfully installed extension version (persisted in
 * ~/.git-ai/extension-version) against the currently running extension version.
 */
async function installationRequired(expectedVersion: string): Promise<boolean> {
  const versionFile = path.join(os.homedir(), ".git-ai", "extension-version");

  let installedVersion: string;
  try {
    installedVersion = fs.readFileSync(versionFile, "utf-8").trim();
  } catch {
    console.log("[git-ai] installer: no version marker found – installation required");
    return true;
  }

  if (installedVersion === expectedVersion) {
    console.log("[git-ai] installer: extension version match – no installation required");
    return false;
  }

  console.log(`[git-ai] installer: extension version mismatch (installed=${installedVersion}, expected=${expectedVersion}) – reinstalling`);
  return true;
}

/**
 * Core installation routine – mirrors the install.ps1 flow step by step.
 */
async function performInstall(
  bundledExe: string,
  extensionVersion: string,
  progress: vscode.Progress<{ message?: string; increment?: number }>
): Promise<void> {
  // ── Step 1: Detect standard git.exe ────────────────────────────────────────
  progress.report({ message: "Detecting git installation…", increment: 5 });
  const stdGitPath = await detectStdGitPath();

  // ── Step 2: Create install directory ───────────────────────────────────────
  progress.report({ message: "Preparing install directory…", increment: 10 });
  const installDir = getInstallDir();
  fs.mkdirSync(installDir, { recursive: true });

  const gitAiExe = path.join(installDir, "git-ai.exe");
  const gitShim = path.join(installDir, "git.exe");
  const gitOgCmd = path.join(installDir, "git-og.cmd");

  // ── Step 3: Stop any running git-ai background service ─────────────────────
  progress.report({ message: "Stopping any running git-ai service…", increment: 5 });
  await tryShutdownService(gitAiExe, 8000);

  // ── Step 4: Copy bundled binary → git-ai.exe ───────────────────────────────
  progress.report({ message: "Installing git-ai.exe…", increment: 20 });
  copyFileSafe(bundledExe, gitAiExe);

  // ── Step 5: Create git.exe proxy shim (same binary, argv[0] dispatch) ──────
  progress.report({ message: "Creating git.exe shim…", increment: 10 });
  copyFileSafe(gitAiExe, gitShim);

  // ── Step 6: Create git-og.cmd (calls real git.exe) ─────────────────────────
  progress.report({ message: "Creating git-og.cmd…", increment: 5 });
  const gitOgContent = `@echo off\r\n"${stdGitPath}" %*\r\n`;
  fs.writeFileSync(gitOgCmd, gitOgContent, { encoding: "ascii" });

  // ── Step 7: Write config.json (only if absent) ─────────────────────────────
  progress.report({ message: "Writing configuration…", increment: 5 });
  writeConfigIfAbsent(stdGitPath);

  // ── Step 8: Update User PATH ────────────────────────────────────────────────
  progress.report({ message: "Updating PATH…", increment: 10 });
  await updateUserPath(installDir);

  // ── Step 9: Run git-ai install-hooks ───────────────────────────────────────
  progress.report({ message: "Installing hooks…", increment: 15 });
  await runInstallHooks(gitAiExe);

  // ── Step 10: Configure Git Bash profile (optional) ─────────────────────────
  progress.report({ message: "Configuring Git Bash…", increment: 5 });
  configureGitBash(installDir);

  // ── Step 11: Persist extension version marker ──────────────────────────────
  progress.report({ message: "Recording installed version…", increment: 5 });
  const versionFile = path.join(os.homedir(), ".git-ai", "extension-version");
  fs.mkdirSync(path.dirname(versionFile), { recursive: true });
  fs.writeFileSync(versionFile, extensionVersion, { encoding: "utf8" });

  progress.report({ message: "Done.", increment: 5 });
  console.log(`[git-ai] installer: installation complete → ${gitAiExe}`);
}

// ─── step implementations ────────────────────────────────────────────────────

/**
 * Detect the "real" git.exe (not our shim).
 * Mirrors install.ps1 Get-StdGitPath().
 */
async function detectStdGitPath(): Promise<string> {
  // 1. Try PATH lookup via 'where git.exe', filtering out git-ai paths.
  try {
    const { stdout } = await execAsync("where git.exe", { timeout: 5000 });
    const candidates = stdout
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !/git-ai/i.test(l));
    if (candidates.length > 0) {
      await verifyGitUsable(candidates[0]);
      return candidates[0];
    }
  } catch {
    // fall through to next strategy
  }

  // 2. Try well-known Git for Windows install locations.
  const wellKnown: string[] = [];
  if (process.env["ProgramFiles"]) {
    wellKnown.push(path.join(process.env["ProgramFiles"], "Git", "bin", "git.exe"));
    wellKnown.push(path.join(process.env["ProgramFiles"], "Git", "cmd", "git.exe"));
  }
  if (process.env["ProgramFiles(x86)"]) {
    wellKnown.push(path.join(process.env["ProgramFiles(x86)"]!, "Git", "bin", "git.exe"));
  }
  if (process.env["LOCALAPPDATA"]) {
    wellKnown.push(path.join(process.env["LOCALAPPDATA"]!, "Programs", "Git", "bin", "git.exe"));
    wellKnown.push(path.join(process.env["LOCALAPPDATA"]!, "Programs", "Git", "cmd", "git.exe"));
  }

  for (const p of wellKnown) {
    if (fs.existsSync(p) && !/git-ai/i.test(p)) {
      try {
        await verifyGitUsable(p);
        return p;
      } catch {
        // try next
      }
    }
  }

  // 3. Fall back to reading from existing config.json.
  try {
    const cfgPath = path.join(os.homedir(), ".git-ai", "config.json");
    if (fs.existsSync(cfgPath)) {
      const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf-8")) as { git_path?: string };
      if (cfg.git_path && !/git-ai/i.test(cfg.git_path) && fs.existsSync(cfg.git_path)) {
        await verifyGitUsable(cfg.git_path);
        return cfg.git_path;
      }
    }
  } catch {
    // fall through
  }

  throw new Error(
    "Could not detect a standard git binary. " +
      "Please ensure Git for Windows is installed and available on your PATH."
  );
}

async function verifyGitUsable(gitPath: string): Promise<void> {
  const { stdout } = await execFileAsync(gitPath, ["--version"], { timeout: 5000 });
  if (!stdout.trim().startsWith("git version")) {
    throw new Error(`Unusable git at ${gitPath}`);
  }
}

/**
 * Attempt graceful (then forced) shutdown of the git-ai background service.
 * Mirrors install.ps1 Stop-GitAiBackgroundService() / Stop-GitAiManagedProcesses().
 * After signalling shutdown, polls until the binary is no longer locked or timeout expires.
 */
async function tryShutdownService(gitAiExe: string, maxWaitMs: number): Promise<void> {
  if (!fs.existsSync(gitAiExe)) {
    return;
  }

  // Soft shutdown
  try {
    await execFileAsync(gitAiExe, ["bg", "shutdown"], { timeout: 5000 });
  } catch {
    // soft shutdown failed – escalate to hard kill
    try {
      await execFileAsync(gitAiExe, ["bg", "shutdown", "--hard"], { timeout: 5000 });
    } catch {
      // ignore – process may already be gone
    }
  }

  // Poll until the file is no longer locked (daemon fully exited)
  await waitForFileReleased(gitAiExe, maxWaitMs);
}

/**
 * Polls until the target file can be opened for writing, or timeout expires.
 * On Windows, this detects when a process has fully released its file handle.
 */
function waitForFileReleased(filePath: string, maxWaitMs: number): Promise<void> {
  return new Promise((resolve) => {
    const deadline = Date.now() + maxWaitMs;
    const poll = (): void => {
      if (Date.now() >= deadline) {
        resolve();
        return;
      }
      try {
        // Attempt to open the file with write access – succeeds only when no
        // other process holds an exclusive lock on the binary.
        const fd = fs.openSync(filePath, fs.constants.O_WRONLY | fs.constants.O_DSYNC);
        fs.closeSync(fd);
        resolve();
        return;
      } catch {
        // File still locked – poll again after a short delay.
        setTimeout(poll, 200);
      }
    };
    poll();
  });
}

/**
 * Copy src → dest, retrying with a longer total window.
 * Handles locked files (e.g., daemon still releasing handles, AV scanners).
 */
function copyFileSafe(src: string, dest: string): void {
  const deadline = Date.now() + 8000;
  let lastErr: unknown;
  for (let attempt = 0; attempt < 30 && Date.now() < deadline; attempt++) {
    try {
      fs.copyFileSync(src, dest);
      return;
    } catch (err) {
      lastErr = err;
      const remaining = deadline - Date.now();
      if (remaining <= 0) { break; }
      // Asynchronous sleep – yields event loop to avoid blocking the VS Code UI.
      const waitMs = Math.min(300, remaining);
      const until = Date.now() + waitMs;
      while (Date.now() < until) {
        /* busy-wait */
      }
    }
  }
  throw lastErr;
}

/**
 * Write ~/.git-ai/config.json only when it does not yet exist.
 * Mirrors install.ps1 config.json write block.
 */
function writeConfigIfAbsent(stdGitPath: string): void {
  const configDir = path.join(os.homedir(), ".git-ai");
  const configPath = path.join(configDir, "config.json");

  if (fs.existsSync(configPath)) {
    return;
  }

  fs.mkdirSync(configDir, { recursive: true });

  const cfg = JSON.stringify(
    {
      git_path: stdGitPath,
      feature_flags: {
        async_mode: true,
      },
    },
    null,
    2
  );

  // Write UTF-8 without BOM (mirrors install.ps1's UTF8Encoding($false)).
  fs.writeFileSync(configPath, cfg, { encoding: "utf8" });
  console.log(`[git-ai] installer: wrote config.json → ${configPath}`);
}

/**
 * Prepend installDir to the Windows User PATH before any existing git entry.
 * Mirrors install.ps1 Set-PathPrependBeforeGit().
 *
 * Uses the registry via PowerShell so the change survives terminal restarts.
 * Falls back to a silent no-op if PowerShell is unavailable.
 */
async function updateUserPath(installDir: string): Promise<void> {
  // Read current User PATH via PowerShell.
  let currentPath = "";
  try {
    const { stdout } = await execAsync(
      `powershell -NoProfile -NonInteractive -Command "[Environment]::GetEnvironmentVariable('Path', 'User')"`,
      { timeout: 10000 }
    );
    currentPath = stdout.trim();
  } catch (err) {
    console.warn("[git-ai] installer: could not read User PATH via PowerShell:", err);
    return;
  }

  const normalizedAdd = normalizePath(installDir);
  const entries = currentPath
    .split(";")
    .map((e) => e.trim())
    .filter((e) => e.length > 0);

  // De-duplicate: remove existing occurrences of installDir.
  const deduped = entries.filter((e) => normalizePath(e) !== normalizedAdd);

  // Insert before the first entry that contains "git" (case-insensitive).
  const gitIndex = deduped.findIndex((e) => /git/i.test(e));
  const insertAt = gitIndex >= 0 ? gitIndex : 0;
  deduped.splice(insertAt, 0, installDir);

  const newPath = deduped.join(";");

  if (newPath === currentPath) {
    console.log("[git-ai] installer: User PATH already contains install dir – no change needed");
    return;
  }

  // Write back via PowerShell.
  try {
    const escaped = newPath.replace(/'/g, "''");
    await execAsync(
      `powershell -NoProfile -NonInteractive -Command "[Environment]::SetEnvironmentVariable('Path', '${escaped}', 'User')"`,
      { timeout: 10000 }
    );
    console.log("[git-ai] installer: User PATH updated successfully");
  } catch (err) {
    // Non-fatal – binary is installed, user just needs to add the path manually.
    console.warn("[git-ai] installer: could not write User PATH:", err);
    vscode.window.showWarningMessage(
      `git-ai: Could not update PATH automatically. ` +
        `Please add "${installDir}" to your PATH manually (before any Git entries).`
    );
  }
}

/**
 * Run `git-ai install-hooks` to register IDE/agent hooks.
 * Mirrors install.ps1 install-hooks call.
 */
async function runInstallHooks(gitAiExe: string): Promise<void> {
  try {
    const { stdout, stderr } = await execFileAsync(gitAiExe, ["install-hooks"], {
      timeout: 30000,
    });
    console.log("[git-ai] installer: install-hooks stdout:", stdout.trim());
    if (stderr.trim()) {
      console.warn("[git-ai] installer: install-hooks stderr:", stderr.trim());
    }
  } catch (err) {
    // Non-fatal – hooks can be set up manually with `git-ai install-hooks`.
    console.warn("[git-ai] installer: install-hooks failed:", err);
    vscode.window.showWarningMessage(
      "git-ai: Hook setup failed. Run `git-ai install-hooks` manually if needed."
    );
  }
}

/**
 * Append PATH export to ~/.bashrc or ~/.bash_profile when Git Bash is detected.
 * Mirrors install.ps1 Git Bash configuration block.
 */
function configureGitBash(installDir: string): void {
  const gitBashPaths: string[] = [];
  if (process.env["ProgramFiles"]) {
    gitBashPaths.push(path.join(process.env["ProgramFiles"], "Git", "bin", "bash.exe"));
  }
  if (process.env["ProgramFiles(x86)"]) {
    gitBashPaths.push(path.join(process.env["ProgramFiles(x86)"]!, "Git", "bin", "bash.exe"));
  }
  if (process.env["LOCALAPPDATA"]) {
    gitBashPaths.push(
      path.join(process.env["LOCALAPPDATA"]!, "Programs", "Git", "bin", "bash.exe")
    );
  }

  const gitBashInstalled = gitBashPaths.some((p) => fs.existsSync(p));
  if (!gitBashInstalled) {
    return;
  }

  const home = os.homedir();
  const bashrcPath = path.join(home, ".bashrc");
  const bashProfilePath = path.join(home, ".bash_profile");
  const markerString = ".git-ai/bin";
  const pathCmd = `export PATH="$HOME/.git-ai/bin:$PATH"`;

  // Prefer .bashrc, fall back to .bash_profile, create .bashrc if neither exists.
  let targetPath: string;
  if (fs.existsSync(bashrcPath)) {
    targetPath = bashrcPath;
  } else if (fs.existsSync(bashProfilePath)) {
    targetPath = bashProfilePath;
  } else {
    targetPath = bashrcPath;
  }

  // Skip if already configured.
  if (fs.existsSync(targetPath)) {
    const content = fs.readFileSync(targetPath, "utf-8");
    if (content.includes(markerString)) {
      console.log(`[git-ai] installer: Git Bash already configured in ${targetPath}`);
      return;
    }
  }

  const timestamp = new Date().toISOString().replace("T", " ").slice(0, 19);
  const appendContent = `\n# Added by git-ai VS Code extension on ${timestamp}\n${pathCmd}\n`;

  try {
    fs.appendFileSync(targetPath, appendContent, { encoding: "utf8" });
    console.log(`[git-ai] installer: configured Git Bash in ${targetPath}`);
  } catch (err) {
    console.warn(`[git-ai] installer: could not write to ${targetPath}:`, err);
  }
}

// ─── utilities ────────────────────────────────────────────────────────────────

/** Normalize a Windows path for comparison (lowercase, no trailing backslash). */
function normalizePath(p: string): string {
  try {
    return path.resolve(p.trim()).replace(/\\+$/, "").toLowerCase();
  } catch {
    return p.trim().replace(/\\+$/, "").toLowerCase();
  }
}

/** Simple semver comparison: returns negative / 0 / positive. */
function compareVersions(a: string, b: string): number {
  const parse = (v: string) => v.split(".").map((n) => parseInt(n, 10) || 0);
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) {
      return diff;
    }
  }
  return 0;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
