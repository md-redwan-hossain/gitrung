#!/usr/bin/env bun
import * as p from "@clack/prompts";
import chalk from "chalk";
import { Command } from "commander";
import { createGitClient } from "./create-git-client.ts";
import { reportHealthResult, runDoctor, runHealthChecks } from "./doctor.ts";
import { formatCliTable, formatKeyValueTable } from "./format-table.ts";
import type { GitHostClient } from "./git-host.ts";
import { loadToken } from "./load-config.ts";
import { parseRepoUrl } from "./parse-repo-url.ts";
import {
  confirmCreatePrStep,
  persistSourceBranch,
  promptSourceBranch,
  resolveSourceBranch,
} from "./source-branch.ts";
import {
  runCreatePrStep,
  validateCreatePrRemote,
} from "./steps/create-pr.ts";
import { runListPrStep } from "./steps/list-pr.ts";
import {
  promptValidatedMergePrNumber,
  runMergePrStep,
} from "./steps/merge-pr.ts";
import {
  collectPrecollectedWorkflowInputs,
  runWorkflowStep,
} from "./steps/run-workflow.ts";
import { cleanupStaleUpgradeArtifacts, runUpgrade } from "./upgrade.ts";
import {
  isStepGroup,
  stepKey,
  type CreatePrStep,
  type LeafStep,
  type MergePrNumberMap,
  type PipelineStep,
  type PrecollectedInputMap,
  type RepoConfig,
  type SelectedSubStepMap,
  type SkippedStepSet,
  type SourceBranchMap,
  type StepGroup,
} from "./schema.ts";

async function main(): Promise<void> {
  cleanupStaleUpgradeArtifacts();
  const program = new Command();
  program
    .name("gitrung")
    .description("Declarative Gitops")
    .option("-r, --repo <label>", "Repo label (configs/<label>.yaml filename stem)")
    .option("-c, --config <path>", "Path to configs directory")
    .action(async () => {
      const opts = program.opts<{ repo?: string; config?: string }>();
      await runPipeline(opts);
    });

  program
    .command("doctor")
    .description("Parse and validate configs directory")
    .option("-c, --config <path>", "Path to configs directory")
    .action((opts: { config?: string }) => {
      runDoctor(opts.config ?? program.opts<{ config?: string }>().config);
    });

  program
    .command("upgrade")
    .description("Check for and install the latest compiled binary")
    .action(runUpgrade);

  await program.parseAsync(process.argv);
}

async function runPipeline(opts: {
  repo?: string;
  config?: string;
}): Promise<void> {
  p.intro("gitrung");

  const health = runHealthChecks(opts.config);
  if (!health.ok) {
    reportHealthResult(health);
    p.outro("Config has problems.");
    process.exit(1);
  }
  for (const w of health.warnings) {
    p.log.warn(w);
  }
  const { config } = health;

  let first = true;
  while (true) {
    const repo = await pickRepo(config, first ? opts.repo : undefined);
    first = false;
    const token = loadToken(repo.gitPlatform);
    const parsed = parseRepoUrl(repo.url, repo.gitPlatform);
    const client = createGitClient(parsed, token);

    p.log.info(
      `Repo: ${repo.label} (${parsed.owner}/${parsed.repo}) [${repo.gitPlatform}]`,
    );
    p.log.info(`${repo.steps.length} step(s)`);

    const timings: StepTiming[] = [];

    const {
      precollectedInputs,
      skipped,
      sourceBranches,
      selectedSubSteps,
      mergePrNumbers,
    } = await runPreparePhase(client, repo.label, repo.steps);

    for (const [index, step] of repo.steps.entries()) {
      if (skipped.has(index)) continue;

      if (isStepGroup(step)) {
        const startTime = Date.now();
        const ran = await runGroupStep(
          client,
          repo.label,
          step,
          index,
          repo.steps.length,
          {
            precollectedInputs,
            skipped,
            sourceBranches,
            selectedSubSteps,
            mergePrNumbers,
          },
        );
        if (ran) {
          const subIndex = selectedSubSteps.get(index)!;
          const child = step.items[subIndex]!;
          const key = stepKey(index, subIndex);
          timings.push({
            index,
            step: child.type,
            description: stepIdentity(child, sourceBranches.get(key)),
            ms: Date.now() - startTime,
          });
        }
        continue;
      }

      p.log.step(
        formatStepLine(
          index,
          repo.steps.length,
          step,
          sourceBranches.get(stepKey(index)),
        ),
      );
      const startTime = Date.now();
      const ran = await runLeafStep(
        client,
        repo.label,
        step,
        stepKey(index),
        {
          precollectedInputs,
          skipped,
          sourceBranches,
          mergePrNumbers,
        },
      );
      if (ran) {
        timings.push({
          index,
          step: step.type,
          description: stepIdentity(step, sourceBranches.get(stepKey(index))),
          ms: Date.now() - startTime,
        });
      }
    }

    printStepTimings(timings);

    const again = await p.confirm({
      message: chalk.yellow("Perform another task?"),
      initialValue: true,
    });
    if (p.isCancel(again) || !again) {
      p.outro("Done.");
      return;
    }
  }
}

