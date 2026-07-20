import assert from "node:assert/strict";
import test from "node:test";
import NotFound from "../src/errors/not_found.js";
import fetchLeetCodeStats from "../src/fetch/fetch_leetcode.js";
import { leetcodeClient } from "../src/fetch/http.js";

test("returns a typed 404 error when LeetCode does not find the user", async () => {
  const originalAdapter = leetcodeClient.defaults.adapter;
  const requests = [];
  leetcodeClient.defaults.adapter = async (config) => {
    requests.push(config);
    const { query } = JSON.parse(config.data);
    const data = query.includes("userPublicProfile")
      ? { matchedUser: null }
      : query.includes("skillStats")
        ? { matchedUser: { tagProblemCounts: {} } }
        : query.includes("languageStats")
          ? { matchedUser: { languageProblemCount: [] } }
          : { userContestRanking: null };

    return { config, data: { data }, headers: {}, status: 200 };
  };

  try {
    await assert.rejects(
      fetchLeetCodeStats("missing-leetcode-user"),
      (error) => {
        assert.ok(error instanceof NotFound);
        assert.equal(error.status, 404);
        assert.deepEqual(error.response, { status: 404 });
        return true;
      },
    );
    assert.equal(requests.length, 4);
    assert.ok(
      requests.every(
        (request) =>
          request.method === "post" &&
          request.url === "https://leetcode.com/graphql",
      ),
    );
  } finally {
    leetcodeClient.defaults.adapter = originalAdapter;
  }
});
