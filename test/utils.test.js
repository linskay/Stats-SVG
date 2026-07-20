import assert from "node:assert/strict";
import test from "node:test";
import { calculateLanguagePercentage } from "../src/utils/calculateLang.js";
import { calculateRank } from "../src/utils/calculateRank.js";

test("calculates language percentages using the k-metric and normalizes Jupyter Notebook", () => {
  const languages = calculateLanguagePercentage({
    JavaScript: { size: 100, count: 4, color: "#f1e05a" },
    "Jupyter Notebook": { size: 25, count: 4, color: "#da5b0b" },
  });

  assert.deepEqual(
    languages.map(({ name, percentage }) => [
      name,
      Number(percentage.toFixed(2)),
    ]),
    [
      ["JavaScript", 66.67],
      ["Jupyter", 33.33],
    ],
  );
  assert.deepEqual(
    calculateLanguagePercentage({
      JavaScript: { size: 0, count: 0, color: "#fff" },
    }),
    [],
  );
});

test("calculates rank level and percentile from contribution metrics", () => {
  const emptyRank = calculateRank({ all_commits: true });
  const strongRank = calculateRank({
    all_commits: true,
    commits: 5000,
    prs: 500,
    issues: 250,
    reviews: 100,
    repos: 100,
    stars: 1000,
    followers: 1000,
  });

  assert.deepEqual(emptyRank, { level: "C", percentile: 100 });
  assert.equal(strongRank.level, "A+");
  assert.ok(strongRank.percentile < 12.5);
});
