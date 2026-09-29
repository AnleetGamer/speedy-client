/**
 * Anleet wire protocol — every message crossing the WebSocket (signaling) or
 * the local launcher<->mod bridge is validated against these schemas.
 */
import { v, check } from './schema.mjs';

export const MAX_MESSAGE_BYTES = 256 * 1024;      // hard cap per message
export const PROTOCOL_VERSION = 1;

const Username = v.string({ min: 3, max: 24, pattern: /^[a-zA-Z0-9_]+$/ });
const Id64 = v.string({ min: 1, max: 128, pattern: /^[A-Za-z0-9_-]+$/ });
const Timestamp = v.number({ min: 0, max: 8.64e15, int: true });

const PresenceField = v.optional(
  v.object({
    playing: v.boolean(),
    status: v.optional(v.string({ max: 120 })),
    server: v.optional(v.string({ max: 120 })),
    mode: v.optional(v.string({ max: 60 })),
    world: v.optional(v.string({ max: 120 })),
    worldDay: v.optional(v.number({ min: 0, max: 1e7, int: true })),
    lobby: v.optional(v.string({ max: 60 })),
    players: v.optional(v.number({ min: 0, max: 1e6, int: true })),
    launcherOpen: v.boolean(),
    inGame: v.boolean(),
  }, { strict: false }),
);

export const CLIENT_MESSAGES = {
  'auth.hello': v.object({ proto: v.number({ int: true }) }),
  'auth.register': v.object({ username: Username, password: v.string({ min: 8, max: 256 }) }),
  'auth.login': v.object({ username: Username, password: v.string({ min: 8, max: 256 }) }),
  'auth.token': v.object({ token: v.string({ min: 16, max: 512 }) }),

  'presence.update': PresenceField,

  'friend.request': v.object({ username: Username, message: v.optional(v.string({ max: 200 })) }),
  'friend.respond': v.object({ requestId: Id64, accept: v.boolean() }),
  'friend.remove': v.object({ userId: Id64 }),
  'friend.list': v.object({}),

  'block.add': v.object({ userId: Id64 }),
  'block.remove': v.object({ userId: Id64 }),
  'block.list': v.object({}),

  'dm.send': v.object({
    to: Id64,
    kind: v.string({ max: 10, pattern: /^(text|image|file)$/ }),
    body: v.string({ min: 1, max: 4000 }),
    meta: v.optional(v.object({ name: v.string({ max: 200 }), size: v.number({ min: 0, max: 5e8 }) }, { strict: false })),
  }),
  'dm.backlog': v.object({ with: Id64, before: v.optional(v.number({ int: true })), limit: v.optional(v.number({ int: true, min: 1, max: 200 })) }),
  'dm.receipt': v.object({ messageId: Id64, state: v.string({ max: 10, pattern: /^(seen|delivered)$/ }) }),
  'typing': v.object({ conversationId: Id64 }),

  'group.create': v.object({ name: v.string({ min: 1, max: 80 }), members: v.array(Username, { max: 32 }) }),
  'group.msg': v.object({ groupId: Id64, body: v.string({ min: 1, max: 4000 }) }),
  'group.invite': v.object({ groupId: Id64, username: Username }),
  'group.join': v.object({ groupId: Id64 }),
  'group.leave': v.object({ groupId: Id64 }),

  'room.join': v.object({ groupId: Id64 }),
  'room.leave': v.object({}),
  'room.roster': v.object({ groupId: Id64 }),

  'call.invite': v.object({ to: Id64, media: v.string({ max: 10, pattern: /^(voice|screen)$/ }) }),
  'call.accept': v.object({ callId: Id64 }),
  'call.reject': v.object({ callId: Id64 }),
  'call.end': v.object({ callId: Id64 }),
  'webrtc.offer': v.object({ callId: Id64, sdp: v.string({ max: 64 * 1024 }) }),
  'webrtc.answer': v.object({ callId: Id64, sdp: v.string({ max: 64 * 1024 }) }),
  'webrtc.ice': v.object({ callId: Id64, candidate: v.any() }),

  'invite.minecraft': v.object({ to: Id64, instance: v.string({ max: 80 }), address: v.optional(v.string({ max: 200 })), message: v.optional(v.string({ max: 200 })) }),
  'invite.respond': v.object({ inviteId: Id64, accept: v.boolean() }),

  'privacy.set': v.object({ key: v.string({ max: 40 }), value: v.any() }),
  'privacy.get': v.object({}),
  'notifications.get': v.object({}),
  'notifications.clear': v.object({ id: v.optional(Id64) }),
  'ping': v.object({ t: v.number({ int: true }) }),
};

