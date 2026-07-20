import assert from "node:assert/strict";
import test from "node:test";
import { createMemoryRateLimiter, rateLimitConfig } from "../src/rate_limit.js";

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
  assert.equal((await limiter.limit("github-status", "127.0.0.1")).success, true);
});
