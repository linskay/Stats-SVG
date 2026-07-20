import 'dotenv/config';
import axios from 'axios';
import NotFound from '../errors/not_found.js';

const steamCDNBaseUrl = 'https://steamcdn-a.akamaihd.net/steamcommunity/public/images/';
const steamApiBaseUrl = 'https://api.steampowered.com/';

const buildSteamApiUrl = (path, apiKey, parameters = {}) => {
    const url = new URL(path, steamApiBaseUrl);
    url.search = new URLSearchParams({
        key: apiKey,
        format: 'json',
        ...parameters
    });

    return url.toString();
};

// Add a simple in-memory cache
const cache = new Map();
const CACHE_TTL = 2 * 60 * 1000; // 2 minutes in milliseconds

const fetchSteamStatus = async (steamID) => {
    const apiKey = process.env.STEAM_API_KEY; // Load API key from .env
    const userProfileUrl = buildSteamApiUrl('ISteamUser/GetPlayerSummaries/v0002/', apiKey, { steamids: steamID });
    const recentGamesUrl = buildSteamApiUrl('IPlayerService/GetRecentlyPlayedGames/v0001/', apiKey, { steamid: steamID });
    const ownedGamesUrl = buildSteamApiUrl('IPlayerService/GetOwnedGames/v0001/', apiKey, {
        steamid: steamID,
        include_played_free_games: 'true'
    });
    const badgesUrl = buildSteamApiUrl('IPlayerService/GetBadges/v1/', apiKey, { steamid: steamID });
    const animatedAvatarUrl = buildSteamApiUrl('IPlayerService/GetAnimatedAvatar/v1/', apiKey, { steamid: steamID });

    try {
        // Check if we have cached data
        const cachedData = cache.get(steamID);
        if (cachedData && Date.now() - cachedData.timestamp < CACHE_TTL) {
            console.log('Returning cached data for', steamID);
            return cachedData.data;
        }
        
        console.time('steam API calls');
        // Fetch data concurrently using Promise.all
        const [userProfileResponse, recentGamesResponse, ownedGamesResponse, badgesResponse, animatedAvatarResponse] = await Promise.all([
            axios.get(userProfileUrl),
            axios.get(recentGamesUrl),
            axios.get(ownedGamesUrl),
            axios.get(badgesUrl),
            axios.get(animatedAvatarUrl)
        ]);
        console.timeEnd('steam API calls');

        console.time('process steam data');
        // Extract the necessary data
        const userProfileData = userProfileResponse.data?.response?.players?.[0];

        if (!userProfileData) {
            console.timeEnd('process steam data');
            throw new NotFound(`Steam user ${steamID} not found`);
        }

        const recentGamesResponseData = recentGamesResponse.data?.response || {};
        const ownedGamesResponseData = ownedGamesResponse.data?.response || {};
        const badgesResponseData = badgesResponse.data?.response || {};
        const animatedAvatarData = animatedAvatarResponse.data?.response?.avatar || {};
        const recentGamesData = recentGamesResponseData.games || [];
        const ownedGamesData = ownedGamesResponseData.games || [];

        const steamData = {
            username: userProfileData.personaname,
            avatar: animatedAvatarData.image_small ? `${steamCDNBaseUrl}${animatedAvatarData.image_small}` : '',
            profile_url: userProfileData.profileurl,
            user_status: userProfileData.personastate === 0 ? 'Offline' :
                         userProfileData.personastate === 1 ? 'Online' :
                         userProfileData.personastate === 2 ? 'Busy' :
                         userProfileData.personastate === 3 ? 'Away' :
                         userProfileData.personastate === 4 ? 'Snooze' :
                         userProfileData.personastate === 5 ? 'Looking to trade' :
                         userProfileData.personastate === 6 ? 'Looking to play' :
                         'Unknown',
            last_logoff: userProfileData.lastlogoff,
            created: userProfileData.timecreated,
            steam_level: badgesResponseData.player_level || 0,
            recent_played_games: recentGamesData,
            recent_played_games_count: recentGamesResponseData.total_count || 0,
            total_owned_games: ownedGamesResponseData.game_count || 0,
            total_playtime: ownedGamesData.reduce((total, game) => total + (game.playtime_forever || 0), 0),
            total_playtime_list: []
        };

        const platformPlaytimes = {
            windows: 'playtime_windows_forever',
            mac: 'playtime_mac_forever',
            linux: 'playtime_linux_forever',
            deck: 'playtime_deck_forever'
        };

        const playtimesByPlatform = Object.entries(platformPlaytimes).reduce((acc, [platform, playtimeKey]) => {
            acc[platform] = ownedGamesData.reduce((total, game) => total + (game[playtimeKey] || 0), 0);
            return acc;
        }, {});

        const totalPlaytime = Object.values(playtimesByPlatform).reduce((sum, playtime) => sum + playtime, 0);
        const unknownPlaytime = steamData.total_playtime - totalPlaytime;

        if (unknownPlaytime > 0) {
            playtimesByPlatform.unknown = unknownPlaytime;
        }

        steamData.total_playtime_list = Object.entries(playtimesByPlatform)
            .map(([platform, playtime]) => ({ [platform]: playtime }))
            .sort((a, b) => Object.values(b)[0] - Object.values(a)[0]);

        steamData.playtime_percentage_list = steamData.total_playtime === 0
            ? []
            : steamData.total_playtime_list.map(item => {
                const [platform, playtime] = Object.entries(item)[0];
                return {
                    [platform]: Number(((playtime / steamData.total_playtime) * 100).toFixed(5))
                };
            });

        // Remove platforms with 0 percentage
        steamData.playtime_percentage_list = steamData.playtime_percentage_list.filter(item => Object.values(item)[0] > 0);

        console.timeEnd('process steam data');

        // Cache the data
        cache.set(steamID, { data: steamData, timestamp: Date.now() });

        return steamData;

    } catch (error) {
        console.error(`Error fetching Steam status: ${error.message}`);
        throw error; // Re-throw the error to allow for external error handling
    }
};

export default fetchSteamStatus;
