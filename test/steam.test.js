import assert from "node:assert/strict";
import test from "node:test";
import axios from "axios";
import fetchSteamStatus from "../src/fetch/fetch_steam.js";

test("returns no playtime percentages when Steam reports zero playtime", async () => {
  const originalGet = axios.get;
  const responses = [
    {
      data: {
        response: {
          players: [
            {
              personaname: "Zero",
              profileurl: "https://steamcommunity.com/id/zero",
              personastate: 0,
              lastlogoff: 0,
              timecreated: 0,
            },
          ],
        },
      },
    },
    { data: { response: { games: [], total_count: 0 } } },
    { data: { response: { games: [], game_count: 0 } } },
    { data: { response: { player_level: 1 } } },
    { data: { response: { avatar: {} } } },
  ];
  axios.get = async () => responses.shift();
  try {
    const stats = await fetchSteamStatus("76561198000000000");
    assert.equal(stats.total_playtime, 0);
    assert.deepEqual(stats.playtime_percentage_list, []);
  } finally {
    axios.get = originalGet;
  }
});
