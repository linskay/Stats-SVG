import "dotenv/config";
import { createTtlCache } from "../utils/cache.js";
import { createRequestDeadline, steamClient, upstreamRequest } from "./http.js";

const steamApiBaseUrl = "https://api.steampowered.com/";
const steamCDNBaseUrl =
  "https://steamcdn-a.akamaihd.net/steamcommunity/public/images/";
const cache = createTtlCache({ ttl: 2 * 60 * 1000, maxSize: 100 });

export const buildSteamApiUrl = (path, apiKey, parameters = {}) => {
  const url = new URL(path, steamApiBaseUrl);
  url.searchParams.set("key", apiKey);
  url.searchParams.set("format", "json");
  for (const [name, value] of Object.entries(parameters)) {
    url.searchParams.set(name, value);
  }
  return url.toString();
};

function createNotFoundError(steamID) {
  const error = new Error(`Steam profile ${steamID} not found`);
  error.response = { status: 404 };
  return error;
}

const fetchSteamStatus = async (steamID) => {
  const cachedData = cache.get(steamID);
  if (cachedData) return cachedData;

  const apiKey = process.env.STEAM_API_KEY;
  const urls = {
    userProfile: buildSteamApiUrl(
      "ISteamUser/GetPlayerSummaries/v0002/",
      apiKey,
      {
        steamids: steamID,
      },
    ),
    recentGames: buildSteamApiUrl(
      "IPlayerService/GetRecentlyPlayedGames/v0001/",
      apiKey,
      { steamid: steamID },
    ),
    ownedGames: buildSteamApiUrl(
      "IPlayerService/GetOwnedGames/v0001/",
      apiKey,
      {
        steamid: steamID,
        include_played_free_games: true,
      },
    ),
    badges: buildSteamApiUrl("IPlayerService/GetBadges/v1/", apiKey, {
      steamid: steamID,
    }),
    animatedAvatar: buildSteamApiUrl(
      "IPlayerService/GetAnimatedAvatar/v1/",
      apiKey,
      { steamid: steamID },
    ),
  };
  const deadline = createRequestDeadline();

  try {
    const request = (url) =>
      upstreamRequest(
        steamClient,
        { method: "get", url },
        deadline,
        "Steam API",
      );
    const [
      userProfileResponse,
      recentGamesResponse,
      ownedGamesResponse,
      badgesResponse,
      animatedAvatarResponse,
    ] = await Promise.all([
      request(urls.userProfile),
      request(urls.recentGames),
      request(urls.ownedGames),
      request(urls.badges),
      request(urls.animatedAvatar),
    ]);

    const userProfileData = userProfileResponse.data.response.players?.[0];
    if (!userProfileData) throw createNotFoundError(steamID);

    const recentGamesData = recentGamesResponse.data.response.games || [];
    const ownedGamesData = ownedGamesResponse.data.response.games || [];
    const animatedAvatarData =
      animatedAvatarResponse.data.response.avatar || {};
    const totalPlaytime = ownedGamesData.reduce(
      (total, game) => total + (game.playtime_forever || 0),
      0,
    );
    const platformPlaytimes = {
      windows: "playtime_windows_forever",
      mac: "playtime_mac_forever",
      linux: "playtime_linux_forever",
      deck: "playtime_deck_forever",
    };
    const playtimesByPlatform = Object.fromEntries(
      Object.entries(platformPlaytimes).map(([platform, playtimeKey]) => [
        platform,
        ownedGamesData.reduce(
          (total, game) => total + (game[playtimeKey] || 0),
          0,
        ),
      ]),
    );
    const knownPlaytime = Object.values(playtimesByPlatform).reduce(
      (sum, playtime) => sum + playtime,
      0,
    );
    const unknownPlaytime = totalPlaytime - knownPlaytime;
    if (unknownPlaytime > 0) playtimesByPlatform.unknown = unknownPlaytime;

    const totalPlaytimeList = Object.entries(playtimesByPlatform)
      .map(([platform, playtime]) => ({ [platform]: playtime }))
      .sort((a, b) => Object.values(b)[0] - Object.values(a)[0]);
    const steamData = {
      username: userProfileData.personaname,
      avatar: `${steamCDNBaseUrl}${animatedAvatarData.image_small || ""}`,
      profile_url: userProfileData.profileurl,
      user_status:
        [
          "Offline",
          "Online",
          "Busy",
          "Away",
          "Snooze",
          "Looking to trade",
          "Looking to play",
        ][userProfileData.personastate] || "Unknown",
      last_logoff: userProfileData.lastlogoff,
      created: userProfileData.timecreated,
      steam_level: badgesResponse.data.response.player_level,
      recent_played_games: recentGamesData,
      recent_played_games_count: recentGamesResponse.data.response.total_count,
      total_owned_games: ownedGamesResponse.data.response.game_count,
      total_playtime: totalPlaytime,
      total_playtime_list: totalPlaytimeList,
      playtime_percentage_list:
        totalPlaytime === 0
          ? []
          : totalPlaytimeList
              .map((item) => {
                const [platform, playtime] = Object.entries(item)[0];
                return {
                  [platform]: Number(
                    ((playtime / totalPlaytime) * 100).toFixed(5),
                  ),
                };
              })
              .filter((item) => Object.values(item)[0] > 0),
    };

    cache.set(steamID, steamData);
    return steamData;
  } finally {
    deadline.dispose();
  }
};

export default fetchSteamStatus;
