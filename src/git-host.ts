import { z, ZodError } from "zod";
import {
  LooseObjectSchema,
  WorkflowRunsResponseSchema,
  type CommitStatus,
  type ContentFile,
  type GitPlatform,
  type PrStatus,
  type PullRequest,
  type WorkflowInputValues,
  type WorkflowRun,
} from "./schema.ts";

export type { CommitStatus, ContentFile, PullRequest, WorkflowRun };

/** Shared REST fetch config for GitHub / Gitea clients. */
export type HostRequestConfig = {
  apiBase: string;
  label: string;
  headers: Record<string, string>;
};

export async function hostRequest(
  config: HostRequestConfig,
  method: string,
  path: string,
  body?: unknown,
): Promise<unknown> {
  const url = `${config.apiBase}${path}`;
  const headers: Record<string, string> = { ...config.headers };
  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }

  const res = await fetch(url, init);
  if (res.status === 204) {
    return undefined;
  }

  const text = await res.text();
  let data: unknown = undefined;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }

  if (!res.ok) {
    const message =
      typeof data === "object" &&
      data !== null &&
      "message" in data &&
      typeof (data as { message: unknown }).message === "string"
        ? (data as { message: string }).message
        : text || res.statusText;
    throw new Error(
      `${config.label} ${method} ${path} → ${res.status}: ${message}`,
    );
  }

  return data;
}

export async function hostRequestParsed<S extends z.ZodType>(
  config: HostRequestConfig,
  method: string,
  path: string,
  schema: S,
  body?: unknown,
): Promise<z.infer<S>> {
  const data = await hostRequest(config, method, path, body);
  try {
    return schema.parse(data);
  } catch (err) {
    if (err instanceof ZodError) {
      throw new Error(
        `Invalid ${config.label} response ${method} ${path}:\n${z.prettifyError(err)}`,
      );
    }
    throw err;
  }
}

export async function listPullRequestsPaged(
  fetchPage: (page: number, perPage: number) => Promise<PullRequest[]>,
  perPage = 50,
  maxPages = 2,
): Promise<PullRequest[]> {
  const all: PullRequest[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const batch = await fetchPage(page, perPage);
    if (batch.length === 0) break;
    all.push(...batch);
    if (batch.length < perPage) break;
  }
  return all;
}

export function findOpenPullRequestInList(
  open: PullRequest[],
  head: string,
  base: string,
): PullRequest | undefined {
  return open.find(
    (pr) =>
      normalizeRef(pr.head?.ref) === normalizeRef(head) &&
      normalizeRef(pr.base?.ref) === normalizeRef(base),
  );
}

export function decodeBase64ContentFile(file: ContentFile): string {
  if (file.encoding !== "base64") {
    throw new Error(`Unexpected content encoding: ${file.encoding}`);
  }
  return Buffer.from(file.content.replace(/\n/g, ""), "base64").toString(
    "utf8",
  );
}

export async function branchExistsFromGet(
  get: () => Promise<unknown>,
): Promise<boolean> {
  try {
    await get();
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("→ 404")) return false;
    throw err;
  }
}

export async function collectWorkflowRunsFromPaths(opts: {
  paths: string[];
  workflowFile: string;
  request: (path: string) => Promise<unknown>;
  includeRaw: (pathIndex: number, path: string, raw: unknown) => boolean;
}): Promise<WorkflowRun[]> {
  const byId = new Map<number, WorkflowRun>();
  let lastError: unknown;
  let anyOk = false;

  for (const [i, path] of opts.paths.entries()) {
    try {
      const data = await opts.request(path);
      const rawRuns = extractWorkflowRuns(data);
      for (const raw of rawRuns) {
        const run = normalizeWorkflowRun(raw);
        if (!run) continue;
        if (!opts.includeRaw(i, path, raw)) continue;
        byId.set(run.id, run);
      }
      anyOk = true;
    } catch (err) {
      lastError = err;
      const message = err instanceof Error ? err.message : String(err);
      if (!message.includes("→ 404")) {
        throw err;
      }
    }
  }

  if (!anyOk && byId.size === 0) {
    throw lastError instanceof Error
      ? lastError
      : new Error(`Failed to list runs for ${opts.workflowFile}`);
  }

  return [...byId.values()].sort(
    (a, b) => (runSortMs(b) ?? 0) - (runSortMs(a) ?? 0),
  );
}

export interface GitHostClient {
  readonly owner: string;
  readonly repo: string;
  readonly repoUrl: string;
  readonly workflowsDir: string;

  createPullRequest(opts: {
    head: string;
    base: string;
    title: string;
    body?: string;
  }): Promise<PullRequest>;

  getPullRequest(index: number): Promise<PullRequest>;

  listPullRequests(state: PrStatus): Promise<PullRequest[]>;

