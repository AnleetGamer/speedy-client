/**
 * Anleet social data layer. One interface, two implementations:
 *  - TursoStore (production, libSQL over HTTP — see turso.mjs)
 *  - MemoryStore (development, tests, and graceful degradation when Turso
 *    is unreachable; documented as non-durable)
 * Only lightweight metadata lives here (§57).
 */
import { createTurso, rowsToObjects } from './turso.mjs';
import { newId } from './auth.mjs';

export const DEFAULT_FEATURED_SERVERS = [
  {
    id: 'hypixel',
    name: 'Hypixel Network',
    tag: 'POPULAR',
    tagClass: 'ok',
    ip: 'mc.hypixel.net',
    port: 25565,
    isOfficial: false,
    defaultMotd: 'Hypixel Network [1.8/1.21] · Bedwars, Skyblock, Duels',
    defaultPlayers: '13.5K+ Online',
    iconUrl: '',
    sortOrder: 0,
  },
  {
    id: 'donutsmp',
    name: 'DonutSMP Network',
    tag: 'HARDCORE SMP',
    tagClass: 'ember',
    ip: 'donutsmp.net',
    port: 25565,
    isOfficial: true,
    defaultMotd: 'The #1 Hardcore Survival SMP · Lifesteal, Economy, PvP',
    defaultPlayers: '16.9K+ Online',
    iconUrl: '',
    sortOrder: 1,
  },
  {
    id: 'manacube',
    name: 'ManaCube',
    tag: 'SURVIVAL & PARKOUR',
    tagClass: '',
    ip: 'play.manacube.com',
    port: 25565,
    isOfficial: false,
    defaultMotd: 'Survival, Skyblock, Islands, Olympus, Earth & Parkour',
    defaultPlayers: '1.1K+ Online',
    iconUrl: '',
    sortOrder: 2,
  },
  {
    id: 'cubecraft',
    name: 'CubeCraft Games',
    tag: 'BEDWARS & SKY',
    tagClass: '',
    ip: 'play.cubecraft.net',
    port: 25565,
    isOfficial: false,
    defaultMotd: 'CubeCraft Games · Bedwars, SkyWars, Parkour & Custom Mini-games',
    defaultPlayers: '320+ Online',
    iconUrl: '',
    sortOrder: 3,
  },
];

export const DEFAULT_NEWS_ITEMS = [
  {
    id: 'speedy-announcement-1',
    title: 'Speedy Client 1.21.4 Performance & UI Update',
    tag: 'ANNOUNCEMENT',
    tagClass: 'ok',
    thumbnail: 'https://launchercontent.mojang.com/v1/news/news-header-1.21.4.jpg',
    link: 'https://www.minecraft.net',
    details: 'FastClient performance improvements, updated Fabric support, and modern UI enhancements are now live.',
    date: 'Nov 2026',
    isOfficial: false,
    sortOrder: 0,
    created: Date.now()
  }
];

