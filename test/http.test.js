import assert from "node:assert/strict";
import test from "node:test";
import axios from "axios";
import {
  UpstreamRequestError,
  createRequestDeadline,
  upstreamRequest,
} from "../src/fetch/http.js";

function clientWith(adapter) {
  return axios.create({ timeout: 100, adapter });
}

test("deadline aborts outstanding upstream requests after its timeout", async () => {
  const deadline = createRequestDeadline(10);
  const client = clientWith(
    (config) =>
      new Promise((_, reject) => {
        config.signal.addEventListener("abort", () =>
          reject(config.signal.reason),
        );
      }),
  );

  try {
    await assert.rejects(
      upstreamRequest(
        client,
        { method: "get", url: "https://example.test" },
        deadline,
        "Test API",
      ),
      (error) => error instanceof UpstreamRequestError && error.status === 504,
    );
    assert.equal(deadline.signal.aborted, true);
  } finally {
    deadline.dispose();
  }
});

test("disposing a deadline cancels its timeout timer", async () => {
  const deadline = createRequestDeadline(10);
  deadline.dispose();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(deadline.signal.aborted, false);
});

test("maps a temporary upstream timeout to HTTP 503", async () => {
  const deadline = createRequestDeadline();
  const client = clientWith(async () => {
    const error = new Error("upstream timed out");
    error.code = "ETIMEDOUT";
    throw error;
  });

  try {
    await assert.rejects(
      upstreamRequest(
        client,
        { method: "get", url: "https://example.test" },
        deadline,
        "Test API",
      ),
      (error) => error instanceof UpstreamRequestError && error.status === 503,
    );
  } finally {
    deadline.dispose();
  }
});
