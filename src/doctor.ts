import * as p from "@clack/prompts";
import { checkIoAccess } from "./io-access.ts";
import { tryLoadConfig } from "./load-config.ts";
import type { AppConfig } from "./schema.ts";

export type HealthCheckResult =
  | { ok: true; config: AppConfig; path: string; warnings: string[] }
  | { ok: false; path: string; errors: string[]; warnings: string[] };

export function runHealthChecks(configDir?: string): HealthCheckResult {
  const io = checkIoAccess(configDir);
  const configResult = tryLoadConfig(configDir);
  const warnings = [...io.warnings, ...configResult.warnings];

  if (io.errors.length > 0 || !configResult.ok) {
    const errors = [...io.errors];
    if (!configResult.ok) errors.push(...configResult.errors);
    return { ok: false, path: configResult.path, errors, warnings };
  }

  return {
    ok: true,
    config: configResult.config,
    path: configResult.path,
    warnings,
  };
}

export function reportHealthResult(result: HealthCheckResult): void {
  if (!result.ok) {
    for (const err of result.errors) {
      p.log.error(err);
    }
    return;
  }

  p.log.info(`Config: ${result.path}`);

  for (const w of result.warnings) {
    p.log.warn(w);
  }

  const { config } = result;
  p.log.success(
    `OK — ${config.length} repo(s), ${config.reduce((n, r) => n + r.steps.length, 0)} step(s)`,
  );
  for (const repo of config) {
    p.log.info(`  ${repo.label}: ${repo.steps.length} step(s)`);
  }
}

export function runDoctor(configPath?: string): void {
  const result = runHealthChecks(configPath);

  if (!result.ok) {
    reportHealthResult(result);
    process.exit(1);
  }

  p.intro("gitrung doctor");
  reportHealthResult(result);
  p.outro("Healthy.");
  process.exit(0);
}
