// Import necessary functions
import fetchGitHubData from '../src/fetch/fetch_github.js';
import fetchLeetCodeStats from '../src/fetch/fetch_leetcode.js';
import fetchSteamStatus from '../src/fetch/fetch_steam.js';
import renderStats from '../src/render/render_github.js';

// Leave time to render and send the response before Vercel's 10-second maxDuration.
const REQUEST_DEADLINE_MS = 8_500;
const MAX_ATTEMPTS = 3;
const BASE_RETRY_DELAY_MS = 250;
const MAX_RETRY_DELAY_MS = 2_000;
const RETRYABLE_SERVER_STATUSES = new Set([500, 502, 503, 504]);

const sleep = (milliseconds) => new Promise(resolve => setTimeout(resolve, milliseconds));

function deadlineError() {
  const error = new Error('Request deadline exceeded before the upstream request completed');
  error.code = 'DEADLINE_EXCEEDED';
  return error;
}

function runBeforeDeadline(fetcher, remaining) {
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(deadlineError()), remaining);
  });

  return Promise.race([fetcher(), timeout]).finally(() => clearTimeout(timeoutId));
}

function getProviderRetryDelay(error) {
  const headers = error.response?.headers;
  if (!headers) return null;

  const retryAfter = headers['retry-after'];
  if (retryAfter) {
    const seconds = Number(retryAfter);
    const retryAt = Number.isFinite(seconds) ? Date.now() + seconds * 1_000 : Date.parse(retryAfter);
    if (Number.isFinite(retryAt)) return Math.max(0, retryAt - Date.now());
  }

  // GitHub and several other providers expose the reset as Unix seconds.
  const resetAt = Number(headers['x-ratelimit-reset']);
  if (Number.isFinite(resetAt) && headers['x-ratelimit-remaining'] === '0') {
    return Math.max(0, resetAt * 1_000 - Date.now());
  }

  return null;
}

export function isRetryableError(error) {
  const status = error.response?.status;
  if (status !== undefined) return status === 429 || RETRYABLE_SERVER_STATUSES.has(status);

  // Axios uses a missing response for connection, DNS and timeout failures.
  return error.isAxiosError === true && Boolean(error.code || error.request);
}

export async function fetchWithRetry(fetcher, { label, deadlineMs = REQUEST_DEADLINE_MS } = {}) {
  const deadlineAt = Date.now() + deadlineMs;
  let lastError;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const remaining = deadlineAt - Date.now();
    if (remaining <= 0) throw lastError || deadlineError();

    try {
      return await runBeforeDeadline(fetcher, remaining);
    } catch (error) {
      lastError = error;
      if (!isRetryableError(error) || attempt === MAX_ATTEMPTS) throw error;

      const exponentialDelay = Math.min(BASE_RETRY_DELAY_MS * 2 ** (attempt - 1), MAX_RETRY_DELAY_MS);
      const jitteredDelay = Math.round(exponentialDelay * (0.5 + Math.random()));
      const delay = Math.max(jitteredDelay, getProviderRetryDelay(error) || 0);
      if (Date.now() + delay >= deadlineAt) throw error;

      console.warn(`${label || 'Upstream request'} failed (attempt ${attempt}/${MAX_ATTEMPTS}); retrying in ${delay}ms`, error.message);
      await sleep(delay);
    }
  }

  throw lastError;
}

export default async function handler(req, res) {
  const { username } = req.query;

  try {
    if (req.url.includes('github-status')) {
      const stats = await fetchWithRetry(() => fetchGitHubData(username), { label: 'GitHub request' });
      //console.log(stats);
      console.time('render stats');
      const svg = await renderStats(stats);
      console.timeEnd('render stats');
      res.setHeader('Content-Type', 'image/svg+xml');
      console.time('send svg');
      res.send(svg);
      console.timeEnd('send svg');

    } else if (req.url.includes('leetcode-status')) {
      console.time('fetch leetcode stats');
      const stats = await fetchWithRetry(() => fetchLeetCodeStats(username), { label: 'LeetCode request' });
      console.timeEnd('fetch leetcode stats');
      console.log(stats);
      res.status(200).json(stats);

    } else if (req.url.includes('steam-status')) {
      console.time('fetch steam status');
      const stats = await fetchWithRetry(() => fetchSteamStatus(username), { label: 'Steam request' });
      console.timeEnd('fetch steam status');
      console.log(stats);
      res.status(200).json(stats);
    } else {
      res.status(404).send('Not Found');
    }

  } catch (error) {
    console.error('Error in handler:', error);
    // Use error handling specific to your server framework
    // For example, in Express.js:
    if (error.response && error.response.status === 403) {
      res.status(503).send('Service temporarily unavailable due to GitHub API rate limits. Please try again later.');
    } else {
      res.status(500).send('Error fetching data or rendering image');
    }
  }
}