export function createMemoryStore() {
  const users = new Map();            // id -> user
  const byName = new Map();           // lowercased username -> user
  const friendships = new Set();      // "a|b" sorted
  const requests = new Map();         // id -> request
  const blocks = new Set();
  const conversations = new Map();    // id -> {id,kind,name,created}
  const members = new Map();          // convId -> Set<userId>
  const messages = new Map();         // convId -> [message]
  const presence = new Map();
  const privacy = new Map();
  const notifications = new Map();    // userId -> [n]

  const fk = (a, b) => [a, b].sort().join('|');
  const now = () => Date.now();

  return {
    mode: 'memory',
    async createUser({ username, passHash }) {
      if (byName.has(username.toLowerCase())) throw Object.assign(new Error('username taken'), { code: 'username-taken' });
      const user = { id: newId(), username, passHash, created: now() };
      users.set(user.id, user);
      byName.set(username.toLowerCase(), user);
      return { id: user.id, username };
    },
    async getUserByUsername(username) {
      const u = byName.get(String(username).toLowerCase());
      return u ? { id: u.id, username: u.username, passHash: u.passHash } : null;
    },
    async getUserById(id) {
      const u = users.get(id);
      return u ? { id: u.id, username: u.username } : null;
    },
    async savePresence(userId, payload) { presence.set(userId, { payload, updated: now() }); },
    async getPresence(userId) { return presence.get(userId)?.payload ?? null; },
    async deletePresence(userId) { presence.delete(userId); },
    async getFriendIds(userId) {
      const out = [];
      for (const key of friendships) {
        const [a, b] = key.split('|');
        if (a === userId) out.push(b);
        else if (b === userId) out.push(a);
      }
      return out;
    },
    async areFriends(a, b) { return friendships.has(fk(a, b)); },
    async addFriendship(a, b) { friendships.add(fk(a, b)); },
    async removeFriendship(a, b) { friendships.delete(fk(a, b)); },
    async createRequest({ from, to, message }) {
      for (const r of requests.values()) if (r.from === from && r.to === to) return r;
      const req = { id: newId(), from, to, message: message ?? null, created: now() };
      requests.set(req.id, req);
      return req;
    },
    async getRequest(id) { return requests.get(id) ?? null; },
    async listRequestsFor(userId) {
      return [...requests.values()].filter(r => r.to === userId);
    },
    async deleteRequest(id) { requests.delete(id); },
    async addBlock(a, b) { blocks.add(`${a}|${b}`); },
    async removeBlock(a, b) { blocks.delete(`${a}|${b}`); },
    async isBlockedEither(a, b) { return blocks.has(`${a}|${b}`) || blocks.has(`${b}|${a}`); },
    async listBlocked(userId) {
      const out = [];
      for (const key of blocks) { const [bl, bd] = key.split('|'); if (bl === userId) out.push(bd); }
      return out;
    },
    async createConversation({ kind, name, memberIds }) {
      const conv = { id: newId(), kind, name: name ?? null, created: now() };
      conversations.set(conv.id, conv);
      members.set(conv.id, new Set(memberIds));
      return conv;
    },
    async getConversation(id) { return conversations.get(id) ?? null; },
    async listConversationsFor(userId) {
      const out = [];
      for (const [cid, set] of members) if (set.has(userId)) out.push(conversations.get(cid));
      return out.filter(Boolean);
    },
    async listMemberIds(conversationId) { return [...(members.get(conversationId) ?? [])]; },
    async addMember(conversationId, userId) { members.get(conversationId)?.add(userId); },
    async removeMember(conversationId, userId) { members.get(conversationId)?.delete(userId); },
    async isMember(conversationId, userId) { return !!members.get(conversationId)?.has(userId); },
    async findDirectConversation(a, b) {
      for (const [cid, set] of members) {
        const conv = conversations.get(cid);
        if (conv?.kind === 'direct' && set.has(a) && set.has(b)) return conv;
      }
      return null;
    },
    async addMessage({ conversationId, senderId, body, kind = 'text', meta = null }) {
      const msg = { id: newId(), conversationId, senderId, body, kind, meta, created: now() };
      if (!messages.has(conversationId)) messages.set(conversationId, []);
      messages.get(conversationId).push(msg);
      return msg;
    },
    async listMessages(conversationId, limit = 100) {
      const list = messages.get(conversationId) ?? [];
      return list.slice(-limit);
    },
    async addNotification({ userId, kind, title, body = null }) {
      if (!notifications.has(userId)) notifications.set(userId, []);
      const n = { id: newId(), userId, kind, title, body, ts: now() };
      notifications.get(userId).push(n);
      return n;
    },
    async listNotifications(userId) { return (notifications.get(userId) ?? []).slice(-100).reverse(); },
    async deleteNotification(id) {
      for (const list of notifications.values()) {
        const i = list.findIndex(n => n.id === id);
        if (i >= 0) { list.splice(i, 1); return; }
      }
    },
    async savePrivacy(userId, settings) { privacy.set(userId, JSON.stringify(settings)); },
    async getPrivacy(userId) {
      const raw = privacy.get(userId);
      return raw ? JSON.parse(raw) : null;
    },
    // ---- Speedy Player Tags ----
    async setMinecraftUsername(userId, name) {
      const u = users.get(userId);
      if (u) u.minecraftUsername = name;
    },
    async recordSpeedyPlayer(username, source = 'launcher') {
      if (!username || typeof username !== 'string') return;
      const clean = username.replace(/[^a-zA-Z0-9_]/g, '').trim();
      if (clean.length < 2 || clean.length > 24) return;
      if (!this._speedyPlayers) this._speedyPlayers = new Map();
      this._speedyPlayers.set(clean.toLowerCase(), { username: clean, source, updated_at: Date.now() });
    },
    async listMinecraftUsernames() {
      const merged = new Map();
      for (const u of users.values()) {
        const n = u.minecraftUsername || u.username;
        if (n) merged.set(String(n).toLowerCase(), String(n));
      }
      if (this._speedyPlayers) {
        for (const [k, v] of this._speedyPlayers.entries()) {
          if (v?.username && !merged.has(k)) merged.set(k, v.username);
        }
      }
      return [...merged.values()];
    },
    // ---- Telemetry & Admin Store Methods ----
    async recordTelemetryBatch({ events = [], errors = [], downloads = [] }) {
      if (!this._telemetryEvents) {
        this._telemetryEvents = [];
        this._clientErrors = [];
        this._downloadStats = [];
      }
      const nowTs = Date.now();
      for (const ev of events) {
        this._telemetryEvents.push({ id: newId(), ts: ev.ts || nowTs, ...ev });
      }
      if (this._telemetryEvents.length > 5000) this._telemetryEvents.splice(0, this._telemetryEvents.length - 5000);

      for (const err of errors) {
        this._clientErrors.push({ id: newId(), ts: err.ts || nowTs, ...err });
      }
      if (this._clientErrors.length > 2000) this._clientErrors.splice(0, this._clientErrors.length - 2000);

      for (const dl of downloads) {
        this._downloadStats.push({ id: newId(), ts: dl.ts || nowTs, ...dl });
      }
      if (this._downloadStats.length > 3000) this._downloadStats.splice(0, this._downloadStats.length - 3000);
      return { ok: true, count: events.length + errors.length + downloads.length };
    },
    async getMetricsSummary() {
      const totalUsers = users.size;
      const downloads = this._downloadStats || [];
      const totalDownloads = downloads.length;
      const recentErrors = (this._clientErrors || []).slice(-100).reverse();
      const events = this._telemetryEvents || [];
      const uniqueDevices = new Set(events.map(e => e.deviceId).filter(Boolean)).size;
      return {
        totalUsers,
        totalDownloads,
        totalErrors: (this._clientErrors || []).length,
        totalEvents: events.length,
        totalDevices: uniqueDevices,
        recentErrors,
      };
    },
    async listRecentErrors(limit = 100) {
      return (this._clientErrors || []).slice(-limit).reverse();
    },
    async listAllErrors(limit = 500) {
      return (this._clientErrors || []).slice(-limit).reverse();
    },
    async clearAllErrors() {
      this._clientErrors = [];
      return { ok: true };
    },
    async listRecentDownloads(limit = 50) {
      return (this._downloadStats || []).slice(-limit).reverse();
    },
    // ---- Quick Play Featured Servers (Memory Mode) ----
    async getFeaturedServers() {
      if (!this._featuredServers) {
        this._featuredServers = DEFAULT_FEATURED_SERVERS.map(s => ({ ...s }));
      }
      return this._featuredServers.slice().sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
    },
    async saveFeaturedServers(list) {
      if (Array.isArray(list)) {
        this._featuredServers = list.map((s, idx) => ({
          id: String(s.id || newId()).trim().toLowerCase().replace(/[^a-z0-9_-]/g, '') || newId(),
          name: String(s.name || '').trim(),
          tag: String(s.tag || '').trim(),
          tagClass: String(s.tagClass || '').trim(),
          ip: String(s.ip || '').trim(),
          port: Number(s.port || 25565),
          isOfficial: !!s.isOfficial,
          defaultMotd: String(s.defaultMotd || '').trim(),
          defaultPlayers: String(s.defaultPlayers || '').trim(),
          iconUrl: String(s.iconUrl || '').trim(),
          sortOrder: typeof s.sortOrder === 'number' ? s.sortOrder : idx,
        }));
      }
      return this.getFeaturedServers();
    },
    async addOrUpdateFeaturedServer(srv) {
      if (!this._featuredServers) {
        this._featuredServers = DEFAULT_FEATURED_SERVERS.map(s => ({ ...s }));
      }
      const id = String(srv.id || srv.name || newId()).trim().toLowerCase().replace(/[^a-z0-9_-]/g, '') || newId();
      const existingIdx = this._featuredServers.findIndex(s => s.id === id);
      const item = {
        id,
        name: String(srv.name || '').trim(),
        tag: String(srv.tag || '').trim(),
        tagClass: String(srv.tagClass || '').trim(),
        ip: String(srv.ip || '').trim(),
        port: Number(srv.port || 25565),
        isOfficial: !!srv.isOfficial,
        defaultMotd: String(srv.defaultMotd || '').trim(),
        defaultPlayers: String(srv.defaultPlayers || '').trim(),
        iconUrl: String(srv.iconUrl || '').trim(),
        sortOrder: typeof srv.sortOrder === 'number' ? srv.sortOrder : (existingIdx >= 0 ? this._featuredServers[existingIdx].sortOrder : this._featuredServers.length),
      };
      if (existingIdx >= 0) {
        this._featuredServers[existingIdx] = item;
      } else {
        this._featuredServers.push(item);
      }
      return item;
    },
    async deleteFeaturedServer(id) {
      if (!this._featuredServers) {
        this._featuredServers = DEFAULT_FEATURED_SERVERS.map(s => ({ ...s }));
      }
      this._featuredServers = this._featuredServers.filter(s => s.id !== id);
      return { ok: true };
    },
    async resetFeaturedServers() {
      this._featuredServers = DEFAULT_FEATURED_SERVERS.map(s => ({ ...s }));
      return this.getFeaturedServers();
    },
    // ---- News & Announcements (Memory Mode) ----
    async getNews() {
      if (!this._newsItems) {
        this._newsItems = DEFAULT_NEWS_ITEMS.map(n => ({ ...n }));
      }
      return this._newsItems.slice().sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
    },
    async saveNews(list) {
      if (Array.isArray(list)) {
        this._newsItems = list.map((item, idx) => ({
          id: String(item.id || newId()).trim().toLowerCase().replace(/[^a-z0-9_-]/g, '') || newId(),
          title: String(item.title || '').trim(),
          tag: String(item.tag || 'ANNOUNCEMENT').trim(),
          tagClass: String(item.tagClass || 'ok').trim(),
          thumbnail: String(item.thumbnail || '').trim(),
          link: String(item.link || '').trim(),
          details: String(item.details || '').trim(),
          date: String(item.date || '').trim(),
          isOfficial: !!item.isOfficial,
          sortOrder: typeof item.sortOrder === 'number' ? item.sortOrder : idx,
          created: item.created || Date.now(),
        }));
      }
      return this.getNews();
    },
    async addOrUpdateNews(item) {
      if (!this._newsItems) {
        this._newsItems = DEFAULT_NEWS_ITEMS.map(n => ({ ...n }));
      }
      const id = String(item.id || newId()).trim().toLowerCase().replace(/[^a-z0-9_-]/g, '') || newId();
      const existingIdx = this._newsItems.findIndex(n => n.id === id);
      const entry = {
        id,
        title: String(item.title || 'Announcement').trim(),
        tag: String(item.tag || 'ANNOUNCEMENT').trim(),
        tagClass: String(item.tagClass || 'ok').trim(),
        thumbnail: String(item.thumbnail || '').trim(),
        link: String(item.link || '').trim(),
        details: String(item.details || '').trim(),
        date: String(item.date || 'Nov 2026').trim(),
        isOfficial: !!item.isOfficial,
        sortOrder: typeof item.sortOrder === 'number' ? item.sortOrder : (existingIdx >= 0 ? this._newsItems[existingIdx].sortOrder : this._newsItems.length),
        created: item.created || Date.now(),
      };
      if (existingIdx >= 0) {
        this._newsItems[existingIdx] = entry;
      } else {
        this._newsItems.push(entry);
      }
      return entry;
    },
    async deleteNews(id) {
      if (!this._newsItems) {
        this._newsItems = DEFAULT_NEWS_ITEMS.map(n => ({ ...n }));
      }
      this._newsItems = this._newsItems.filter(n => n.id !== id);
      return { ok: true };
    },
    async resetNews() {
      this._newsItems = DEFAULT_NEWS_ITEMS.map(n => ({ ...n }));
      return this.getNews();
    },
  };
}