  findOpenPullRequest(
    head: string,
    base: string,
  ): Promise<PullRequest | undefined>;

  compare(base: string, head: string): Promise<{ total_commits: number }>;

  mergePullRequest(
    index: number,
    opts: { mergeWhenChecksSucceed: boolean },
  ): Promise<void>;

  /** Combined commit status for the given SHA (pending / success / failure / …). */
  getCommitStatus(sha: string): Promise<CommitStatus>;

  getFileContents(path: string, ref: string): Promise<string>;

  branchExists(name: string): Promise<boolean>;

  dispatchWorkflow(
    workflow: string,
    ref: string,
    inputs: Record<string, string>,
  ): Promise<void>;

  listWorkflowRuns(workflowFile: string, limit?: number): Promise<WorkflowRun[]>;
}

export function workflowsDirFor(platform: GitPlatform): string {
  return platform === "github" ? ".github/workflows" : ".gitea/workflows";
}

export function toDispatchInputs(
  values: WorkflowInputValues,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(values)) {
    if (typeof value === "boolean") {
      out[key] = value ? "true" : "false";
    } else {
      out[key] = String(value);
    }
  }
  return out;
}

export function normalizeWorkflowRun(raw: unknown): WorkflowRun | null {
  const parsed = LooseObjectSchema.safeParse(raw);
  if (!parsed.success) return null;

  let obj = parsed.data;
  const nested = LooseObjectSchema.safeParse(obj.workflow_run);
  if (nested.success) {
    obj = nested.data;
  }

  const id = asNumber(obj.id ?? obj.run_id);
  if (id === undefined) return null;

  const status = asString(
    obj.status ?? obj.state ?? obj.Status ?? obj.run_status,
  );
  const conclusion = asNullableString(
    obj.conclusion ?? obj.Conclusion ?? obj.result,
  );

  const headObj = LooseObjectSchema.safeParse(obj.head);
  const headRef = headObj.success ? headObj.data.ref : undefined;

  return {
    id,
    run_number: asNumber(obj.run_number ?? obj.number ?? obj.index),
    name: asString(obj.name ?? obj.display_title ?? obj.title),
    status,
    conclusion,
    event: asString(obj.event ?? obj.trigger ?? obj.event_name),
    html_url: asString(obj.html_url ?? obj.url ?? obj.htmlUrl),
    created_at: asString(obj.created_at ?? obj.created ?? obj.Created),
    run_started_at: asString(
      obj.run_started_at ?? obj.started_at ?? obj.started ?? obj.Started,
    ),
    updated_at: asString(obj.updated_at ?? obj.updated ?? obj.Updated),
    head_branch: asString(obj.head_branch ?? obj.branch ?? headRef),
    display_title: asString(obj.display_title ?? obj.title ?? obj.name),
  };
}

export function extractWorkflowRuns(data: unknown): unknown[] {
  const parsed = WorkflowRunsResponseSchema.safeParse(data);
  if (!parsed.success) return [];
  if (Array.isArray(parsed.data)) return parsed.data;
  if (Array.isArray(parsed.data.workflow_runs)) return parsed.data.workflow_runs;
  if (Array.isArray(parsed.data.runs)) return parsed.data.runs;
  if (Array.isArray(parsed.data.data)) return parsed.data.data;
  return [];
}

export function runMatchesWorkflow(
  raw: unknown,
  workflowFile: string,
): boolean {
  const parsed = LooseObjectSchema.safeParse(raw);
  if (!parsed.success) return true;
  const obj = parsed.data;

  const workflowObj = LooseObjectSchema.safeParse(obj.workflow);
  const workflowPath = workflowObj.success
    ? (workflowObj.data.path ?? workflowObj.data.name)
    : undefined;

  const candidates = [
    obj.path,
    obj.workflow_id,
    obj.workflow_path,
    obj.name,
    workflowPath,
  ]
    .map((v) => (typeof v === "string" ? v : ""))
    .filter(Boolean);

  if (candidates.length === 0) return true;
  const needle = workflowFile.toLowerCase();
  return candidates.some(
    (c) =>
      c.toLowerCase() === needle ||
      c.toLowerCase().endsWith(`/${needle}`) ||
      c.toLowerCase().includes(needle),
  );
}

export function runSortMs(run: WorkflowRun): number | undefined {
  const raw = run.run_started_at ?? run.created_at ?? run.updated_at;
  if (!raw) return undefined;
  const ms = Date.parse(raw);
  return Number.isNaN(ms) ? undefined : ms;
}

export function normalizeRef(ref: string | undefined): string {
  if (!ref) return "";
  return ref.replace(/^refs\/heads\//, "");
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

function asString(value: unknown): string | undefined {
  if (typeof value === "string" && value.length > 0) return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return undefined;
}

function asNullableString(value: unknown): string | null | undefined {
  if (value === null) return null;
  return asString(value);
}
