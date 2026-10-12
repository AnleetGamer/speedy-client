/**
 * Anleet social data layer. One interface, two implementations:
 *  - TursoStore (production, libSQL over HTTP — see turso.mjs)
 *  - MemoryStore (development, tests, and graceful degradation when Turso
 *    is unreachable; documented as non-durable)
 * Only lightweight metadata lives here (§57).
 */
import { createTurso, rowsToObjects } from './turso.mjs';
import { newId } from './auth.mjs';

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
      return {
        totalUsers,
        totalDownloads,
        totalErrors: (this._clientErrors || []).length,
        totalEvents: events.length,
        recentErrors,
      };
    },
    async listRecentErrors(limit = 100) {
      return (this._clientErrors || []).slice(-limit).reverse();
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
    recentErrors: 'SELECT id, user_id as userId, subsystem, message, stack, level, ts FROM client_errors ORDER BY ts DESC LIMIT ?',
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
      const [uRes, dlRes, errRes, evRes] = await Promise.all([
        one(q.countUsers, []).catch(() => [{ count: 0 }]),
        one(q.countDownloads, []).catch(() => [{ count: 0 }]),
        one(q.countErrors, []).catch(() => [{ count: 0 }]),
        one(q.countEvents, []).catch(() => [{ count: 0 }]),
      ]);
      const recentErrRows = await one(q.recentErrors, [100]).catch(() => []);
      return {
        totalUsers: Number(uRes[0]?.count ?? 0),
        totalDownloads: Number(dlRes[0]?.count ?? 0),
        totalErrors: Number(errRes[0]?.count ?? 0),
        totalEvents: Number(evRes[0]?.count ?? 0),
        recentErrors: recentErrRows,
      };
    },
    async listRecentErrors(limit = 100) {
      return one(q.recentErrors, [limit]).catch(() => []);
    },
  };
}
