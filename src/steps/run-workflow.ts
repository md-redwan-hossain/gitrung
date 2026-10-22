import * as p from "@clack/prompts";
import {
  formatInputSetsSummary,
  formatInputsInline,
  formatInputsSummary,
  getLatestWorkflowInputBatch,
  getLatestWorkflowInputs,
  loadHistory,
  recordWorkflowInputBatch,
  recordWorkflowInputs,
  saveHistory,
} from "../history.ts";
import {
  toDispatchInputs,
  type GitHostClient,
} from "../git-host.ts";
import { createSpinner } from "../spinner.ts";
import {
  assertBranchExists,
  assertWorkflowFileExists,
} from "../validate-remote.ts";
import {
  parseWorkflowDispatchInputs,
  promptSingleWorkflowInput,
  promptWorkflowInputs,
} from "../workflow-inputs.ts";
import {
  repeatActionInputId,
  type PrecollectedInputMap,
  type RunWorkflowStep,
  type WorkflowInputValues,
  type YamlInput,
} from "../schema.ts";
import { waitForDispatchedWorkflowSuccess } from "./pr-shared.ts";

/** Validate remote, prompt for inputs, persist history. Used right after prepare Yes. */
export async function collectPrecollectedWorkflowInputs(
  client: GitHostClient,
  label: string,
  step: RunWorkflowStep,
  opts?: { labelHint?: string },
): Promise<WorkflowInputValues[]> {
  await validateRunWorkflowRemote(client, step);
  const sets = await collectWorkflowInputSets(client, label, step);
  persistCollectedSets(label, step, sets);
  if (sets.length > 0 && Object.keys(sets[0]!).length > 0) {
    p.note(
      formatInputSetsSummary(sets),
      `Recorded in history for ${opts?.labelHint ?? step.workflow}`,
    );
  }
  return sets;
}

export async function runWorkflowStep(
  client: GitHostClient,
  label: string,
  step: RunWorkflowStep,
  opts?: { stepKey?: string; precollectedInputs?: PrecollectedInputMap },
): Promise<void> {
  const precollected =
    opts?.stepKey !== undefined
      ? opts.precollectedInputs?.get(opts.stepKey)
      : undefined;

  if (precollected === undefined) {
    throw new Error(
      `Missing precollected inputs for workflow ${step.workflow} (step key ${opts?.stepKey ?? "?"})`,
    );
  }

  const sets = precollected;
  const hasInputs =
    sets.length > 0 && Object.keys(sets[0] ?? {}).length > 0;
  if (hasInputs) {
    p.log.info(
      `Using prepared inputs for ${step.workflow} (${sets.length} set(s)):\n${formatInputSetsSummary(sets)}`,
    );
  }

  const claimedRunIds = new Set<number>();

  try {
    for (const [index, inputs] of sets.entries()) {
      const inline =
        sets.length > 1 ? formatInputsInline(inputs) : "";
      const detail = inline || undefined;
      if (sets.length > 1) {
        p.log.step(
          detail
            ? `Dispatch ${index + 1}/${sets.length}: ${step.workflow} (${detail})`
            : `Dispatch ${index + 1}/${sets.length}: ${step.workflow}`,
        );
      }
      await dispatchOne(client, step, inputs, claimedRunIds, detail);
    }
  } catch (err) {
    if (!step.exit_on_error) {
      p.log.error(err instanceof Error ? err.message : String(err));
      return;
    }
    throw err;
  }
}

function persistCollectedSets(
  label: string,
  step: RunWorkflowStep,
  sets: WorkflowInputValues[],
): void {
  const nonEmpty = sets.filter((s) => Object.keys(s).length > 0);
  if (nonEmpty.length === 0) return;

  const history = loadHistory();
  if (repeatActionInputId(step) || nonEmpty.length > 1) {
    recordWorkflowInputBatch(history, label, step.workflow, nonEmpty);
  } else {
    recordWorkflowInputs(history, label, step.workflow, nonEmpty[0]!);
  }
  saveHistory(history);
}

async function dispatchOne(
  client: GitHostClient,
  step: RunWorkflowStep,
  inputs: WorkflowInputValues,
  claimedRunIds: Set<number>,
  detail?: string,
): Promise<void> {
  const dispatchedAt = new Date();
  const detailSuffix = detail ? ` (${detail})` : "";
  const dispatchSpinner = createSpinner(
    `Dispatching ${step.workflow} on ${step.use_workflow_from_branch}${detailSuffix}`,
  ).start();

  try {
    await client.dispatchWorkflow(
      step.workflow,
      step.use_workflow_from_branch,
      toDispatchInputs(inputs),
    );
    dispatchSpinner.succeedSuccess(`Dispatched ${step.workflow}${detailSuffix}`);
  } catch (err) {
    dispatchSpinner.fail(`Failed to dispatch ${step.workflow}${detailSuffix}`);
    throw err;
  }

  if (step.wait_until_finish) {
    const runId = await waitForDispatchedWorkflowSuccess(
      client,
      step.workflow,
      step.use_workflow_from_branch,
      dispatchedAt,
      {
        excludeIds: claimedRunIds,
        detail,
        onRunFound: (run) => {
          if (run.html_url) p.log.info(`URL: ${run.html_url}`);
        },
      },
    );
    claimedRunIds.add(runId);
  }
}

