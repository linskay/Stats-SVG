import NotFound from "../errors/not_found.js";
import { createTtlCache } from "../utils/cache.js";
import {
  createRequestDeadline,
  leetcodeClient,
  upstreamRequest,
} from "./http.js";

const cache = new Map();
const CACHE_TTL = 2 * 60 * 1000;

async function fetchLeetCodeStats(username) {
  const LEETCODE_API_ENDPOINT = "https://leetcode.com/graphql";

  const skill_query = `
    query skillStats($username: String!) {
        matchedUser(username: $username) {
            tagProblemCounts {
                advanced {
                    tagName
                    tagSlug
                    problemsSolved
                }
                intermediate {
                    tagName
                    tagSlug
                    problemsSolved
                }
                fundamental {
                    tagName
                    tagSlug
                    problemsSolved
                }
            }
        }
    }
  `;

  const language_query = `
    query languageStats($username: String!) {
        matchedUser(username: $username) {
            languageProblemCount {
                languageName
                problemsSolved
            }
        }
    }
  `;

  const contest_query = `
    query userContestRankingInfo($username: String!) {
        userContestRanking(username: $username) {
            attendedContestsCount
            rating
            globalRanking
            topPercentage
            badge {
                name
            }
        }
    }
  `;

  const user_query = `
  query userPublicProfile($username: String!) {
    matchedUser(username: $username) {
      username
      submitStats: submitStatsGlobal {
        acSubmissionNum {
          difficulty
          count
          submissions
        }
        acRate: acSubmissionNum {
          difficulty
          count
        }
      }
      profile {
        ranking
        reputation
        starRating
      }
      badges {
        id
        displayName
        icon
      }
      upcomingBadges {
        name
        icon
      }
      activeBadge {
        displayName
      }
    }
  }`;

  // Check if we have cached data
  const cached = cache.get(username);
  if (cached) {
    console.log("Returning cached data for", username);
    return cached;
  }

  console.time("leetcode API calls");
  const deadline = createRequestDeadline();
  const request = (query) =>
    upstreamRequest(
      leetcodeClient,
      {
        method: "post",
        url: LEETCODE_API_ENDPOINT,
        data: { query, variables: { username } },
        headers: {
          "Content-Type": "application/json",
          Referer: "https://leetcode.com",
        },
      },
      deadline,
      "LeetCode API",
    );

  try {
    const [user_data, skill_data, language_data, contest_data] =
      await Promise.all([
        request(user_query),
        request(skill_query),
        request(language_query),
        request(contest_query),
      ]);

    console.timeEnd("leetcode API calls");

    console.time("process leetcode data");
    // Check for errors in the responses
    [user_data, skill_data, language_data, contest_data].forEach((response) => {
      if (response.data.errors) {
        throw new Error(response.data.errors[0].message);
      }
    });

    const user_data_extracted = user_data.data.data.matchedUser;
    const skill_user = skill_data.data.data.matchedUser;
    const language_user = language_data.data.data.matchedUser;
    if (!user_data_extracted || !skill_user || !language_user) {
      throw new NotFound(`LeetCode user ${username} not found`);
    }

    const skill_data_extracted = skill_user.tagProblemCounts;
    const language_data_extracted = language_user.languageProblemCount;
    const contest_data_extracted = contest_data.data.data.userContestRanking;

    const leetcode_stats = {
      username: user_data_extracted.username,
      skills: {
        advanced: skill_data_extracted.advanced.map((skill) => ({
          tag_name: skill.tagName,
          tag_slug: skill.tagSlug,
          problems_solved: skill.problemsSolved,
        })),
        intermediate: skill_data_extracted.intermediate.map((skill) => ({
          tag_name: skill.tagName,
          tag_slug: skill.tagSlug,
          problems_solved: skill.problemsSolved,
        })),
        fundamental: skill_data_extracted.fundamental.map((skill) => ({
          tag_name: skill.tagName,
          tag_slug: skill.tagSlug,
          problems_solved: skill.problemsSolved,
        })),
      },
      //sort languages by problems solved
      languages: language_data_extracted.sort(
        (a, b) => b.problemsSolved - a.problemsSolved,
      ),
      contests: contest_data_extracted
        ? {
            attendedContestsCount:
              contest_data_extracted.attendedContestsCount || 0,
            rating: contest_data_extracted.rating || 0,
            globalRanking: contest_data_extracted.globalRanking || 0,
            topPercentage: contest_data_extracted.topPercentage || 0,
            badge: contest_data_extracted.badge
              ? contest_data_extracted.badge
              : { name: "None" },
          }
        : {
            attendedContestsCount: 0,
            rating: 0,
            globalRanking: 0,
            topPercentage: 0,
            badge: { name: "None" },
          },
    };

    console.timeEnd("process leetcode data");

    // Cache the result
    cache.set(username, { data: leetcode_stats, timestamp: Date.now() });

    return leetcode_stats;
  } catch (error) {
    console.error("Error fetching LeetCode stats:", error);
    throw error;
  } finally {
    deadline.dispose();
  }
}

export default fetchLeetCodeStats;
