import assert from "node:assert/strict";
import test from "node:test";
import fetchSteamStatus, {
  buildSteamApiUrl,
} from "../src/fetch/fetch_steam.js";
import { steamClient } from "../src/fetch/http.js";

function responseFor(url, { players } = {}) {
  if (url.includes("GetPlayerSummaries")) {
    return { data: { response: { players: players ?? [profile()] } } };
  }
  if (url.includes("GetRecentlyPlayedGames")) {
    return { data: { response: { games: [], total_count: 0 } } };
  }
  if (url.includes("GetOwnedGames")) {
    return { data: { response: { games: [], game_count: 0 } } };
  }
  if (url.includes("GetBadges"))
    return { data: { response: { player_level: 1 } } };
  return { data: { response: { avatar: {} } } };
}

function profile() {
  return {
    personaname: "Zero",
    profileurl: "https://steamcommunity.com/id/zero",
    personastate: 0,
    lastlogoff: 0,
    timecreated: 0,
  };
}

async function withSteamResponses(callback, options) {
  const originalRequest = steamClient.request;
  const requestedUrls = [];
  steamClient.request = async ({ url }) => {
    requestedUrls.push(url);
    return responseFor(url, options);
  };
  try {
    await callback(requestedUrls);
  } finally {
    steamClient.request = originalRequest;
  }
}

test("buildSteamApiUrl creates HTTPS URLs with encoded query parameters", () => {
  const url = buildSteamApiUrl("IPlayerService/GetBadges/v1/", "key value", {
    steamid: "76561198000000000",
  });
  assert.match(url, /^https:\/\/api\.steampowered\.com\//);
  assert.equal(new URL(url).searchParams.get("key"), "key value");
  assert.equal(new URL(url).searchParams.get("format"), "json");
});

test("module can be imported without syntax errors", async () => {
  const module = await import("../src/fetch/fetch_steam.js");
  assert.equal(typeof module.default, "function");
});

test("returns no playtime percentages when Steam reports zero playtime", async () => {
  await withSteamResponses(async (requestedUrls) => {
    const stats = await fetchSteamStatus("76561198000000000");
    assert.equal(stats.total_playtime, 0);
    assert.deepEqual(stats.playtime_percentage_list, []);
    assert.equal(requestedUrls.length, 5);
    assert.ok(requestedUrls.every((url) => new URL(url).protocol === "https:"));
  });
});

test("treats an empty Steam profile response as not found", async () => {
  await withSteamResponses(
    async () => {
      await assert.rejects(fetchSteamStatus("76561198000000001"), {
        response: { status: 404 },
      });
    },
    { players: [] },
  );
});
