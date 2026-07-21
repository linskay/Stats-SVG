import fetchGitHubData from "../src/fetch/fetch_github.js";
import fetchLeetCodeStats from "../src/fetch/fetch_leetcode.js";
import fetchSteamStatus from "../src/fetch/fetch_steam.js";
import { REQUEST_DEADLINE_MS } from "../src/fetch/http.js";
import renderStats from "../src/render/render_github.js";
import {
  createVercelRateLimiter,
  clientKey,
  sendRateLimitExceeded,
} from "../src/rate_limit.js";

const GITHUB_LOGIN_PATTERN = /^(?!-)(?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){1,39}$/;
const LEETCODE_USERNAME_PATTERN = /^[A-Za-z0-9_-]{1,30}$/;
const STEAM_ID_PATTERN = /^\d{17}$/;
const RETRYABLE_STATUSES = new Set([429, 502, 503, 504]);
const NETWORK_ERROR_CODES = new Set([
  "ECONNABORTED",
  "ECONNREFUSED",
  "ECONNRESET",
  "EAI_AGAIN",
  "ENETDOWN",
  "ENETUNREACH",
  "ENOTFOUND",
  "EPIPE",
  "ERR_NETWORK",
  "ETIMEDOUT",
]);
const DEFAULT_MAX_RETRY_DELAY_MS = 8_000;

function upstreamStatus(error) {
  return error?.status ?? error?.response?.status;
}

function hasGraphqlValidationErrors(error) {
  const errors = error?.response?.data?.errors ?? error?.errors;
  return Array.isArray(errors) && errors.length > 0;
}

export function isRetryableError(error) {
  if (!error || hasGraphqlValidationErrors(error)) return false;

  const status = upstreamStatus(error);
  if (status !== undefined) return RETRYABLE_STATUSES.has(status);

  return (
    NETWORK_ERROR_CODES.has(error.code) ||
    (error.isAxiosError === true && Boolean(error.request))
  );
}

function retryAfterMs(error, now = Date.now()) {
  const headers = error?.response?.headers;
  const retryAfter = headers?.get?.("retry-after") ?? headers?.["retry-after"];
  if (typeof retryAfter !== "string" && typeof retryAfter !== "number") {
    return undefined;
  }

  const seconds = Number(retryAfter);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;

  const retryAt = Date.parse(retryAfter);
  return Number.isNaN(retryAt) ? undefined : Math.max(0, retryAt - now);
}

function retryDelayMs(error, attempt, retryDelay, maxRetryDelay, random) {
  const upstreamDelay = retryAfterMs(error);
  if (upstreamDelay !== undefined) return upstreamDelay;

  const exponentialDelay = Math.min(maxRetryDelay, retryDelay * 2 ** attempt);
  return Math.floor(exponentialDelay * (0.5 + random() * 0.5));
}

function deadlineExceededError(cause) {
  const error = new Error("Request retry deadline exceeded", { cause });
  error.code = "DEADLINE_EXCEEDED";
  error.status = 504;
  return error;
}

function validateGitHubLogin(login) {
  return typeof login === "string" && GITHUB_LOGIN_PATTERN.test(login);
}

function validateLeetCodeUsername(username) {
  return (
    typeof username === "string" && LEETCODE_USERNAME_PATTERN.test(username)
  );
}

function validateSteamId(steamId) {
  return typeof steamId === "string" && STEAM_ID_PATTERN.test(steamId);
}

