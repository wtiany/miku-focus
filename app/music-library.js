/* Source collections contain references to songs; the play queue is stored separately. */
(function (root) {
  "use strict";
  class MusicLibrary {
    constructor(saved) {
      this.songs = new Map();
      this.groups = [{ id: "local", name: "本地导入", source: "local", songIds: [] }];
      if (saved?.version === 2 && Array.isArray(saved.playlists)) for (const p of saved.playlists) {
        if (p && Array.isArray(p.tracks) && (/^[1-9]\d{0,15}$/.test(String(p.id)) || p.id === "legacy")) this.importNetease({ id: p.id, name: p.name, tracks: p.tracks.map(t => ({ ...t, available: true, requiresLogin: Boolean(t?.requiresLogin) })) });
      }
    }
    group(id) { return this.groups.find(p => p.id === id); }
    groupSongs(id) { return (this.group(id)?.songIds || []).map(id => this.songs.get(id)).filter(Boolean); }
    addLocal(track) {
      if (!track?.id?.startsWith("local:")) throw new Error("本地歌曲标识无效");
      this.songs.set(track.id, track);
      const group = this.group("local"); if (!group.songIds.includes(track.id)) group.songIds.push(track.id);
    }
    importNetease(data) {
      const playlistId = String(data.id || "legacy");
      if (!/^[1-9]\d{0,15}$/.test(playlistId) && playlistId !== "legacy") throw new Error("歌单 ID 无效");
      const groupId = "netease:" + playlistId;
      let group = this.group(groupId);
      if (!group) { group = { id: groupId, playlistId, source: "netease", name: "", songIds: [] }; this.groups.push(group); }
      group.name = String(data.name || "以前导入的网易云音乐").slice(0, 180);
      let added = 0;
      for (const item of (Array.isArray(data.tracks) ? data.tracks : [])) {
        if (!item) continue;
        const neteaseId = String(item.id);
        if (!item.available || !/^[1-9]\d{0,15}$/.test(neteaseId)) continue;
        const id = "netease-song:" + neteaseId;
        const fields = { id, source: "netease", neteaseId, name: String(item.name || "网易云歌曲").slice(0, 180), artist: String(item.artist || "").slice(0, 240), dur: Math.min(43200, Math.max(0, Number(item.duration) || 0)), requiresLogin: Boolean(item.requiresLogin), url: `/api/netease/audio/${neteaseId}` };
        const existing = this.songs.get(id);
        if (existing) Object.assign(existing, fields); else this.songs.set(id, fields);
        if (!group.songIds.includes(id)) { group.songIds.push(id); added++; }
      }
      return { added, capacitySkipped: 0, groupId };
    }
    removeFromGroup(groupId, songId) {
      const group = this.group(groupId); if (!group) return [];
      const candidates = songId ? group.songIds.filter(id => id === songId) : group.songIds.slice();
      group.songIds = songId ? group.songIds.filter(id => id !== songId) : [];
      if (!songId && group.source !== "local") this.groups = this.groups.filter(p => p !== group);
      const orphaned = candidates.filter(id => !this.groups.some(p => p.songIds.includes(id))).map(id => this.songs.get(id)).filter(Boolean);
      for (const song of orphaned) this.songs.delete(song.id);
      return orphaned;
    }
    serialize() {
      const playlists = [];
      for (const group of this.groups.filter(p => p.source === "netease")) {
        const tracks = this.groupSongs(group.id).map(t => ({ id: t.neteaseId, name: t.name, artist: t.artist, duration: t.dur, requiresLogin: Boolean(t.requiresLogin) }));
        playlists.push({ id: group.playlistId, name: group.name, tracks });
      }
      return { version: 2, playlists };
    }
    queueIds(queue) { return queue.map(t => t.id); }
    restoreQueue(ids) { return [...new Set(Array.isArray(ids) ? ids.filter(id => typeof id === "string") : [])].map(id => this.songs.get(id)).filter(Boolean); }
  }
  if (typeof module === "object" && module.exports) module.exports = { MusicLibrary };
  else root.MikuMusic = { MusicLibrary };
})(globalThis);
