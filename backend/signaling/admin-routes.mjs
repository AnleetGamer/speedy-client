/**
 * Speedy Admin Routes & Telemetry Ingestion Hub
 * 
 * - Admin credentials hardcoded per requirement:
 *     email: hausdhajt235@gmail.com
 *     pass:  yo32156%23414@#$@
 * - SSE Live Stream: /api/admin/live-stream (pushes online/offline, downloads, errors, startup, shutdown)
 * - Telemetry Batch Ingestion: POST /api/telemetry/batch (50MB cap check)
 * - Turso Persistent Error Center:
 *     GET  /api/admin/errors (search & filter)
 *     GET  /api/admin/errors/export (download JSON/CSV reports)
 *     POST /api/admin/errors/clear (clear resolved errors)
 * - Active Launcher Tracking:
 *     Tracks live desktop clients, device IDs, platforms, and uptimes.
 * - Persistent Stream Buffer:
 *     Keeps last 250 admin logs in memory so reloads never lose activity logs.
 */
import crypto from 'node:crypto';

const ADMIN_EMAIL = 'hausdhajt235@gmail.com';
const ADMIN_PASSWORD = 'yo32156%23414@#$@';

const adminSessions = new Set(); // token strings
const sseClients = new Set(); // res objects

// Live active desktop launchers: deviceId -> { deviceId, platform, arch, version, firstSeen, lastSeen, status }
const activeLaunchers = new Map();

// Ring buffer of recent admin activity logs so they persist across page reloads
const recentAdminLogs = [];

function recordAdminLog(entry) {
  recentAdminLogs.push(entry);
  if (recentAdminLogs.length > 250) recentAdminLogs.shift();
}

// 50 MB limit in bytes
export const MAX_TELEMETRY_BYTES = 50 * 1024 * 1024;

// Periodic cleanup of inactive launchers (if no batch or ping received for > 90 seconds)
setInterval(() => {
  const cutoff = Date.now() - 90 * 1000;
  for (const [id, info] of activeLaunchers.entries()) {
    if (info.lastSeen < cutoff) {
      activeLaunchers.delete(id);
      broadcastAdminEvent('shutdown', { deviceId: id, reason: 'timeout', activeLaunchers: activeLaunchers.size });
    }
  }
}, 15_000);

export function broadcastAdminEvent(type, payload) {
  const ts = payload?._ts || payload?.ts || Date.now();
  recordAdminLog({ type, payload, ts });

  if (sseClients.size === 0) return;
  const data = `event: ${type}\ndata: ${JSON.stringify({ ...payload, _ts: ts })}\n\n`;
  for (const client of sseClients) {
    try {
      client.write(data);
    } catch {
      sseClients.delete(client);
    }
  }
}

