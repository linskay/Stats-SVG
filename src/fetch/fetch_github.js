import "dotenv/config";
import pLimit from "p-limit";
import { calculateLanguagePercentage } from "../utils/calculateLang.js";
import { calculateRank } from "../utils/calculateRank.js";
import { createSingleFlight, createTtlCache } from "../utils/cache.js";
import {
  createRequestDeadline,
  githubClient,
  upstreamRequest,
} from "./http.js";
import config from "../../config.js";
import NotFound from "../errors/not_found.js";

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GRAPHQL_QUERY_USER_INFO = `
  query userInfo($login: String!) {
    user(login: $login) {
      name
      login
      createdAt
      followers {
        totalCount
      }
      pullRequests {
        totalCount
      }
      repositoryDiscussions {
        totalCount
      }
      repositoryDiscussionComments {
        totalCount
      }
    }
  }
`;

const GRAPHQL_QUERY_REPOSITORIES = `
  query userRepositories($login: String!, $after: String) {
    user(login: $login) {
      repositories(first: 100, after: $after, ownerAffiliations: OWNER, isFork: false, visibility: PUBLIC, orderBy: {field: CREATED_AT, direction: DESC}) {
        pageInfo {
          hasNextPage
          endCursor
        }
        nodes {
          stargazers {
            totalCount
          }
          forkCount
          languages(first: 20, orderBy: {field: SIZE, direction: DESC}) {
            edges {
              size
              node {
                color
                name
              }
            }
          }
        }
      }
      repositoriesContributedTo {
        totalCount
      }
    }
  }
`;

const GRAPHQL_QUERY_CONTRIBUTIONS_CALENDAR = `
  query userContributions($login: String!, $from: DateTime!, $to: DateTime!) {
    user(login: $login) {
      contributionsCollection(from: $from, to: $to) {
        contributionCalendar {
          totalContributions
          weeks {
            contributionDays {
              date
              contributionCount
            }
          }
        }
      }
    }
  }
`;

const GRAPHQL_QUERY_CONTRIBUTIONS_BY_YEAR = `
  query userContributionsByYear($login: String!, $from: DateTime!, $to: DateTime!) {
    user(login: $login) {
      contributionsCollection(from: $from, to: $to) {
        totalCommitContributions
        totalPullRequestContributions
        totalPullRequestReviewContributions
        totalIssueContributions
      }
    }
  }
`;

const cache = createTtlCache({ ttl: 2 * 60 * 1000, maxSize: 100 });
const singleFlight = createSingleFlight();
const ALL_TIME_CONTRIBUTIONS_CONCURRENCY = 3;

function graphqlErrorMessage(errors) {
  return errors
    .map((error) => error.message)
    .filter(Boolean)
    .join("; ");
}

function isRateLimitGraphqlError(errors) {
  return errors.some(
    (error) =>
      error.type === "RATE_LIMITED" || /rate limit/i.test(error.message),
  );
}

function isValidationGraphqlError(errors) {
  return errors.some((error) =>
    /validation|syntax|unknown argument|unknown field|variable/i.test(
      `${error.type ?? ""} ${error.message ?? ""}`,
    ),
  );
}

function isTemporaryGraphqlError(errors) {
  return errors.some((error) =>
    /internal|temporary|service unavailable|something went wrong/i.test(
      `${error.type ?? ""} ${error.message ?? ""}`,
    ),
  );
}

function isAuthorizationGraphqlError(errors) {
  return errors.some((error) =>
    /forbidden|unauthorized/i.test(
      `${error.type ?? ""} ${error.message ?? ""}`,
    ),
  );
}

/**
 * GitHub can return GraphQL failures with HTTP 200. Convert these responses
 * to typed errors before callers consume partial response data.
 */
export function validateGitHubGraphqlResponse(response, username) {
  const errors = response.data?.errors;
  if (Array.isArray(errors) && errors.length > 0) {
    const message =
      graphqlErrorMessage(errors) || "GitHub GraphQL request failed";
    const status = isRateLimitGraphqlError(errors)
      ? 429
      : isValidationGraphqlError(errors)
        ? 400
        : isTemporaryGraphqlError(errors)
          ? 503
          : isAuthorizationGraphqlError(errors)
            ? 403
            : 502;
    throw new UpstreamRequestError(message, { status, errors });
  }

  if (response.data?.data?.user === null) {
    throw new NotFound(`GitHub user ${username} not found`);
  }

  return response;
}

function getCacheKey(username) {
  return `github:${username.trim().toLowerCase()}`;
}

