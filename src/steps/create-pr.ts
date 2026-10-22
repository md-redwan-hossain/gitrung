import * as p from "@clack/prompts";
import type { GitHostClient } from "../git-host.ts";
import type { CreatePrStep } from "../schema.ts";
import { createSpinner } from "../spinner.ts";
import {
  assertBranchExists,
  assertWorkflowFileExists,
} from "../validate-remote.ts";
import {
  assertPrMergeable,
  waitForPrChecks,
  waitForPrMerged,
  waitForWorkflowSuccess,
} from "./pr-shared.ts";

/** Source + destination branches and after_merge wait_for workflow files on dest. */
export async function validateCreatePrRemote(
  client: GitHostClient,
  step: CreatePrStep,
  sourceBranch: string,
): Promise<void> {
  await assertBranchExists(client, sourceBranch);
  await assertBranchExists(client, step.destination_branch);
  if (!step.merge) return;
  for (const workflow of step.after_merge.wait_for) {
    await assertWorkflowFileExists(
      client,
      workflow,
      step.destination_branch,
    );
  }
}

export async function runCreatePrStep(
  client: GitHostClient,
  step: CreatePrStep,
  opts: { sourceBranch: string },
): Promise<void> {
  const sourceBranch = opts.sourceBranch;
  const title =
    step.title ?? `Merge ${sourceBranch} into ${step.destination_branch}`;
  const body =
    step.body ??
    `Automated PR: \`${sourceBranch}\` → \`${step.destination_branch}\``;

  await validateCreatePrRemote(client, step, sourceBranch);

  const existing = await client.findOpenPullRequest(
    sourceBranch,
    step.destination_branch,
  );
  if (existing) {
    p.log.warn(`Open PR already exists: #${existing.number}`);
    if (existing.html_url) p.log.info(`URL: ${existing.html_url}`);
    p.cancel("Skipped create_pr (PR already exists).");
    process.exit(0);
  }

  const compareSpinner = createSpinner(
    `Comparing ${step.destination_branch}...${sourceBranch}`,
  ).start();
  try {
    const diff = await client.compare(
      step.destination_branch,
      sourceBranch,
    );
    if (diff.total_commits === 0) {
      compareSpinner.warn("Nothing to merge (empty diff)");
      p.log.info(
        `Skipped create_pr: ${sourceBranch} has no commits ahead of ${step.destination_branch}; continuing.`,
      );
      return;
    }
    compareSpinner.succeedInfo(
      `${diff.total_commits} commit(s) ahead of ${step.destination_branch}`,
    );
  } catch (err) {
    compareSpinner.fail("Failed to compare branches");
    throw err;
  }

  const createPrSpinner = createSpinner(
    `Creating PR ${sourceBranch} → ${step.destination_branch}`,
  ).start();

  let pr;
  try {
    pr = await client.createPullRequest({
      head: sourceBranch,
      base: step.destination_branch,
      title,
      body,
    });
    createPrSpinner.succeedInfo(`PR #${pr.number} created`);
    if (pr.html_url) p.log.info(`URL: ${pr.html_url}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (isDuplicatePrError(message)) {
      createPrSpinner.warn("PR already exists");
      p.cancel("Skipped create_pr (duplicate PR).");
      process.exit(0);
    }
    createPrSpinner.fail("Failed to create PR");
    throw err;
  }

  if (!step.merge) {
    p.log.info(`PR #${pr.number} left open (merge=false)`);
    return;
  }

  await assertPrMergeable(client, pr.number);

  const mergeSpinner = createSpinner(
    `Scheduling merge of PR #${pr.number} when checks pass`,
  ).start();

  try {
    await client.mergePullRequest(pr.number, {
      mergeWhenChecksSucceed: true,
    });
    mergeSpinner.succeedInfo(
      `PR #${pr.number} will merge when all checks pass`,
    );
  } catch (err) {
    mergeSpinner.fail(`Failed to merge PR #${pr.number}`);
    throw err;
  }

  await waitForPrChecks(client, pr.number);

  const mergedAt = await waitForPrMerged(client, pr.number);

  const claimedRunIds = new Set<number>();
  for (const workflow of step.after_merge.wait_for) {
    const runId = await waitForWorkflowSuccess(
      client,
      workflow,
      step.destination_branch,
      mergedAt,
      { excludeIds: claimedRunIds },
    );
    claimedRunIds.add(runId);
  }
}

function isDuplicatePrError(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes("→ 409") ||
    lower.includes("pull request already exists") ||
    lower.includes("already exists")
  );
}
