import assert from "node:assert/strict";
import test from "node:test";
import {
  createHandler,
  isRetryableError,
  validateGitHubLogin,
  validateLeetCodeUsername,
  validateSteamId,
} from "../api/index.js";
import { UpstreamRequestError } from "../src/fetch/http.js";
import { createMemoryRateLimiter } from "../src/rate_limit.js";

function response() {
  return {
    statusCode: undefined,
    body: undefined,
    headers: {},
    status(code) {
      this.statusCode = code;
      return this;
    },
    send(body) {
      this.body = body;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
    setHeader(name, value) {
      this.headers[name] = value;
    },
  };
}

test("validates endpoint-specific query parameters before accessing upstream services", async () => {
  let called = false;
  const handler = createHandler({
    githubFetcher: async () => {
      called = true;
    },
    maxRetries: 1,
  });
  const res = response();
  await handler(
    { params: { action: "github-status" }, query: { username: "<script>" } },
    res,
  );

  assert.equal(res.statusCode, 400);
  assert.equal(called, false);
  assert.equal(validateGitHubLogin("octo-cat"), true);
  assert.equal(validateGitHubLogin(["octo-cat"]), false);
});

test("accepts only numeric 17-digit Steam IDs", () => {
  assert.equal(validateSteamId("76561198000000000"), true);
  assert.equal(validateSteamId("not-a-steam-id"), false);
  assert.equal(validateSteamId("7656119800000000"), false);
});

test("rejects GitHub logins with invalid hyphens", () => {
  assert.equal(validateGitHubLogin("-octocat"), false);
  assert.equal(validateGitHubLogin("octocat-"), false);
  assert.equal(validateGitHubLogin("octo--cat"), false);
});

test("accepts public LeetCode username characters", () => {
  assert.equal(validateLeetCodeUsername("leetcode"), true);
  assert.equal(validateLeetCodeUsername("leetcode_user-42"), true);
});

test("rate limit rejects requests before a GitHub provider fetch or retry", async () => {
  let calls = 0;
  let sleeps = 0;
  const handler = createHandler({
    githubFetcher: async () => {
      calls += 1;
      throw { response: { status: 503 } };
    },
    maxRetries: 5,
    sleep: async () => {
      sleeps += 1;
    },
    rateLimiter: { limit: async () => ({ success: false, retryAfter: 42 }) },
  });
  const res = response();

  await handler(
    { params: { action: "github-status" }, query: { username: "octocat" } },
    res,
  );

  assert.deepEqual(
    [res.statusCode, res.body, res.headers["Retry-After"]],
    [429, "Too Many Requests", "42"],
  );
  assert.equal(calls, 0);
  assert.equal(sleeps, 0);
});

test("exceeded endpoint limits do not call any provider fetcher or schedule retries", async () => {
  const limiter = createMemoryRateLimiter();
  const calls = { github: 0, leetcode: 0, steam: 0 };
  let sleeps = 0;
  const handler = createHandler({
    githubFetcher: async () => {
      calls.github += 1;
      throw { response: { status: 503 } };
    },
    leetcodeFetcher: async () => {
      calls.leetcode += 1;
      throw { response: { status: 503 } };
    },
    steamFetcher: async () => {
      calls.steam += 1;
      throw { response: { status: 503 } };
    },
    maxRetries: 5,
    sleep: async () => {
      sleeps += 1;
    },
    rateLimiter: limiter,
  });
  const endpoints = [
    ["github-status", "octocat", "github", 60],
    ["leetcode-status", "leetcode", "leetcode", 30],
    ["steam-status", "76561198000000000", "steam", 20],
  ];

  for (const [action, username, provider, limit] of endpoints) {
    const key = `limited-${provider}`;
    for (let index = 0; index < limit; index += 1) {
      await limiter.limit(action, key);
    }

    const res = response();
    await handler(
      {
        params: { action },
        query: { username },
        headers: { "x-forwarded-for": key },
      },
      res,
    );
    assert.deepEqual([res.statusCode, res.headers["Retry-After"]], [429, "60"]);
  }

  assert.deepEqual(calls, { github: 0, leetcode: 0, steam: 0 });
  assert.equal(sleeps, 0);
});

test("returns 404 for a missing upstream user and 502 for an upstream failure", async () => {
  const notFound = createHandler({
    githubFetcher: async () => {
      throw { response: { status: 404 } };
    },
    maxRetries: 1,
  });
  const unavailable = createHandler({
    githubFetcher: async () => {
      throw { response: { status: 500 } };
    },
    maxRetries: 1,
  });
  const first = response();
  const second = response();

  await notFound(
    { params: { action: "github-status" }, query: { username: "octocat" } },
    first,
  );
  await unavailable(
    { params: { action: "github-status" }, query: { username: "octocat" } },
    second,
  );
  assert.deepEqual([first.statusCode, first.body], [404, "User not found"]);
  assert.deepEqual(
    [second.statusCode, second.body],
    [502, "Upstream service error"],
  );
});

test("returns 503 for a temporary upstream timeout", async () => {
  const handler = createHandler({
    githubFetcher: async () => {
      throw new UpstreamRequestError("GitHub API is temporarily unavailable", {
        status: 503,
      });
    },
    maxRetries: 1,
  });
  const res = response();

  await handler(
    { params: { action: "github-status" }, query: { username: "octocat" } },
    res,
  );

  assert.deepEqual(
    [res.statusCode, res.body],
    [503, "Upstream service temporarily unavailable"],
  );
});

test("does not retry non-retryable 400 and 404 upstream responses", async () => {
  for (const status of [400, 404]) {
    let calls = 0;
    const handler = createHandler({
      githubFetcher: async () => {
        calls += 1;
        throw { response: { status } };
      },
      maxRetries: 4,
      retryDelay: 0,
    });
    const res = response();

    await handler(
      { params: { action: "github-status" }, query: { username: "octocat" } },
      res,
    );

    assert.equal(calls, 1, `status ${status} must not be retried`);
  }
});

test("retries retryable 503 and 429 responses only up to the configured limit", async () => {
  for (const status of [503, 429]) {
    let calls = 0;
    const delays = [];
    const handler = createHandler({
      githubFetcher: async () => {
        calls += 1;
        throw { response: { status } };
      },
      maxRetries: 3,
      retryDelay: 10,
      random: () => 1,
      sleep: async (delay) => delays.push(delay),
    });
    const res = response();

    await handler(
      { params: { action: "github-status" }, query: { username: "octocat" } },
      res,
    );

    assert.equal(calls, 3, `status ${status} must use all attempts`);
    assert.deepEqual(delays, [10, 20]);
  }
});

test("uses Retry-After before exponential backoff", async () => {
  let calls = 0;
  const delays = [];
  const handler = createHandler({
    githubFetcher: async () => {
      calls += 1;
      if (calls === 1) {
        throw { response: { status: 429, headers: { "retry-after": "2" } } };
      }
      return { login: "octocat" };
    },
    renderer: async () => "<svg />",
    maxRetries: 2,
    retryDelay: 10,
    sleep: async (delay) => delays.push(delay),
  });
  const res = response();

  await handler(
    { params: { action: "github-status" }, query: { username: "octocat" } },
    res,
  );

  assert.equal(calls, 2);
  assert.deepEqual(delays, [2_000]);
});

test("returns 504 when a retry delay would exceed the request deadline", async () => {
  const handler = createHandler({
    githubFetcher: async () => {
      throw { response: { status: 503 } };
    },
    maxRetries: 3,
    retryDelay: 100,
    deadlineMs: 50,
    random: () => 1,
    sleep: async () => assert.fail("deadline must prevent a retry"),
  });
  const res = response();

  await handler(
    { params: { action: "github-status" }, query: { username: "octocat" } },
    res,
  );

  assert.deepEqual(
    [res.statusCode, res.body],
    [504, "Upstream service temporarily unavailable"],
  );
});

test("identifies only allowed HTTP statuses and network errors as retryable", () => {
  assert.equal(isRetryableError({ response: { status: 502 } }), true);
  assert.equal(isRetryableError({ code: "ECONNRESET" }), true);
  assert.equal(isRetryableError({ response: { status: 401 } }), false);
  assert.equal(
    isRetryableError({
      response: { status: 503, data: { errors: [{ message: "validation" }] } },
    }),
    false,
  );
  assert.equal(isRetryableError(new TypeError("programming mistake")), false);
});
