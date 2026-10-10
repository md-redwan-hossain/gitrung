import * as p from "@clack/prompts";
import { normalizeRef, type GitHostClient, type WorkflowRun } from "../git-host.ts";
import { createSpinner } from "../spinner.ts";

export const POLL_MS = 10_000;
export const TIMEOUT_MS = 45 * 60 * 1000;
export const MERGEABLE_TIMEOUT_MS = 3 * 60 * 1000;
export const MERGE_SKEW_MS = 30_000;

export async function waitForPrMerged(
  client: GitHostClient,
  prNumber: number,
): Promise<Date> {
  const spinner = createSpinner(`Waiting for PR #${prNumber} to merge…`).start();
  const deadline = Date.now() + TIMEOUT_MS;

  try {
    while (Date.now() < deadline) {
      const pr = await client.getPullRequest(prNumber);
      if (pr.merged) {
        const mergedAt = pr.merged_at
          ? new Date(pr.merged_at)
          : new Date();
        spinner.succeedSuccess(`PR #${prNumber} merged`);
        return mergedAt;
      }
      spinner.text = `Waiting for PR #${prNumber} to merge… (state=${pr.state})`;
      await sleep(POLL_MS);
    }
    spinner.fail(`Timed out waiting for PR #${prNumber} to merge`);
    throw new Error(
      `PR #${prNumber} did not merge within ${TIMEOUT_MS / 60_000} minutes`,
    );
  } catch (err) {
    if (spinner.isSpinning) spinner.fail(`Failed waiting for PR #${prNumber}`);
    throw err;
  }
}

export async function waitForWorkflowSuccess(
  client: GitHostClient,
  workflowFile: string,
  destinationBranch: string,
  mergedAt: Date,
  opts?: { excludeIds?: ReadonlySet<number> },
): Promise<number> {
  return waitForWorkflowRunSuccess(client, workflowFile, destinationBranch, {
    earliestMs: mergedAt.getTime() - MERGE_SKEW_MS,
    excludeIds: opts?.excludeIds,
  });
}

export async function waitForDispatchedWorkflowSuccess(
  client: GitHostClient,
  workflowFile: string,
  ref: string,
  dispatchedAt: Date,
  opts?: {
    excludeIds?: ReadonlySet<number>;
    detail?: string;
    onRunFound?: (run: WorkflowRun) => void;
  },
): Promise<number> {
  return waitForWorkflowRunSuccess(client, workflowFile, ref, {
    earliestMs: dispatchedAt.getTime() - MERGE_SKEW_MS,
    excludeIds: opts?.excludeIds,
    detail: opts?.detail,
    onRunFound: opts?.onRunFound,
  });
}

function waitDetailPrefix(detail: string | undefined): string {
  return detail ? `${detail}, ` : "";
}

function runUrlSuffix(run: WorkflowRun): string {
  return run.html_url ? ` ${run.html_url}` : "";
}

