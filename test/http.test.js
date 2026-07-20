import assert from "node:assert/strict";
import test from "node:test";
import {
  createRequestDeadline,
  UpstreamRequestError,
  upstreamRequest,
} from "../src/fetch/http.js";

test("aborts every parallel upstream request when the deadline expires", async () => {
  const deadline = createRequestDeadline(20);
  const signals = [];
  const client = {
    defaults: { timeout: 1_000 },
    request: ({ signal }) =>
      new Promise((_, reject) => {
        signals.push(signal);
        signal.addEventListener("abort", () => reject(new Error("aborted")), {
          once: true,
        });
      }),
  };

  try {
    const requests = [
      upstreamRequest(
        client,
        { url: "https://upstream.test/one" },
        deadline,
        "Test",
      ),
      upstreamRequest(
        client,
        { url: "https://upstream.test/two" },
        deadline,
        "Test",
      ),
    ];

    await assert.rejects(Promise.all(requests), (error) => {
      assert.ok(error instanceof UpstreamRequestError);
      assert.equal(error.status, 504);
      return true;
    });
    assert.equal(signals.length, 2);
    assert.ok(
      signals.every((signal) => signal === deadline.signal && signal.aborted),
    );
  } finally {
    deadline.dispose();
  }
});

test("converts an upstream timeout into a temporary-unavailable error", async () => {
  const deadline = createRequestDeadline();
  const client = {
    defaults: { timeout: 1_000 },
    request: async () => {
      const error = new Error("socket timed out");
      error.code = "ETIMEDOUT";
      throw error;
    },
  };

  try {
    await assert.rejects(
      upstreamRequest(
        client,
        { url: "https://upstream.test" },
        deadline,
        "Test",
      ),
      (error) => {
        assert.ok(error instanceof UpstreamRequestError);
        assert.equal(error.status, 503);
        assert.deepEqual(error.response, { status: 503 });
        return true;
      },
    );
  } finally {
    deadline.dispose();
  }
});
