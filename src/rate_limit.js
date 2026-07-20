const ENDPOINT_LIMITS = {
  "github-status": 60,
  "leetcode-status": 30,
  "steam-status": 20,
};
const WINDOW_SECONDS = 60;

export const rateLimitConfig = Object.freeze(
  Object.fromEntries(
    Object.entries(ENDPOINT_LIMITS).map(([action, limit]) => [
      action,
      { limit, windowSeconds: WINDOW_SECONDS },
    ]),
  ),
);

function clientKey(request) {
  const forwarded = request.headers?.["x-forwarded-for"];
  const ip = typeof forwarded === "string" ? forwarded.split(",")[0].trim() : request.ip;
  return ip || "anonymous";
}

function retryAfter(seconds) {
  return Math.max(1, Math.ceil(seconds));
}

export function createMemoryRateLimiter({ now = () => Date.now() } = {}) {
  const requests = new Map();
  return {
    async limit(action, key) {
      const config = rateLimitConfig[action];
      if (!config) return { success: true };

      const bucketKey = `${action}:${key}`;
      const timestamp = now();
      const current = requests.get(bucketKey);
      const windowMs = config.windowSeconds * 1_000;
      const bucket = !current || current.resetAt <= timestamp
        ? { count: 0, resetAt: timestamp + windowMs }
        : current;
      bucket.count += 1;
      requests.set(bucketKey, bucket);
      return bucket.count <= config.limit
        ? { success: true }
        : { success: false, retryAfter: retryAfter((bucket.resetAt - timestamp) / 1_000) };
    },
  };
}

const FIXED_WINDOW_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
local ttl = redis.call('TTL', KEYS[1])
return { count, ttl }
`;

/** A Redis/KV-backed limiter for Vercel production instances. */
export function createDistributedRateLimiter({
  url = process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL,
  token = process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN,
  fetcher = globalThis.fetch,
} = {}) {
  if (!url || !token) {
    throw new Error("KV_REST_API_URL and KV_REST_API_TOKEN are required on Vercel production");
  }

  return {
    async limit(action, key) {
      const config = rateLimitConfig[action];
      if (!config) return { success: true };
      const redisKey = `rate-limit:${action}:${key}:${Math.floor(Date.now() / (config.windowSeconds * 1_000))}`;
      const response = await fetcher(`${url.replace(/\/$/, "")}/pipeline`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify([["EVAL", FIXED_WINDOW_SCRIPT, 1, redisKey, config.windowSeconds]]),
      });
      if (!response.ok) throw new Error(`KV rate limit request failed with ${response.status}`);
      const [result] = await response.json();
      const [count, ttl] = result.result;
      return count <= config.limit
        ? { success: true }
        : { success: false, retryAfter: retryAfter(ttl) };
    },
  };
}

export function createVercelRateLimiter() {
  return process.env.VERCEL_ENV === "production"
    ? createDistributedRateLimiter()
    : null;
}

export function createRateLimitMiddleware(limiter) {
  return async function rateLimitMiddleware(req, res, next) {
    const result = await limiter.limit(req.params.action, clientKey(req));
    if (!result.success) {
      res.setHeader("Retry-After", String(result.retryAfter));
      return res.status(429).send("Too Many Requests");
    }
    return next();
  };
}

export { clientKey };
