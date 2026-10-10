import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, extname, resolve } from "node:path";
import { z, ZodError } from "zod";
import {
  RepoFileSchema,
  type AppConfig,
  type GitPlatform,
  type RepoConfig,
} from "./schema.ts";

export function projectRoot(): string {
  return process.cwd();
}

export function defaultConfigDir(): string {
  return resolve(process.cwd(), "configs");
}

export type LoadConfigResult =
  | { ok: true; config: AppConfig; path: string; warnings: string[] }
  | { ok: false; path: string; errors: string[]; warnings: string[] };

function isConfigFile(name: string): boolean {
  const lower = name.toLowerCase();
  if (lower.endsWith(".yaml.example") || lower.endsWith(".yml.example")) {
    return false;
  }
  return lower.endsWith(".yaml") || lower.endsWith(".yml");
}

function labelFromFilename(name: string): string {
  const lower = name.toLowerCase();
  if (lower.endsWith(".yaml")) return name.slice(0, -".yaml".length);
  if (lower.endsWith(".yml")) return name.slice(0, -".yml".length);
  return basename(name, extname(name));
}

export function tryLoadConfig(configDir?: string): LoadConfigResult {
  const path = configDir ? resolve(configDir) : defaultConfigDir();
  const warnings: string[] = [];
  const hint =
    "Copy configs/my-repo.yaml.example to configs/<name>.yaml and edit it.";

  if (!existsSync(path)) {
    return {
      ok: false,
      path,
      errors: [`Configs directory not found: ${path}`, hint],
      warnings,
    };
  }

  let isDir = false;
  try {
    isDir = statSync(path).isDirectory();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      path,
      errors: [`Failed to read configs directory: ${message}`],
      warnings,
    };
  }

  if (!isDir) {
    return {
      ok: false,
      path,
      errors: [
        `Config path must be a directory of .yaml/.yml files: ${path}`,
        hint,
      ],
      warnings,
    };
  }

  let entries: string[];
  try {
    entries = readdirSync(path);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      path,
      errors: [`Failed to read configs directory: ${message}`],
      warnings,
    };
  }

  const files = entries
    .filter((name) => {
      if (!isConfigFile(name)) return false;
      try {
        return statSync(resolve(path, name)).isFile();
      } catch {
        return false;
      }
    })
    .sort((a, b) => a.localeCompare(b));

  if (files.length === 0) {
    return {
      ok: false,
      path,
      errors: [`No .yaml or .yml config files in: ${path}`, hint],
      warnings,
    };
  }

  const seenLabels = new Map<string, string>();
  const repos: RepoConfig[] = [];
  const errors: string[] = [];

  for (const fileName of files) {
    const filePath = resolve(path, fileName);
    const label = labelFromFilename(fileName);

    const prevFile = seenLabels.get(label);
    if (prevFile !== undefined) {
      errors.push(
        `Duplicate repo label "${label}" from ${prevFile} and ${fileName}`,
      );
      continue;
    }
    seenLabels.set(label, fileName);

    let raw: string;
    try {
      raw = readFileSync(filePath, "utf8");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push(`${fileName}: failed to read — ${message}`);
      continue;
    }

    if (raw.trim().length === 0) {
      errors.push(`${fileName}: file is empty`);
      continue;
    }

    let data: unknown;
    try {
      data = Bun.YAML.parse(raw);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push(`${fileName}: failed to parse YAML — ${message}`);
      continue;
    }

    if (data === null || typeof data !== "object" || Array.isArray(data)) {
      errors.push(
        `${fileName}: root must be a single repo object (not an array)`,
      );
      continue;
    }

    const record = data as Record<string, unknown>;
    if ("label" in record) {
      warnings.push(
        `${fileName}: ignoring "label" field (label comes from the filename: ${label})`,
      );
      delete record.label;
    }

    try {
      const parsed = RepoFileSchema.parse(record);
      repos.push({ ...parsed, label });
    } catch (err) {
      if (err instanceof ZodError) {
        errors.push(`${fileName}: invalid config:\n${z.prettifyError(err)}`);
      } else {
        throw err;
      }
    }
  }

  if (errors.length > 0) {
    return { ok: false, path, errors, warnings };
  }

  if (repos.length === 0) {
    return {
      ok: false,
      path,
      errors: [`No usable repo configs in: ${path}`, hint],
      warnings,
    };
  }

  return { ok: true, config: repos, path, warnings };
}

export function loadToken(gitPlatform: GitPlatform): string {
  if (gitPlatform === "github") {
    const token = process.env.GITHUB_TOKEN?.trim();
    if (!token) {
      throw new Error(
        "GITHUB_TOKEN is missing. Copy .env.example to .env and set your GitHub token (repo + workflow scopes).",
      );
    }
    return token;
  }

  const token = process.env.GITEA_TOKEN?.trim();
  if (!token) {
    throw new Error(
      "GITEA_TOKEN is missing. Copy .env.example to .env and set your token.",
    );
  }
  return token;
}