type PipelineMaps = {
  precollectedInputs: PrecollectedInputMap;
  skipped: SkippedStepSet;
  sourceBranches: SourceBranchMap;
  selectedSubSteps: SelectedSubStepMap;
  mergePrNumbers: MergePrNumberMap;
};

type StepTiming = {
  index: number;
  step: string;
  description: string;
  ms: number;
};

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const rem = seconds - minutes * 60;
  return `${minutes}m ${Math.round(rem)}s`;
}

function printStepTimings(timings: StepTiming[]): void {
  if (timings.length === 0) return;
  const totalMs = timings.reduce((sum, t) => sum + t.ms, 0);
  const rows = timings.map((t) => [
    String(t.index + 1),
    chalk.green(t.step),
    formatDuration(t.ms),
    t.description,
  ]);
  p.log.info(
    `Total time taken: ${formatDuration(totalMs)}\n${formatCliTable(rows, { head: ["#", "step", "time", "description"] })}`,
  );
}

type PrepareLeafContext = {
  leaf: LeafStep;
  key: string;
  index: number;
  fromOneOfGroup: boolean;
};

type PrepareMaps = {
  skipped: SkippedStepSet;
  sourceBranches: SourceBranchMap;
  mergePrNumbers: MergePrNumberMap;
  precollectedInputs: PrecollectedInputMap;
};

/** one-of → selected child; top-level leaf → itself. */
function resolvePrepareLeafContext(
  step: PipelineStep,
  index: number,
  selectedSubSteps: SelectedSubStepMap,
): PrepareLeafContext | null {
  if (isStepGroup(step)) {
    const subIndex = selectedSubSteps.get(index);
    if (subIndex === undefined) return null;
    return {
      leaf: step.items[subIndex]!,
      key: stepKey(index, subIndex),
      index,
      fromOneOfGroup: true,
    };
  }
  return {
    leaf: step,
    key: stepKey(index),
    index,
    fromOneOfGroup: false,
  };
}

