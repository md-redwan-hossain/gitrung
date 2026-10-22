import type { GitPlatform, ParsedRepo } from "./schema.ts";

export function parseRepoUrl(
  url: string,
  git_platform: GitPlatform,
): ParsedRepo {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid repo URL: ${url}`);
  }

  const parts = parsed.pathname.replace(/\/+$/, "").split("/").filter(Boolean);
  if (parts.length < 2) {
    throw new Error(
      `Repo URL must look like https://host/owner/repo, got: ${url}`,
    );
  }

  const owner = parts[0]!;
  const repo = parts[1]!.replace(/\.git$/, "");
  const repoUrl = `${parsed.origin}/${owner}/${repo}`;

  if (git_platform === "github") {
    const host = parsed.hostname.toLowerCase();
    const apiBase =
      host === "github.com" || host === "www.github.com"
        ? "https://api.github.com"
        : `${parsed.origin}/api/v3`;
    return { apiBase, owner, repo, url: repoUrl, git_platform };
  }

  return {
    apiBase: `${parsed.origin}/api/v1`,
    owner,
    repo,
    url: repoUrl,
    git_platform,
  };
}
