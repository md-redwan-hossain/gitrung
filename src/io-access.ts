import { accessSync, constants, existsSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { defaultConfigDir, projectRoot } from "./load-config.ts";

export type IoCheckResult = {
  errors: string[];
  warnings: string[];
};

export function isBunRuntime(): boolean {
  const executable = basename(process.execPath).toLowerCase();
  return executable === "bun" || executable === "bun.exe";
}

function canAccess(path: string, mode: number): boolean {
  try {
    accessSync(path, mode);
    return true;
  } catch {
    return false;
  }
}

/** Write check for the directory that holds the running executable (self-upgrade). */
export function checkUpgradeWriteAccess(): string | undefined {
  if (isBunRuntime()) return undefined;
  const dir = dirname(resolve(process.execPath));
  if (!canAccess(dir, constants.W_OK)) {
    return `Upgrade directory not writable: ${dir}`;
  }
  return undefined;
}

export function checkIoAccess(configDir?: string): IoCheckResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  const configsPath = configDir ? resolve(configDir) : defaultConfigDir();
  if (!canAccess(configsPath, constants.R_OK)) {
    errors.push(`Configs not readable: ${configsPath}`);
  }

  const envPath = resolve(projectRoot(), ".env");
  if (!existsSync(envPath)) {
    warnings.push(`.env not found at ${envPath} (tokens may still come from the shell environment)`);
  } else if (!canAccess(envPath, constants.R_OK)) {
    errors.push(`.env not readable: ${envPath}`);
  }

  const root = projectRoot();
  if (!canAccess(root, constants.W_OK)) {
    errors.push(`Project directory not writable (needed for metadata.jsonc): ${root}`);
  }

  if (isBunRuntime()) {
    warnings.push("Self-upgrade write check skipped (running under Bun, not a compiled binary)");
  } else {
    const upgradeError = checkUpgradeWriteAccess();
    if (upgradeError) errors.push(upgradeError);
  }

  return { errors, warnings };
}
