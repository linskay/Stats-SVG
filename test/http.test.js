import assert from "node:assert/strict";
import test from "node:test";
import {
  createRequestDeadline,
  UpstreamRequestError,
  upstreamRequest,
} from "../src/fetch/http.js";

test("maps an upstream request timeout to a temporary-unavailable error", async () => {
  const deadline = createRequestDeadline(1_000);
  const client = {
    defaults: { timeout: 500 },
    request: async () => {
      const error = new Error("timeout");
      error.code = "ECONNABORTED";
      throw error;
    },
  };

  try {
    await assert.rejects(
      upstreamRequest(
        client,
        { method: "get", url: "https://example.test" },
        deadline,
        "Example API",
      ),
      (error) => error instanceof UpstreamRequestError && error.status === 503,
    );
  } finally {
    deadline.dispose();
  }
});

test("deadline aborts an in-flight request and maps it to a gateway timeout", async () => {
  const deadline = createRequestDeadline(10);
  const client = {
    defaults: { timeout: 1_000 },
    request: ({ signal }) =>
      new Promise((_, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      }),
  };

  try {
    await assert.rejects(
      upstreamRequest(
        client,
        { method: "get", url: "https://example.test" },
        deadline,
        "Example API",
      ),
      (error) => error instanceof UpstreamRequestError && error.status === 504,
    );
    assert.equal(deadline.signal.aborted, true);
  } finally {
    deadline.dispose();
  }
});

test("disposing a deadline cancels its scheduled abort", async () => {
  const deadline = createRequestDeadline(10);
  deadline.dispose();
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(deadline.signal.aborted, false);
});