export function createTursoStore({ url, token }) {
  const db = createTurso({ url, token });

  const q = {
    userByName: 'SELECT id, username, pass_hash AS passHash FROM users WHERE username = ?',
    userById: 'SELECT id, username FROM users WHERE id = ?',
    insertUser: 'INSERT INTO users (id, username, pass_hash, created) VALUES (?,?,?,?)',
    savePresence: 'INSERT INTO presence (user_id, payload, updated) VALUES (?,?,?) ON CONFLICT(user_id) DO UPDATE SET payload = excluded.payload, updated = excluded.updated',
    getPresence: 'SELECT payload FROM presence WHERE user_id = ?',
    delPresence: 'DELETE FROM presence WHERE user_id = ?',
    friends: 'SELECT CASE WHEN a = ? THEN b ELSE a END AS friendId FROM friendships WHERE a = ? OR b = ?',
    isFriend: 'SELECT 1 AS x FROM friendships WHERE (a = ? AND b = ?) OR (a = ? AND b = ?)',
    addFriend: 'INSERT OR IGNORE INTO friendships (a, b, created) VALUES (?,?,?)',
    delFriend: 'DELETE FROM friendships WHERE (a = ? AND b = ?) OR (a = ? AND b = ?)',
    insertReq: 'INSERT INTO friend_requests (id, from_id, to_id, message, created) VALUES (?,?,?,?,?)',
    getReq: 'SELECT id, from_id, to_id, from_id AS "from", to_id AS "to", message, created FROM friend_requests WHERE id = ?',
    reqsFor: 'SELECT id, from_id, to_id, from_id AS "from", to_id AS "to", message, created FROM friend_requests WHERE to_id = ?',
    delReq: 'DELETE FROM friend_requests WHERE id = ?',
    addBlock: 'INSERT INTO blocks (blocker, blocked, created) VALUES (?,?,?) ON CONFLICT DO NOTHING',
    delBlock: 'DELETE FROM blocks WHERE blocker = ? AND blocked = ?',
    blockedBy: 'SELECT blocked FROM blocks WHERE blocker = ?',
    isBlocked: 'SELECT 1 AS x FROM blocks WHERE (blocker = ? AND blocked = ?) OR (blocker = ? AND blocked = ?)',
    insertConv: 'INSERT INTO conversations (id, kind, name, created) VALUES (?,?,?,?)',
    getConv: 'SELECT id, kind, name, created FROM conversations WHERE id = ?',
    convsFor: 'SELECT c.id, c.kind, c.name, c.created FROM conversations c JOIN conversation_members m ON m.conversation_id = c.id WHERE m.user_id = ?',
    members: 'SELECT user_id FROM conversation_members WHERE conversation_id = ?',
    addMember: 'INSERT INTO conversation_members (conversation_id, user_id, joined) VALUES (?,?,?) ON CONFLICT DO NOTHING',
    delMember: 'DELETE FROM conversation_members WHERE conversation_id = ? AND user_id = ?',
    isMember: 'SELECT 1 AS x FROM conversation_members WHERE conversation_id = ? AND user_id = ?',
    directConv: `SELECT c.id, c.kind, c.name, c.created FROM conversations c
                 JOIN conversation_members m1 ON m1.conversation_id = c.id AND m1.user_id = ?
                 JOIN conversation_members m2 ON m2.conversation_id = c.id AND m2.user_id = ?
                 WHERE c.kind = 'direct' LIMIT 1`,
    insertMsg: 'INSERT INTO messages (id, conversation_id, sender_id, body, kind, meta, created) VALUES (?,?,?,?,?,?,?)',
    msgs: 'SELECT id, conversation_id AS conversationId, sender_id AS senderId, body, kind, meta, created FROM messages WHERE conversation_id = ? ORDER BY created ASC LIMIT ?',
    insertNotif: 'INSERT INTO notifications (id, user_id, kind, title, body, ts) VALUES (?,?,?,?,?,?)',
    notifsFor: 'SELECT id, kind, title, body, ts FROM notifications WHERE user_id = ? ORDER BY ts DESC LIMIT 100',
    savePrivacy: 'INSERT INTO privacy_settings (user_id, settings) VALUES (?,?) ON CONFLICT(user_id) DO UPDATE SET settings = excluded.settings',
    getPrivacy: 'SELECT settings FROM privacy_settings WHERE user_id = ?',
    delNotif: 'DELETE FROM notifications WHERE id = ?',
    insertTelemetry: 'INSERT INTO telemetry_events (id, user_id, device_id, event_type, payload, ts) VALUES (?,?,?,?,?,?)',
    insertError: 'INSERT INTO client_errors (id, user_id, subsystem, message, stack, level, ts) VALUES (?,?,?,?,?,?,?)',
    insertDownload: 'INSERT INTO download_stats (id, user_id, url, size, duration_ms, status, ts) VALUES (?,?,?,?,?,?,?)',
    countUsers: 'SELECT COUNT(*) as count FROM users',
    countDownloads: 'SELECT COUNT(*) as count FROM download_stats',
    countErrors: 'SELECT COUNT(*) as count FROM client_errors',
    countEvents: 'SELECT COUNT(*) as count FROM telemetry_events',
    countDevices: 'SELECT COUNT(DISTINCT device_id) as count FROM telemetry_events WHERE device_id IS NOT NULL',
    recentErrors: 'SELECT id, user_id as userId, subsystem, message, stack, level, ts FROM client_errors ORDER BY ts DESC LIMIT ?',
    clearErrors: 'DELETE FROM client_errors',
    recentDownloads: 'SELECT id, user_id as userId, url, size, duration_ms as durationMs, status, ts FROM download_stats ORDER BY ts DESC LIMIT ?',
  };

  async function one(sql, args) {
    const r = await db.exec(sql, args);
    return rowsToObjects(r);
  }

  return {
    mode: 'turso',
    exec(sql, args) { return db.exec(sql, args); },
    async createUser({ username, passHash }) {
      const existing = await one(q.userByName, [username]);
      if (existing.length) throw Object.assign(new Error('username taken'), { code: 'username-taken' });
      const id = newId();
      await db.exec(q.insertUser, [id, username, passHash, Date.now()]);
      return { id, username };
    },
    async getUserByUsername(username) {
      const rows = await one(q.userByName, [String(username)]);
      return rows[0] ?? null;
    },
    async getUserById(id) { return (await one(q.userById, [id]))[0] ?? null; },
    async savePresence(userId, payload) { await db.exec(q.savePresence, [userId, JSON.stringify(payload), Date.now()]); },
    async getPresence(userId) {
      const rows = await one(q.getPresence, [userId]);
      return rows[0] ? JSON.parse(rows[0].payload) : null;
    },
    async deletePresence(userId) { await db.exec(q.delPresence, [userId]); },
    async getFriendIds(userId) {
      const rows = await one(q.friends, [userId, userId, userId]);
      return rows.map(r => r.friendId ?? r.friendid ?? r.friend_id).filter(Boolean);
    },
    async areFriends(a, b) { return (await one(q.isFriend, [a, b, b, a])).length > 0; },
    async addFriendship(a, b) {
      const [x, y] = String(a) < String(b) ? [a, b] : [b, a];
      await db.exec(q.addFriend, [x, y, Date.now()]);
    },
    async removeFriendship(a, b) { await db.exec(q.delFriend, [a, b, b, a]); },
    async createRequest({ from, to, message }) {
      const existing = (await db.batch([
        { sql: q.reqsFor, args: [to] },
      ]))[0];
      for (const r of rowsToObjects(existing)) {
        const rFrom = r.from ?? r.from_id ?? r.fromId;
        if (rFrom === from) return { ...r, from: rFrom, to: r.to ?? r.to_id ?? r.toId };
      }
      const id = newId();
      await db.exec(q.insertReq, [id, from, to, message ?? null, Date.now()]);
      return { id, from, to, message: message ?? null, created: Date.now() };
    },
    async getRequest(id) {
      const rows = await one(q.getReq, [id]);
      if (!rows[0]) return null;
      const r = rows[0];
      return { id: r.id, from: r.from ?? r.from_id ?? r.fromId, to: r.to ?? r.to_id ?? r.toId, message: r.message ?? null, created: r.created };
    },
    async listRequestsFor(userId) {
      const rows = await one(q.reqsFor, [userId]);
      return rows.map(r => ({ id: r.id, from: r.from ?? r.from_id ?? r.fromId, to: r.to ?? r.to_id ?? r.toId, message: r.message ?? null, created: r.created }));
    },
    async deleteRequest(id) { await db.exec(q.delReq, [id]); },
    async addBlock(a, b) { await db.exec(q.addBlock, [a, b, Date.now()]); },
    async removeBlock(a, b) { await db.exec(q.delBlock, [a, b]); },
    async isBlockedEither(a, b) { return (await one(q.isBlocked, [a, b, b, a])).length > 0; },
    async listBlocked(userId) { return (await one(q.blockedBy, [userId])).map(r => r.blocked); },
    async createConversation({ kind, name, memberIds }) {
      const id = newId();
      await db.exec(q.insertConv, [id, kind, name ?? null, Date.now()]);
      await db.batch(memberIds.map(uid => ({ sql: q.addMember, args: [id, uid, Date.now()] })));
      return { id, kind, name: name ?? null, created: Date.now() };
    },
    async getConversation(id) { return (await one(q.getConv, [id]))[0] ?? null; },
    async listConversationsFor(userId) { return one(q.convsFor, [userId]); },
    async listMemberIds(conversationId) { return (await one(q.members, [conversationId])).map(r => r.user_id); },
    async addMember(conversationId, userId) { await db.exec(q.addMember, [conversationId, userId, Date.now()]); },
    async removeMember(conversationId, userId) { await db.exec(q.delMember, [conversationId, userId]); },
    async isMember(conversationId, userId) { return (await one(q.isMember, [conversationId, userId])).length > 0; },
    async findDirectConversation(a, b) { return (await one(q.directConv, [a, b]))[0] ?? null; },
    async addMessage({ conversationId, senderId, body, kind = 'text', meta = null }) {
      const id = newId();
      const created = Date.now();
      await db.exec(q.insertMsg, [id, conversationId, senderId, body, kind, meta ? JSON.stringify(meta) : null, created]);
      return { id, conversationId, senderId, body, kind, meta, created };
    },
    async listMessages(conversationId, limit = 100) {
      const rows = await one(q.msgs, [conversationId, limit]);
      return rows.map(r => ({ ...r, meta: r.meta ? JSON.parse(r.meta) : null }));
    },
    async addNotification({ userId, kind, title, body = null }) {
      const id = newId();
      const ts = Date.now();
      await db.exec(q.insertNotif, [id, userId, kind, title, body, ts]);
      return { id, userId, kind, title, body, ts };
    },
    async listNotifications(userId) { return one(q.notifsFor, [userId]); },
    async deleteNotification(id) { await db.exec(q.delNotif, [id]); },
    async savePrivacy(userId, settings) { await db.exec(q.savePrivacy, [userId, JSON.stringify(settings)]); },
    async getPrivacy(userId) {
      const rows = await one(q.getPrivacy, [userId]);
      return rows[0] ? JSON.parse(rows[0].settings) : null;
    },
    // ---- Speedy Player Tags ----
    async setMinecraftUsername(userId, name) {
      await db.exec('UPDATE users SET minecraft_username = ? WHERE id = ?', [name, userId]);
    },
    async recordSpeedyPlayer(username, source = 'launcher') {
      if (!username || typeof username !== 'string') return;
      const clean = username.replace(/[^a-zA-Z0-9_]/g, '').trim();
      if (clean.length < 2 || clean.length > 24) return;
      await db.exec(
        'INSERT INTO speedy_players (username_lower, username, source, updated_at) VALUES (?,?,?,?) ON CONFLICT(username_lower) DO UPDATE SET username = excluded.username, source = excluded.source, updated_at = excluded.updated_at',
        [clean.toLowerCase(), clean, String(source || 'launcher').slice(0, 32), Date.now()]
      );
    },
    async listMinecraftUsernames() {
      const merged = new Map();
      const r1 = await db.exec(
        'SELECT COALESCE(minecraft_username, username) AS name FROM users WHERE minecraft_username IS NOT NULL OR username IS NOT NULL',
        []
      );
      for (const row of rowsToObjects(r1)) {
        if (row.name) merged.set(String(row.name).toLowerCase(), String(row.name));
      }
      try {
        const r2 = await db.exec('SELECT username AS name FROM speedy_players WHERE username IS NOT NULL', []);
        for (const row of rowsToObjects(r2)) {
          if (row.name && !merged.has(String(row.name).toLowerCase())) {
            merged.set(String(row.name).toLowerCase(), String(row.name));
          }
        }
      } catch {
        // Table may not exist yet on first boot before schema migration
      }
      return [...merged.values()];
    },
    // ---- Telemetry & Admin Store Methods ----
    async recordTelemetryBatch({ events = [], errors = [], downloads = [] }) {
      const stmts = [];
      const nowTs = Date.now();
      for (const ev of events) {
        stmts.push({
          sql: q.insertTelemetry,
          args: [newId(), ev.userId ?? null, ev.deviceId ?? null, ev.type || 'event', JSON.stringify(ev.payload || {}), ev.ts || nowTs],
        });
      }
      for (const err of errors) {
        stmts.push({
          sql: q.insertError,
          args: [newId(), err.userId ?? null, err.subsystem || 'general', String(err.message || '').slice(0, 1000), String(err.stack || '').slice(0, 4000), err.level || 'error', err.ts || nowTs],
        });
      }
      for (const dl of downloads) {
        stmts.push({
          sql: q.insertDownload,
          args: [newId(), dl.userId ?? null, dl.url || '', dl.size || 0, dl.durationMs || 0, dl.status || 'ok', dl.ts || nowTs],
        });
      }
      if (stmts.length > 0) {
        await db.batch(stmts);
      }
      return { ok: true, count: stmts.length };
    },
    async getMetricsSummary() {
      const [uRes, dlRes, errRes, evRes, devRes] = await Promise.all([
        one(q.countUsers, []).catch(() => [{ count: 0 }]),
        one(q.countDownloads, []).catch(() => [{ count: 0 }]),
        one(q.countErrors, []).catch(() => [{ count: 0 }]),
        one(q.countEvents, []).catch(() => [{ count: 0 }]),
        one(q.countDevices, []).catch(() => [{ count: 0 }]),
      ]);
      const recentErrRows = await one(q.recentErrors, [100]).catch(() => []);
      return {
        totalUsers: Number(uRes[0]?.count ?? 0),
        totalDownloads: Number(dlRes[0]?.count ?? 0),
        totalErrors: Number(errRes[0]?.count ?? 0),
        totalEvents: Number(evRes[0]?.count ?? 0),
        totalDevices: Number(devRes[0]?.count ?? 0),
        recentErrors: recentErrRows,
      };
    },
    async listRecentErrors(limit = 100) {
      return one(q.recentErrors, [limit]).catch(() => []);
    },
    async listAllErrors(limit = 500) {
      return one(q.recentErrors, [limit]).catch(() => []);
    },
    async clearAllErrors() {
      await db.exec(q.clearErrors, []);
      return { ok: true };
    },
    async listRecentDownloads(limit = 50) {
      return one(q.recentDownloads, [limit]).catch(() => []);
    },
    // ---- Quick Play Featured Servers (Turso Persistent Mode) ----
    async getFeaturedServers() {
      await db.exec(`CREATE TABLE IF NOT EXISTS featured_servers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        tag TEXT DEFAULT '',
        tag_class TEXT DEFAULT '',
        ip TEXT NOT NULL,
        port INTEGER DEFAULT 25565,
        is_official INTEGER DEFAULT 0,
        default_motd TEXT DEFAULT '',
        default_players TEXT DEFAULT '',
        icon_url TEXT DEFAULT '',
        sort_order INTEGER DEFAULT 0,
        created INTEGER NOT NULL
      )`, []).catch(() => {});

      const rows = await one('SELECT id, name, tag, tag_class as tagClass, ip, port, is_official as isOfficial, default_motd as defaultMotd, default_players as defaultPlayers, icon_url as iconUrl, sort_order as sortOrder, created FROM featured_servers ORDER BY sort_order ASC, created ASC', []).catch(() => []);
      if (!rows || rows.length === 0) {
        // Seed default 4 servers
        const now = Date.now();
        const stmts = DEFAULT_FEATURED_SERVERS.map((s, idx) => ({
          sql: 'INSERT INTO featured_servers (id, name, tag, tag_class, ip, port, is_official, default_motd, default_players, icon_url, sort_order, created) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
          args: [s.id, s.name, s.tag, s.tagClass, s.ip, s.port || 25565, s.isOfficial ? 1 : 0, s.defaultMotd, s.defaultPlayers, s.iconUrl || '', idx, now + idx]
        }));
        await db.batch(stmts).catch(() => {});
        return DEFAULT_FEATURED_SERVERS.map(s => ({ ...s }));
      }
      return rows.map(r => ({
        id: r.id,
        name: r.name,
        tag: r.tag || '',
        tagClass: r.tagClass || '',
        ip: r.ip,
        port: Number(r.port || 25565),
        isOfficial: Boolean(r.isOfficial),
        defaultMotd: r.defaultMotd || '',
        defaultPlayers: r.defaultPlayers || '',
        iconUrl: r.iconUrl || '',
        sortOrder: Number(r.sortOrder || 0),
      }));
    },
    async saveFeaturedServers(list) {
      if (!Array.isArray(list)) return this.getFeaturedServers();
      await db.exec('DELETE FROM featured_servers', []).catch(() => {});
      const now = Date.now();
      const stmts = list.map((s, idx) => {
        const id = String(s.id || newId()).trim().toLowerCase().replace(/[^a-z0-9_-]/g, '') || newId();
        return {
          sql: 'INSERT INTO featured_servers (id, name, tag, tag_class, ip, port, is_official, default_motd, default_players, icon_url, sort_order, created) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
          args: [
            id,
            String(s.name || '').trim(),
            String(s.tag || '').trim(),
            String(s.tagClass || '').trim(),
            String(s.ip || '').trim(),
            Number(s.port || 25565),
            s.isOfficial ? 1 : 0,
            String(s.defaultMotd || '').trim(),
            String(s.defaultPlayers || '').trim(),
            String(s.iconUrl || '').trim(),
            typeof s.sortOrder === 'number' ? s.sortOrder : idx,
            now + idx
          ]
        };
      });
      if (stmts.length > 0) {
        await db.batch(stmts);
      }
      return this.getFeaturedServers();
    },
    async addOrUpdateFeaturedServer(s) {
      const id = String(s.id || s.name || newId()).trim().toLowerCase().replace(/[^a-z0-9_-]/g, '') || newId();
      await db.exec(`
        INSERT INTO featured_servers (id, name, tag, tag_class, ip, port, is_official, default_motd, default_players, icon_url, sort_order, created)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET
          name = excluded.name,
          tag = excluded.tag,
          tag_class = excluded.tag_class,
          ip = excluded.ip,
          port = excluded.port,
          is_official = excluded.is_official,
          default_motd = excluded.default_motd,
          default_players = excluded.default_players,
          icon_url = excluded.icon_url,
          sort_order = excluded.sort_order
      `, [
        id,
        String(s.name || '').trim(),
        String(s.tag || '').trim(),
        String(s.tagClass || '').trim(),
        String(s.ip || '').trim(),
        Number(s.port || 25565),
        s.isOfficial ? 1 : 0,
        String(s.defaultMotd || '').trim(),
        String(s.defaultPlayers || '').trim(),
        String(s.iconUrl || '').trim(),
        Number(s.sortOrder || 0),
        Date.now()
      ]);
      return { ok: true, id };
    },
    async deleteFeaturedServer(id) {
      await db.exec('DELETE FROM featured_servers WHERE id = ?', [id]);
      return { ok: true };
    },
    async resetFeaturedServers() {
      await db.exec('DELETE FROM featured_servers', []).catch(() => {});
      return this.getFeaturedServers();
    },
    // ---- News & Announcements (Turso Persistent Mode) ----
    async getNews() {
      await db.exec(`CREATE TABLE IF NOT EXISTS news_items (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        tag TEXT DEFAULT 'ANNOUNCEMENT',
        tag_class TEXT DEFAULT 'ok',
        thumbnail TEXT DEFAULT '',
        link TEXT DEFAULT '',
        details TEXT DEFAULT '',
        date TEXT DEFAULT '',
        is_official INTEGER DEFAULT 0,
        sort_order INTEGER DEFAULT 0,
        created INTEGER
      )`).catch(() => {});

      const rows = await one('SELECT id, title, tag, tag_class as tagClass, thumbnail, link, details, date, is_official as isOfficial, sort_order as sortOrder, created FROM news_items ORDER BY sort_order ASC, created DESC', []).catch(() => []);
      if (!rows || rows.length === 0) {
        const now = Date.now();
        const stmts = DEFAULT_NEWS_ITEMS.map((n, idx) => ({
          sql: 'INSERT INTO news_items (id, title, tag, tag_class, thumbnail, link, details, date, is_official, sort_order, created) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
          args: [n.id, n.title, n.tag, n.tagClass, n.thumbnail, n.link, n.details, n.date, n.isOfficial ? 1 : 0, idx, now + idx]
        }));
        await db.batch(stmts).catch(() => {});
        return DEFAULT_NEWS_ITEMS.map(n => ({ ...n }));
      }
      return rows.map(r => ({
        id: r.id,
        title: r.title,
        tag: r.tag || '',
        tagClass: r.tagClass || 'ok',
        thumbnail: r.thumbnail || '',
        link: r.link || '',
        details: r.details || '',
        date: r.date || '',
        isOfficial: Boolean(r.isOfficial),
        sortOrder: Number(r.sortOrder || 0),
        created: Number(r.created || 0),
      }));
    },
    async saveNews(list) {
      if (!Array.isArray(list)) return this.getNews();
      await db.exec('DELETE FROM news_items', []).catch(() => {});
      const now = Date.now();
      const stmts = list.map((n, idx) => {
        const id = String(n.id || newId()).trim().toLowerCase().replace(/[^a-z0-9_-]/g, '') || newId();
        return {
          sql: 'INSERT INTO news_items (id, title, tag, tag_class, thumbnail, link, details, date, is_official, sort_order, created) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
          args: [
            id,
            String(n.title || '').trim(),
            String(n.tag || 'ANNOUNCEMENT').trim(),
            String(n.tagClass || 'ok').trim(),
            String(n.thumbnail || '').trim(),
            String(n.link || '').trim(),
            String(n.details || '').trim(),
            String(n.date || '').trim(),
            n.isOfficial ? 1 : 0,
            typeof n.sortOrder === 'number' ? n.sortOrder : idx,
            n.created || now + idx,
          ]
        };
      });
      await db.batch(stmts).catch(() => {});
      return this.getNews();
    },
    async addOrUpdateNews(n) {
      const id = String(n.id || newId()).trim().toLowerCase().replace(/[^a-z0-9_-]/g, '') || newId();
      await db.exec(`
        INSERT INTO news_items (id, title, tag, tag_class, thumbnail, link, details, date, is_official, sort_order, created)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET
          title = excluded.title,
          tag = excluded.tag,
          tag_class = excluded.tag_class,
          thumbnail = excluded.thumbnail,
          link = excluded.link,
          details = excluded.details,
          date = excluded.date,
          is_official = excluded.is_official,
          sort_order = excluded.sort_order
      `, [
        id,
        String(n.title || '').trim(),
        String(n.tag || 'ANNOUNCEMENT').trim(),
        String(n.tagClass || 'ok').trim(),
        String(n.thumbnail || '').trim(),
        String(n.link || '').trim(),
        String(n.details || '').trim(),
        String(n.date || '').trim(),
        n.isOfficial ? 1 : 0,
        Number(n.sortOrder || 0),
        Date.now()
      ]);
      return { ok: true, id };
    },
    async deleteNews(id) {
      await db.exec('DELETE FROM news_items WHERE id = ?', [id]);
      return { ok: true };
    },
    async resetNews() {
      await db.exec('DELETE FROM news_items', []).catch(() => {});
      return this.getNews();
    },
  };
}
