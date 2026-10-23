"use strict";
// NetEase metadata and authorized audio. Account cookies stay on the server; no unlocking.
const HEADERS = { Referer: "https://music.163.com/", "User-Agent": "Mozilla/5.0" };
class NeteaseError extends Error {
  constructor(message, status = 502) { super(message); this.status = status; }
}
function parsePlaylistId(input) {
  const value = String(input || "").trim();
  if (/^[1-9]\d{0,15}$/.test(value)) return value;
  let url;
  try { url = new URL(value); } catch { throw new NeteaseError("请粘贴网易云歌单完整链接或歌单 ID。", 400); }
  if (!["http:", "https:"].includes(url.protocol) || !["music.163.com", "y.music.163.com"].includes(url.hostname) || url.username || url.password || url.port) throw new NeteaseError("仅支持 music.163.com 的歌单链接。", 400);
  const fragment = url.hash.replace(/^#/, "");
  const page = fragment.startsWith("/") ? new URL(fragment, "https://music.163.com") : url;
  const id = page.searchParams.get("id");
  if (!/\/playlist\/?$/.test(page.pathname) || !/^[1-9]\d{0,15}$/.test(id || "")) throw new NeteaseError("这不是有效的歌单链接，请复制歌单的分享链接。", 400);
  return id;
}
function safeMusicUrl(value) {
  const url = new URL(value);
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.port || !(url.hostname === "music.163.com" || /^[a-z0-9-]+\.music\.(126\.net|163\.com)$/.test(url.hostname))) throw new NeteaseError("网易云返回了不支持的音频地址。");
  url.protocol = "https:";
  return url.href;
}
function createNeteaseProvider(options = {}) {
  const fetcher = options.fetch || fetch;
  const cookie = () => typeof options.cookie === "function" ? options.cookie() : options.cookie || "";
  const playlists = new Map(), pending = new Map(), audioCache = new Map();
  let activeLoads = 0, activeChecks = 0;
  async function getJson(url) {
    const r = await fetcher(url, { headers: { ...HEADERS, ...(cookie() ? { Cookie: cookie() } : {}) }, signal: AbortSignal.timeout(12000), redirect: "error" });
    if (!r.ok) throw new NeteaseError("网易云暂时无法访问，请稍后重试。");
    const body = await r.text();
    if (body.length > 5 * 1024 * 1024) throw new NeteaseError("歌单数据过大，请使用较小的歌单。");
    let data; try { data = JSON.parse(body); } catch { throw new NeteaseError("网易云返回的数据无法读取，请稍后重试。"); }
    if (data.code !== 200) {
      if (data.code === 301) { options.onExpired?.(); throw new NeteaseError("网易云登录已失效，请重新扫码登录。", 401); }
      if (data.code === 401) throw new NeteaseError("该歌单已被创建者设置为隐私，请改用公开歌单。", 403);
      throw new NeteaseError(data.code === 404 ? "歌单不存在或已删除。" : "暂时无法读取这份歌单，请确认歌单公开后重试。", data.code === 404 ? 404 : 502);
    }
    return data;
  }
  async function resolvePublicAudio(id) {
    if (!/^[1-9]\d{0,15}$/.test(String(id))) throw new NeteaseError("歌曲 ID 无效。", 400);
    const saved = audioCache.get(String(id));
    if (saved && saved.expires > Date.now()) { if (!saved.url) throw new NeteaseError("网易云暂未提供这首歌的公开播放地址。", 404); return saved.url; }
    if (activeChecks >= 8) throw new NeteaseError("正在检查其他歌曲，请稍后重试。", 429);
    activeChecks++;
    try {
      let url = `https://music.163.com/song/media/outer/url?id=${id}.mp3`;
      for (let redirects = 0; redirects < 5; redirects++) {
        const r = await fetcher(safeMusicUrl(url), { headers: { ...HEADERS, Range: "bytes=0-63" }, redirect: "manual", signal: AbortSignal.timeout(6000) });
        const location = r.headers.get("location"), type = r.headers.get("content-type") || "";
        await r.body?.cancel();
        if ([301, 302, 303, 307, 308].includes(r.status) && location) { url = safeMusicUrl(new URL(location, url).href); continue; }
        if (r.ok && /^audio\//i.test(type)) {
          audioCache.delete(String(id)); audioCache.set(String(id), { url: safeMusicUrl(url), expires: Date.now() + 5 * 60000 });
          while (audioCache.size > 1000) audioCache.delete(audioCache.keys().next().value);
          return safeMusicUrl(url);
        }
        audioCache.set(String(id), { url: null, expires: Date.now() + 60000 });
        while (audioCache.size > 1000) audioCache.delete(audioCache.keys().next().value);
        throw new NeteaseError("网易云暂未提供这首歌的公开播放地址。", 404);
      }
      throw new NeteaseError("音频地址重定向过多，请稍后重试。");
    } finally { activeChecks--; }
  }
  async function resolveAudio(id) {
    if (!cookie()) return resolvePublicAudio(id);
    if (!/^[1-9]\d{0,15}$/.test(String(id))) throw new NeteaseError("歌曲 ID 无效。", 400);
    const key = "account:" + id, saved = audioCache.get(key);
    if (saved && saved.expires > Date.now()) return saved.url;
    try { return await (options.publicProvider?.resolveAudio(id) || resolvePublicAudio(id)); }
    catch (err) { if (err.status === 429) throw err; }
    if (activeChecks >= 8) throw new NeteaseError("正在检查其他歌曲，请稍后重试。", 429);
    activeChecks++;
    try {
      const data = await getJson("https://music.163.com/api/song/enhance/player/url/v1?ids=" + encodeURIComponent(JSON.stringify([String(id)])) + "&level=standard&encodeType=mp3");
      const track = data.data?.find((t) => String(t.id) === String(id));
      if (!track?.url || track.code !== 200 || track.freeTrialInfo) throw new NeteaseError(track?.freeTrialInfo ? "当前账号只能试听，未导入完整歌曲。" : "当前账号暂时没有这首歌的播放权限。", 404);
      const url = safeMusicUrl(track.url);
      audioCache.set(key, { url, expires: Date.now() + Math.min(300, Math.max(30, Number(track.expi) || 300)) * 1000 });
      while (audioCache.size > 1000) audioCache.delete(audioCache.keys().next().value);
      return url;
    } finally { activeChecks--; }
  }
  async function load(id) {
    const detail = await getJson(`https://music.163.com/api/v6/playlist/detail?id=${id}&n=1000&s=0`);
    const p = detail.playlist;
    if (!p || !Array.isArray(p.tracks)) throw new NeteaseError("这份歌单暂时无法读取。");
    const ids = [...new Set((p.trackIds?.length ? p.trackIds : p.tracks).map((t) => String(t.id)).filter((v) => /^[1-9]\d{0,15}$/.test(v)))].slice(0, 200);
    const songs = new Map(p.tracks.map((t) => [String(t.id), t]));
    const missing = ids.filter((id) => !songs.has(id));
    for (let i = 0; i < missing.length; i += 100) {
      const chunk = missing.slice(i, i + 100);
      const result = await getJson("https://music.163.com/api/v3/song/detail?c=" + encodeURIComponent(JSON.stringify(chunk.map((id) => ({ id })))) + "&ids=" + encodeURIComponent(JSON.stringify(chunk)));
      for (const song of result.songs || []) songs.set(String(song.id), song);
    }
    const tracks = ids.map((id) => {
      const t = songs.get(id);
      return { id, name: String(t?.name || "歌曲暂不可用").slice(0, 180), artist: (t?.ar || t?.artists || []).map((a) => a.name).join(" / ").slice(0, 240), duration: Math.min(43200, Math.max(0, Number(t?.dt || t?.duration || 0) / 1000)), fee: t?.fee, available: false, reason: "", link: `https://music.163.com/song?id=${id}` };
    });
    const deadline = Date.now() + 45000;
    let cursor = 0;
    await Promise.all(Array.from({ length: Math.min(3, tracks.length) }, async () => {
      while (cursor < tracks.length) {
        const t = tracks[cursor++];
        if (!t.duration) { t.reason = "歌曲资料暂不可用"; continue; }
        if (!cookie() && (t.fee === 1 || t.fee === 4)) { t.reason = "请登录网易云后按账号权限重新检查"; continue; }
        if (Date.now() > deadline) { t.reason = "检查超时，可稍后重试"; continue; }
        try { await resolveAudio(t.id); t.available = true; t.requiresLogin = Boolean(cookie() && audioCache.has("account:" + t.id)); }
        catch (err) { if (err.status === 401) throw err; t.reason = err.status === 404 ? err.message : "暂时连接失败，可稍后重试"; }
      }
    }));
    const result = { id, authenticated: Boolean(cookie()), name: String(p.name || "网易云歌单").slice(0, 180), total: Math.max(Number(p.trackCount) || ids.length, ids.length), checked: tracks.length, available: tracks.filter((t) => t.available).length, tracks: tracks.map(({ fee, ...t }) => t), checkedAt: new Date().toISOString() };
    playlists.delete(id); playlists.set(id, { data: result, expires: Date.now() + (tracks.some((t) => /重试/.test(t.reason)) ? 30000 : 10 * 60000) });
    while (playlists.size > 8) playlists.delete(playlists.keys().next().value);
    return result;
  }
  async function getPlaylist(input) {
    const id = parsePlaylistId(input), saved = playlists.get(id);
    if (saved && saved.expires > Date.now()) return saved.data;
    if (pending.has(id)) return pending.get(id);
    if (activeLoads >= 1) throw new NeteaseError("正在检查另一份歌单，请稍后再试。", 429);
    activeLoads++;
    const operation = load(id).catch((err) => { if (err instanceof NeteaseError) throw err; throw new NeteaseError("连接网易云超时，请稍后重试。"); }).finally(() => { activeLoads--; pending.delete(id); });
    pending.set(id, operation);
    return operation;
  }
  return { getPlaylist, resolveAudio };
}
module.exports = { createNeteaseProvider, parsePlaylistId, safeMusicUrl, NeteaseError };
