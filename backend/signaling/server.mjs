#!/usr/bin/env node
/**
 * Anleet signaling & presence server.
 *
 * Deployment target: a single small Render web service (or any Node host).
 * Responsibilities (§1, §30):
 *   - Anleet identity (register / login / token auth) — scrypt + HMAC, no deps
 *   - presence coordination for friends
 *   - WebRTC signaling relay (offer / answer / ICE) — media is NEVER relayed
 *     here; voice/video/screen share flows peer-to-peer
 *   - group voice room rosters
 *   - direct & group message coordination + offline delivery
 *   - lightweight Turso persistence (metadata only)
 *   - serves the interactive UI preview at / (dev/demo convenience)
 *
 * Environment:
 *   PORT                    (Render injects; default 8787)
 *   TURSO_DATABASE_URL      optional — memory mode when absent
 *   TURSO_AUTH_TOKEN        optional
 *   SECRET                  HMAC secret (required in production; auto-generated for dev)
 *   ANLEET_PREVIEW_DIR      directory to serve at / (optional)
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { attachWebSocketServer } from './ws.mjs';
import { createMemoryStore, createTursoStore } from './store.mjs';
import { hashPassword, verifyPassword, createTokenFactory, newId } from './auth.mjs';
import { decode, encode, PROTOCOL_VERSION } from '../shared/protocol/messages.mjs';
import { createRateLimiter } from '../shared/protocol/schema.mjs';
import { defaultPrivacy, filterPresence } from '../shared/presence/logic.mjs';
import { checkImpersonation } from '../shared/safety/impersonation.mjs';

const PORT = Number(process.env.PORT || 8787);
const PREVIEW_DIR = process.env.ANLEET_PREVIEW_DIR || path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'tools', 'preview');
const PRESENCE_TTL_MS = 90_000;

// ---------------------------------------------------------------- store
let store;
let storeMode = 'memory';
if (process.env.TURSO_DATABASE_URL && process.env.TURSO_AUTH_TOKEN) {
  try {
    store = createTursoStore({ url: process.env.TURSO_DATABASE_URL, token: process.env.TURSO_AUTH_TOKEN });
    storeMode = 'turso';
    // Ensure tables exist on boot
    const schemaFile = path.join(path.dirname(fileURLToPath(import.meta.url)), 'schema.sql');
    if (fs.existsSync(schemaFile)) {
      const sqlText = fs.readFileSync(schemaFile, 'utf8');
      const stmts = sqlText.replace(/--.*$/gm, '').split(';').map(s => s.trim()).filter(s => s.length > 0);
      for (const sql of stmts) {
        await store.exec(sql).catch(() => {});
      }
    }
    await store.getUserByUsername('__probe__').catch(() => {});
    console.log('[speedy] Turso persistent database connected successfully.');
  } catch (e) {
    console.error('[speedy] Turso init failed, falling back to memory store:', e.message);
    store = createMemoryStore();
  }
} else {
  store = createMemoryStore();
}

// ---------------------------------------------------------------- auth
let SECRET = process.env.SECRET;
if (!SECRET) {
  const secretFile = path.join(process.cwd(), '.anleet-dev-secret');
  try { SECRET = fs.readFileSync(secretFile, 'utf8').trim(); } catch { SECRET = crypto.randomBytes(32).toString('hex'); fs.writeFileSync(secretFile, SECRET); }
  if (storeMode === 'memory') console.warn('[anleet] dev secret generated at', secretFile);
}
const tokens = createTokenFactory(SECRET);

// ---------------------------------------------------------------- sessions
const sessions = new Map();   // userId -> Set<conn>
const lastSeen = new Map();   // userId -> ms (for presence TTL)
const activeCalls = new Map(); // callId -> {from, to, media, state} — server-global so either side resolves

function onlineIds() { return [...sessions.keys()]; }

async function sendTo(userId, wire) {
  const set = sessions.get(userId);
  if (!set) return false;
  const data = typeof wire === 'string' ? wire : JSON.stringify(wire);
  for (const conn of set) conn.send(data);
  return true;
}

function sendError(conn, code, detail, of) {
  conn.send(encode('error', { code, detail: String(detail).slice(0, 300), of }));
}

async function friendPayloadFor(userId) {
  const friendIds = await store.getFriendIds(userId);
  const out = [];
  for (const fid of friendIds) {
    const user = await store.getUserById(fid);
    if (!user) continue;
    const [theirPrivacy, rawPresence] = await Promise.all([store.getPrivacy(fid), store.getPresence(fid)]);
    const filtered = filterPresence(rawPresence, theirPrivacy ?? defaultPrivacy(), 'friend');
    out.push({ id: fid, username: user.username, presence: filtered.visible ? filtered.presence : null, canDm: filtered.canDm, canCall: filtered.canCall });
  }
  return out;
}

async function notifyNewCallLike(userId, kind, title, body) {
  const n = await store.addNotification({ userId, kind, title, body });
  await sendTo(userId, encode('notification.new', { id: n.id, kind: n.kind, title: n.title, body: n.body ?? undefined, ts: n.ts }));
}

// ---------------------------------------------------------------- message handlers
const handlers = {
  async 'auth.register'(conn, msg) {
    const user = await store.createUser({ username: msg.username, passHash: hashPassword(msg.password) });
    await store.savePrivacy(user.id, defaultPrivacy());
    await finishAuth(conn, user);
  },
  async 'auth.login'(conn, msg) {
    const user = await store.getUserByUsername(msg.username);
    if (!user || !verifyPassword(msg.password, user.passHash)) {
      return sendError(conn, 'bad-credentials', 'Wrong username or password.', 'auth.login');
    }
    await finishAuth(conn, { id: user.id, username: user.username });
  },
  async 'auth.token'(conn, msg) {
    const valid = tokens.verify(msg.token);
    if (!valid) return sendError(conn, 'bad-token', 'Session expired — sign in again.', 'auth.token');
    const user = await store.getUserById(valid.userId);
    if (!user) return sendError(conn, 'bad-token', 'Unknown account.', 'auth.token');
    await finishAuth(conn, user);
  },

  async 'presence.update'(conn, msg, ctx) {
    const payload = { ...(msg ?? {}), ts: Date.now() };
    await store.savePresence(ctx.userId, payload);
    lastSeen.set(ctx.userId, Date.now());
    await fanoutPresence(ctx.userId, payload);
  },

  async 'friend.list'(conn, _msg, ctx) {
    conn.send(encode('ready', await readyPayload(ctx.userId)));
  },

  async 'friend.request'(conn, msg, ctx) {
    const target = await store.getUserByUsername(msg.username);
    if (!target) return sendError(conn, 'unknown-user', 'No Anleet user with that name.', 'friend.request');
    if (target.id === ctx.userId) return sendError(conn, 'self-request', 'That is you.', 'friend.request');
    if (await store.isBlockedEither(ctx.userId, target.id)) return sendError(conn, 'blocked', 'Request cannot be sent.', 'friend.request');
    if (await store.areFriends(ctx.userId, target.id)) return sendError(conn, 'already-friends', 'You are already friends.', 'friend.request');
    const theirPrivacy = (await store.getPrivacy(target.id)) ?? defaultPrivacy();
    if (theirPrivacy.allowRequests === 'nobody') {
      return sendError(conn, 'requests-closed', 'This person is not accepting friend requests.', 'friend.request');
    }
    if (theirPrivacy.allowRequests === 'friends' && !(await mutualFriendExists(ctx.userId, target.id))) {
      return sendError(conn, 'requests-friends-only', 'This person only accepts requests via mutual friends.', 'friend.request');
    }
    const req = await store.createRequest({ from: ctx.userId, to: target.id, message: msg.message ?? null });
    await notifyNewCallLike(target.id, 'friend-request', `${ctx.username} sent a friend request`, msg.message ?? undefined);
    const delivered = await sendTo(target.id, encode('friend.request.new', {
      requestId: req.id, from: ctx.userId, fromName: ctx.username, message: msg.message ?? undefined,
    }));
    // Lightweight impersonation warning for the receiver (§39).
    const friends = await friendPayloadFor(target.id);
    const imp = checkImpersonation(ctx.username, [...friends.map(f => f.username), target.username]);
    if (delivered && imp.suspicious) {
      await sendTo(target.id, encode('notification.new', {
        id: 'imp-' + req.id, kind: 'impersonation-warning',
        title: `@${ctx.username} may be impersonating @${imp.match.name}`,
        body: 'These names look extremely similar.', ts: Date.now(),
      }));
    }
    conn.send(encode('dm.ack', { tempId: `fr-${req.id}`, messageId: req.id, conversationId: `fr-${target.id}`, ts: Date.now() }));
  },

  async 'friend.respond'(conn, msg, ctx) {
    const req = await store.getRequest(msg.requestId);
    if (!req || req.to !== ctx.userId) return sendError(conn, 'no-request', 'That request is gone.', 'friend.respond');
    await store.deleteRequest(req.id);
    const fromUser = await store.getUserById(req.from);
    if (msg.accept && fromUser) {
      await store.addFriendship(ctx.userId, req.from);
      await notifyNewCallLike(req.from, 'friend-accepted', `${ctx.username} accepted your friend request`);
      await sendTo(req.from, encode('friend.request.resolved', { requestId: req.id, accepted: true, by: ctx.userId, byName: ctx.username }));
      await pushPresenceTo(ctx.userId, req.from);
      await pushPresenceTo(req.from, ctx.userId);
    }
  },

  async 'friend.remove'(conn, msg, ctx) {
    if (!(await store.areFriends(ctx.userId, msg.userId))) return;
    await store.removeFriendship(ctx.userId, msg.userId);
    await sendTo(msg.userId, encode('friend.removed', { userId: ctx.userId }));
  },

  async 'block.add'(conn, msg, ctx) {
    await store.addBlock(ctx.userId, msg.userId);
    if (await store.areFriends(ctx.userId, msg.userId)) {
      await store.removeFriendship(ctx.userId, msg.userId);
      await sendTo(msg.userId, encode('friend.removed', { userId: ctx.userId }));
    }
  },
  async 'block.remove'(conn, msg, ctx) { await store.removeBlock(ctx.userId, msg.userId); },
  async 'block.list'(conn, _msg, ctx) {
    const ids = await store.listBlocked(ctx.userId);
    const out = [];
    for (const id of ids) { const u = await store.getUserById(id); if (u) out.push({ id, username: u.username }); }
    conn.send(JSON.stringify({ t: 'block.list', items: out }));
  },

  async 'dm.send'(conn, msg, ctx) {
    const target = await store.getUserById(msg.to);
    if (!target) return sendError(conn, 'unknown-user', 'User not found.', 'dm.send');
    if (await store.isBlockedEither(ctx.userId, msg.to)) return sendError(conn, 'blocked', 'Message cannot be delivered.', 'dm.send');
    const theirPrivacy = (await store.getPrivacy(msg.to)) ?? defaultPrivacy();
    if (theirPrivacy.allowDms === 'nobody') return sendError(conn, 'dms-closed', 'This person does not accept DMs.', 'dm.send');
    if (theirPrivacy.allowDms === 'friends' && !(await store.areFriends(ctx.userId, msg.to))) {
      return sendError(conn, 'dms-friends-only', 'Only friends can message this person.', 'dm.send');
    }
    let conv = await store.findDirectConversation(ctx.userId, msg.to);
    if (!conv) conv = await store.createConversation({ kind: 'direct', memberIds: [ctx.userId, msg.to] });
    const stored = await store.addMessage({ conversationId: conv.id, senderId: ctx.userId, body: msg.body, kind: msg.kind, meta: msg.meta ?? null });
    const ack = encode('dm.ack', { tempId: msg.tempId ?? null, messageId: stored.id, conversationId: conv.id, ts: stored.created });
    conn.send(ack);
    const delivered = await sendTo(msg.to, encode('dm.new', {
      messageId: stored.id, conversationId: conv.id, from: ctx.userId, fromName: ctx.username,
      body: stored.body, kind: stored.kind, meta: stored.meta ?? undefined, ts: stored.created,
    }));
    if (!delivered) await notifyNewCallLike(msg.to, 'message', `${ctx.username}: ${stored.body.slice(0, 60)}`);
  },

  async 'dm.backlog'(conn, msg, ctx) {
    let conv = await store.findDirectConversation(ctx.userId, msg.with);
    if (!conv) return conn.send(encode('dm.backlog', { with: msg.with, messages: [] }));
    const list = await store.listMessages(conv.id, msg.limit ?? 100);
    conn.send(encode('dm.backlog', { with: msg.with, messages: list }));
  },

  async 'dm.receipt'(conn, msg, ctx) {
    // Find sender via message id is not stored per-message here; the renderer
    // includes conversation context, so we relay to conversation members.
    if (msg.conversationId && (await store.isMember(msg.conversationId, ctx.userId))) {
      const memberIds = await store.listMemberIds(msg.conversationId);
      for (const uid of memberIds) {
        if (uid !== ctx.userId) await sendTo(uid, encode('dm.receipt', { messageId: msg.messageId, by: ctx.userId }));
      }
    }
  },

  async 'typing'(conn, msg, ctx) {
    if (!(await store.isMember(msg.conversationId, ctx.userId))) return;
    const memberIds = await store.listMemberIds(msg.conversationId);
    for (const uid of memberIds) {
      if (uid !== ctx.userId) await sendTo(uid, encode('typing', { conversationId: msg.conversationId, from: ctx.userId, fromName: ctx.username }));
    }
  },

  async 'group.create'(conn, msg, ctx) {
    const memberIds = [ctx.userId];
    for (const name of msg.members) {
      if (name === ctx.username) continue;
      const u = await store.getUserByUsername(name);
      if (u) memberIds.push(u.id);
    }
    const conv = await store.createConversation({ kind: 'group', name: msg.name, memberIds });
    for (const uid of memberIds) {
      if (uid === ctx.userId) continue;
      const u = await store.getUserById(uid);
      await notifyNewCallLike(uid, 'group-invite', `${ctx.username} added you to ${msg.name}`);
      await sendTo(uid, encode('group.invited', { groupId: conv.id, name: msg.name, byName: ctx.username }));
    }
    conn.send(encode('group.new', { groupId: conv.id, name: msg.name, members: await memberPayload(conv.id) }));
  },

  async 'group.msg'(conn, msg, ctx) {
    if (!(await store.isMember(msg.groupId, ctx.userId))) return sendError(conn, 'not-member', 'You are not in this group.', 'group.msg');
    const stored = await store.addMessage({ conversationId: msg.groupId, senderId: ctx.userId, body: msg.body });
    const memberIds = await store.listMemberIds(msg.groupId);
    for (const uid of memberIds) {
      if (uid === ctx.userId) continue;
      const delivered = await sendTo(uid, encode('group.msg', {
        messageId: stored.id, groupId: msg.groupId, from: ctx.userId, fromName: ctx.username, body: stored.body, ts: stored.created,
      }));
      if (!delivered) await notifyNewCallLike(uid, 'message', `${ctx.username} (group): ${stored.body.slice(0, 60)}`);
    }
    conn.send(encode('dm.ack', { tempId: msg.tempId ?? null, messageId: stored.id, conversationId: msg.groupId, ts: stored.created }));
  },

  async 'group.invite'(conn, msg, ctx) {
    if (!(await store.isMember(msg.groupId, ctx.userId))) return sendError(conn, 'not-member', 'Not your group.', 'group.invite');
    const conv = await store.getConversation(msg.groupId);
    const u = await store.getUserByUsername(msg.username);
    if (!u || !conv) return sendError(conn, 'unknown-user', 'User not found.', 'group.invite');
    await store.addMember(msg.groupId, u.id);
    await notifyNewCallLike(u.id, 'group-invite', `${ctx.username} added you to ${conv.name}`);
    await sendTo(u.id, encode('group.invited', { groupId: msg.groupId, name: conv.name, byName: ctx.username }));
    await broadcastGroupRoster(msg.groupId);
  },
  async 'group.join'(conn, msg, ctx) {
    if (!(await store.isMember(msg.groupId, ctx.userId))) return sendError(conn, 'not-member', 'Not a member.', 'group.join');
    await broadcastGroupRoster(msg.groupId);
  },
  async 'group.leave'(conn, msg, ctx) {
    await store.removeMember(msg.groupId, ctx.userId);
    await broadcastGroupRoster(msg.groupId);
  },

  // ---- group voice rooms ----
  async 'room.join'(conn, msg, ctx) {
    if (!(await store.isMember(msg.groupId, ctx.userId))) return sendError(conn, 'not-member', 'Join the group first.', 'room.join');
    ctx.room = conn.__room = msg.groupId;
    await broadcastGroupRoster(msg.groupId);
  },
  async 'room.leave'(conn, _msg, ctx) {
    const groupId = ctx.room;
    ctx.room = null;
    if (groupId) await broadcastGroupRoster(groupId);
  },
  async 'room.roster'(conn, msg, ctx) {
    await broadcastGroupRoster(msg.groupId);
  },

  // ---- calls (1:1) + webrtc relay ----
  async 'call.invite'(conn, msg, ctx) {
    const target = await store.getUserById(msg.to);
    if (!target) return sendError(conn, 'unknown-user', 'User not found.', 'call.invite');
    if (await store.isBlockedEither(ctx.userId, msg.to)) return sendError(conn, 'blocked', 'Call cannot be placed.', 'call.invite');
    const theirPrivacy = (await store.getPrivacy(msg.to)) ?? defaultPrivacy();
    if (theirPrivacy.allowCalls === 'nobody') return sendError(conn, 'calls-closed', 'This person does not accept calls.', 'call.invite');
    if (theirPrivacy.allowCalls === 'friends' && !(await store.areFriends(ctx.userId, msg.to))) {
      return sendError(conn, 'calls-friends-only', 'Only friends can call this person.', 'call.invite');
    }
    const callId = newId();
    activeCalls.set(callId, { from: ctx.userId, to: msg.to, media: msg.media, state: 'ringing' });
    const delivered = await sendTo(msg.to, encode('call.incoming', { callId, from: ctx.userId, fromName: ctx.username, media: msg.media }));
    if (!delivered) {
      activeCalls.delete(callId);
      await notifyNewCallLike(msg.to, 'missed-call', `Missed ${msg.media} call from ${ctx.username}`);
      return sendError(conn, 'offline', 'User is offline.', 'call.invite');
    }
  },
  async 'call.accept'(conn, msg, ctx) {
    const call = activeCalls.get(msg.callId);
    if (!call) return sendError(conn, 'no-call', 'That call is gone.', 'call.accept');
    call.state = 'active';
    const peer = call.from === ctx.userId ? call.to : call.from;
    await sendTo(peer, encode('call.accepted', { callId: msg.callId, by: ctx.userId }));
  },
  async 'call.reject'(conn, msg, ctx) {
    const call = activeCalls.get(msg.callId);
    if (!call) return;
    activeCalls.delete(msg.callId);
    const peer = call.from === ctx.userId ? call.to : call.from;
    await sendTo(peer, encode('call.rejected', { callId: msg.callId, by: ctx.userId }));
  },
  async 'call.end'(conn, msg, ctx) {
    const call = activeCalls.get(msg.callId);
    if (!call) return;
    activeCalls.delete(msg.callId);
    const peer = call.from === ctx.userId ? call.to : call.from;
    await sendTo(peer, encode('call.ended', { callId: msg.callId, reason: 'remote' }));
  },
  async 'webrtc.offer'(conn, msg, ctx) { await relayWebRtc(conn, msg, ctx, 'webrtc.offer'); },
  async 'webrtc.answer'(conn, msg, ctx) { await relayWebRtc(conn, msg, ctx, 'webrtc.answer'); },
  async 'webrtc.ice'(conn, msg, ctx) { await relayWebRtc(conn, msg, ctx, 'webrtc.ice'); },

  async 'invite.minecraft'(conn, msg, ctx) {
    const target = await store.getUserById(msg.to);
    if (!target) return sendError(conn, 'unknown-user', 'User not found.', 'invite.minecraft');
    if (await store.isBlockedEither(ctx.userId, msg.to)) return sendError(conn, 'blocked', 'Invite cannot be sent.', 'invite.minecraft');
    const inviteId = newId();
    await sendTo(msg.to, encode('invite.minecraft.new', {
      inviteId, from: ctx.userId, fromName: ctx.username,
      instance: msg.instance, address: msg.address ?? undefined, message: msg.message ?? undefined,
    }));
    await notifyNewCallLike(msg.to, 'minecraft-invite', `${ctx.username} invited you to play`, msg.address ?? undefined);
  },
  async 'invite.respond'(conn, msg, ctx) {
    // The invite carries its id on the receiver side; acceptance is relayed by id correlation.
    sendError(conn, 'invite-relay', 'Invite responses are delivered via the original invite context.', 'invite.respond');
  },

  async 'privacy.set'(conn, msg, ctx) {
    const current = (await store.getPrivacy(ctx.userId)) ?? defaultPrivacy();
    const next = { ...current, [msg.key]: msg.value };
    await store.savePrivacy(ctx.userId, next);
    conn.send(encode('privacy.state', { settings: next }));
    // Re-broadcast filtered presence to friends since visibility may have changed.
    const raw = await store.getPresence(ctx.userId);
    if (raw) await fanoutPresence(ctx.userId, raw);
  },
  async 'privacy.get'(conn, _msg, ctx) {
    conn.send(encode('privacy.state', { settings: (await store.getPrivacy(ctx.userId)) ?? defaultPrivacy() }));
  },
  async 'notifications.get'(conn, _msg, ctx) {
    conn.send(encode('notifications.list', { items: await store.listNotifications(ctx.userId) }));
  },
  async 'notifications.clear'(conn, msg) {
    if (msg.id) await store.deleteNotification(msg.id);
  },

  async 'ping'(conn, msg) {
    conn.send(encode('pong', { t: msg.t }));
    if (conn.__userId) lastSeen.set(conn.__userId, Date.now());
  },
};

// ---------------------------------------------------------------- helpers
function relayWebRtc(conn, msg, ctx, type) {
  // 1:1 call relay
  const call = activeCalls.get(msg.callId);
  if (call) {
    const peer = call.from === ctx.userId ? call.to : call.from;
    sendTo(peer, encode(type, { callId: msg.callId, from: ctx.userId, ...(type === 'webrtc.ice' ? { candidate: msg.candidate } : { sdp: msg.sdp }) }));
    return;
  }
  // Group-room mesh relay: callId is "room-<groupId>" — fan out to room members.
  if (String(msg.callId).startsWith('room-')) {
    const groupId = String(msg.callId).slice(5);
    for (const [uid, set] of sessions) {
      if (uid === ctx.userId) continue;
      for (const c of set) if (c.__room === groupId) c.send(encode(type, { callId: msg.callId, from: ctx.userId, ...(type === 'webrtc.ice' ? { candidate: msg.candidate } : { sdp: msg.sdp }) }));
    }
  }
}

async function mutualFriendExists(a, b) {
  const [fa, fb] = await Promise.all([store.getFriendIds(a), store.getFriendIds(b)]);
  return fa.some(x => fb.includes(x));
}

async function memberPayload(convId) {
  const ids = await store.listMemberIds(convId);
  const out = [];
  for (const id of ids) {
    const u = await store.getUserById(id);
    if (u) out.push({ id, username: u.username, online: sessions.has(id), inRoom: false });
  }
  return out;
}

async function broadcastGroupRoster(groupId) {
  const members = await memberPayload(groupId);
  for (const [uid, set] of sessions) {
    if (!members.some(m => m.id === uid)) continue;
    for (const c of set) {
      c.send(encode('room.state', { groupId, members: members.map(m => ({ ...m, inRoom: c.__room === groupId ? true : undefined, self: m.id === uid })) }));
      c.send(encode('group.roster', { groupId, members }));
    }
  }
}

async function fanoutPresence(userId, rawPresence) {
  const privacy = (await store.getPrivacy(userId)) ?? defaultPrivacy();
  const friendIds = await store.getFriendIds(userId);
  for (const fid of friendIds) {
    if (!sessions.has(fid)) continue;
    const filtered = filterPresence(rawPresence, privacy, 'friend');
    await sendTo(fid, filtered.visible
      ? encode('presence.snapshot', { userId, presence: filtered.presence })
      : encode('presence.offline', { userId }));
  }
}

async function pushPresenceTo(ofUserId, toUserId) {
  const raw = await store.getPresence(ofUserId);
  const privacy = (await store.getPrivacy(ofUserId)) ?? defaultPrivacy();
  const filtered = filterPresence(raw, privacy, 'friend');
  await sendTo(toUserId, filtered.visible
    ? encode('presence.snapshot', { userId: ofUserId, presence: filtered.presence })
    : encode('presence.offline', { userId: ofUserId }));
}

async function readyPayload(userId) {
  const friends = await friendPayloadFor(userId);
  const requests = await store.listRequestsFor(userId);
  const reqOut = [];
  for (const r of requests) {
    const u = await store.getUserById(r.from);
    if (u) reqOut.push({ requestId: r.id, from: r.from, fromName: u.username, message: r.message ?? undefined });
  }
  const convs = await store.listConversationsFor(userId);
  const groups = [];
  for (const c of convs) {
    if (c.kind !== 'group') continue;
    groups.push({ groupId: c.id, name: c.name, members: await memberPayload(c.id) });
  }
  const notifs = await store.listNotifications(userId);
  return {
    userId,
    username: (await store.getUserById(userId)).username,
    friends,
    requests: reqOut,
    groups,
    undelivered: [],
    notifications: notifs,
    privacy: (await store.getPrivacy(userId)) ?? defaultPrivacy(),
  };
}

async function finishAuth(conn, user) {
  if (conn.__userId && conn.__userId !== user.id) sessions.get(conn.__userId)?.delete(conn);
  conn.__userId = user.id;
  conn.__username = user.username;
  if (!sessions.has(user.id)) sessions.set(user.id, new Set());
  sessions.get(user.id).add(conn);
  lastSeen.set(user.id, Date.now());
  conn.send(encode('auth.ok', { userId: user.id, username: user.username, token: tokens.issue(user.id) }));
  conn.send(encode('ready', await readyPayload(user.id)));
  // Tell friends we are here (launcher-open presence, no game).
  await store.savePresence(user.id, { playing: false, launcherOpen: true, inGame: false, ts: Date.now() });
  await fanoutPresence(user.id, { playing: false, launcherOpen: true, inGame: false, ts: Date.now() });
}

// ---------------------------------------------------------------- server
const server = http.createServer((req, res) => {
  const url = (req.url || '/').split('?')[0];
  if (url === '/healthz') { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('ok'); return; }
  serveStatic(url, res);
});

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json', '.ico': 'image/x-icon' };

function serveStatic(url, res) {
  if (!fs.existsSync(PREVIEW_DIR)) {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('Anleet signaling server. WebSocket endpoint: /ws\n');
    return;
  }
  const rel = url === '/' ? 'index.html' : url.slice(1);
  const file = path.normalize(path.join(PREVIEW_DIR, rel));
  if (!file.startsWith(path.normalize(PREVIEW_DIR))) { res.writeHead(403); res.end(); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}

attachWebSocketServer(server, {
  path: '/ws',
  onConnection(conn) {
    const ctx = { userId: null, username: null, room: null, calls: new Map() };
    conn.__room = null;
    const rl = createRateLimiter([
      { name: 'auth', capacity: 8, refillPerSec: 0.2 },
      { name: 'dm.send', capacity: 20, refillPerSec: 2 },
      { name: 'group.msg', capacity: 20, refillPerSec: 2 },
      { name: 'friend.request', capacity: 5, refillPerSec: 0.1 },
      { name: 'presence.update', capacity: 30, refillPerSec: 0.5 },
      { name: 'webrtc', capacity: 80, refillPerSec: 8 },
      { name: 'default', capacity: 60, refillPerSec: 10 },
    ]);
    const authTimer = setTimeout(() => { if (!ctx.userId) conn.close(4001); }, 10_000);

    conn.onmessage = async (raw) => {
      ctx.userId = conn.__userId;      // keep per-connection ctx in sync with auth state
      ctx.username = conn.__username;
      const decoded = decode(raw);
      if (!decoded.ok) {
        if (decoded.reason === 'too-large') return conn.close(1009);
        return sendError(conn, 'bad-message', 'Malformed message: ' + decoded.reason);
      }
      const { type, msg } = decoded;
      const isAuth = type.startsWith('auth.');
      if (!ctx.userId && !isAuth) return sendError(conn, 'not-authenticated', 'Sign in first.');
      const bucket = isAuth ? 'auth' : type.startsWith('webrtc.') || type.startsWith('call.') ? 'webrtc' : rl.take(type) ? type : 'default';
      if (!rl.take(bucket)) return sendError(conn, 'rate-limited', 'Slow down a little.', type);
      try {
        await handlers[type](conn, msg, ctx);
      } catch (e) {
        console.error('[anleet] handler error', type, e.stack || e.message);
        // Surface typed errors (username-taken, dms-closed, ...) to the client.
        sendError(conn, e.code || 'server-error', e.code ? e.message : 'Something failed on our side.', type);
      }
    };

    conn.onclose = async () => {
      clearTimeout(authTimer);
      ctx.userId = conn.__userId;
      if (!ctx.userId) return;
      const set = sessions.get(ctx.userId);
      set?.delete(conn);
      if (set && set.size === 0) {
        sessions.delete(ctx.userId);
        ctx.room = null;
        // Fail any active calls involving this user — no zombie sessions (§59).
        for (const [callId, call] of activeCalls) {
          if (call.from === ctx.userId || call.to === ctx.userId) {
            activeCalls.delete(callId);
            const peer = call.from === ctx.userId ? call.to : call.from;
            sendTo(peer, encode('call.ended', { callId, reason: 'disconnect' }));
          }
        }
        // Grace period: presence TTL keeps the user "online" briefly across reconnects.
        setTimeout(async () => {
          if (!sessions.has(ctx.userId)) {
            await store.deletePresence(ctx.userId);
            const friends = await store.getFriendIds(ctx.userId);
            for (const fid of friends) await sendTo(fid, encode('presence.offline', { userId: ctx.userId }));
          }
        }, PRESENCE_TTL_MS);
      }
    };
  },
});

// Presence heartbeat sweep (event-driven, single timer — §56).
setInterval(() => {
  const now = Date.now();
  for (const [uid, ts] of lastSeen) {
    if (sessions.has(uid)) { lastSeen.set(uid, now); continue; }
    if (now - ts > PRESENCE_TTL_MS * 2) lastSeen.delete(uid);
  }
}, 30_000).unref();

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[anleet] signaling server on :${PORT} (store: ${storeMode}, protocol v${PROTOCOL_VERSION})`);
});
