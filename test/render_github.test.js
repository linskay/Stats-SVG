import assert from 'node:assert/strict';
import test from 'node:test';
import renderStats, { escapeXml, sanitizeHexColor } from '../src/render/render_github.js';

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
    rank: { level: 'A', percentile: 10 },
    language_percentages: [{
      name: maliciousText,
      percentage: 100,
      color: 'url(javascript:alert(1))',
    }],
    contribution_distribution: {
      '2026-01-01': { total: 1 },
      '2026-01-02': { total: 2 },
    },
    ...overrides,
  };
}

test('escapeXml escapes all XML-sensitive characters', () => {
  assert.equal(escapeXml('&<>"\''), '&amp;&lt;&gt;&quot;&apos;');
});

test('renderStats keeps hostile names and language labels as SVG text', async () => {
  const svg = await renderStats(createStats());
  const escapedText = '&lt;/text&gt;&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;';

  assert.match(svg, new RegExp(escapedText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.doesNotMatch(svg, /<script[\s>]/i);
  assert.doesNotMatch(svg, /<\/text><script/i);
  assert.ok(svg.includes(`https://github.com/${encodeURIComponent(maliciousText)}`));
});

test('renderStats replaces invalid language colors with a safe hex color', async () => {
  const svg = await renderStats(createStats());

  assert.equal(sanitizeHexColor('url(javascript:alert(1))'), '#cccccc');
  assert.doesNotMatch(svg, /url\(javascript:alert\(1\)\)/i);
  assert.match(svg, /(?:stroke|fill)="#cccccc"/);
});