/** Prepare-phase confirms / inputs (before any step executes). */
async function runPrepareLeaf(
  client: GitHostClient,
  label: string,
  ctx: PrepareLeafContext,
  maps: PrepareMaps,
  totalSteps: number,
): Promise<void> {
  const { leaf, key, index, fromOneOfGroup } = ctx;

  if (leaf.type === "create-pr") {
    const initial = await resolveSourceBranch(label, leaf);
    p.log.step(formatStepTitle(index, totalSteps, leaf, initial));
    const result = await confirmCreatePrStep(
      leaf.destinationBranch,
      initial,
      label,
      {
        reprint: (source) => {
          p.log.step(formatStepTitle(index, totalSteps, leaf, source));
        },
      },
    );
    if (result.action === "skip") {
      maps.skipped.add(index);
      p.log.info(
        `Will skip step ${index + 1}: ${chalk.green(stepIdentity(leaf, initial))}`,
      );
      return;
    }

    let source = result.sourceBranch;
    while (true) {
      try {
        await validateCreatePrRemote(client, leaf, source);
        maps.sourceBranches.set(key, source);
        return;
      } catch (err) {
        const text = err instanceof Error ? err.message : String(err);
        p.log.error(text);
        const sourceFailed =
          text.includes(`"${source}"`) ||
          text.includes(`Branch "${source}"`) ||
          text.includes(`branch ${source}`);
        if (!sourceFailed) throw err;
        p.log.info("Enter another source branch.");
        source = await promptSourceBranch(source);
        persistSourceBranch(label, leaf.destinationBranch, source);
      }
    }
  }

  if (leaf.type === "run-workflow") {
    p.log.step(formatStepTitle(index, totalSteps, leaf));
    const ok = await confirmRunWorkflowStep();
    if (!ok) {
      maps.skipped.add(index);
      p.log.info(
        `Will skip step ${index + 1}: ${chalk.green(stepIdentity(leaf))}`,
      );
      return;
    }
    const sets = await collectPrecollectedWorkflowInputs(client, label, leaf, {
      labelHint: fromOneOfGroup
        ? `step ${index + 1} (one-of)`
        : `step ${index + 1}`,
    });
    maps.precollectedInputs.set(key, sets);
    return;
  }

  if (leaf.type === "merge-pr") {
    // Collect PR# early when chosen under a one-of group
    if (!fromOneOfGroup) return;
    const validated = await promptValidatedMergePrNumber(
      client,
      leaf,
      `Enter PR number for step ${index + 1} (merge-pr)`,
    );
    maps.mergePrNumbers.set(key, validated.pr.number);
    return;
  }

  if (leaf.type === "list-pr") return;

  const _exhaustive: never = leaf;
  throw new Error(`Unknown leaf: ${JSON.stringify(_exhaustive)}`);
}

async function runPreparePhase(
  client: GitHostClient,
  label: string,
  steps: PipelineStep[],
): Promise<{
  precollectedInputs: PrecollectedInputMap;
  skipped: SkippedStepSet;
  sourceBranches: SourceBranchMap;
  selectedSubSteps: SelectedSubStepMap;
  mergePrNumbers: MergePrNumberMap;
}> {
  const skipped: SkippedStepSet = new Set();
  const sourceBranches: SourceBranchMap = new Map();
  const selectedSubSteps: SelectedSubStepMap = new Map();
  const mergePrNumbers: MergePrNumberMap = new Map();
  const precollectedInputs: PrecollectedInputMap = new Map();
  const maps: PrepareMaps = {
    skipped,
    sourceBranches,
    mergePrNumbers,
    precollectedInputs,
  };

  // one-of: pick child first
  for (const [index, step] of steps.entries()) {
    if (!isStepGroup(step)) continue;
    const subIndex = await selectSubStep(step, index, steps.length);
    if (subIndex === "skip") {
      skipped.add(index);
      p.log.info(`Will skip step ${index + 1}: ${chalk.green("one-of")}`);
      continue;
    }
    selectedSubSteps.set(index, subIndex);
  }

  // Ordered confirms / inputs / PR#
  for (const [index, step] of steps.entries()) {
    if (skipped.has(index)) continue;
    const ctx = resolvePrepareLeafContext(step, index, selectedSubSteps);
    if (!ctx) continue;
    await runPrepareLeaf(client, label, ctx, maps, steps.length);
  }

  return {
    precollectedInputs,
    skipped,
    sourceBranches,
    selectedSubSteps,
    mergePrNumbers,
  };
}

