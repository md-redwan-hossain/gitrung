import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { z, ZodError } from "zod";
import { projectRoot } from "./load-config.ts";
import {
  HistoryFileSchema,
  type HistoryFile,
  type WorkflowHistoryEntry,
  type WorkflowInputValues,
} from "./schema.ts";

const MAX_LAST_USED = 5;
const METADATA_FILE = "metadata.jsonc";
const LEGACY_HISTORY_FILE = "history.jsonc";

function metadataPath(): string {
  return resolve(projectRoot(), METADATA_FILE);
}

function legacyHistoryPath(): string {
  return resolve(projectRoot(), LEGACY_HISTORY_FILE);
}

export function sourceBranchKey(
  label: string,
  destinationBranch: string,
): string {
  return `${label}:create-pr:${destinationBranch}`;
}

function parseHistoryFile(path: string): HistoryFile {
  const raw = readFileSync(path, "utf8");
  const data = Bun.JSONC.parse(raw);
  try {
    return HistoryFileSchema.parse(data);
  } catch (err) {
    if (err instanceof ZodError) {
      throw new Error(`Invalid ${METADATA_FILE}:\n${z.prettifyError(err)}`);
    }
    throw err;
  }
}

export function loadHistory(): HistoryFile {
  const path = metadataPath();
  if (existsSync(path)) {
    return parseHistoryFile(path);
  }

  const legacyPath = legacyHistoryPath();
  if (existsSync(legacyPath)) {
    const history = parseHistoryFile(legacyPath);
    saveHistory(history);
    return history;
  }

  return { workflowLogs: {}, sourceBranches: {} };
}

export function saveHistory(history: HistoryFile): void {
  const body = JSON.stringify(history, null, 2);
  const content = `// Auto-updated by gitrung.\n${body}\n`;
  writeFileSync(metadataPath(), content, "utf8");
}

export function getLatestWorkflowInputs(
  history: HistoryFile,
  label: string,
  workflowName: string,
): WorkflowInputValues | undefined {
  const workflow = findWorkflowEntry(history, label, workflowName);
  return workflow?.lastUsed[0];
}

/** Full last repeat batch, if any. */
export function getLatestWorkflowInputBatch(
  history: HistoryFile,
  label: string,
  workflowName: string,
): WorkflowInputValues[] | undefined {
  const workflow = findWorkflowEntry(history, label, workflowName);
  const batch = workflow?.lastBatch;
  if (!batch || batch.length === 0) return undefined;
  return batch.map(cloneInputs);
}

export function recordWorkflowInputs(
  history: HistoryFile,
  label: string,
  workflowName: string,
  inputs: WorkflowInputValues,
): HistoryFile {
  const workflow = ensureWorkflowEntry(history, label, workflowName);

  workflow.lastUsed = [
    cloneInputs(inputs),
    ...workflow.lastUsed.filter((entry) => !shallowEqual(entry, inputs)),
  ].slice(0, MAX_LAST_USED);

  return history;
}

/** Persist a full repeat collect as lastBatch and refresh lastUsed from those sets. */
export function recordWorkflowInputBatch(
  history: HistoryFile,
  label: string,
  workflowName: string,
  sets: WorkflowInputValues[],
): HistoryFile {
  const workflow = ensureWorkflowEntry(history, label, workflowName);
  const cloned = sets
    .filter((inputs) => Object.keys(inputs).length > 0)
    .map(cloneInputs);
  workflow.lastBatch = cloned;
  // Newest first in lastUsed for single-input reuse compatibility
  workflow.lastUsed = [...cloned].reverse().slice(0, MAX_LAST_USED);
  return history;
}

function findWorkflowEntry(
  history: HistoryFile,
  label: string,
  workflowName: string,
): WorkflowHistoryEntry | undefined {
  return history.workflowLogs[label]?.find((w) => w.name === workflowName);
}

function ensureWorkflowEntry(
  history: HistoryFile,
  label: string,
  workflowName: string,
): WorkflowHistoryEntry {
  let workflows = history.workflowLogs[label];
  if (!workflows) {
    workflows = [];
    history.workflowLogs[label] = workflows;
  }

  let workflow = workflows.find((w) => w.name === workflowName);
  if (!workflow) {
    workflow = { name: workflowName, lastUsed: [] };
    workflows.push(workflow);
  }
  return workflow;
}

export function getSourceBranch(
  history: HistoryFile,
  label: string,
  destinationBranch: string,
): string | undefined {
  return history.sourceBranches[sourceBranchKey(label, destinationBranch)];
}

/** Overwrites the single last source branch for this label + destination. */
export function setSourceBranch(
  history: HistoryFile,
  label: string,
  destinationBranch: string,
  sourceBranch: string,
): HistoryFile {
  history.sourceBranches[sourceBranchKey(label, destinationBranch)] =
    sourceBranch;
  return history;
}

function cloneInputs(inputs: WorkflowInputValues): WorkflowInputValues {
  return { ...inputs };
}

function shallowEqual(
  a: WorkflowInputValues,
  b: WorkflowInputValues,
): boolean {
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((key) => a[key] === b[key]);
}

export function formatInputsSummary(inputs: WorkflowInputValues): string {
  return Object.entries(inputs)
    .map(([k, v]) => `  ${k}: ${String(v)}`)
    .join("\n");
}

/** Compact one-line label for spinners / step logs (e.g. `client=CLIENT_DC`). */
export function formatInputsInline(inputs: WorkflowInputValues): string {
  return Object.entries(inputs)
    .map(([k, v]) => `${k}=${String(v)}`)
    .join(", ");
}

export function formatInputSetsSummary(sets: WorkflowInputValues[]): string {
  return sets
    .map((inputs, i) => `#${i + 1}\n${formatInputsSummary(inputs)}`)
    .join("\n\n");
}

export type { WorkflowHistoryEntry };
