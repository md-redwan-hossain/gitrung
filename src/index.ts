#!/usr/bin/env bun
import * as p from "@clack/prompts";
import chalk from "chalk";
import Table from "cli-table3";
import { Command } from "commander";
import { createGitClient } from "./create-git-client.ts";
import { reportHealthResult, runDoctor, runHealthChecks } from "./doctor.ts";
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
  validateRunWorkflowRemote,
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
    .description("Run declarative Gitea/GitHub PR + workflow automation steps")
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

  const repo = await pickRepo(config, opts.repo);
  const token = loadToken(repo.gitPlatform);
  const parsed = parseRepoUrl(repo.url, repo.gitPlatform);
  const client = createGitClient(parsed, token);

  p.log.info(
    `Repo: ${repo.label} (${parsed.owner}/${parsed.repo}) [${repo.gitPlatform}]`,
  );
  p.log.info(`${repo.steps.length} step(s)`);

  const alreadyRan = await runBeforeAskUpfrontListPrSteps(client, repo.steps);

  const {
    askUpfrontInputs,
    skipped,
    sourceBranches,
    selectedSubSteps,
    mergePrNumbers,
  } = await runAskUpfrontPhase(client, repo.label, repo.steps);

  for (const [index, step] of repo.steps.entries()) {
    // Early-run / ask-upfront already logged these; do not reprint.
    if (alreadyRan.has(index) || skipped.has(index)) continue;

    if (isStepGroup(step)) {
      await runGroupStep(
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
        },
      );
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
    await runLeafStep(
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
      },
    );
  }

  p.outro("Done.");
}

type PipelineMaps = {
  askUpfrontInputs: AskUpfrontInputMap;
  skipped: SkippedStepSet;
  sourceBranches: SourceBranchMap;
  selectedSubSteps: SelectedSubStepMap;
  mergePrNumbers: MergePrNumberMap;
};