async function selectSubStep(
  group: StepGroup,
  groupIndex: number,
  totalSteps: number,
): Promise<number | "skip"> {
  const selected = await p.select({
    message: `Which one-of item to run for ${chalk.yellow(`[${groupIndex + 1}/${totalSteps}]`)}?`,
    options: [
      ...group.items.map((child, i) => ({
        value: i as number | "skip",
        label: chalk.green(child.type),
      })),
      { value: "skip" as const, label: "Skip" },
    ],
  });

  if (p.isCancel(selected)) {
    p.cancel("Cancelled.");
    process.exit(0);
  }

  return selected;
}

async function confirmRunWorkflowStep(): Promise<boolean> {
  const answer = await p.select({
    message: "Run this step?",
    options: [
      { value: "yes", label: "Yes" },
      { value: "skip", label: "Skip" },
    ],
    initialValue: "yes",
  });

  if (p.isCancel(answer)) {
    p.cancel("Cancelled.");
    process.exit(0);
  }

  return answer === "yes";
}

async function pickRepo(
  repos: RepoConfig[],
  label?: string,
): Promise<RepoConfig> {
  if (label) {
    const found = repos.find((r) => r.label === label);
    if (!found) {
      throw new Error(
        `Repo label "${label}" not found. Available: ${repos
          .map((r) => r.label)
          .join(", ")}`,
      );
    }
    return found;
  }

  if (repos.length === 1) {
    return repos[0]!;
  }

  const selected = await p.autocomplete({
    message: "Select a repo",
    placeholder: "Type to search…",
    options: repos.map((r) => ({
      value: r.label,
      label: `${r.label} [${r.gitPlatform}]`,
      hint: r.url,
    })),
    filter: (search, option) =>
      String(option.value).toLowerCase().includes(search.toLowerCase()),
  });

  if (p.isCancel(selected)) {
    p.cancel("Cancelled.");
    process.exit(0);
  }

  return repos.find((r) => r.label === selected)!;
}

type ParamRow = { key: string; value: string };

function stepIdentity(step: LeafStep, resolvedSource?: string): string {
  if (step.type === "create-pr") {
    const source = resolvedSource ?? step.sourceBranch ?? "prompt";
    return `${source} → ${step.destinationBranch}`;
  }
  if (step.type === "run-workflow") {
    return `${step.workflow} @ ${step.useWorkflowFromBranch}`;
  }
  if (step.type === "list-pr") {
    return "list-pr";
  }
  return "merge-pr";
}

function stepParamRows(
  step: LeafStep,
  resolvedSource?: string,
): ParamRow[] {
  if (step.type === "create-pr") {
    const source = resolvedSource ?? step.sourceBranch ?? "prompt";
    const rows: ParamRow[] = [
      { key: "source", value: source },
      { key: "destination", value: step.destinationBranch },
      { key: "merge", value: String(step.merge) },
      {
        key: "afterMerge.waitFor",
        value: step.merge
          ? step.afterMerge.waitFor.join(",") || "—"
          : "—",
      },
    ];
    if (step.title) rows.push({ key: "title", value: step.title });
    if (step.body) rows.push({ key: "body", value: step.body });
    return rows;
  }
  if (step.type === "list-pr") {
    const rows: ParamRow[] = [{ key: "status", value: step.status }];
    if (step.user) rows.push({ key: "user", value: step.user });
    return rows;
  }
  if (step.type === "merge-pr") {
    if (step.when.length === 0) {
      return [{ key: "when", value: "—" }];
    }
    return step.when.flatMap((w, i) => {
      const prefix = step.when.length === 1 ? "when" : `when[${i}]`;
      return [
        { key: `${prefix}.destinationBranch`, value: w.destinationBranch },
        { key: `${prefix}.waitFor`, value: w.waitFor.join(",") },
      ];
    });
  }
  const rows: ParamRow[] = [
    { key: "workflow", value: step.workflow },
    { key: "useWorkflowFromBranch", value: step.useWorkflowFromBranch },
    { key: "waitUntilFinish", value: String(step.waitUntilFinish) },
    { key: "exitOnError", value: String(step.exitOnError) },
  ];
  for (const [i, w] of step.when.entries()) {
    const prefix = step.when.length === 1 ? "when" : `when[${i}]`;
    rows.push(
      { key: `${prefix}.actionInputId`, value: w.actionInputId },
      { key: `${prefix}.repeat`, value: String(w.repeat) },
    );
  }
  return rows;
}

