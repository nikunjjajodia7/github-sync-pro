import { requestUrl, Notice } from "obsidian";

const CLIENT_ID = "Iv23liwq8PhSpVtHGahx";
const DEVICE_CODE_URL = "https://github.com/login/device/code";
const ACCESS_TOKEN_URL = "https://github.com/login/oauth/access_token";
const GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";

// GitHub Apps use installation-level permissions (set during app registration),
// not OAuth scopes. No scope parameter needed for Device Flow with GitHub Apps.

// Maximum time to wait for user to authorize (5 minutes)
const MAX_POLL_DURATION_MS = 5 * 60 * 1000;

export interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}

export interface OAuthTokenResponse {
  access_token: string;
  token_type: string;
  scope: string;
  refresh_token?: string;
  refresh_token_expires_in?: number;
  expires_in?: number;
}

export interface GitHubUser {
  login: string;
  avatar_url: string;
  name: string | null;
}

export interface GitHubRepo {
  name: string;
  full_name: string;
  private: boolean;
  description: string | null;
}

/**
 * Step 1: Request a device code from GitHub.
 * Returns the user_code the user must enter at verification_uri.
 */
export async function requestDeviceCode(): Promise<DeviceCodeResponse> {
  const response = await requestUrl({
    url: DEVICE_CODE_URL,
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      client_id: CLIENT_ID,
    }),
    throw: false,
  });

  if (response.status !== 200) {
    throw new Error(`Failed to request device code: ${response.status}`);
  }
  return response.json;
}

/**
 * Step 2: Poll for the access token after user has entered the device code.
 * Returns the token once the user authorizes, or throws on timeout/denial.
 */
export async function pollForToken(
  deviceCode: string,
  interval: number,
): Promise<OAuthTokenResponse> {
  let pollInterval = interval * 1000; // convert to ms
  const startTime = Date.now();

  while (Date.now() - startTime < MAX_POLL_DURATION_MS) {
    await sleep(pollInterval);

    const response = await requestUrl({
      url: ACCESS_TOKEN_URL,
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        client_id: CLIENT_ID,
        device_code: deviceCode,
        grant_type: GRANT_TYPE,
      }),
      throw: false,
    });

    if (response.status !== 200) {
      throw new Error(`Token request failed: ${response.status}`);
    }

    const data = response.json;

    if (data.access_token) {
      return data as OAuthTokenResponse;
    }

    switch (data.error) {
      case "authorization_pending":
        // User hasn't entered the code yet, keep polling
        continue;
      case "slow_down":
        // GitHub wants us to slow down — increase interval by 5s
        pollInterval += 5000;
        continue;
      case "expired_token":
        throw new Error("Authorization timed out. Please try again.");
      case "access_denied":
        throw new Error("Authorization was denied by the user.");
      default:
        throw new Error(`OAuth error: ${data.error_description || data.error}`);
    }
  }

  throw new Error("Authorization timed out after 5 minutes. Please try again.");
}

/**
 * Refresh an expired access token using the refresh token.
 */
export async function refreshAccessToken(
  refreshToken: string,
): Promise<OAuthTokenResponse> {
  const response = await requestUrl({
    url: ACCESS_TOKEN_URL,
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      client_id: CLIENT_ID,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
    throw: false,
  });

  if (response.status !== 200) {
    throw new Error(`Failed to refresh token: ${response.status}`);
  }

  const data = response.json;
  if (data.error) {
    throw new Error(`Refresh failed: ${data.error_description || data.error}`);
  }

  return data as OAuthTokenResponse;
}

/**
 * Validate a token by fetching the authenticated user.
 */
export async function validateToken(token: string): Promise<GitHubUser> {
  const response = await requestUrl({
    url: "https://api.github.com/user",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
    },
    throw: false,
  });

  if (response.status === 401) {
    throw new Error("Token is invalid or expired");
  }
  if (response.status !== 200) {
    throw new Error(`Failed to validate token: ${response.status}`);
  }
  return response.json;
}

/**
 * List repos the authenticated user has access to.
 */
export async function listUserRepos(
  token: string,
): Promise<GitHubRepo[]> {
  const response = await requestUrl({
    url: "https://api.github.com/user/repos?sort=updated&per_page=100&affiliation=owner",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
    },
    throw: false,
  });

  if (response.status !== 200) {
    throw new Error(`Failed to list repos: ${response.status}`);
  }
  return response.json;
}

/**
 * Create a new private repo for the authenticated user.
 */
export async function createRepo(
  token: string,
  name: string,
  description: string = "Obsidian vault synced by GitHub Sync Pro",
): Promise<GitHubRepo> {
  const response = await requestUrl({
    url: "https://api.github.com/user/repos",
    method: "POST",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body: JSON.stringify({
      name,
      description,
      private: true,
      auto_init: false,
    }),
    throw: false,
  });

  if (response.status === 422) {
    throw new Error(`Repository "${name}" already exists. Choose a different name.`);
  }
  if (response.status !== 201) {
    throw new Error(`Failed to create repo: ${response.status}`);
  }
  return response.json;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
