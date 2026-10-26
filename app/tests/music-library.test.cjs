"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { MusicLibrary } = require("../music-library.js");
const song = (id, extra = {}) => ({ id, name: `歌曲${id}`, artist: "歌手", duration: 60, available: true, ...extra });
test("source playlists retain shared songs and merge a repeated import without duplicating membership", () => {
  const lib = new MusicLibrary();
  lib.addLocal({ id: "local:one", name: "本地歌曲", source: "local" });
  lib.importNetease({ id: "101", name: "夜间学习", tracks: [song("11"), song("12"), song("99", { available: false })] });
  lib.importNetease({ id: "102", name: "休息音乐", tracks: [song("12"), song("13")] });
  assert.deepEqual(lib.groups.map(g => [g.name, g.songIds.length]), [["本地导入", 1], ["夜间学习", 2], ["休息音乐", 2]]);
  assert.equal(lib.songs.size, 4);
  assert.equal(lib.groupSongs("netease:101")[1], lib.groupSongs("netease:102")[0]);
  assert.equal(lib.importNetease({ id: "101", name: "夜间学习（更新）", tracks: [song("11"), song("14"), song("14")] }).added, 1);
  assert.equal(lib.group("netease:101").name, "夜间学习（更新）");
  assert.equal(lib.groupSongs("netease:101").length, 3);
});
test("queue changes leave collections intact; persisted queue resolves stable song references only", () => {
  const lib = new MusicLibrary();
  lib.importNetease({ id: "101", name: "收藏", tracks: [song("11"), song("12")] });
  const queue = lib.groupSongs("netease:101"); queue.splice(0, 1);
  assert.equal(lib.groupSongs("netease:101").length, 2);
  const restored = new MusicLibrary(JSON.parse(JSON.stringify(lib.serialize())));
  assert.deepEqual(restored.restoreQueue([...lib.queueIds(queue), "missing", "netease-song:12"]).map(t => t.name), ["歌曲12"]);
  assert.deepEqual(restored.restoreQueue([]), []);
});
test("account-only metadata and queue persist without audio URLs or account credentials", () => {
  const lib = new MusicLibrary();
  lib.importNetease({ id: "101", name: "混合歌单", tracks: [song("11"), song("12", { requiresLogin: true })] });
  lib.importNetease({ id: "102", name: "账号歌单", tracks: [song("12", { requiresLogin: true })] });
  const saved = lib.serialize();
  assert.equal(saved.playlists.length, 2); assert.deepEqual(saved.playlists[0].tracks.map(t => t.id), ["11", "12"]);
  assert.deepEqual(lib.queueIds([...lib.songs.values()]), ["netease-song:11", "netease-song:12"]);
  assert.equal(new MusicLibrary(saved).groupSongs("netease:102")[0].requiresLogin, true);
  assert.ok(!JSON.stringify(saved).includes("/api/") && !JSON.stringify(saved).includes("cookie"));
});
test("delete one source preserves shared songs; deleting the last reference removes the song; empty playlists survive reload", () => {
  const lib = new MusicLibrary();
  lib.importNetease({ id: "101", name: "歌单1", tracks: [song("11"), song("12")] });
  lib.importNetease({ id: "102", name: "歌单2", tracks: [song("12")] });
  assert.deepEqual(lib.removeFromGroup("netease:101").map(t => t.neteaseId), ["11"]);
  assert.equal(lib.group("netease:101"), undefined); assert.ok(lib.songs.has("netease-song:12"));
  assert.deepEqual(lib.removeFromGroup("netease:102", "netease-song:12").map(t => t.neteaseId), ["12"]);
  assert.equal(new MusicLibrary(lib.serialize()).group("netease:102").songIds.length, 0);
  lib.addLocal({ id: "local:one", source: "local" }); lib.removeFromGroup("local");
  assert.deepEqual(lib.group("local").songIds, []); assert.equal(lib.songs.size, 0);
});
test("damaged saved entries are ignored without discarding valid source playlists", () => {
  const lib = new MusicLibrary({ version: 2, playlists: [null, { id: "../bad", tracks: [] }, { id: "101", name: "保留歌单", tracks: [null, song("11"), song("invalid")] }] });
  assert.deepEqual(lib.groupSongs("netease:101").map(t => t.neteaseId), ["11"]);
});