async function fetchGitHubDataUncached(username) {
  console.log("Fetching data for", username);

  const cacheKey = getCacheKey(username);
  const cachedData = cache.get(cacheKey);
  if (cachedData) return cachedData;

  const url = "https://api.github.com/graphql";
  const headers = {
    Authorization: `bearer ${GITHUB_TOKEN}`,
    "Content-Type": "application/json",
  };

  const now = new Date();
  const fromDate = new Date(now);
  fromDate.setDate(
    now.getDate() - config.contribution_distribution.days_to_show + 1,
  );

  const deadline = createRequestDeadline();
  const request = async (data) => {
    const response = await upstreamRequest(
      githubClient,
      { method: "post", url, data, headers },
      deadline,
      "GitHub API",
    );
    return validateGitHubGraphqlResponse(response, username);
  };

  try {
    console.time("GitHub API calls");

    const fetchUserInfo = async () => {
      const response = await request({
        query: GRAPHQL_QUERY_USER_INFO,
        variables: { login: username },
      });
      return response.data?.data?.user;
    };

    const fetchRepositories = async () => {
      const allRepositories = [];
      let repositoriesContributedTo;
      let hasNextPage = true;
      let after = null;

      while (hasNextPage) {
        const response = await request({
          query: GRAPHQL_QUERY_REPOSITORIES,
          variables: { login: username, after },
        });

        const data = response.data?.data?.user;

        if (!data) {
          throw new Error("No user data returned from GitHub API");
        }

        allRepositories.push(...data.repositories.nodes);
        repositoriesContributedTo = data.repositoriesContributedTo;
        hasNextPage = data.repositories.pageInfo.hasNextPage;
        after = data.repositories.pageInfo.endCursor;
      }

      return {
        repositories: { nodes: allRepositories },
        repositoriesContributedTo,
      };
    };

    async function fetchContributionsCalendar(username, fromDate, toDate) {
      const startDate = new Date(fromDate);
      const endDate = new Date(toDate);

      // Check if the date period is greater than 1 year
      const isMoreThanOneYear = endDate - startDate > 365 * 24 * 60 * 60 * 1000;

      if (isMoreThanOneYear) {
        const limit = pLimit(ALL_TIME_CONTRIBUTIONS_CONCURRENCY);
        const promises = [];

        // Separate the date range by year
        for (
          let year = startDate.getFullYear();
          year <= endDate.getFullYear();
          year++
        ) {
          const yearStartDate = new Date(year, 0, 1); // January 1st of the current year
          const yearEndDate = new Date(year, 11, 31); // December 31st of the current year

          // Adjust the start and end dates if they fall outside the specified range
          const from = yearStartDate < startDate ? startDate : yearStartDate;
          const to = yearEndDate > endDate ? endDate : yearEndDate;

          // Create a promise for the current year range
          promises.push(
            limit(() => fetchContributionsForYear(request, username, from, to)),
          );
        }

        // Wait for all promises to resolve
        const results = await Promise.all(promises);

        // Combine results
        const combinedResult = results.reduce((acc, curr) => {
          for (const date in curr) {
            if (!acc[date]) {
              acc[date] = { total: 0 };
            }
            acc[date].total += curr[date].total;
          }
          return acc;
        }, {});

        // Log the length of the combined result
        console.log(Object.keys(combinedResult).length);
        return combinedResult;
      } else {
        // If the period is 1 year or less, run a normal query
        return fetchContributionsForYear(request, username, startDate, endDate);
      }
    }

    const [userInfo, repositories, contributionsCalendar] = await Promise.all([
      fetchUserInfo(),
      fetchRepositories(),
      fetchContributionsCalendar(username, fromDate, now),
    ]);

    console.timeEnd("GitHub API calls");

    if (!userInfo) throw new NotFound(`GitHub user ${username} not found`);

    // Fetch all-time contributions in parallel
    console.time("Fetching all-time contributions");
    const allTimeContributions = await fetchAllTimeContributions(
      request,
      username,
      userInfo.createdAt,
    );
    console.timeEnd("Fetching all-time contributions");

    console.time("Data Processing");

    const stats = {
      login: userInfo.login,
      name: userInfo.name || userInfo.login,
      followers: userInfo.followers?.totalCount || 0,
      total_commits: allTimeContributions.commits,
      total_prs: allTimeContributions.prs,
      total_prs_reviewed: allTimeContributions.reviews,
      total_issues: allTimeContributions.issues,
      total_merged_prs: userInfo.pullRequests?.totalCount || 0,
      total_repos: repositories.repositories?.nodes?.length || 0,
      total_stars:
        repositories.repositories?.nodes?.reduce(
          (acc, repo) => acc + (repo.stargazers?.totalCount || 0),
          0,
        ) || 0,
      total_forks:
        repositories.repositories?.nodes?.reduce(
          (acc, repo) => acc + (repo.forkCount || 0),
          0,
        ) || 0,
      total_contributes_to: userInfo.repositoriesContributedTo?.totalCount || 0,
      top_languages: calculateTopLanguages(
        repositories.repositories?.nodes || [],
      ),
      total_discussions_started:
        userInfo.repositoryDiscussions?.totalCount || 0,
      total_discussions_answered:
        userInfo.repositoryDiscussionComments?.totalCount || 0,
    };

    stats.merged_prs_percentage = stats.total_prs
      ? Math.min((stats.total_merged_prs / stats.total_prs) * 100, 100)
      : 0;

    stats.rank = calculateRank({
      all_commits: true,
      commits: stats.total_commits,
      prs: stats.total_prs,
      issues: stats.total_issues,
      reviews: stats.total_prs_reviewed,
      repos: stats.total_repos,
      stars: stats.total_stars,
      followers: stats.followers,
    });

    stats.language_percentages = calculateLanguagePercentage(
      stats.top_languages,
    );

    stats.contribution_distribution = await processContributionsCalendar(
      contributionsCalendar,
    );

    console.timeEnd("Data Processing");

    // Cache the results
    cache.set(cacheKey, stats);

    return stats;
  } catch (error) {
    console.error("Error fetching data from GitHub:", error);
    throw error;
  } finally {
    deadline.dispose();
  }
}

