-- Anleet social schema (Turso / libSQL). Lightweight metadata ONLY (§57):
-- identity, relationships, conversations, messages, receipts, presence,
-- privacy, notifications. No media, no large blobs, no file storage.
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  pass_hash TEXT NOT NULL,
  created INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  label TEXT,
  last_seen INTEGER
);
CREATE TABLE IF NOT EXISTS friendships (
  a TEXT NOT NULL,
  b TEXT NOT NULL,
  created INTEGER NOT NULL,
  PRIMARY KEY (a, b)
);
CREATE TABLE IF NOT EXISTS friend_requests (
  id TEXT PRIMARY KEY,
  from_id TEXT NOT NULL,
  to_id TEXT NOT NULL,
  message TEXT,
  created INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS blocks (
  blocker TEXT NOT NULL,
  blocked TEXT NOT NULL,
  created INTEGER NOT NULL,
  PRIMARY KEY (blocker, blocked)
);
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,               -- 'direct' | 'group'
  name TEXT,
  created INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS conversation_members (
  conversation_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  joined INTEGER NOT NULL,
  PRIMARY KEY (conversation_id, user_id)
);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  sender_id TEXT NOT NULL,
  body TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'text',
  meta TEXT,
  created INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS message_receipts (
  message_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'delivered',
  at INTEGER,
  PRIMARY KEY (message_id, user_id)
);
CREATE TABLE IF NOT EXISTS presence (
  user_id TEXT PRIMARY KEY,
  payload TEXT,
  updated INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS privacy_settings (
  user_id TEXT PRIMARY KEY,
  settings TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT,
  ts INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS reports (
  id TEXT PRIMARY KEY,
  reporter TEXT NOT NULL,
  target TEXT NOT NULL,
  reason TEXT,
  ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, created);
CREATE INDEX IF NOT EXISTS idx_requests_to ON friend_requests(to_id);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, ts);
