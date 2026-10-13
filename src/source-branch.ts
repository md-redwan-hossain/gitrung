import * as p from "@clack/prompts";
import {
  getSourceBranch,
  loadHistory,
  saveHistory,
  setSourceBranch,
} from "./history.ts";
import type { CreatePrStep } from "./schema.ts";

/**
 * Resolve create-pr source branch: config → history → prompt.
 * Saves to history when the user chooses/enters a value (not when taken from config as-is).
 */
export async function resolveSourceBranch(
  label: string,
  step: CreatePrStep,
): Promise<string> {
  if (step.sourceBranch) {
    return step.sourceBranch;
  }

  const history = loadHistory();
  const last = getSourceBranch(history, label, step.destinationBranch);

  if (last) {
    p.note(last, "Last source branch");
    const reuse = await p.confirm({
      message: "Use source branch from history?",
      initialValue: true,
    });
    if (p.isCancel(reuse)) {
      p.cancel("Cancelled.");
      process.exit(0);
    }
    if (reuse) {
      return last;
    }
  }

  const entered = await promptSourceBranch(last);
  persistSourceBranch(label, step.destinationBranch, entered);
  return entered;
}

export async function promptSourceBranch(
  initial?: string,
): Promise<string> {
  const value = await p.text({
    message: "Source branch",
    placeholder: initial ?? "feature-branch",
    initialValue: initial,
    validate: (v) => {
      if (!v || !v.trim()) return "Source branch is required";
      return undefined;
    },
  });

  if (p.isCancel(value)) {
    p.cancel("Cancelled.");
    process.exit(0);
  }

  return value.trim();
}

export function persistSourceBranch(
  label: string,
  destinationBranch: string,
  sourceBranch: string,
): void {
  const history = loadHistory();
  setSourceBranch(history, label, destinationBranch, sourceBranch);
  saveHistory(history);
}

export type CreatePrConfirmResult =
  | { action: "run"; sourceBranch: string }
  | { action: "skip" };

/**
 * Yes / Skip / [Use from history] / Change source branch.
 * History option appears when a saved source differs from the current (config) value.
 * Call reprint after a source change so the step header/table stay current.
 */
export async function confirmCreatePrStep(
  destinationBranch: string,
  sourceBranch: string,
  label: string,
  opts?: { reprint?: (source: string) => void },
): Promise<CreatePrConfirmResult> {
  let current = sourceBranch;

  while (true) {
    const historySource = getSourceBranch(
      loadHistory(),
      label,
      destinationBranch,
    );

    const options: { value: string; label: string }[] = [
      { value: "yes", label: "Yes" },
      { value: "skip", label: "Skip" },
    ];
    if (historySource && historySource !== current) {
      options.push({
        value: "history",
        label: `Use from history (${historySource} → ${destinationBranch})`,
      });
    }
    options.push({ value: "change", label: "Change source branch" });

    const choice = await p.select({
      message: "Run this step?",
      options,
    });

    if (p.isCancel(choice)) {
      p.cancel("Cancelled.");
      process.exit(0);
    }

    if (choice === "yes") {
      return { action: "run", sourceBranch: current };
    }
    if (choice === "skip") {
      return { action: "skip" };
    }
    if (choice === "history" && historySource) {
      persistSourceBranch(label, destinationBranch, historySource);
      return { action: "run", sourceBranch: historySource };
    }

    current = await promptSourceBranch(current);
    persistSourceBranch(label, destinationBranch, current);
    opts?.reprint?.(current);
  }
}
