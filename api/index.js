import fetchGitHubData from '../src/fetch/fetch_github.js';
import fetchLeetCodeStats from '../src/fetch/fetch_leetcode.js';
import fetchSteamStatus from '../src/fetch/fetch_steam.js';
import renderStats from '../src/render/render_github.js';

const MINUTE = 60 * 1000;

// Keep each provider's identifier rules explicit: they are not interchangeable.
export const USERNAME_REQUIREMENTS = {
  github: {
    label: 'GitHub login',
    minLength: 1,
    maxLength: 39,
    format: /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/
  },
  leetcode: {
    label: 'LeetCode username',
    minLength: 1,
    maxLength: 30,
    format: /^[A-Za-z0-9_-]+$/
  },
  steam: {
    label: 'SteamID',
    minLength: 17,
    maxLength: 17,
    format: /^7656119\d{10}$/
  }
};

function validateUsername(username, provider) {
  const requirement = USERNAME_REQUIREMENTS[provider];

  if (typeof username !== 'string' || username.length === 0) {
    return `${requirement.label} is required and must be a string`;
  }
  if (username.length < requirement.minLength || username.length > requirement.maxLength) {
    return `${requirement.label} must be ${requirement.minLength}-${requirement.maxLength} characters long`;
  }
  if (!requirement.format.test(username)) {
    return `${requirement.label} has an invalid format`;
  }
  return null;
}

function getClientIp(req) {
  const forwarded = req.headers?.['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length > 0) return forwarded.split(',')[0].trim();
  return req.socket?.remoteAddress || req.connection?.remoteAddress || 'unknown';
}

/** A bounded, per-IP fixed-window rate-limit middleware. */
function createRateLimiter({ windowMs, max, maxEntries = 10_000 }) {
  const requests = new Map();

  return (req, res) => {
    const now = Date.now();
    for (const [ip, state] of requests) {
      if (state.resetAt <= now) requests.delete(ip);
    }

    const ip = getClientIp(req);
    let state = requests.get(ip);
    if (!state || state.resetAt <= now) state = { count: 0, resetAt: now + windowMs };

    state.count += 1;
    requests.delete(ip);
    requests.set(ip, state);
    while (requests.size > maxEntries) requests.delete(requests.keys().next().value);

    const remaining = Math.max(0, max - state.count);
    res.setHeader('X-RateLimit-Limit', String(max));
    res.setHeader('X-RateLimit-Remaining', String(remaining));

    if (state.count > max) {
      const retryAfter = Math.ceil((state.resetAt - now) / 1000);
      res.setHeader('Retry-After', String(retryAfter));
      res.status(429).json({ error: 'Too many requests. Please try again later.' });
      return false;
    }
    return true;
  };
}

const globalRateLimit = createRateLimiter({ windowMs: MINUTE, max: 60 });
const endpointRateLimits = {
  github: createRateLimiter({ windowMs: MINUTE, max: 10 }),
  leetcode: createRateLimiter({ windowMs: MINUTE, max: 20 }),
  steam: createRateLimiter({ windowMs: MINUTE, max: 10 })
};

async function fetchWithRetry(fetcher, username, maxRetries = 5, retryDelay = 1000) {
  let lastError;
  for (let attempt = 0; attempt < maxRetries; attempt += 1) {
    try {
      return await fetcher(username);
    } catch (error) {
      lastError = error;
      console.error(`Attempt ${attempt + 1} failed:`, error.message);
      if (attempt < maxRetries - 1) await new Promise(resolve => setTimeout(resolve, retryDelay));
    }
  }
  throw lastError;
}

const endpoints = {
  '/api/github-status': { provider: 'github', fetcher: fetchGitHubData },
  '/api/leetcode-status': { provider: 'leetcode', fetcher: fetchLeetCodeStats },
  '/api/steam-status': { provider: 'steam', fetcher: fetchSteamStatus }
};

export default async function handler(req, res) {
  const path = new URL(req.url, 'http://localhost').pathname;
  const endpoint = endpoints[path];
  if (!endpoint) return res.status(404).send('Not Found');

  // Validation deliberately runs before retry logic and before a fetcher can call an external API.
  const validationError = validateUsername(req.query?.username, endpoint.provider);
  if (validationError) return res.status(400).json({ error: validationError });

  if (!globalRateLimit(req, res) || !endpointRateLimits[endpoint.provider](req, res)) return;

  try {
    const stats = await fetchWithRetry(endpoint.fetcher, req.query.username);
    if (endpoint.provider === 'github') {
      const svg = await renderStats(stats);
      res.setHeader('Content-Type', 'image/svg+xml');
      return res.send(svg);
    }
    return res.status(200).json(stats);
  } catch (error) {
    console.error('Error in handler:', error);
    if (error.response?.status === 403) {
      return res.status(503).send('Service temporarily unavailable due to upstream API rate limits. Please try again later.');
    }
    return res.status(500).send('Error fetching data or rendering image');
  }
}
