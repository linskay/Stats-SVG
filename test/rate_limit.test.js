import assert from "node:assert/strict";
import test from "node:test";
import {
  createDistributedRateLimiter,
  createMemoryRateLimiter,
  createRateLimitMiddleware,
  rateLimitConfig,
} from "../src/rate_limit.js";

test("uses independent limits for GitHub, LeetCode, and Steam endpoints", async () => {
  let timestamp = 0;
  const limiter = createMemoryRateLimiter({ now: () => timestamp });

  for (const [action, { limit }] of Object.entries(rateLimitConfig)) {
    for (let index = 0; index < limit; index += 1) {
      assert.equal((await limiter.limit(action, "127.0.0.1")).success, true);
    }
    const blocked = await limiter.limit(action, "127.0.0.1");
    assert.equal(blocked.success, false);
    assert.equal(blocked.retryAfter, 60);
  }

  timestamp = 60_000;
  assert.equal(
    (await limiter.limit("github-status", "127.0.0.1")).success,
    true,
  );
});

test("local middleware returns 429 and Retry-After without calling next", async () => {
  let nextCalls = 0;
  const middleware = createRateLimitMiddleware({
    limit: async () => ({ success: false, retryAfter: 12.1 }),
  });
  const res = {
    headers: {},
    setHeader(name, value) {
      this.headers[name] = value;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    send(body) {
      this.body = body;
      return this;
    },
  };

  await middleware(
    { params: { action: "github-status" }, headers: {}, ip: "127.0.0.1" },
    res,
    () => {
      nextCalls += 1;
    },
  );

  assert.deepEqual(
    [res.statusCode, res.body, res.headers["Retry-After"]],
    [429, "Too Many Requests", "13"],
  );
  assert.equal(nextCalls, 0);
});

test("distributed limiter uses an atomic KV pipeline and reports its TTL", async () => {
  let request;
  const limiter = createDistributedRateLimiter({
    url: "https://kv.example.com/",
    token: "secret",
    fetcher: async (url, options) => {
      request = { url, options };
      return {
        ok: true,
        json: async () => [{ result: [61, 17] }],
      };
    },
  });

  const result = await limiter.limit("github-status", "203.0.113.1");

  assert.deepEqual(result, { success: false, retryAfter: 17 });
  assert.equal(request.url, "https://kv.example.com/pipeline");
  assert.equal(request.options.headers.Authorization, "Bearer secret");
  const [[command, , keyCount, redisKey, windowSeconds]] = JSON.parse(
    request.options.body,
  );
  assert.equal(command, "EVAL");
  assert.equal(keyCount, 1);
  assert.match(redisKey, /^rate-limit:github-status:203\.0\.113\.1:/);
  assert.equal(windowSeconds, 60);
});
