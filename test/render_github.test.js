import assert from "node:assert/strict";
import test from "node:test";
import renderStats from "../src/render/render_github.js";

const maliciousText = '</text><script>alert("x")</script>';

function createStats(overrides = {}) {
  return {
    login: maliciousText,
    name: maliciousText,
    followers: 1,
    total_commits: 1,
    total_prs: 1,
    total_prs_reviewed: 1,
    total_issues: 1,
    total_merged_prs: 1,
    total_repos: 1,
    total_stars: 1,
    total_forks: 1,
    total_contributes_to: 1,
    total_discussions_started: 1,
    total_discussions_answered: 1,
    merged_prs_percentage: 100,
    rank: { level: "A", percentile: 10 },
    language_percentages: [
      {
        name: maliciousText,
        percentage: 100,
        color: "url(javascript:alert(1))",
      },
    ],
    contribution_distribution: {
      "2026-01-01": { total: 1 },
      "2026-01-02": { total: 2 },
    },
    ...overrides,
  };
}

test("renderStats keeps hostile names and language labels as SVG text", async () => {
  const svg = await renderStats(createStats());
  const escapedText =
    "&lt;/text&gt;&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;";

  assert.match(
    svg,
    new RegExp(escapedText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
  );
  assert.doesNotMatch(svg, /<script[\s>]/i);
  assert.doesNotMatch(svg, /<\/text><script/i);
  assert.ok(
    svg.includes(`https://github.com/${encodeURIComponent(maliciousText)}`),
  );
});

test("renderStats only renders hex language colors", async () => {
  const invalidColors = ["url(javascript:alert(1))", "red;fill:red", ""];
  const validColors = ["#abc", "#abcd", "#aabbcc", "#aabbccdd"];
  const language_percentages = [...invalidColors, ...validColors].map(
    (color, index) => ({
      name: `Language ${index}`,
      percentage: 100 / (invalidColors.length + validColors.length),
      color,
    }),
  );
  const svg = await renderStats(createStats({ language_percentages }));

  for (const color of invalidColors.filter(Boolean)) {
    assert.doesNotMatch(
      svg,
      new RegExp(color.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    );
  }
  assert.equal(
    (svg.match(/stroke="#cccccc"/g) ?? []).length,
    invalidColors.length,
  );

  for (const color of validColors) {
    assert.match(svg, new RegExp(`stroke="${color}"`));
  }
});