export function handleAdminAndTelemetry(req, res, { store, sessions, SECRET }) {
  const reqUrl = new URL(req.url || '/', 'http://localhost');
  const url = reqUrl.pathname;
  const method = req.method || 'GET';

  // Helper for json responses — MUST return true so callers
  // that do `return json(...)` propagate a truthy value back to
  // server.mjs, preventing the fall-through to serveStatic.
  function json(status, data) {
    res.writeHead(status, {
      'content-type': 'application/json',
      'access-control-allow-origin': '*',
      'access-control-allow-headers': 'Content-Type, Authorization',
    });
    res.end(JSON.stringify(data));
    return true;
  }

  // Pre-flight CORS
  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET, POST, OPTIONS, DELETE',
      'access-control-allow-headers': 'Content-Type, Authorization',
    });
    res.end();
    return true;
  }

  // Admin route authentication helper
  function checkAdminAuth() {
    const queryToken = reqUrl.searchParams.get('token');
    const authHeader = req.headers['authorization'] || '';
    const token = queryToken || authHeader.replace(/^Bearer\s+/i, '').trim();
    if (token && adminSessions.has(token)) return true;
    return false;
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

  // 2. Direct Instant Shutdown Signal (Fast exit)
  if (url === '/api/telemetry/shutdown' && method === 'POST') {
    readJsonBody(req, (err, body) => {
      const devId = body?.deviceId;
      if (devId && activeLaunchers.has(devId)) {
        activeLaunchers.delete(devId);
        broadcastAdminEvent('shutdown', {
          deviceId: devId,
          uptimeSeconds: body?.uptimeSeconds,
          activeLaunchers: activeLaunchers.size,
        });
      }
      return json(200, { ok: true, activeLaunchers: activeLaunchers.size });
    });
    return true;
  }

  // 3. Telemetry Batch Ingestion
  if (url === '/api/telemetry/batch' && method === 'POST') {
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

        // Process lifecycle events & update active launchers
        for (const ev of events) {
          const devId = ev.deviceId || ev.payload?.deviceId || 'anonymous-client';
          if (ev.type === 'launcher_startup') {
            activeLaunchers.set(devId, {
              deviceId: devId,
              platform: ev.payload?.platform || 'windows',
              arch: ev.payload?.arch || 'x64',
              version: ev.payload?.version || '1.0.0',
              firstSeen: ev.ts || Date.now(),
              lastSeen: Date.now(),
              status: 'online',
            });
            broadcastAdminEvent('startup', {
              deviceId: devId,
              platform: ev.payload?.platform,
              version: ev.payload?.version,
              activeLaunchers: activeLaunchers.size,
            });
          } else if (ev.type === 'launcher_shutdown') {
            activeLaunchers.delete(devId);
            broadcastAdminEvent('shutdown', {
              deviceId: devId,
              uptimeSeconds: ev.payload?.uptimeSeconds,
              activeLaunchers: activeLaunchers.size,
            });
          } else if (ev.type === 'launcher_heartbeat') {
            if (activeLaunchers.has(devId)) {
              activeLaunchers.get(devId).lastSeen = Date.now();
            } else if (devId !== 'anonymous-client') {
              activeLaunchers.set(devId, {
                deviceId: devId,
                platform: ev.payload?.platform || 'windows',
                arch: ev.payload?.arch || 'x64',
                version: ev.payload?.version || '1.0.0',
                firstSeen: ev.ts || Date.now(),
                lastSeen: Date.now(),
                status: 'online',
              });
              broadcastAdminEvent('startup', {
                deviceId: devId,
                platform: ev.payload?.platform || 'windows',
                version: ev.payload?.version || '1.0.0',
                activeLaunchers: activeLaunchers.size,
              });
            }
          } else {
            // General event — refresh lastSeen if device is tracked
            if (activeLaunchers.has(devId)) {
              activeLaunchers.get(devId).lastSeen = Date.now();
            }
          }
        }

        // Notify active dashboard viewers live
        if (errors.length > 0) {
          for (const errorItem of errors) {
            broadcastAdminEvent('error', errorItem);
          }
        }
        if (downloads.length > 0) {
          for (const dl of downloads) {
            broadcastAdminEvent('download', dl);
          }
        }
        if (events.length > 0) {
          broadcastAdminEvent('events', { count: events.length, activeLaunchers: activeLaunchers.size });
        }

        return json(200, { ok: true, processed: events.length + errors.length + downloads.length });
      } catch (e) {
        return json(500, { error: e.message });
      }
    });
    return true;
  }

  // 4. Admin Metrics Summary API (Includes total users, active launchers, and persisted log buffer)
  if (url === '/api/admin/metrics' && method === 'GET') {
    if (!checkAdminAuth()) return json(401, { error: 'Unauthorized' });
    store.getMetricsSummary().then((summary) => {
      json(200, {
        ...summary,
        onlineUsers: sessions.size,
        onlineLaunchers: activeLaunchers.size,
        activeLaunchersList: [...activeLaunchers.values()],
        onlineUserIds: [...sessions.keys()],
        recentLogs: recentAdminLogs.slice(-150),
      });
    }).catch((e) => json(500, { error: e.message }));
    return true;
  }

  // 5. Admin Error Center — List & Search from Turso
  if (url === '/api/admin/errors' && method === 'GET') {
    if (!checkAdminAuth()) return json(401, { error: 'Unauthorized' });
    const limit = Math.min(Number(reqUrl.searchParams.get('limit') || 200), 500);
    const search = (reqUrl.searchParams.get('search') || '').toLowerCase().trim();
    const subsystem = reqUrl.searchParams.get('subsystem') || '';

    store.listAllErrors(limit).then((errors) => {
      let filtered = errors;
      if (subsystem) {
        filtered = filtered.filter(e => e.subsystem === subsystem);
      }
      if (search) {
        filtered = filtered.filter(e => 
          (e.message && e.message.toLowerCase().includes(search)) ||
          (e.stack && e.stack.toLowerCase().includes(search)) ||
          (e.subsystem && e.subsystem.toLowerCase().includes(search))
        );
      }
      json(200, { errors: filtered, total: filtered.length });
    }).catch((e) => json(500, { error: e.message }));
    return true;
  }

  // 6. Admin Error Center — Export / Download Reports from Turso
  if (url === '/api/admin/errors/export' && method === 'GET') {
    if (!checkAdminAuth()) return json(401, { error: 'Unauthorized' });
    const format = reqUrl.searchParams.get('format') || 'json';

    store.listAllErrors(1000).then((errors) => {
      const dateTag = new Date().toISOString().slice(0, 10);
      if (format === 'csv') {
        const header = 'ID,Timestamp,Date,Subsystem,Level,Message,Stack\n';
        const rows = errors.map(e => {
          const esc = (val) => `"${String(val || '').replace(/"/g, '""').replace(/\n/g, ' ')}"`;
          return [
            esc(e.id),
            e.ts,
            esc(new Date(e.ts).toISOString()),
            esc(e.subsystem),
            esc(e.level),
            esc(e.message),
            esc(e.stack)
          ].join(',');
        }).join('\n');

        res.writeHead(200, {
          'content-type': 'text/csv; charset=utf-8',
          'content-disposition': `attachment; filename="speedy-errors-${dateTag}.csv"`,
          'access-control-allow-origin': '*',
        });
        res.end(header + rows);
        return;
      }

      // Default JSON download
      const jsonStr = JSON.stringify({
        exportedAt: new Date().toISOString(),
        totalErrors: errors.length,
        errors,
      }, null, 2);

      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'content-disposition': `attachment; filename="speedy-errors-${dateTag}.json"`,
        'access-control-allow-origin': '*',
      });
      res.end(jsonStr);
    }).catch((e) => json(500, { error: e.message }));
    return true;
  }

  // 7. Admin Error Center — Clear All Errors
  if (url === '/api/admin/errors/clear' && (method === 'POST' || method === 'DELETE')) {
    if (!checkAdminAuth()) return json(401, { error: 'Unauthorized' });
    store.clearAllErrors().then(() => {
      broadcastAdminEvent('errors_cleared', { ts: Date.now() });
      json(200, { ok: true, message: 'All errors cleared from Turso' });
    }).catch((e) => json(500, { error: e.message }));
    return true;
  }

  // 8. Admin Downloads List API
  if (url === '/api/admin/downloads' && method === 'GET') {
    if (!checkAdminAuth()) return json(401, { error: 'Unauthorized' });
    const limit = Math.min(Number(reqUrl.searchParams.get('limit') || 100), 200);
    store.listRecentDownloads(limit).then((downloads) => {
      json(200, { downloads, total: downloads.length });
    }).catch((e) => json(500, { error: e.message }));
    return true;
  }

  // 9. Admin Live SSE Stream
  if (url === '/api/admin/live-stream' && method === 'GET') {
    if (!checkAdminAuth()) {
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
    res.write(`event: connected\ndata: ${JSON.stringify({
      status: 'connected',
      onlineUsers: sessions.size,
      onlineLaunchers: activeLaunchers.size,
      ts: Date.now()
    })}\n\n`);

    // Replay recent buffered events so dashboard immediately has latest live activity
    for (const logItem of recentAdminLogs) {
      try {
        res.write(`event: ${logItem.type}\ndata: ${JSON.stringify({ ...logItem.payload, _ts: logItem.ts })}\n\n`);
      } catch {}
    }

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
