import assert from "node:assert/strict";
import test from "node:test";
import fetchGitHubData from "../src/fetch/fetch_github.js";
import { githubClient } from "../src/fetch/http.js";

test("builds GitHub statistics for a user from the shared HTTP client", async () => {
  const originalAdapter = githubClient.defaults.adapter;
  const queries = [];
  githubClient.defaults.adapter = async (config) => {
    const { query } = JSON.parse(config.data);
    queries.push(query);

    if (query.includes("query userInfo")) {
      return {
        config,
        data: {
          data: {
            user: {
              name: "Test Octocat",
              login: "test-octocat",
              createdAt: new Date().toISOString(),
              followers: { totalCount: 7 },
              pullRequests: { totalCount: 5 },
              repositoryDiscussions: { totalCount: 3 },
              repositoryDiscussionComments: { totalCount: 4 },
              repositoriesContributedTo: { totalCount: 6 },
            },
          },
        },
      };
    }

    if (query.includes("query userRepositories")) {
      return {
        config,
        data: {
          data: {
            user: {
              repositories: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [
                  {
                    stargazers: { totalCount: 11 },
                    forkCount: 2,
                    languages: {
                      edges: [
                        {
                          size: 10,
                          node: { color: "#f1e05a", name: "JavaScript" },
                        },
                      ],
                    },
                  },
                ],
              },
            },
          },
        },
      };
    }

    if (query.includes("query userContributionsByYear")) {
      return {
        config,
        data: {
          data: {
            user: {
              contributionsCollection: {
                totalCommitContributions: 20,
                totalPullRequestContributions: 10,
                totalPullRequestReviewContributions: 8,
                totalIssueContributions: 6,
              },
            },
          },
        },
      };
    }

    return {
      config,
      data: {
        data: {
          user: {
            contributionsCollection: {
              contributionCalendar: {
                weeks: [
                  {
                    contributionDays: [
                      { date: "2026-07-01", contributionCount: 9 },
                    ],
                  },
                ],
              },
            },
          },
        },
      },
    };
  };

  try {
    const stats = await fetchGitHubData("Test-Octocat");

    assert.deepEqual(
      {
        login: stats.login,
        name: stats.name,
        followers: stats.followers,
        commits: stats.total_commits,
        prs: stats.total_prs,
        reviews: stats.total_prs_reviewed,
        issues: stats.total_issues,
        mergedPrs: stats.total_merged_prs,
        repositories: stats.total_repos,
        stars: stats.total_stars,
        forks: stats.total_forks,
        contributedTo: stats.total_contributes_to,
        discussionsStarted: stats.total_discussions_started,
        discussionsAnswered: stats.total_discussions_answered,
        distribution: stats.contribution_distribution,
      },
      {
        login: "test-octocat",
        name: "Test Octocat",
        followers: 7,
        commits: 20,
        prs: 10,
        reviews: 8,
        issues: 6,
        mergedPrs: 5,
        repositories: 1,
        stars: 11,
        forks: 2,
        contributedTo: 6,
        discussionsStarted: 3,
        discussionsAnswered: 4,
        distribution: { "2026-07-01": { total: 9 } },
      },
    );
    assert.ok(queries.some((query) => query.includes("createdAt")));
  } finally {
    githubClient.defaults.adapter = originalAdapter;
  }
});
