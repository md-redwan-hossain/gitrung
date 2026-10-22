import { GiteaClient } from "./gitea.ts";
import type { GitHostClient } from "./git-host.ts";
import { GitHubClient } from "./github.ts";
import type { ParsedRepo } from "./schema.ts";

export function createGitClient(
  parsed: ParsedRepo,
  token: string,
): GitHostClient {
  if (parsed.git_platform === "github") {
    return new GitHubClient(parsed, token);
  }
  return new GiteaClient(parsed, token);
}
