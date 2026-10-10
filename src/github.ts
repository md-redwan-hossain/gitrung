import { z, ZodError } from "zod";
import {
  branchExistsFromGet,
  collectWorkflowRunsFromPaths,
  decodeBase64ContentFile,
  findOpenPullRequestInList,
  hostRequest,
  hostRequestParsed,
  listPullRequestsPaged,
  runMatchesWorkflow,
  workflowsDirFor,
  type GitHostClient,
  type HostRequestConfig,
  type PullRequest,
  type WorkflowRun,
} from "./git-host.ts";
import {
  CommitStatusSchema,
  CompareResultSchema,
  ContentFileSchema,
  EnableAutoMergeDataSchema,
  GraphqlEnvelopeSchema,
  PullRequestListSchema,
  PullRequestSchema,
  type CommitStatus,
  type ParsedRepo,
  type PrStatus,
} from "./schema.ts";

export class GitHubClient implements GitHostClient {
  readonly workflowsDir = workflowsDirFor("github");
  private readonly http: HostRequestConfig;
  private readonly token: string;

  constructor(
    private readonly parsed: ParsedRepo,
    token: string,
  ) {
    this.token = token;
    this.http = {
      apiBase: parsed.apiBase,
      label: "GitHub",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    };
  }

  get owner(): string {
    return this.parsed.owner;
  }

  get repo(): string {
    return this.parsed.repo;
  }

  get repoUrl(): string {
    return this.parsed.url;
  }

  async createPullRequest(opts: {
    head: string;
    base: string;
    title: string;
    body?: string;
  }): Promise<PullRequest> {
    return hostRequestParsed(
      this.http,
      "POST",
      `/repos/${this.owner}/${this.repo}/pulls`,
      PullRequestSchema,
      {
        head: opts.head,
        base: opts.base,
        title: opts.title,
        body: opts.body ?? "",
      },
    );
  }

  async getPullRequest(index: number): Promise<PullRequest> {
    return hostRequestParsed(
      this.http,
      "GET",
      `/repos/${this.owner}/${this.repo}/pulls/${index}`,
      PullRequestSchema,
    );
  }

  async listPullRequests(state: PrStatus): Promise<PullRequest[]> {
    const ghState = state === "all" ? "all" : state;
    return listPullRequestsPaged((page, perPage) =>
      hostRequestParsed(
        this.http,
        "GET",
        `/repos/${this.owner}/${this.repo}/pulls?state=${encodeURIComponent(ghState)}&page=${page}&per_page=${perPage}`,
        PullRequestListSchema,
      ),
    );
  }

  async findOpenPullRequest(
    head: string,
    base: string,
  ): Promise<PullRequest | undefined> {
    const open = await this.listPullRequests("open");
    return findOpenPullRequestInList(open, head, base);
  }

  async compare(
    base: string,
    head: string,
  ): Promise<{ total_commits: number }> {
    const path = `/repos/${this.owner}/${this.repo}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`;
    const data = await hostRequestParsed(this.http, "GET", path, CompareResultSchema);

    if (typeof data.ahead_by === "number") {
      return { total_commits: data.ahead_by };
    }
    if (typeof data.total_commits === "number") {
      return { total_commits: data.total_commits };
    }
    if (Array.isArray(data.commits)) {
      return { total_commits: data.commits.length };
    }
    return { total_commits: 0 };
  }

  async mergePullRequest(
    index: number,
    opts: { mergeWhenChecksSucceed: boolean },
  ): Promise<void> {
    if (opts.mergeWhenChecksSucceed) {
      await this.enableAutoMerge(index);
      return;
    }

    await hostRequest(
      this.http,
      "PUT",
      `/repos/${this.owner}/${this.repo}/pulls/${index}/merge`,
      { merge_method: "merge" },
    );
  }

  async getCommitStatus(sha: string): Promise<CommitStatus> {
    return hostRequestParsed(
      this.http,
      "GET",
      `/repos/${this.owner}/${this.repo}/commits/${encodeURIComponent(sha)}/status`,
      CommitStatusSchema,
    );
  }

  async getFileContents(path: string, ref: string): Promise<string> {
    const encodedPath = path
      .split("/")
      .map(encodeURIComponent)
      .join("/");
    const file = await hostRequestParsed(
      this.http,
      "GET",
      `/repos/${this.owner}/${this.repo}/contents/${encodedPath}?ref=${encodeURIComponent(ref)}`,
      ContentFileSchema,
    );
    return decodeBase64ContentFile(file);
  }