export async function validateRunWorkflowRemote(
  client: GitHostClient,
  step: RunWorkflowStep,
): Promise<void> {
  await assertBranchExists(client, step.use_workflow_from_branch);
  await assertWorkflowFileExists(
    client,
    step.workflow,
    step.use_workflow_from_branch,
  );
}

/** Collect one or more input sets (repeat when configured) before any dispatch. */
export async function collectWorkflowInputSets(
  client: GitHostClient,
  label: string,
  step: RunWorkflowStep,
): Promise<WorkflowInputValues[]> {
  const inputDefs = await fetchWorkflowInputDefs(client, step);
  if (Object.keys(inputDefs).length === 0) {
    p.log.info("Workflow has no dispatch inputs.");
    return [{}];
  }

  const repeatId = repeatActionInputId(step);

  if (repeatId) {
    const batch = getLatestWorkflowInputBatch(
      loadHistory(),
      label,
      step.workflow,
    );
    if (batch && batch.length > 0) {
      p.note(formatInputSetsSummary(batch), "Last used input sets");
      const reuse = await p.confirm({
        message: `Use all ${batch.length} input set(s) from history?`,
        initialValue: true,
      });
      if (p.isCancel(reuse)) {
        p.cancel("Cancelled.");
        process.exit(0);
      }
      if (reuse) {
        return batch;
      }
    }
  }

  const first = await resolveInteractiveInputs(
    label,
    step.workflow,
    inputDefs,
    { skipHistory: Boolean(repeatId) },
  );

  if (!repeatId) {
    return [first];
  }

  const repeatDef = inputDefs[repeatId];
  if (!repeatDef) {
    throw new Error(
      `when.action_input_id "${repeatId}" is not a workflow_dispatch input on ${step.workflow}`,
    );
  }

  const sets: WorkflowInputValues[] = [first];
  const used = new Set<string>();
  const firstVal = first[repeatId];
  if (firstVal !== undefined) used.add(String(firstVal));

  while (true) {
    if (!hasRemainingChoiceOptions(repeatDef, used)) {
      p.log.info(`No remaining options for "${repeatId}".`);
      break;
    }

    const again = await p.confirm({
      message: `Add another ${repeatId}?`,
      initialValue: false,
    });
    if (p.isCancel(again)) {
      p.cancel("Cancelled.");
      process.exit(0);
    }
    if (!again) break;

    const nextValue = await promptSingleWorkflowInput(repeatId, repeatDef, {
      exclude: used,
    });
    used.add(String(nextValue));

    sets.push({ ...first, [repeatId]: nextValue });
  }

  return sets;
}

async function fetchWorkflowInputDefs(
  client: GitHostClient,
  step: RunWorkflowStep,
): Promise<Record<string, YamlInput>> {
  const workflowPath = `${client.workflowsDir}/${step.workflow}`;
  const fetchSpinner = createSpinner(
    `Fetching ${workflowPath} @ ${step.use_workflow_from_branch}`,
  ).start();

  let yamlText: string;
  try {
    yamlText = await client.getFileContents(
      workflowPath,
      step.use_workflow_from_branch,
    );
    fetchSpinner.succeedInfo(`Loaded ${step.workflow}`);
  } catch (err) {
    fetchSpinner.fail(`Failed to fetch ${workflowPath}`);
    throw err;
  }

  return parseWorkflowDispatchInputs(yamlText);
}

function hasRemainingChoiceOptions(
  def: YamlInput,
  used: ReadonlySet<string>,
): boolean {
  if (def.type !== "choice") return true;
  const options = def.options ?? [];
  return options.some((opt) => !used.has(opt));
}

async function resolveInteractiveInputs(
  label: string,
  workflowName: string,
  inputDefs: Record<string, YamlInput>,
  opts?: { skipHistory?: boolean },
): Promise<WorkflowInputValues> {
  if (!opts?.skipHistory) {
    const history = loadHistory();
    const latest = getLatestWorkflowInputs(history, label, workflowName);

    if (latest && Object.keys(latest).length > 0) {
      p.note(formatInputsSummary(latest), "Last used inputs");
      const reuse = await p.confirm({
        message: "Use inputs from history?",
        initialValue: true,
      });
      if (p.isCancel(reuse)) {
        p.cancel("Cancelled.");
        process.exit(0);
      }
      if (reuse) {
        return { ...latest };
      }
    }
  }

  return promptWorkflowInputs(inputDefs);
}