export const SERVER_MESSAGES = {
  'auth.ok': v.object({ userId: Id64, username: Username, token: v.string({ max: 512 }) }),
  'auth.error': v.object({ code: v.string({ max: 40 }), detail: v.string({ max: 200 }) }),
  'ready': v.object({ userId: Id64, username: Username, friends: v.array(v.any(), { max: 500 }), requests: v.array(v.any(), { max: 200 }), groups: v.array(v.any(), { max: 200 }), undelivered: v.array(v.any(), { max: 500 }) }),
  'presence.snapshot': v.object({ userId: Id64, presence: PresenceField }),
  'presence.offline': v.object({ userId: Id64 }),
  'friend.request.new': v.object({ requestId: Id64, from: Id64, fromName: Username, message: v.optional(v.string({ max: 200 })) }),
  'friend.request.resolved': v.object({ requestId: Id64, accepted: v.boolean(), by: Id64, byName: Username }),
  'friend.removed': v.object({ userId: Id64 }),
  'dm.new': v.object({ messageId: Id64, conversationId: Id64, from: Id64, fromName: Username, body: v.string({ max: 4000 }), kind: v.string({ max: 10 }), meta: v.any(), ts: Timestamp }),
  'dm.ack': v.object({ tempId: v.any(), messageId: Id64, conversationId: Id64, ts: Timestamp }),
  'dm.backlog': v.object({ with: Id64, messages: v.array(v.any(), { max: 200 }) }),
  'dm.receipt': v.object({ messageId: Id64, by: Id64 }),
  'typing': v.object({ conversationId: Id64, from: Id64, fromName: Username }),
  'group.new': v.object({ groupId: Id64, name: v.string({ max: 80 }), members: v.array(v.any(), { max: 64 }) }),
  'group.msg': v.object({ messageId: Id64, groupId: Id64, from: Id64, fromName: Username, body: v.string({ max: 4000 }), ts: Timestamp }),
  'group.roster': v.object({ groupId: Id64, members: v.array(v.any(), { max: 64 }) }),
  'group.invited': v.object({ groupId: Id64, name: v.string({ max: 80 }), byName: Username }),
  'room.state': v.object({ groupId: Id64, members: v.array(v.any(), { max: 64 }) }),
  'call.incoming': v.object({ callId: Id64, from: Id64, fromName: Username, media: v.string({ max: 10 }) }),
  'call.accepted': v.object({ callId: Id64, by: Id64 }),
  'call.rejected': v.object({ callId: Id64, by: Id64 }),
  'call.ended': v.object({ callId: Id64, reason: v.string({ max: 40 }) }),
  'webrtc.offer': v.object({ callId: Id64, from: Id64, sdp: v.string({ max: 64 * 1024 }) }),
  'webrtc.answer': v.object({ callId: Id64, from: Id64, sdp: v.string({ max: 64 * 1024 }) }),
  'webrtc.ice': v.object({ callId: Id64, from: Id64, candidate: v.any() }),
  'invite.minecraft.new': v.object({ inviteId: Id64, from: Id64, fromName: Username, instance: v.string({ max: 80 }), address: v.optional(v.string({ max: 200 })), message: v.optional(v.string({ max: 200 })) }),
  'invite.minecraft.resolved': v.object({ inviteId: Id64, accepted: v.boolean() }),
  'privacy.state': v.object({ settings: v.any() }),
  'notifications.list': v.object({ items: v.array(v.any(), { max: 200 }) }),
  'notification.new': v.object({ id: Id64, kind: v.string({ max: 40 }), title: v.string({ max: 120 }), body: v.optional(v.string({ max: 300 })), ts: Timestamp }),
  'error': v.object({ code: v.string({ max: 40 }), detail: v.optional(v.string({ max: 300 })), of: v.optional(v.string({ max: 40 })) }),
  'pong': v.object({ t: v.number({ int: true }) }),
};

/** Validate and decode one inbound message. Returns {ok, type, msg} or {ok:false, reason}. */
export function decode(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return { ok: false, reason: 'empty' };
  if (Buffer.byteLength(raw, 'utf8') > MAX_MESSAGE_BYTES) return { ok: false, reason: 'too-large' };
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return { ok: false, reason: 'bad-json' }; }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return { ok: false, reason: 'bad-shape' };
  const type = parsed.t;
  if (typeof type !== 'string') return { ok: false, reason: 'no-type' };
  const schema = CLIENT_MESSAGES[type];
  if (!schema) return { ok: false, reason: 'unknown-type' };
  const result = check(schema, parsed);
  if (!result.ok) return { ok: false, reason: 'invalid', errors: result.errors };
  return { ok: true, type, msg: parsed };
}

/** Encode an outbound message; throws on schema violation so bugs surface in dev. */
export function encode(type, msg) {
  const schema = SERVER_MESSAGES[type] || CLIENT_MESSAGES[type];
  if (!schema) throw new Error('unknown message type: ' + type);
  const result = check(schema, { t: type, ...msg });
  if (!result.ok) throw new Error('bad message ' + type + ': ' + JSON.stringify(result.errors.slice(0, 3)));
  return JSON.stringify({ t: type, ...msg });
}
