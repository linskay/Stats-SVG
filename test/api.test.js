import assert from "node:assert/strict";
import test from "node:test";
import { createHandler, validateUsername } from "../api/index.js";

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

test("validates username query parameter before accessing upstream services", async () => {
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
  assert.equal(validateUsername("octo-cat"), true);
  assert.equal(validateUsername(["octo-cat"]), false);
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

test("returns 503 when an upstream request is temporarily unavailable", async () => {
  const handler = createHandler({
    githubFetcher: async () => {
      const error = new Error("temporary upstream failure");
      error.status = 503;
      throw error;
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