async function fetchWithRetry(
  fetcher,
  username,
  maxRetries,
  retryDelay,
  {
    deadlineMs = REQUEST_DEADLINE_MS,
    maxRetryDelay = DEFAULT_MAX_RETRY_DELAY_MS,
    sleep = (delay) => new Promise((resolve) => setTimeout(resolve, delay)),
    random = Math.random,
  } = {},
) {
  let lastError;
  const deadline = Date.now() + deadlineMs;
  for (let attempt = 0; attempt < maxRetries; attempt += 1) {
    if (Date.now() >= deadline) throw deadlineExceededError(lastError);
    try {
      return await fetcher(username);
    } catch (error) {
      lastError = error;
      if (!isRetryableError(error) || attempt === maxRetries - 1) break;

      const delay = retryDelayMs(
        error,
        attempt,
        retryDelay,
        maxRetryDelay,
        random,
      );
      if (Date.now() + delay >= deadline) throw deadlineExceededError(error);
      await sleep(delay);
    }
  }
  throw lastError;
}

function sendUpstreamError(res, error) {
  const status = upstreamStatus(error);
  if (error?.code === "DEADLINE_EXCEEDED" || status === 504) {
    return res.status(504).send("Upstream service temporarily unavailable");
  }
  if (status === 404) {
    return res.status(404).send("User not found");
  }
  if (status === 403) {
    return res
      .status(503)
      .send(
        "Service temporarily unavailable due to upstream rate limits. Please try again later.",
      );
  }
  if (status === 503 || status === 504) {
    return res.status(status).send("Upstream service temporarily unavailable");
  }
  if (status) {
    return res.status(502).send("Upstream service error");
  }
  return res.status(500).send("Error fetching data or rendering image");
}

export function createHandler({
  githubFetcher = fetchGitHubData,
  leetcodeFetcher = fetchLeetCodeStats,
  steamFetcher = fetchSteamStatus,
  renderer = renderStats,
  maxRetries = 5,
  retryDelay = 1000,
  deadlineMs = REQUEST_DEADLINE_MS,
  maxRetryDelay = DEFAULT_MAX_RETRY_DELAY_MS,
  sleep,
  random,
  rateLimiter = createVercelRateLimiter(),
} = {}) {
  const retryOptions = { deadlineMs, maxRetryDelay, sleep, random };
  return async function handler(req, res) {
    const action =
      req.params?.action ??
      new URL(req.url, "http://localhost").pathname.split("/").pop();
    const username = req.query?.username;

    if (
      !["github-status", "leetcode-status", "steam-status"].includes(action)
    ) {
      return res.status(404).send("Not Found");
    }

    const validateUsername = {
      "github-status": validateGitHubLogin,
      "leetcode-status": validateLeetCodeUsername,
      "steam-status": validateSteamId,
    }[action];
    if (!validateUsername(username)) {
      return res
        .status(400)
        .send("A valid username query parameter is required");
    }

    if (rateLimiter) {
      try {
        const result = await rateLimiter.limit(action, clientKey(req));
        if (!result.success) {
          return sendRateLimitExceeded(res, result.retryAfter);
        }
      } catch (error) {
        console.error("Rate limit service error:", error);
        return res
          .status(503)
          .send("Rate limit service temporarily unavailable");
      }
    }

    try {
      if (action === "github-status") {
        const stats = await fetchWithRetry(
          githubFetcher,
          username,
          maxRetries,
          retryDelay,
          retryOptions,
        );
        const svg = await renderer(stats);
        res.setHeader("Content-Type", "image/svg+xml");
        return res.send(svg);
      }
      if (action === "leetcode-status") {
        const stats = await fetchWithRetry(
          leetcodeFetcher,
          username,
          maxRetries,
          retryDelay,
          retryOptions,
        );
        return res.status(200).json(stats);
      }
      if (action === "steam-status") {
        const stats = await fetchWithRetry(
          steamFetcher,
          username,
          maxRetries,
          retryDelay,
          retryOptions,
        );
        return res.status(200).json(stats);
      }
      return res.status(404).send("Not Found");
    } catch (error) {
      console.error("Error in handler:", error);
      return sendUpstreamError(res, error);
    }
  };
}

export {
  fetchWithRetry,
  sendUpstreamError,
  validateGitHubLogin,
  validateLeetCodeUsername,
  validateSteamId,
};
export default createHandler();
