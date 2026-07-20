import axios from 'axios';
import 'dotenv/config';
import { calculateLanguagePercentage } from '../utils/calculateLang.js';
import { calculateRank } from '../utils/calculateRank.js';
import { createTtlCache } from '../utils/cache.js';
import config from '../../config.js';
import pkg from 'http2-wrapper';
import pLimit from 'p-limit';
const { http2Adapter } = pkg;

const { http2Adapter } = pkg;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const http2Axios = axios.create({ adapter: http2Adapter });

const GRAPHQL_QUERY_USER_INFO = `
  query userInfo($login: String!) {
    user(login: $login) {
      name
      login
      followers {
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

// Add a simple in-memory cache
const cache = new Map();
const CACHE_TTL = 2 * 60 * 1000; // 2 minutes in milliseconds
const ALL_TIME_CONTRIBUTIONS_CONCURRENCY = 3;

async function fetchGitHubData(username) {
  console.log('Fetching data for', username);
  // The API handler validates the login before calling this function.
  const cacheKey = username.toLowerCase();

  const cachedData = cache.get(cacheKey);
  if (cachedData) {
    return cachedData;
  }

  const url = 'https://api.github.com/graphql';
  const headers = {
    Authorization: `bearer ${GITHUB_TOKEN}`,
    'Content-Type': 'application/json'
  };

  try {
    console.time('GitHub API calls');

    const fetchUserInfo = async () => {
      const response = await http2Axios.post(url, { query: GRAPHQL_QUERY_USER_INFO, variables: { login: username } }, { headers });
      return response.data?.data?.user;
    };

    const fetchRepositories = async () => {
      const allRepositories = [];
      let hasNextPage = true;
      let after = null;

      while (hasNextPage) {
        const response = await http2Axios.post(url, {
          query: GRAPHQL_QUERY_REPOSITORIES,
          variables: { login: username, after }
        }, { headers });
        const data = response.data?.data?.user;

        if (!data) {
          throw new Error('No user data returned from GitHub API');
        }

        allRepositories.push(...data.repositories.nodes);
        hasNextPage = data.repositories.pageInfo.hasNextPage;
        after = data.repositories.pageInfo.endCursor;
      }

      return allRepositories;
    };

    const [userInfo, repositories] = await Promise.all([fetchUserInfo(), fetchRepositories()]);
    console.timeEnd('GitHub API calls');

    if (!userInfo) throw new Error(`User ${username} not found`);

    console.time('Data Processing');
    const stats = {
      login: userInfo.login,
      name: userInfo.name || userInfo.login,
      followers: userInfo.followers?.totalCount || 0,
      // Contribution, pull-request, and discussion totals may include private activity.
      // Do not query or expose them from this public endpoint.
      total_commits: 0,
      total_prs: 0,
      total_prs_reviewed: 0,
      total_issues: 0,
      total_merged_prs: 0,
      total_repos: repositories.length,
      total_stars: repositories.reduce((acc, repo) => acc + (repo.stargazers?.totalCount || 0), 0),
      total_forks: repositories.reduce((acc, repo) => acc + (repo.forkCount || 0), 0),
      total_contributes_to: 0,
      top_languages: calculateTopLanguages(repositories),
      total_discussions_started: 0,
      total_discussions_answered: 0,
      contribution_distribution: {}
    };

    stats.merged_prs_percentage = 0;
    stats.rank = calculateRank({
      all_commits: true,
      commits: stats.total_commits,
      prs: stats.total_prs,
      issues: stats.total_issues,
      reviews: stats.total_prs_reviewed,
      repos: stats.total_repos,
      stars: stats.total_stars,
      followers: stats.followers
    });
    stats.language_percentages = calculateLanguagePercentage(stats.top_languages);
    console.timeEnd('Data Processing');

    // Cache the results
    cache.set(cacheKey, stats);

    return stats;
  } catch (error) {
    console.error('Error fetching data from GitHub:', error);
    throw error;
  }
}

function calculateTopLanguages(reposNodes) {
  const languageCounts = {};
  reposNodes.forEach(repo => {
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
  if (contributionsCollection && typeof contributionsCollection === 'object') {
    // Iterate over the keys (dates) in the contributionsCollection
    for (const date in contributionsCollection) {
      if (contributionsCollection.hasOwnProperty(date)) {
        const total = contributionsCollection[date].total || 0; // Use 0 if total is undefined
        result[date] = { total }; // Store the total contributions for the date
      }
    }
  } else {
    console.warn('Invalid contributionsCollection:', contributionsCollection);
  }

  return result;
}

async function fetchContributionsForYear(url, headers, username, fromDate, toDate) {
  const response = await http2Axios.post(url, { 
    query: GRAPHQL_QUERY_CONTRIBUTIONS_CALENDAR, 
    variables: { login: username, from: fromDate.toISOString(), to: toDate.toISOString() } 
  }, { headers });

  const contributionsCollection = response.data?.data?.user?.contributionsCollection;
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

async function fetchAllTimeContributions(url, headers, username, userCreatedAt) {
  const createdDate = new Date(userCreatedAt);
  const currentDate = new Date();
  
  // GitHub's GraphQL API charges a separate query cost for every year. Keep this
  // deliberately small instead of starting one request per account year at once.
  const limit = pLimit(ALL_TIME_CONTRIBUTIONS_CONCURRENCY);
  const requests = [];
  
  for (let year = createdDate.getFullYear(); year <= currentDate.getFullYear(); year++) {
    // Calculate the start and end dates for each year
    const yearStart = new Date(Math.max(
      new Date(year, 0, 1).getTime(),
      createdDate.getTime()
    ));
    
    const yearEnd = new Date(Math.min(
      new Date(year, 11, 31, 23, 59, 59).getTime(),
      currentDate.getTime()
    ));
    
    requests.push(limit(async () => {
      const response = await http2Axios.post(url, {
        query: GRAPHQL_QUERY_CONTRIBUTIONS_BY_YEAR,
        variables: {
          login: username,
          from: yearStart.toISOString(),
          to: yearEnd.toISOString()
        }
      }, { headers });

      if (response.data?.errors?.length) {
        throw new Error(`GitHub GraphQL error for ${year}: ${response.data.errors[0].message}`);
      }

      const contributions = response.data?.data?.user?.contributionsCollection;
      if (!contributions) {
        throw new Error(`GitHub returned no contributions for ${year}`);
      }

      return {
        commits: contributions.totalCommitContributions || 0,
        prs: contributions.totalPullRequestContributions || 0,
        reviews: contributions.totalPullRequestReviewContributions || 0,
        issues: contributions.totalIssueContributions || 0
      };
    }));
  }
  
  // Preserve usable data when an individual year fails, but never turn a wholly
  // failed request into a convincing all-zero result.
  const settledContributions = await Promise.allSettled(requests);
  const failedYears = settledContributions.filter(({ status }) => status === 'rejected');
  const yearlyContributions = settledContributions
    .filter(({ status }) => status === 'fulfilled')
    .map(({ value }) => value);

  if (yearlyContributions.length === 0) {
    throw new AggregateError(
      failedYears.map(({ reason }) => reason),
      'Unable to fetch all-time GitHub contributions'
    );
  }

  if (failedYears.length > 0) {
    console.warn(`Could not fetch contributions for ${failedYears.length} year(s); returning partial totals`);
  }
  
  // Sum up all contributions
  const totals = yearlyContributions.reduce((acc, year) => ({
    commits: acc.commits + year.commits,
    prs: acc.prs + year.prs,
    reviews: acc.reviews + year.reviews,
    issues: acc.issues + year.issues
  }), { commits: 0, prs: 0, reviews: 0, issues: 0 });
  
  console.log(`Fetched contributions for ${yearlyContributions.length}/${requests.length} years with concurrency ${ALL_TIME_CONTRIBUTIONS_CONCURRENCY}`);
  return totals;
}

export default fetchGitHubData;
