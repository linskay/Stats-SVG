import assert from "node:assert/strict";
import test from "node:test";
import renderStats from "../src/render/render_github.js";

test("escapes user and language text rendered into SVG", async () => {
  const svg = await renderStats({
    name: "<script>alert(1)</script>",
    login: "octocat",
    total_stars: 0,
    total_forks: 0,
    followers: 0,
    total_commits: 0,
    total_issues: 0,
    total_prs: 0,
    total_merged_prs: 0,
    total_prs_reviewed: 0,
    merged_prs_percentage: 0,
    total_repos: 0,
    total_contributes_to: 0,
    total_discussions_started: 0,
    total_discussions_answered: 0,
    rank: { level: "C", percentile: 100 },
    language_percentages: [
      { name: "<img src=x>", percentage: 100, color: "#fff" },
    ],
    contribution_distribution: { "2026-01-01": { total: 0 } },
  });
  assert.ok(svg.includes("&lt;script&gt;alert(1)&lt;/script&gt;"));
  assert.ok(svg.includes("&lt;img src=x&gt;"));
  assert.equal(svg.includes("<script>alert(1)</script>"), false);
});