/** list-pr steps with runBeforeAskUpfront run before ask-upfront prompts; indices skipped in the main loop. */
async function runBeforeAskUpfrontListPrSteps(
  client: GitHostClient,
  steps: PipelineStep[],
): Promise<Set<number>> {
  const alreadyRan = new Set<number>();

  for (const [index, step] of steps.entries()) {
    if (isStepGroup(step)) continue;
    if (step.type !== "list-pr" || !step.runBeforeAskUpfront) continue;
    p.log.step(formatStepLine(index, steps.length, step));
    await runListPrStep(client, step);
    alreadyRan.add(index);
  }

  return alreadyRan;
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
    const result = await confirmCreatePrStep(
      leaf.destinationBranch,
      initial,
      label,
      index,
      totalSteps,
    );
    if (result.action === "skip") {
      maps.skipped.add(index);
      p.log.info(
        formatStepBlock(
          `Will skip step ${index + 1}: `,
          leaf,
          initial,
        ),
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
    const ok = await confirmRunWorkflowStep(leaf, index, totalSteps);
    if (!ok) {
      maps.skipped.add(index);
      p.log.info(formatStepBlock(`Will skip step ${index + 1}: `, leaf));
      return;
    }
    await validateRunWorkflowRemote(client, leaf);
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
}> {
  const skipped: SkippedStepSet = new Set();
  const sourceBranches: SourceBranchMap = new Map();
  const selectedSubSteps: SelectedSubStepMap = new Map();
  const mergePrNumbers: MergePrNumberMap = new Map();
  const maps: AskUpfrontMaps = {
    skipped,
    sourceBranches,
    mergePrNumbers,
  };

  // Ask-upfront groups: pick child first
  for (const [index, step] of steps.entries()) {
    if (!isStepGroup(step) || !step.askUpfront) continue;
    const subIndex = await selectSubStep(step, index, steps.length);
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
  };
}

async function selectSubStep(
  group: StepGroup,
  groupIndex: number,
  totalSteps: number,
): Promise<number> {
  const selected = await p.select({
    message: `Which one-of item to run for ${chalk.yellow(`[${groupIndex + 1}/${totalSteps}]`)}?`,
    options: group.items.map((child, i) => ({
      value: i,
      label: chalk.green(child.type),
    })),
  });

  if (p.isCancel(selected)) {
    p.cancel("Cancelled.");
    process.exit(0);
  }

  return selected;
}

async function confirmRunWorkflowStep(
  step: RunWorkflowStep,
  stepIndex: number,
  totalSteps: number,
): Promise<boolean> {
  const answer = await p.select({
    message: `Run ${chalk.yellow(`[${stepIndex + 1}/${totalSteps}]`)}: ${step.workflow} @ ${step.useWorkflowFromBranch}?`,
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

  const selected = await p.select({
    message: "Select a repo",
    options: repos.map((r) => ({
      value: r.label,
      label: `${r.label} [${r.gitPlatform}]`,
      hint: r.url,
    })),
  });

  if (p.isCancel(selected)) {
    p.cancel("Cancelled.");
    process.exit(0);
  }

  return repos.find((r) => r.label === selected)!;
}

type ParamRow = { key: string; value: string };

function stepParamRows(
  step: LeafStep,
  resolvedSource?: string,
): ParamRow[] {
  if (step.type === "create-pr") {
    const source = resolvedSource ?? step.sourceBranch ?? "prompt";
    return [
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
  if (rows.length === 0) return "";
  const table = new Table({
    chars: {
      top: "═",
      "top-mid": "╤",
      "top-left": "╔",
      "top-right": "╗",
      bottom: "═",
      "bottom-mid": "╧",
      "bottom-left": "╚",
      "bottom-right": "╝",
      left: "║",
      "left-mid": "",
      mid: "",
      "mid-mid": "",
      right: "║",
      "right-mid": "",
      middle: "│",
    },
    style: { head: [], border: [], "padding-left": 1, "padding-right": 1 },
  });
  for (const row of rows) {
    table.push([row.key, row.value]);
  }
  return table
    .toString()
    .split("\n")
    .map((line) => `    ${line}`)
    .join("\n");
}

function formatStepBlock(
  prefix: string,
  step: LeafStep,
  resolvedSource?: string,
): string {
  const header = `${prefix}${chalk.green(step.type)}`;
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
): Promise<void> {
  // Main loop already continues for skipped; keep as a quiet guard.
  if (maps.skipped.has(groupIndex)) return;

  let subIndex = maps.selectedSubSteps.get(groupIndex);
  if (subIndex === undefined) {
    subIndex = await selectSubStep(group, groupIndex, totalSteps);
    maps.selectedSubSteps.set(groupIndex, subIndex);
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

  await runLeafStep(
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
): Promise<void> {
  if (step.type === "create-pr") {
    await runCreatePrWithResolve(
      client,
      label,
      step,
      key,
      topIndex,
      totalSteps,
      maps.sourceBranches,
    );
    return;
  }

  if (step.type === "run-workflow" && step.confirmBeforeRun) {
    // Ask-upfront phase already confirmed when inputs were collected for this key
    if (!maps.askUpfrontInputs.has(key)) {
      const ok = await confirmRunWorkflowStep(step, topIndex, totalSteps);
      if (!ok) {
        p.log.info(formatStepBlock("Skipped: ", step));
        return;
      }
    }
  }

  if (step.type === "run-workflow") {
    await runWorkflowStep(client, label, step, {
      stepKey: key,
      askUpfrontInputs: maps.askUpfrontInputs,
    });
    return;
  }

  if (step.type === "list-pr") {
    await runListPrStep(client, step);
    return;
  }

  if (step.type === "merge-pr") {
    const precollected = maps.mergePrNumbers.get(key);
    await runMergePrStep(client, step, {
      prNumber: precollected,
    });
    return;
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
): Promise<void> {
  let source = sourceBranches.get(key);

  if (source === undefined) {
    source = await resolveSourceBranch(label, step);

    // Confirm here when not already handled in Ask-upfront phase (sourceBranches unset)
    if (step.confirmBeforeRun) {
      const result = await confirmCreatePrStep(
        step.destinationBranch,
        source,
        label,
        stepIndex,
        totalSteps,
      );
      if (result.action === "skip") {
        p.log.info(formatStepBlock("Skipped: ", step, source));
        return;
      }
      source = result.sourceBranch;
    }

    sourceBranches.set(key, source);
  }

  await runCreatePrStep(client, step, { sourceBranch: source });
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  p.log.error(message);
  process.exit(1);
});
