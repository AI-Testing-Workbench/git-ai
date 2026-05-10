import * as vscode from "vscode";
import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs";
import { execFile } from "node:child_process";

let installationChecked = false;

interface InstallResult {
  success: boolean;
  message: string;
  error?: string;
}

function getExtensionResourceDir(extensionPath: string): string {
  return path.join(extensionPath, "resources");
}

function getInstallDir(): string {
  return path.join(os.homedir(), ".git-ai", "bin");
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.promises.access(filePath, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function canWriteFile(filePath: string): Promise<boolean> {
  try {
    await fs.promises.access(filePath, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

async function stopGitAiProcesses(installDir: string): Promise<void> {
  return new Promise((resolve) => {
    const gitAiExe = path.join(installDir, "git-ai.exe");
    const gitShim = path.join(installDir, "git.exe");

    const stopProcess = (exePath: string): Promise<void> => {
      return new Promise((res) => {
        if (os.platform() === "win32") {
          execFile("powershell.exe", [
            "-Command",
            `Get-Process | Where-Object { $_.Path -eq '${exePath}' -and $_.Id -ne $PID } | Stop-Process -Force -ErrorAction SilentlyContinue`
          ], { timeout: 10000 }, () => res());
        } else {
          execFile("pkill", ["-f", exePath], () => res());
        }
      });
    };

    Promise.all([
      fileExists(gitAiExe).then(exists => exists ? stopProcess(gitAiExe) : Promise.resolve()),
      fileExists(gitShim).then(exists => exists ? stopProcess(gitShim) : Promise.resolve())
    ]).then(() => {
      setTimeout(resolve, 1000);
    });
  });
}

async function findGitPath(): Promise<string | null> {
  const platform = os.platform();

  if (platform === "win32") {
    const commonPaths = [
      "C:\\Program Files\\Git\\cmd\\git.exe",
      "C:\\Program Files (x86)\\Git\\cmd\\git.exe",
      path.join(process.env.LOCALAPPDATA || "", "Programs", "Git", "cmd", "git.exe")
    ];

    for (const p of commonPaths) {
      if (await fileExists(p)) {
        return p;
      }
    }

    return new Promise((resolve) => {
      execFile("where", ["git.exe"], { timeout: 5000 }, (err, stdout) => {
        if (err || !stdout.trim()) {
          resolve(null);
        } else {
          const firstPath = stdout.trim().split(/\r?\n/)[0];
          if (firstPath.toLowerCase().includes("git-ai")) {
            resolve(null);
          } else {
            resolve(firstPath);
          }
        }
      });
    });
  } else {
    return new Promise((resolve) => {
      execFile("which", ["git"], { timeout: 5000 }, (err, stdout) => {
        if (err || !stdout.trim()) {
          resolve(null);
        } else {
          const gitPath = stdout.trim().split(/\r?\n/)[0];
          if (gitPath.toLowerCase().includes("git-ai")) {
            resolve(null);
          } else {
            resolve(gitPath);
          }
        }
      });
    });
  }
}

async function updatePathPrependGit(installDir: string, platform: string): Promise<{ success: boolean; error?: string }> {
  if (platform === "win32") {
    return new Promise((resolve) => {
      const escapedInstallDir = installDir.replace(/\\/g, "\\\\");
      
      const psScript = `
$ErrorActionPreference = 'Stop'
try {
  $installDir = '${escapedInstallDir}'
  $sep = ';'
  
  # Get current user PATH (use if instead of ?? for PowerShell 5.0 compatibility)
  $currentPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  if ($null -eq $currentPath) { $currentPath = '' }
  $pathParts = if ($currentPath -ne '') { $currentPath -split $sep } else { @() }
  
  # Remove installDir if already present
  $pathParts = $pathParts | Where-Object { $_ -ne '' -and $_ -ne $installDir }
  
  # Find first path containing 'git' (case-insensitive)
  $gitPath = ($pathParts | Where-Object { $_ -like '*git*' -or $_ -like '*Git*' } | Select-Object -First 1)
  
  # Build new PATH: installDir first, then git path, then rest
  $newParts = @($installDir)
  if ($gitPath) {
    $newParts += $gitPath
  }
  $newParts += $pathParts
  
  $newPath = $newParts -join $sep
  
  # Set user PATH
  [Environment]::SetEnvironmentVariable('Path', $newPath, 'User')
  
  # Broadcast environment change (Windows 10+)
  try {
    Add-Type -TypeDefinition @"
      using System;
      using System.Runtime.InteropServices;
      public class Win32 {
        [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Auto)]
        public static extern IntPtr SendMessageTimeout(
          IntPtr hWnd, uint Msg, UIntPtr wParam, string lParam,
          uint fuFlags, uint uTimeout, out UIntPtr lpdwResult);
      }
"@
    $HWND_BROADCAST = [IntPtr]0xffff
    $WM_SETTINGCHANGE = 0x1a
    $result = [UIntPtr]::Zero
    [Win32]::SendMessageTimeout($HWND_BROADCAST, $WM_SETTINGCHANGE, [UIntPtr]::Zero, "Environment", 2, 5000, [ref]$result) | Out-Null
  } catch {
    # Ignore broadcast errors
  }
  
  Write-Output "SUCCESS: PATH updated to: $newPath"
} catch {
  Write-Error "FAILED: $($_.Exception.Message)"
  exit 1
}
`;

      execFile("powershell.exe", ["-ExecutionPolicy", "Bypass", "-NoProfile", "-Command", psScript], { timeout: 30000 }, (err, stdout, stderr) => {
        const output = stdout + stderr;
        console.log("[git-ai] PATH update output:", output);
        
        if (output.includes("SUCCESS")) {
          resolve({ success: true });
        } else {
          resolve({ success: false, error: output || "Failed to update PATH" });
        }
      });
    });
  } else {
    return new Promise((resolve) => {
      const bashrc = path.join(os.homedir(), ".bashrc");
      const pathLine = `export PATH="${installDir}:$PATH"`;

      fs.promises.readFile(bashrc, "utf-8").catch(() => "").then(content => {
        if (!content.includes(".git-ai/bin")) {
          return fs.promises.appendFile(bashrc, `\n# Added by git-ai\n${pathLine}\n`);
        }
      }).then(() => resolve({ success: true }));
    });
  }
}

async function createGitShims(installDir: string, gitPath: string): Promise<void> {
  const platform = os.platform();

  if (platform === "win32") {
    const gitShim = path.join(installDir, "git.exe");
    const gitOgShim = path.join(installDir, "git-og.cmd");

    await fs.promises.copyFile(path.join(installDir, "git-ai.exe"), gitShim);

    const shimContent = `@echo off\r\n"${gitPath}" %*\r\n`;
    await fs.promises.writeFile(gitOgShim, shimContent, "ascii");
  } else {
    const gitShim = path.join(installDir, "git");
    await fs.promises.copyFile(path.join(installDir, "git-ai"), gitShim);
    await fs.promises.chmod(gitShim, 0o755);

    const gitOgShim = path.join(installDir, "git-og");
    await fs.promises.writeFile(gitOgShim, `#!/bin/bash\n"${gitPath}" "$@"\n`);
    await fs.promises.chmod(gitOgShim, 0o755);
  }
}

async function writeConfig(gitPath: string): Promise<void> {
  const configDir = path.join(os.homedir(), ".git-ai");
  const configPath = path.join(configDir, "config.json");

  try {
    await fs.promises.access(configPath);
    console.log("[git-ai] Config already exists, skipping...");
    return;
  } catch {
    // Config doesn't exist, create it
  }

  const config = {
    git_path: gitPath,
    feature_flags: {
      async_mode: true
    }
  };

  await fs.promises.mkdir(configDir, { recursive: true });
  await fs.promises.writeFile(configPath, JSON.stringify(config, null, 2));
  console.log("[git-ai] Config written to:", configPath);
}

async function updateVSCodeGitPath(installDir: string): Promise<void> {
  return new Promise((resolve) => {
    if (os.platform() !== "win32") {
      resolve();
      return;
    }

    const gitAiGitPath = path.join(installDir, "git.exe");
    
    // Update VSCode settings.json
    const psScript = `
$ErrorActionPreference = 'Stop'
try {
  # Get VSCode user settings path
  $settingsDir = Join-Path $env:APPDATA "tscode\\User"
  $settingsPath = Join-Path $settingsDir "settings.json"
  
  # Ensure directory exists
  if (-not (Test-Path $settingsDir)) {
    New-Item -ItemType Directory -Force -Path $settingsDir | Out-Null
  }
  
  $gitAiGitPath = '${gitAiGitPath.replace(/\\/g, "\\\\")}'
  
  # Read existing settings or create new object
  $settings = @{}
  if (Test-Path $settingsPath) {
    $content = Get-Content $settingsPath -Raw -ErrorAction SilentlyContinue
    if ($content) {
      try {
        $jsonObj = $content | ConvertFrom-Json
        # Convert PSObject to Hashtable
        $settings = @{}
        $jsonObj.PSObject.Properties | ForEach-Object {
          $settings[$_.Name] = $_.Value
        }
      } catch {
        $settings = @{}
      }
    }
  }
  
  # Update git.path
  $settings['git.path'] = $gitAiGitPath
  
  # Write back as JSON
  $json = $settings | ConvertTo-Json -Depth 10
  Set-Content -Path $settingsPath -Value $json -Encoding UTF8
  
  Write-Output "SUCCESS: VSCode git.path set to: $gitAiGitPath"
} catch {
  Write-Error "FAILED: $($_.Exception.Message)"
  exit 1
}
`;

    execFile("powershell.exe", ["-ExecutionPolicy", "Bypass", "-NoProfile", "-Command", psScript], { timeout: 30000 }, (err, stdout, stderr) => {
      const output = stdout + stderr;
      console.log("[git-ai] VSCode settings update:", output);
      resolve();
    });
  });
}

async function runInstallHooks(gitAiExe: string): Promise<void> {
  return new Promise((resolve) => {
    execFile(gitAiExe, ["install-hooks"], { timeout: 60000 }, (err, stdout, stderr) => {
      if (err) {
        console.warn("[git-ai] install-hooks warning:", err.message);
      } else {
        console.log("[git-ai] install-hooks output:", stdout);
      }
      resolve();
    });
  });
}

async function performInstallation(extensionPath: string): Promise<InstallResult> {
  const platform = os.platform();
  const resourcesDir = getExtensionResourceDir(extensionPath);
  const installDir = getInstallDir();

  console.log("[git-ai] Extension resources:", resourcesDir);
  console.log("[git-ai] Install directory:", installDir);
  console.log("[git-ai] Platform:", platform);

  // Find git-ai binary in resources
  const binaryNames = platform === "win32"
    ? ["git-ai-windows-x64.exe", "git-ai-windows-arm64.exe", "git-ai.exe"]
    : platform === "darwin"
      ? ["git-ai-darwin-arm64", "git-ai-darwin-x64", "git-ai"]
      : ["git-ai-linux-x64", "git-ai-linux-arm64", "git-ai"];

  let sourceBinary: string | null = null;
  for (const name of binaryNames) {
    const candidate = path.join(resourcesDir, name);
    if (await fileExists(candidate)) {
      sourceBinary = candidate;
      break;
    }
  }

  if (!sourceBinary) {
    return {
      success: false,
      message: "Binary not found",
      error: `Could not find git-ai binary in ${resourcesDir}. Tried: ${binaryNames.join(", ")}`
    };
  }

  console.log("[git-ai] Found binary:", sourceBinary);

  // Find Git
  const gitPath = await findGitPath();
  if (!gitPath) {
    return {
      success: false,
      message: "Git not found",
      error: platform === "win32"
        ? "Git not found in PowerShell PATH. Please ensure Git is installed and accessible from PowerShell."
        : "Git not found. Please install Git first."
    };
  }

  console.log("[git-ai] Found Git at:", gitPath);

  // Create install directory
  await fs.promises.mkdir(installDir, { recursive: true });

  // Stop existing processes
  await stopGitAiProcesses(installDir);

  // Copy binary
  const finalExe = platform === "win32"
    ? path.join(installDir, "git-ai.exe")
    : path.join(installDir, "git-ai");

  await fs.promises.copyFile(sourceBinary, finalExe);

  if (platform !== "win32") {
    await fs.promises.chmod(finalExe, 0o755);
  }

  console.log("[git-ai] Binary copied to:", finalExe);

  // Create shims
  await createGitShims(installDir, gitPath);

  // Write config
  await writeConfig(gitPath);

  // Update PATH
  const pathResult = await updatePathPrependGit(installDir, platform);
  if (!pathResult.success) {
    console.warn("[git-ai] PATH update failed:", pathResult.error);
  }

  // Update VSCode git.path setting
  await updateVSCodeGitPath(installDir);

  // Run install-hooks (optional, non-blocking)
  runInstallHooks(finalExe).catch(() => {});

  return {
    success: true,
    message: pathResult.success 
      ? `Successfully installed git-ai to ${installDir}` 
      : `Installed git-ai to ${installDir}, but PATH update failed. Please restart VSCode and terminals.`
  };
}

export async function ensureGitAiInstalled(context: vscode.ExtensionContext): Promise<boolean> {
  if (installationChecked) {
    return true;
  }
  installationChecked = true;

  const platform = os.platform();

  // Skip on non-Windows for now (binary not bundled)
  if (platform !== "win32") {
    console.log("[git-ai] Skipping installation on non-Windows platform");
    return true;
  }

  const installDir = getInstallDir();
  const finalExe = path.join(installDir, platform === "win32" ? "git-ai.exe" : "git-ai");

  // Check if already installed
  if (await fileExists(finalExe)) {
    console.log("[git-ai] git-ai already installed at:", finalExe);
    return true;
  }

  console.log("[git-ai] Starting git-ai installation from VSCode extension...");
  console.log("[git-ai] Extension path:", context.extensionPath);

  try {
    const result = await performInstallation(context.extensionPath);

    if (result.success) {
      vscode.window.showInformationMessage(
        "git-ai has been installed successfully! Please restart VSCode and your terminal to use it."
      );
      return true;
    } else {
      vscode.window.showErrorMessage(`Failed to install git-ai: ${result.message}`);
      console.error("[git-ai] Installation failed:", result.error);
      return false;
    }
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error("[git-ai] Installation error:", errorMsg);
    vscode.window.showErrorMessage(`Installation error: ${errorMsg}`);
    return false;
  }
}
