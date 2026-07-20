import axios from 'axios';
import 'dotenv/config';
import { calculateLanguagePercentage } from '../utils/calculateLang.js';
import { calculateRank } from '../utils/calculateRank.js';
import pkg from 'http2-wrapper';

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

const cache = new Map();
const CACHE_TTL = 2 * 60 * 1000;

async function fetchGitHubData(username) {
  console.log('Fetching data for', username);

  const cachedData = cache.get(username);
  if (cachedData && Date.now() - cachedData.timestamp < CACHE_TTL) {
    return cachedData.data;
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

    cache.set(username, { data: stats, timestamp: Date.now() });
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

export default fetchGitHubData;