async function waitForWorkflowRunSuccess(
  client: GitHostClient,
  workflowFile: string,
  ref: string,
  opts: {
    earliestMs: number;
    excludeIds?: ReadonlySet<number>;
    detail?: string;
    onRunFound?: (run: WorkflowRun) => void;
  },
): Promise<number> {
  const detailSuffix = opts.detail ? ` (${opts.detail})` : "";
  const deadline = Date.now() + TIMEOUT_MS;
  let pinnedId: number | undefined;
  let spinner: ReturnType<typeof createSpinner> | undefined;
  let announced = false;

  try {
    while (Date.now() < deadline) {
      const runs = await client.listWorkflowRuns(workflowFile);
      let candidate: WorkflowRun | undefined;

      if (pinnedId !== undefined) {
        candidate = runs.find((run) => run.id === pinnedId);
        // Pin missing from list — keep waiting; do not re-pick another run.
      } else {
        candidate = pickWorkflowRun(runs, ref, opts.earliestMs, opts.excludeIds);
        if (candidate) pinnedId = candidate.id;
      }

      if (!candidate) {
        await sleep(POLL_MS);
        continue;
      }

      if (!announced) {
        announced = true;
        opts.onRunFound?.(candidate);
        spinner = createSpinner(
          `Waiting for ${workflowFile}${detailSuffix}…`,
        ).start();
      }

      const outcome = classifyRun(candidate);
      if (outcome === "pending") {
        spinner!.text = `Waiting for ${workflowFile} (${waitDetailPrefix(opts.detail)}run ${formatRunRef(candidate)})…`;
        await sleep(POLL_MS);
        continue;
      }
      if (outcome === "failed") {
        spinner!.fail(
          `${workflowFile} failed (${waitDetailPrefix(opts.detail)}run ${formatRunRef(candidate)}${runUrlSuffix(candidate)})`,
        );
        throw new Error(
          `Workflow ${workflowFile} ended with status=${candidate.status} conclusion=${candidate.conclusion}`,
        );
      }

      spinner!.succeedSuccess(
        `${workflowFile} succeeded (${waitDetailPrefix(opts.detail)}run ${formatRunRef(candidate)})`,
      );
      return candidate.id;
    }

    if (spinner) {
      spinner.fail(`Timed out waiting for ${workflowFile}${detailSuffix}`);
    }
    throw new Error(
      `${workflowFile} did not succeed within ${TIMEOUT_MS / 60_000} minutes`,
    );
  } catch (err) {
    if (spinner?.isSpinning) {
      spinner.fail(`Failed waiting for ${workflowFile}${detailSuffix}`);
    }
    throw err;
  }
}

export async function assertPrMergeable(
  client: GitHostClient,
  prNumber: number,
): Promise<void> {
  const spinner = createSpinner(
    `Checking mergeability of PR #${prNumber}…`,
  ).start();
  const deadline = Date.now() + MERGEABLE_TIMEOUT_MS;

  try {
    while (Date.now() < deadline) {
      const pr = await client.getPullRequest(prNumber);

      if (pr.merged) {
        spinner.fail(`PR #${prNumber} is already merged`);
        throw new Error(`PR #${prNumber} is already merged`);
      }

      const state = (pr.state ?? "").toLowerCase();
      if (state === "closed") {
        spinner.fail(`PR #${prNumber} is already closed`);
        throw new Error(`PR #${prNumber} is already closed`);
      }

      if (pr.mergeable === null || pr.mergeable === undefined) {
        spinner.text = `Checking mergeability of PR #${prNumber}… (computing)`;
        await sleep(POLL_MS);
        continue;
      }

      if (pr.mergeable === false) {
        spinner.fail(`PR #${prNumber} has merge conflicts`);
        throw new Error(
          `PR #${prNumber} has merge conflicts and cannot be merged`,
        );
      }

      spinner.succeedInfo(`PR #${prNumber} is mergeable`);
      return;
    }

    spinner.fail(`Timed out waiting for mergeability of PR #${prNumber}`);
    throw new Error(
      `PR #${prNumber} mergeability was not computed within ${MERGEABLE_TIMEOUT_MS / 60_000} minutes`,
    );
  } catch (err) {
    if (spinner.isSpinning) {
      spinner.fail(`Failed checking mergeability of PR #${prNumber}`);
    }
    throw err;
  }
}

