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
  collectAskUpfrontWorkflowInputs,
  runWorkflowStep,
} from "./steps/run-workflow.ts";
import { cleanupStaleUpgradeArtifacts, runUpgrade } from "./upgrade.ts";
import {
  isStepGroup,
  stepKey,
  type CreatePrStep,
  type AskUpfrontInputMap,
  type LeafStep,
  type MergePrNumberMap,
  type PipelineStep,
  type RepoConfig,
  type RunWorkflowStep,
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
    const { alreadyRan, timings: earlyTimings } =
      await runBeforeAskUpfrontListPrSteps(client, repo.steps);
    timings.push(...earlyTimings);

    const {
      askUpfrontInputs,
      skipped,
      sourceBranches,
      selectedSubSteps,
      mergePrNumbers,
      shownHeaders,
    } = await runAskUpfrontPhase(client, repo.label, repo.steps);

    for (const [index, step] of repo.steps.entries()) {
      // Early-run / ask-upfront already logged these; do not reprint.
      if (alreadyRan.has(index) || skipped.has(index)) continue;

      if (isStepGroup(step)) {
        const startTime = Date.now();
        const ran = await runGroupStep(
          client,
          repo.label,
          step,
          index,
          repo.steps.length,
          {
            askUpfrontInputs,
            skipped,
            sourceBranches,
            selectedSubSteps,
            mergePrNumbers,
            shownHeaders,
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
        formatStepTitle(
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
        index,
        repo.steps.length,
        {
          askUpfrontInputs,
          skipped,
          sourceBranches,
          mergePrNumbers,
          shownHeaders,
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
  askUpfrontInputs: AskUpfrontInputMap;
  skipped: SkippedStepSet;
  sourceBranches: SourceBranchMap;
  selectedSubSteps: SelectedSubStepMap;
  mergePrNumbers: MergePrNumberMap;
  shownHeaders: Set<number>;
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

/** list-pr steps with runBeforeAskUpfront run before ask-upfront prompts; indices skipped in the main loop. */
async function runBeforeAskUpfrontListPrSteps(
  client: GitHostClient,
  steps: PipelineStep[],
): Promise<{ alreadyRan: Set<number>; timings: StepTiming[] }> {
  const alreadyRan = new Set<number>();
  const timings: StepTiming[] = [];

  for (const [index, step] of steps.entries()) {
    if (isStepGroup(step)) continue;
    if (step.type !== "list-pr" || !step.runBeforeAskUpfront) continue;
    p.log.step(formatStepLine(index, steps.length, step));
    const startTime = Date.now();
    await runListPrStep(client, step);
    timings.push({
      index,
      step: step.type,
      description: stepIdentity(step),
      ms: Date.now() - startTime,
    });
    alreadyRan.add(index);
  }

  return { alreadyRan, timings };
}

type AskUpfrontLeafContext = {
  leaf: LeafStep;
  key: string;
  index: number;
  fromAskUpfrontGroup: boolean;
};

type AskUpfrontMaps = {
  skipped: SkippedStepSet;
  sourceBranches: SourceBranchMap;
  mergePrNumbers: MergePrNumberMap;
  shownHeaders: Set<number>;
};

/** Ask-upfront group → selected child; non-askUpfront group → null; top-level leaf → itself. */
function resolveAskUpfrontLeafContext(
  step: PipelineStep,
  index: number,
  selectedSubSteps: SelectedSubStepMap,
): AskUpfrontLeafContext | null {
  if (isStepGroup(step)) {
    if (!step.askUpfront) return null;
    const subIndex = selectedSubSteps.get(index);
    if (subIndex === undefined) return null;
    return {
      leaf: step.items[subIndex]!,
      key: stepKey(index, subIndex),
      index,
      fromAskUpfrontGroup: true,
    };
  }
  return {
    leaf: step,
    key: stepKey(index),
    index,
    fromAskUpfrontGroup: false,
  };
}

/** Type-specific ask-upfront prompts + immediate remote validation. */
async function runAskUpfrontLeaf(
  client: GitHostClient,
  label: string,
  ctx: AskUpfrontLeafContext,
  maps: AskUpfrontMaps,
  totalSteps: number,
): Promise<void> {
  const { leaf, key, index, fromAskUpfrontGroup } = ctx;

  if (leaf.type === "create-pr") {
    if (!leaf.askUpfront || !leaf.confirmBeforeRun) return;
    const initial = await resolveSourceBranch(label, leaf);
    p.log.step(formatStepLine(index, totalSteps, leaf, initial));
    maps.shownHeaders.add(index);
    const result = await confirmCreatePrStep(
      leaf.destinationBranch,
      initial,
      label,
      {
        reprint: (source) => {
          p.log.step(formatStepLine(index, totalSteps, leaf, source));
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
    if (!leaf.askUpfront || !leaf.confirmBeforeRun) return;
    p.log.step(formatStepLine(index, totalSteps, leaf));
    maps.shownHeaders.add(index);
    const ok = await confirmRunWorkflowStep();
    if (!ok) {
      maps.skipped.add(index);
      p.log.info(
        `Will skip step ${index + 1}: ${chalk.green(stepIdentity(leaf))}`,
      );
      return;
    }
    return;
  }

  if (leaf.type === "merge-pr") {
    // Only collect PR# early when chosen under an ask-upfront one-of group
    if (!fromAskUpfrontGroup) return;
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

async function runAskUpfrontPhase(
  client: GitHostClient,
  label: string,
  steps: PipelineStep[],
): Promise<{
  askUpfrontInputs: AskUpfrontInputMap;
  skipped: SkippedStepSet;
  sourceBranches: SourceBranchMap;
  selectedSubSteps: SelectedSubStepMap;
  mergePrNumbers: MergePrNumberMap;
  shownHeaders: Set<number>;
}> {
  const skipped: SkippedStepSet = new Set();
  const sourceBranches: SourceBranchMap = new Map();
  const selectedSubSteps: SelectedSubStepMap = new Map();
  const mergePrNumbers: MergePrNumberMap = new Map();
  const shownHeaders = new Set<number>();
  const maps: AskUpfrontMaps = {
    skipped,
    sourceBranches,
    mergePrNumbers,
    shownHeaders,
  };

  // Ask-upfront groups: pick child first
  for (const [index, step] of steps.entries()) {
    if (!isStepGroup(step) || !step.askUpfront) continue;
    const subIndex = await selectSubStep(step, index, steps.length);
    if (subIndex === "skip") {
      skipped.add(index);
      p.log.info(`Will skip step ${index + 1}: ${chalk.green("one-of")}`);
      continue;
    }
    selectedSubSteps.set(index, subIndex);
  }

  // Ordered confirms / PR# (walker is type-agnostic)
  for (const [index, step] of steps.entries()) {
    if (skipped.has(index)) continue;
    const ctx = resolveAskUpfrontLeafContext(step, index, selectedSubSteps);
    if (!ctx) continue;
    await runAskUpfrontLeaf(client, label, ctx, maps, steps.length);
  }

  const askUpfrontWorkflowSteps: {
    step: RunWorkflowStep;
    key: string;
    labelHint: string;
  }[] = [];

  for (const [index, step] of steps.entries()) {
    if (skipped.has(index)) continue;
    const ctx = resolveAskUpfrontLeafContext(step, index, selectedSubSteps);
    if (!ctx) continue;
    if (ctx.leaf.type !== "run-workflow" || !ctx.leaf.askUpfront) continue;
    askUpfrontWorkflowSteps.push({
      step: ctx.leaf,
      key: ctx.key,
      labelHint: ctx.fromAskUpfrontGroup
        ? `step ${index + 1} (one-of)`
        : `step ${index + 1}`,
    });
  }

  if (askUpfrontWorkflowSteps.length === 0) {
    return {
      askUpfrontInputs: new Map(),
      skipped,
      sourceBranches,
      selectedSubSteps,
      mergePrNumbers,
      shownHeaders,
    };
  }

  p.log.info(
    `Collecting ask-upfront inputs for ${askUpfrontWorkflowSteps.length} workflow(s)…`,
  );
  const askUpfrontInputs = await collectAskUpfrontWorkflowInputs(
    client,
    label,
    askUpfrontWorkflowSteps,
  );
  return {
    askUpfrontInputs,
    skipped,
    sourceBranches,
    selectedSubSteps,
    mergePrNumbers,
    shownHeaders,
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
      { key: "askUpfront", value: String(step.askUpfront) },
      { key: "confirmBeforeRun", value: String(step.confirmBeforeRun) },
    ];
    if (step.title) rows.push({ key: "title", value: step.title });
    if (step.body) rows.push({ key: "body", value: step.body });
    return rows;
  }
  if (step.type === "list-pr") {
    const rows: ParamRow[] = [{ key: "status", value: step.status }];
    if (step.user) rows.push({ key: "user", value: step.user });
    rows.push({
      key: "runBeforeAskUpfront",
      value: String(step.runBeforeAskUpfront),
    });
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
    { key: "askUpfront", value: String(step.askUpfront) },
    { key: "confirmBeforeRun", value: String(step.confirmBeforeRun) },
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

/** Title-only step header (no param table) — used when a step starts executing. */
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

  let subIndex = maps.selectedSubSteps.get(groupIndex);
  if (subIndex === undefined) {
    const selected = await selectSubStep(group, groupIndex, totalSteps);
    if (selected === "skip") {
      maps.skipped.add(groupIndex);
      p.log.info(`Skipped: ${chalk.green("one-of")}`);
      return false;
    }
    subIndex = selected;
    maps.selectedSubSteps.set(groupIndex, subIndex);
  }

  const child = group.items[subIndex]!;
  const key = stepKey(groupIndex, subIndex);
  p.log.step(
    formatStepTitle(
      groupIndex,
      totalSteps,
      child,
      maps.sourceBranches.get(key),
    ),
  );

  return runLeafStep(
    client,
    label,
    child,
    key,
    groupIndex,
    totalSteps,
    maps,
  );
}

async function runLeafStep(
  client: GitHostClient,
  label: string,
  step: LeafStep,
  key: string,
  topIndex: number,
  totalSteps: number,
  maps: Omit<PipelineMaps, "selectedSubSteps">,
): Promise<boolean> {
  if (step.type === "create-pr") {
    return runCreatePrWithResolve(
      client,
      label,
      step,
      key,
      topIndex,
      totalSteps,
      maps.sourceBranches,
    );
  }

  if (step.type === "run-workflow" && step.confirmBeforeRun) {
    // Ask-upfront phase already confirmed when inputs were collected for this key
    if (!maps.askUpfrontInputs.has(key)) {
      const ok = await confirmRunWorkflowStep();
      if (!ok) {
        p.log.info(formatStepBlock("Skipped: ", step));
        return false;
      }
    }
  }

  if (step.type === "run-workflow") {
    await runWorkflowStep(client, label, step, {
      stepKey: key,
      askUpfrontInputs: maps.askUpfrontInputs,
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
  label: string,
  step: CreatePrStep,
  key: string,
  stepIndex: number,
  totalSteps: number,
  sourceBranches: SourceBranchMap,
): Promise<boolean> {
  let source = sourceBranches.get(key);

  if (source === undefined) {
    source = await resolveSourceBranch(label, step);

    // Confirm here when not already handled in Ask-upfront phase (sourceBranches unset)
    if (step.confirmBeforeRun) {
      const result = await confirmCreatePrStep(
        step.destinationBranch,
        source,
        label,
        {
          reprint: (next) => {
            p.log.step(formatStepLine(stepIndex, totalSteps, step, next));
          },
        },
      );
      if (result.action === "skip") {
        p.log.info(formatStepBlock("Skipped: ", step, source));
        return false;
      }
      source = result.sourceBranch;
    }

    sourceBranches.set(key, source);
  }

  await runCreatePrStep(client, step, { sourceBranch: source });
  return true;
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  p.log.error(message);
  process.exit(1);
});
