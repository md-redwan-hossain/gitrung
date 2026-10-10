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
  PullRequestListSchema,
  PullRequestSchema,
  type CommitStatus,
  type ParsedRepo,
  type PrStatus,
} from "./schema.ts";

export class GiteaClient implements GitHostClient {
  readonly workflowsDir = workflowsDirFor("gitea");
  private readonly http: HostRequestConfig;

  constructor(
    private readonly parsed: ParsedRepo,
    token: string,
  ) {
    this.http = {
      apiBase: parsed.apiBase,
      label: "Gitea",
      headers: {
        Authorization: `token ${token}`,
        Accept: "application/json",
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
    return listPullRequestsPaged((page, perPage) =>
      hostRequestParsed(
        this.http,
        "GET",
        `/repos/${this.owner}/${this.repo}/pulls?state=${encodeURIComponent(state)}&page=${page}&limit=${perPage}`,
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
    await hostRequest(
      this.http,
      "POST",
      `/repos/${this.owner}/${this.repo}/pulls/${index}/merge`,
      {
        Do: "merge",
        merge_title_field: "",
        merge_message_field: "",
        merge_when_checks_succeed: opts.mergeWhenChecksSucceed,
        force_merge: false,
      },
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
      `/repos/${this.owner}/${this.repo}/actions/workflows/${workflowId}/runs?limit=${limit}`,
      `/repos/${this.owner}/${this.repo}/actions/runs?workflow_id=${workflowId}&limit=${limit}`,
      `/repos/${this.owner}/${this.repo}/actions/runs?limit=${limit}`,
    ];

    return collectWorkflowRunsFromPaths({
      paths,
      workflowFile,
      request: (path) => hostRequest(this.http, "GET", path),
      includeRaw: (_i, path, raw) => {
        if (
          path.includes("actions/runs?") &&
          !path.includes("workflow_id=") &&
          !runMatchesWorkflow(raw, workflowFile)
        ) {
          return false;
        }
        return true;
      },
    });
  }
}
