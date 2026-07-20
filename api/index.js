import fetchGitHubData from "../src/fetch/fetch_github.js";
import fetchLeetCodeStats from "../src/fetch/fetch_leetcode.js";
import fetchSteamStatus from "../src/fetch/fetch_steam.js";
import renderStats from "../src/render/render_github.js";

const USERNAME_PATTERN = /^[A-Za-z0-9-]{1,39}$/;

function validateUsername(username) {
  return typeof username === "string" && USERNAME_PATTERN.test(username);
}

async function fetchWithRetry(fetcher, username, maxRetries, retryDelay) {
  let lastError;
  for (let attempt = 0; attempt < maxRetries; attempt += 1) {
    try {
      return await fetcher(username);
    } catch (error) {
      lastError = error;
      if (attempt < maxRetries - 1) {
        await new Promise((resolve) => setTimeout(resolve, retryDelay));
      }
    }
  }
  throw lastError;
}

function sendUpstreamError(res, error) {
  const status = error.status ?? error.response?.status;
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
} = {}) {
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
    if (!validateUsername(username)) {
      return res
        .status(400)
        .send("A valid username query parameter is required");
    }

    try {
      if (action === "github-status") {
        const stats = await fetchWithRetry(
          githubFetcher,
          username,
          maxRetries,
          retryDelay,
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
        );
        return res.status(200).json(stats);
      }
      if (action === "steam-status") {
        const stats = await fetchWithRetry(
          steamFetcher,
          username,
          maxRetries,
          retryDelay,
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

export { validateUsername };
export default createHandler();