/** Wait until commit checks are no longer pending; fail on failure/error. */
export async function waitForPrChecks(
  client: GitHostClient,
  prNumber: number,
): Promise<void> {
  const pr = await client.getPullRequest(prNumber);
  const sha = typeof pr.head?.sha === "string" ? pr.head.sha : undefined;
  if (!sha) {
    p.log.warn(
      `PR #${prNumber} has no head SHA; skipping check wait and proceeding to merge`,
    );
    return;
  }

  const spinner = createSpinner(
    `Waiting for checks on PR #${prNumber}…`,
  ).start();
  const deadline = Date.now() + TIMEOUT_MS;

  try {
    while (Date.now() < deadline) {
      const status = await client.getCommitStatus(sha);
      const state = (status.state ?? "").toLowerCase();
      const total = status.total_count ?? 0;

      if (total === 0 || state === "" || state === "success") {
        spinner.succeedInfo(
          total === 0
            ? `No checks on PR #${prNumber}; proceeding`
            : `Checks passed on PR #${prNumber}`,
        );
        return;
      }

      if (
        state === "failure" ||
        state === "error" ||
        state === "failed"
      ) {
        spinner.fail(`Checks failed on PR #${prNumber} (state=${state})`);
        throw new Error(
          `PR #${prNumber} checks finished with state=${state}`,
        );
      }

      // pending / warning / unknown → keep waiting
      spinner.text = `Waiting for checks on PR #${prNumber}… (state=${state}, count=${total})`;
      await sleep(POLL_MS);
    }

    spinner.fail(`Timed out waiting for checks on PR #${prNumber}`);
    throw new Error(
      `PR #${prNumber} checks did not finish within ${TIMEOUT_MS / 60_000} minutes`,
    );
  } catch (err) {
    if (spinner.isSpinning) {
      spinner.fail(`Failed waiting for checks on PR #${prNumber}`);
    }
    throw err;
  }
}

export function matchWhenWaitFor(
  when: { destinationBranch: string; waitFor: string[] }[],
  baseRef: string | undefined,
): { destinationBranch: string; waitFor: string[] } | undefined {
  if (!baseRef || when.length === 0) return undefined;
  const base = normalizeRef(baseRef);
  return when.find(
    (entry) => normalizeRef(entry.destinationBranch) === base,
  );
}

/** UI run number when available, else internal id. */
export function formatRunRef(run: WorkflowRun | undefined): string {
  if (!run) return "#?";
  return `#${run.run_number ?? run.id}`;
}

/**
 * Newest run at/after earliestMs on ref. No time-less fallback.
 * Rows without head_branch are skipped. excludeIds are ignored.
 */
function pickWorkflowRun(
  runs: WorkflowRun[],
  destinationBranch: string,
  earliestMs: number,
  excludeIds?: ReadonlySet<number>,
): WorkflowRun | undefined {
  const branch = normalizeRef(destinationBranch);

  const strict = runs.filter((run) => {
    if (excludeIds?.has(run.id)) return false;
    if (!run.head_branch) return false;
    const runBranch = normalizeRef(run.head_branch);
    if (runBranch !== branch) return false;
    const started = runTimeMs(run);
    if (started === undefined || started < earliestMs) return false;
    return true;
  });

  if (strict.length === 0) return undefined;
  strict.sort((a, b) => (runTimeMs(b) ?? 0) - (runTimeMs(a) ?? 0));
  return strict[0];
}

function runTimeMs(run: WorkflowRun): number | undefined {
  const raw = run.run_started_at ?? run.created_at ?? run.updated_at;
  if (!raw) return undefined;
  const ms = Date.parse(raw);
  return Number.isNaN(ms) ? undefined : ms;
}

function classifyRun(
  run: WorkflowRun,
): "pending" | "success" | "failed" {
  const status = (run.status ?? "").toLowerCase();
  const conclusion = (run.conclusion ?? "").toLowerCase();

  if (
    status === "success" ||
    conclusion === "success" ||
    (status === "completed" && conclusion === "success")
  ) {
    return "success";
  }

  if (
    ["failure", "failed", "cancelled", "canceled", "timed_out", "action_required"].includes(
      status,
    ) ||
    ["failure", "failed", "cancelled", "canceled", "timed_out", "action_required", "startup_failure"].includes(
      conclusion,
    )
  ) {
    return "failed";
  }

  if (
    ["queued", "waiting", "requested", "pending", "in_progress", "running"].includes(
      status,
    )
  ) {
    return "pending";
  }

  if (
    status === "completed" &&
    (conclusion === "" || conclusion === "null")
  ) {
    return "pending";
  }

  if (status === "completed") {
    return conclusion === "success" ? "success" : "failed";
  }

  if (conclusion === "success") return "success";

  return "pending";
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
