import * as p from "@clack/prompts";
import type { GitHostClient, PullRequest } from "../git-host.ts";
import type { MergePrStep } from "../schema.ts";
import { createSpinner } from "../spinner.ts";
import { assertWorkflowFileExists } from "../validate-remote.ts";
import {
  assertPrMergeable,
  matchWhenWaitFor,
  waitForPrChecks,
  waitForPrMerged,
  waitForWorkflowSuccess,
} from "./pr-shared.ts";

export type ValidatedMergePr = {
  pr: PullRequest;
  waitFor: string[];
  destinationBranch: string;
};

export async function promptMergePrNumber(
  message = "Enter PR number to merge",
): Promise<number> {
  const raw = await p.text({
    message,
    validate: (value) => {
      const trimmed = (value ?? "").trim();
      if (!/^\d+$/.test(trimmed) || Number(trimmed) <= 0) {
        return "Enter a positive integer PR number";
      }
    },
  });

  if (p.isCancel(raw)) {
    p.cancel("Cancelled.");
    process.exit(0);
  }

  return Number(raw.trim());
}

/** Exists, open, mergeable, soft when → waitFor workflow files. */
export async function validateMergePr(
  client: GitHostClient,
  step: MergePrStep,
  prNumber: number,
): Promise<ValidatedMergePr> {
  let pr: PullRequest;
  try {
    pr = await client.getPullRequest(prNumber);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("→ 404")) {
      throw new Error(`PR #${prNumber} does not exist`);
    }
    throw err;
  }

  if (pr.merged) {
    throw new Error(`PR #${prNumber} is already merged`);
  }

  const state = (pr.state ?? "").toLowerCase();
  if (state === "closed") {
    throw new Error(`PR #${prNumber} is already closed`);
  }

  if (state !== "open") {
    throw new Error(
      `PR #${prNumber} is not open (state=${pr.state ?? "unknown"})`,
    );
  }

  p.log.info(
    `PR #${pr.number}: ${pr.title} (${pr.head?.ref ?? "?"} → ${pr.base?.ref ?? "?"}) ${pr.html_url}`,
  );

  const matched = matchWhenWaitFor(step.when, pr.base?.ref);
  const waitFor = matched?.wait_for ?? [];
  const destinationBranch =
    matched?.destination_branch ?? pr.base?.ref ?? "";

  if (matched) {
    p.log.info(
      `when matched destination=${matched.destination_branch}; wait_for=${matched.wait_for.join(",")}`,
    );
    for (const workflow of waitFor) {
      await assertWorkflowFileExists(
        client,
        workflow,
        matched.destination_branch,
      );
    }
  } else if (step.when.length > 0) {
    p.log.info(
      `No when entry for base=${pr.base?.ref ?? "—"}; skipping post-merge workflow waits`,
    );
  }

  await assertPrMergeable(client, pr.number);

  return { pr, waitFor, destinationBranch };
}

/** Prompt until remote validation succeeds. */
export async function promptValidatedMergePrNumber(
  client: GitHostClient,
  step: MergePrStep,
  message = "Enter PR number to merge",
): Promise<ValidatedMergePr> {
  while (true) {
    const prNumber = await promptMergePrNumber(message);
    try {
      return await validateMergePr(client, step, prNumber);
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err);
      p.log.error(text);
      p.log.info("Enter another PR number, or Ctrl+C to cancel.");
    }
  }
}

export async function runMergePrStep(
  client: GitHostClient,
  step: MergePrStep,
  opts?: { prNumber?: number },
): Promise<void> {
  const validated =
    opts?.prNumber !== undefined
      ? await validateMergePr(client, step, opts.prNumber)
      : await promptValidatedMergePrNumber(client, step);

  const { pr, waitFor, destinationBranch } = validated;

  await waitForPrChecks(client, pr.number);

  const mergeSpinner = createSpinner(`Merging PR #${pr.number} now`).start();
  try {
    await client.mergePullRequest(pr.number, {
      mergeWhenChecksSucceed: false,
    });
    mergeSpinner.succeedInfo(`PR #${pr.number} merge requested`);
  } catch (err) {
    mergeSpinner.fail(`Failed to merge PR #${pr.number}`);
    throw err;
  }

  const mergedAt = await waitForPrMerged(client, pr.number);

  const claimedRunIds = new Set<number>();
  for (const workflow of waitFor) {
    const runId = await waitForWorkflowSuccess(
      client,
      workflow,
      destinationBranch,
      mergedAt,
      { excludeIds: claimedRunIds },
    );
    claimedRunIds.add(runId);
  }
}
