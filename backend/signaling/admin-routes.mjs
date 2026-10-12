/**
 * Speedy Admin Routes & Telemetry Ingestion Hub
 * 
 * - Admin credentials hardcoded per requirement:
 *     email: hausdhajt235@gmail.com
 *     pass:  yo32156%23414@#$@
 * - SSE Live Stream: /api/admin/live-stream (pushes online/offline, downloads, errors)
 * - Telemetry Batch Ingestion: POST /api/telemetry/batch (50MB cap check)
 */
import crypto from 'node:crypto';

const ADMIN_EMAIL = 'hausdhajt235@gmail.com';
const ADMIN_PASSWORD = 'yo32156%23414@#$@';

const adminSessions = new Set(); // token strings
const sseClients = new Set(); // res objects

// 50 MB limit in bytes
export const MAX_TELEMETRY_BYTES = 50 * 1024 * 1024;

export function broadcastAdminEvent(type, payload) {
  if (sseClients.size === 0) return;
  const data = `event: ${type}\ndata: ${JSON.stringify({ ...payload, _ts: Date.now() })}\n\n`;
  for (const client of sseClients) {
    try {
      client.write(data);
    } catch {
      sseClients.delete(client);
    }
  }
}

export function handleAdminAndTelemetry(req, res, { store, sessions, SECRET }) {
  const url = (req.url || '/').split('?')[0];
  const method = req.method || 'GET';

  // Helper for json responses
  function json(status, data) {
    res.writeHead(status, {
      'content-type': 'application/json',
      'access-control-allow-origin': '*',
      'access-control-allow-headers': 'Content-Type, Authorization',
    });
    res.end(JSON.stringify(data));
  }

  // Pre-flight CORS
  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'access-control-allow-headers': 'Content-Type, Authorization',
    });
    res.end();
    return true;
  }

  // 1. Admin Login API
  if (url === '/api/admin/login' && method === 'POST') {
    readJsonBody(req, (err, body) => {
      if (err) return json(400, { error: 'Invalid JSON' });
      const { email, password } = body || {};
      if (email === ADMIN_EMAIL && password === ADMIN_PASSWORD) {
        const token = crypto.randomBytes(32).toString('hex');
        adminSessions.add(token);
        return json(200, { ok: true, token, email: ADMIN_EMAIL });
      }
      return json(401, { error: 'Invalid admin credentials' });
    });
    return true;
  }

  // 2. Telemetry Batch Ingestion
  if (url === '/api/telemetry/batch' && method === 'POST') {
    // Check Content-Length header up front
    const contentLength = Number(req.headers['content-length'] || 0);
    if (contentLength > MAX_TELEMETRY_BYTES) {
      return json(413, { error: 'Payload exceeds 50MB safety limit' });
    }

    readJsonBody(req, async (err, payload) => {
      if (err) {
        if (err.message === 'TOO_LARGE') return json(413, { error: 'Payload exceeds 50MB safety limit' });
        return json(400, { error: 'Invalid JSON batch' });
      }

      const { events = [], errors = [], downloads = [] } = payload || {};
      try {
        await store.recordTelemetryBatch({ events, errors, downloads });

        // Notify active dashboard viewers live
        if (errors.length > 0) {
          for (const errorItem of errors) {
            broadcastAdminEvent('error', errorItem);
          }
        }
        if (downloads.length > 0) {
          broadcastAdminEvent('downloads', { count: downloads.length, recent: downloads });
        }
        if (events.length > 0) {
          broadcastAdminEvent('events', { count: events.length });
        }

        return json(200, { ok: true, processed: events.length + errors.length + downloads.length });
      } catch (e) {
        return json(500, { error: e.message });
      }
    });
    return true;
  }

  // Admin route authentication helper
  function checkAdminAuth() {
    const authHeader = req.headers['authorization'] || '';
    const token = authHeader.replace(/^Bearer\s+/i, '').trim();
    if (token && adminSessions.has(token)) return true;
    return false;
  }

  // 3. Admin Metrics Summary API
  if (url === '/api/admin/metrics' && method === 'GET') {
    if (!checkAdminAuth()) return json(401, { error: 'Unauthorized' });
    store.getMetricsSummary().then((summary) => {
      json(200, {
        ...summary,
        onlineUsers: sessions.size,
        onlineUserIds: [...sessions.keys()],
      });
    }).catch((e) => json(500, { error: e.message }));
    return true;
  }

  // 4. Admin Live SSE Stream
  if (url === '/api/admin/live-stream' && method === 'GET') {
    // Check query token or authorization
    const queryToken = new URL(req.url, 'http://localhost').searchParams.get('token');
    const authHeader = req.headers['authorization'] || '';
    const token = queryToken || authHeader.replace(/^Bearer\s+/i, '').trim();

    if (!token || !adminSessions.has(token)) {
      res.writeHead(401, { 'content-type': 'text/plain' });
      res.end('Unauthorized admin stream');
      return true;
    }

    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      'connection': 'keep-alive',
      'access-control-allow-origin': '*',
    });
    res.write(`event: connected\ndata: ${JSON.stringify({ status: 'connected', onlineUsers: sessions.size, ts: Date.now() })}\n\n`);

    sseClients.add(res);

    // Keep Render awake by sending a ping comment every 45s
    const pingTimer = setInterval(() => {
      try { res.write(': heartbeat\n\n'); } catch { clearInterval(pingTimer); }
    }, 45_000);

    req.on('close', () => {
      clearInterval(pingTimer);
      sseClients.delete(res);
    });
    return true;
  }

  return false;
}

function readJsonBody(req, cb) {
  let bytes = 0;
  const chunks = [];
  req.on('data', (chunk) => {
    bytes += chunk.length;
    if (bytes > MAX_TELEMETRY_BYTES) {
      req.destroy();
      return cb(new Error('TOO_LARGE'));
    }
    chunks.push(chunk);
  });
  req.on('end', () => {
    try {
      const text = Buffer.concat(chunks).toString('utf8');
      const obj = text ? JSON.parse(text) : {};
      cb(null, obj);
    } catch (e) {
      cb(e);
    }
  });
}