function formatParamTable(rows: ParamRow[]): string {
  return formatKeyValueTable(rows);
}

function formatToolIdentity(
  step: LeafStep,
  resolvedSource?: string,
): string {
  const identity = stepIdentity(step, resolvedSource);
  const tool = chalk.cyan(`(${step.type})`);
  return identity === step.type ? tool : `${tool} ${chalk.green(identity)}`;
}

/** Title-only step header (no param table) — used during prepare/confirm. */
function formatStepTitle(
  index: number,
  total: number,
  step: LeafStep,
  resolvedSource?: string,
): string {
  return `${chalk.yellow(`[${index + 1}/${total}]`)} ${formatToolIdentity(step, resolvedSource)}`;
}

function formatStepBlock(
  prefix: string,
  step: LeafStep,
  resolvedSource?: string,
): string {
  const header = `${prefix}${formatToolIdentity(step, resolvedSource)}`;
  const table = formatParamTable(stepParamRows(step, resolvedSource));
  return table ? `${header}\n${table}` : header;
}

function formatStepLine(
  index: number,
  total: number,
  step: LeafStep,
  resolvedSource?: string,
): string {
  return formatStepBlock(
    `${chalk.yellow(`[${index + 1}/${total}]`)} `,
    step,
    resolvedSource,
  );
}

async function runGroupStep(
  client: GitHostClient,
  label: string,
  group: StepGroup,
  groupIndex: number,
  totalSteps: number,
  maps: PipelineMaps,
): Promise<boolean> {
  // Main loop already continues for skipped; keep as a quiet guard.
  if (maps.skipped.has(groupIndex)) return false;

  const subIndex = maps.selectedSubSteps.get(groupIndex);
  if (subIndex === undefined) {
    throw new Error(`Missing one-of selection for step ${groupIndex + 1}`);
  }

  const child = group.items[subIndex]!;
  const key = stepKey(groupIndex, subIndex);
  p.log.step(
    formatStepLine(
      groupIndex,
      totalSteps,
      child,
      maps.sourceBranches.get(key),
    ),
  );

  return runLeafStep(client, label, child, key, maps);
}

async function runLeafStep(
  client: GitHostClient,
  label: string,
  step: LeafStep,
  key: string,
  maps: Omit<PipelineMaps, "selectedSubSteps">,
): Promise<boolean> {
  if (step.type === "create-pr") {
    return runCreatePrWithResolve(client, step, key, maps.sourceBranches);
  }

  if (step.type === "run-workflow") {
    await runWorkflowStep(client, label, step, {
      stepKey: key,
      precollectedInputs: maps.precollectedInputs,
    });
    return true;
  }

  if (step.type === "list-pr") {
    await runListPrStep(client, step);
    return true;
  }

  if (step.type === "merge-pr") {
    const precollected = maps.mergePrNumbers.get(key);
    await runMergePrStep(client, step, {
      prNumber: precollected,
    });
    return true;
  }

  const _exhaustive: never = step;
  throw new Error(`Unknown step: ${JSON.stringify(_exhaustive)}`);
}

async function runCreatePrWithResolve(
  client: GitHostClient,
  step: CreatePrStep,
  key: string,
  sourceBranches: SourceBranchMap,
): Promise<boolean> {
  const source = sourceBranches.get(key);
  if (source === undefined) {
    throw new Error(
      `Missing prepared source branch for create-pr (step key ${key})`,
    );
  }

  await runCreatePrStep(client, step, { sourceBranch: source });
  return true;
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  p.log.error(message);
  process.exit(1);
});
