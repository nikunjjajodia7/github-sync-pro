import { requestUrl } from "obsidian";
import Logger from "src/logger";
import { GitHubSyncSettings } from "src/settings/settings";
import { retryUntil } from "src/utils";

export type RepoContent = {
  files: { [key: string]: GetTreeResponseItem };
  sha: string;
};

/**
 * Represents a single item in a tree response from the GitHub API.
 */
export type GetTreeResponseItem = {
  path: string;
  mode: string;
  type: string;
  sha: string;
  size: number;
  url: string;
};

export type NewTreeRequestItem = {
  path: string;
  mode: string;
  type: string;
  sha?: string | null;
  content?: string;
};

/**
 * Response received when we create a new binary blob on GitHub
 */
export type CreatedBlob = {
  sha: string;
};

/**
 * Represents a git blob response from the GitHub API.
 */
export type BlobFile = {
  sha: string;
  node_id: string;
  size: number;
  url: string;
  content: string;
  encoding: string;
};

/**
 * Represents a commit that modified a specific file.
 */
export type FileCommit = {
  sha: string;
  message: string;
  date: string;
  authorName: string;
};

/**
 * Custom error to make some stuff easier
 */
class GithubAPIError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface RateLimitInfo {
  remaining: number;
  limit: number;
  resetAt: Date;
}

export default class GithubClient {
  private _rateLimit: RateLimitInfo = {
    remaining: 5000,
    limit: 5000,
    resetAt: new Date(),
  };

  constructor(
    private settings: GitHubSyncSettings,
    private logger: Logger,
  ) {}

  get rateLimit(): Readonly<RateLimitInfo> {
    return this._rateLimit;
  }