  async branchExists(name: string): Promise<boolean> {
    return branchExistsFromGet(() =>
      hostRequest(
        this.http,
        "GET",
        `/repos/${this.owner}/${this.repo}/branches/${encodeURIComponent(name)}`,
      ),
    );
  }

  async dispatchWorkflow(
    workflow: string,
    ref: string,
    inputs: Record<string, string>,
  ): Promise<void> {
    const workflowId = encodeURIComponent(workflow);
    await hostRequest(
      this.http,
      "POST",
      `/repos/${this.owner}/${this.repo}/actions/workflows/${workflowId}/dispatches`,
      {
        ref,
        inputs,
      },
    );
  }

  async listWorkflowRuns(
    workflowFile: string,
    limit = 20,
  ): Promise<WorkflowRun[]> {
    const workflowId = encodeURIComponent(workflowFile);
    const paths = [
      `/repos/${this.owner}/${this.repo}/actions/workflows/${workflowId}/runs?per_page=${limit}`,
      `/repos/${this.owner}/${this.repo}/actions/runs?per_page=${limit}`,
    ];

    return collectWorkflowRunsFromPaths({
      paths,
      workflowFile,
      request: (path) => hostRequest(this.http, "GET", path),
      includeRaw: (i, _path, raw) =>
        i === 0 || runMatchesWorkflow(raw, workflowFile),
    });
  }

  private async enableAutoMerge(prNumber: number): Promise<void> {
    const pr = await this.getPullRequest(prNumber);
    const nodeId = pr.node_id;
    if (!nodeId) {
      throw new Error(
        `PR #${prNumber} has no node_id; cannot enable GitHub auto-merge`,
      );
    }

    const data = await this.graphql(
      `mutation($pullRequestId: ID!) {
        enablePullRequestAutoMerge(input: {
          pullRequestId: $pullRequestId
          mergeMethod: MERGE
        }) {
          pullRequest { autoMergeRequest { enabledAt } }
        }
      }`,
      { pullRequestId: nodeId },
      EnableAutoMergeDataSchema,
    );

    if (data.errors?.length) {
      throw new Error(
        `GitHub auto-merge failed for PR #${prNumber}: ${data.errors.map((e) => e.message).join("; ")}. Enable auto-merge on the repository settings.`,
      );
    }

    const enabled =
      data.enablePullRequestAutoMerge?.pullRequest?.autoMergeRequest?.enabledAt;
    if (!enabled) {
      throw new Error(
        `GitHub auto-merge was not enabled for PR #${prNumber}. Enable auto-merge in the repo settings (Settings → General → Allow auto-merge).`,
      );
    }
  }

  private async graphql(
    query: string,
    variables: Record<string, unknown>,
    dataSchema: typeof EnableAutoMergeDataSchema,
  ): Promise<
    z.infer<typeof EnableAutoMergeDataSchema> & {
      errors?: { message: string }[];
    }
  > {
    const url =
      this.parsed.apiBase === "https://api.github.com"
        ? "https://api.github.com/graphql"
        : `${new URL(this.parsed.apiBase).origin}/api/graphql`;

    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: JSON.stringify({ query, variables }),
    });

    const text = await res.text();
    let data: unknown;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      throw new Error(`GitHub GraphQL → ${res.status}: ${text}`);
    }

    if (!res.ok) {
      throw new Error(`GitHub GraphQL → ${res.status}: ${text}`);
    }

    let envelope;
    try {
      envelope = GraphqlEnvelopeSchema.parse(data);
    } catch (err) {
      if (err instanceof ZodError) {
        throw new Error(
          `Invalid GitHub GraphQL envelope:\n${z.prettifyError(err)}`,
        );
      }
      throw err;
    }

    if (envelope.errors?.length) {
      const parsedData = dataSchema.safeParse(envelope.data ?? {});
      const base = parsedData.success ? parsedData.data : {};
      return { ...base, errors: envelope.errors };
    }

    try {
      return dataSchema.parse(envelope.data ?? data);
    } catch (err) {
      if (err instanceof ZodError) {
        throw new Error(
          `Invalid GitHub GraphQL data:\n${z.prettifyError(err)}`,
        );
      }
      throw err;
    }
  }
}