function calculateTopLanguages(reposNodes) {
  const languageCounts = {};
  reposNodes.forEach((repo) => {
    repo.languages.edges.forEach(({ size, node }) => {
      if (!languageCounts[node.name]) {
        languageCounts[node.name] = { size: 0, color: node.color, count: 0 };
      }
      languageCounts[node.name].size += size;
      languageCounts[node.name].count += 1;
    });
  });

  return Object.entries(languageCounts)
    .sort(([, a], [, b]) => b.size - a.size)
    .reduce((result, [key, value]) => ({ ...result, [key]: value }), {});
}

// Process contributions calendar in date:{total:value}
async function processContributionsCalendar(contributionsCollection) {
  const result = {};

  // Check if contributionsCollection is a valid object
  if (contributionsCollection && typeof contributionsCollection === "object") {
    // Iterate over the keys (dates) in the contributionsCollection
    for (const date in contributionsCollection) {
      if (contributionsCollection.hasOwnProperty(date)) {
        const total = contributionsCollection[date].total || 0; // Use 0 if total is undefined
        result[date] = { total }; // Store the total contributions for the date
      }
    }
  } else {
    console.warn("Invalid contributionsCollection:", contributionsCollection);
  }

  return result;
}

async function fetchContributionsForYear(request, username, fromDate, toDate) {
  const response = await request({
    query: GRAPHQL_QUERY_CONTRIBUTIONS_CALENDAR,
    variables: {
      login: username,
      from: fromDate.toISOString(),
      to: toDate.toISOString(),
    },
  });

  const contributionsCollection =
    response.data?.data?.user?.contributionsCollection;
  const result = {};

  // Check if contributionsCollection and contributionCalendar exist
  if (contributionsCollection && contributionsCollection.contributionCalendar) {
    for (const week of contributionsCollection.contributionCalendar.weeks) {
      for (const day of week.contributionDays) {
        // Initialize the date entry if it doesn't exist
        if (!result[day.date]) {
          result[day.date] = { total: 0 }; // Initialize total contributions for the date
        }
        // Accumulate contributions for the date
        result[day.date].total += day.contributionCount;
      }
    }
  }

  return result;
}

async function fetchAllTimeContributions(request, username, userCreatedAt) {
  const createdDate = new Date(userCreatedAt);
  const currentDate = new Date();

  const limit = pLimit(ALL_TIME_CONTRIBUTIONS_CONCURRENCY);
  const promises = [];

  for (
    let year = createdDate.getFullYear();
    year <= currentDate.getFullYear();
    year++
  ) {
    // Calculate the start and end dates for each year
    const yearStart = new Date(
      Math.max(new Date(year, 0, 1).getTime(), createdDate.getTime()),
    );

    const yearEnd = new Date(
      Math.min(
        new Date(year, 11, 31, 23, 59, 59).getTime(),
        currentDate.getTime(),
      ),
    );

    // Create a promise for fetching this year's contributions
    promises.push(
      limit(() =>
        request({
          query: GRAPHQL_QUERY_CONTRIBUTIONS_BY_YEAR,
          variables: {
            login: username,
            from: yearStart.toISOString(),
            to: yearEnd.toISOString(),
          },
        }).then((response) => {
          const contributions =
            response.data?.data?.user?.contributionsCollection;
          return {
            commits: contributions?.totalCommitContributions || 0,
            prs: contributions?.totalPullRequestContributions || 0,
            reviews: contributions?.totalPullRequestReviewContributions || 0,
            issues: contributions?.totalIssueContributions || 0,
          };
        }),
      ),
    );
  }

  const yearlyContributions = await Promise.all(promises);

  // Sum up all contributions
  const totals = yearlyContributions.reduce(
    (acc, year) => ({
      commits: acc.commits + year.commits,
      prs: acc.prs + year.prs,
      reviews: acc.reviews + year.reviews,
      issues: acc.issues + year.issues,
    }),
    { commits: 0, prs: 0, reviews: 0, issues: 0 },
  );

  console.log(
    `Fetched contributions for ${promises.length} years with concurrency ${ALL_TIME_CONTRIBUTIONS_CONCURRENCY}`,
  );
  return totals;
}

function fetchGitHubData(username) {
  const cacheKey = getCacheKey(username);
  const cachedData = cache.get(cacheKey);
  if (cachedData) return Promise.resolve(cachedData);

  return singleFlight(cacheKey, () => fetchGitHubDataUncached(username));
}

export default fetchGitHubData;