  private headers() {
    return {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${this.settings.githubToken}`,
      "X-GitHub-Api-Version": "2022-11-28",
    };
  }

  private shouldStopRetrying(res: { status: number }) {
    return res.status !== 422 && res.status !== 429 && res.status < 500;
  }

  private updateRateLimit(response: { headers: Record<string, string> }) {
    const remaining = response.headers?.["x-ratelimit-remaining"];
    const limit = response.headers?.["x-ratelimit-limit"];
    const reset = response.headers?.["x-ratelimit-reset"];
    if (remaining !== undefined) {
      this._rateLimit.remaining = parseInt(remaining, 10);
    }
    if (limit !== undefined) {
      this._rateLimit.limit = parseInt(limit, 10);
    }
    if (reset !== undefined) {
      this._rateLimit.resetAt = new Date(parseInt(reset, 10) * 1000);
    }
  }

  /**
   * Central request helper. Handles retry, error checking, logging, and rate limit tracking.
   */
  private async request({
    url,
    method = "GET",
    body,
    errorMessage,
    retry = false,
    maxRetries = 5,
  }: {
    url: string;
    method?: string;
    body?: string;
    errorMessage: string;
    retry?: boolean;
    maxRetries?: number;
  }) {
    const response = await retryUntil(
      async () => {
        return requestUrl({
          url,
          headers: this.headers(),
          method,
          body,
          throw: false,
        });
      },
      (res) => this.shouldStopRetrying(res),
      retry ? maxRetries : 0,
    );

    this.updateRateLimit(response);

    if (response.status < 200 || response.status >= 400) {
      await this.logger.error(errorMessage, response);
      throw new GithubAPIError(response.status, `${errorMessage}, status ${response.status}`);
    }
    return response;
  }

  private repoUrl(path: string = ""): string {
    return `https://api.github.com/repos/${this.settings.githubOwner}/${this.settings.githubRepo}${path}`;
  }

  async getRepoContent({ retry = false, maxRetries = 5 } = {}): Promise<RepoContent> {
    const response = await this.request({
      url: this.repoUrl(`/git/trees/${this.settings.githubBranch}?recursive=1&t=${Date.now()}`),
      errorMessage: "Failed to get repo content",
      retry,
      maxRetries,
    });

    const files = response.json.tree
      .filter((file: GetTreeResponseItem) => file.type === "blob")
      .reduce(
        (
          acc: { [key: string]: GetTreeResponseItem },
          file: GetTreeResponseItem,
        ) => ({ ...acc, [file.path]: file }),
        {},
      );
    return { files, sha: response.json.sha };
  }

  async createTree({
    tree,
    retry = false,
    maxRetries = 5,
  }: {
    tree: { tree: NewTreeRequestItem[]; base_tree: string };
    retry?: boolean;
    maxRetries?: number;
  }) {
    const response = await this.request({
      url: this.repoUrl("/git/trees"),
      method: "POST",
      body: JSON.stringify(tree),
      errorMessage: "Failed to create tree",
      retry,
      maxRetries,
    });
    return response.json.sha;
  }

  async createCommit({
    message,
    treeSha,
    parent,
    retry = false,
    maxRetries = 5,
  }: {
    message: string;
    treeSha: string;
    parent: string;
    retry?: boolean;
    maxRetries?: number;
  }): Promise<string> {
    const response = await this.request({
      url: this.repoUrl("/git/commits"),
      method: "POST",
      body: JSON.stringify({ message, tree: treeSha, parents: [parent] }),
      errorMessage: "Failed to create commit",
      retry,
      maxRetries,
    });
    return response.json.sha;
  }

  async getBranchHeadSha({ retry = false, maxRetries = 5 } = {}) {
    const response = await this.request({
      url: this.repoUrl(`/git/refs/heads/${this.settings.githubBranch}`),
      errorMessage: "Failed to get branch head sha",
      retry,
      maxRetries,
    });
    return response.json.object.sha;
  }

  async updateBranchHead({
    sha,
    retry = false,
    maxRetries = 5,
  }: {
    sha: string;
    retry?: boolean;
    maxRetries?: number;
  }) {
    await this.request({
      url: this.repoUrl(`/git/refs/heads/${this.settings.githubBranch}`),
      method: "PATCH",
      body: JSON.stringify({ sha }),
      errorMessage: "Failed to update branch head sha",
      retry,
      maxRetries,
    });
  }

  async createBlob({
    content,
    encoding = "base64",
    retry = false,
    maxRetries = 5,
  }: {
    content: string;
    encoding?: "utf-8" | "base64";
    retry?: boolean;
    maxRetries?: number;
  }): Promise<CreatedBlob> {
    const response = await this.request({
      url: this.repoUrl("/git/blobs"),
      method: "POST",
      body: JSON.stringify({ content, encoding }),
      errorMessage: "Failed to create blob",
      retry,
      maxRetries,
    });
    return { sha: response.json["sha"] };
  }

  async getBlob({
    sha,
    retry = false,
    maxRetries = 5,
  }: {
    sha: string;
    retry?: boolean;
    maxRetries?: number;
  }): Promise<BlobFile> {
    const response = await this.request({
      url: this.repoUrl(`/git/blobs/${sha}`),
      errorMessage: "Failed to get blob",
      retry,
      maxRetries,
    });
    return response.json;
  }

  async createFile({
    path,
    content,
    message,
    retry = false,
    maxRetries = 5,
  }: {
    path: string;
    content: string;
    message: string;
    retry?: boolean;
    maxRetries?: number;
  }) {
    await this.request({
      url: this.repoUrl(`/contents/${path}`),
      method: "PUT",
      body: JSON.stringify({ message, content, branch: this.settings.githubBranch }),
      errorMessage: "Failed to create file",
      retry,
      maxRetries,
    });
  }

  async downloadRepositoryArchive({ retry = false, maxRetries = 5 } = {}): Promise<ArrayBuffer> {
    const response = await this.request({
      url: this.repoUrl(`/zipball/${this.settings.githubBranch}`),
      errorMessage: "Failed to download zip archive",
      retry,
      maxRetries,
    });
    return response.arrayBuffer;
  }

  /**
   * Get the commit history for a specific file path.
   */
  async getFileCommits({
    path,
    perPage = 30,
    retry = false,
    maxRetries = 3,
  }: {
    path: string;
    perPage?: number;
    retry?: boolean;
    maxRetries?: number;
  }): Promise<FileCommit[]> {
    const response = await this.request({
      url: this.repoUrl(`/commits?path=${encodeURIComponent(path)}&sha=${this.settings.githubBranch}&per_page=${perPage}`),
      errorMessage: "Failed to get file commits",
      retry,
      maxRetries,
    });
    return response.json.map((commit: any) => ({
      sha: commit.sha,
      message: commit.commit.message,
      date: commit.commit.committer.date,
      authorName: commit.commit.author.name,
    }));
  }

  /**
   * Get file content at a specific commit SHA.
   * Uses the Contents API (single file fetch) instead of fetching the entire tree.
   */
  async getFileAtCommit({
    path,
    commitSha,
    retry = false,
    maxRetries = 3,
  }: {
    path: string;
    commitSha: string;
    retry?: boolean;
    maxRetries?: number;
  }): Promise<string | null> {
    // Validate commitSha format to prevent URL manipulation
    if (!/^[0-9a-f]{7,40}$/i.test(commitSha)) {
      throw new Error(`Invalid commit SHA: ${commitSha}`);
    }
    try {
      const response = await this.request({
        url: this.repoUrl(`/contents/${encodeURIComponent(path)}?ref=${commitSha}`),
        errorMessage: "Failed to get file at commit",
        retry,
        maxRetries,
      });
      return response.json.content; // base64 encoded
    } catch (err: any) {
      if (err.status === 404) return null;
      throw err;
    }
  }
}
