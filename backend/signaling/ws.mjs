/**
 * Minimal RFC 6455 WebSocket implementation — server + client.
 * Zero dependencies (no `ws` package) so the signaling server runs anywhere
 * Node runs, with no native compilation and nothing to build.
 * TLS termination (wss://) is handled by the edge (Render) in production.
 */
import crypto from 'node:crypto';
import net from 'node:net';
import http from 'node:http';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/** Frame encoder. */
function encodeFrame(opcode, payload, masked = false, maskKey = null) {
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  header[0] = 0x80 | opcode; // FIN + opcode
  if (masked) {
    header[1] |= 0x80;
    const key = maskKey ?? crypto.randomBytes(4);
    const maskedPayload = Buffer.from(payload);
    for (let i = 0; i < maskedPayload.length; i++) maskedPayload[i] ^= key[i % 4];
    return Buffer.concat([header, key, maskedPayload]);
  }
  return Buffer.concat([header, payload]);
}

/** Incremental frame parser. */
function createParser({ maxPayload, onFrame, onClose }) {
  let buf = Buffer.alloc(0);
  let fragOpcode = null;
  let fragBuf = Buffer.alloc(0);
  return {
    feed(chunk) {
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
      for (;;) {
        if (buf.length < 2) return;
        const fin = (buf[0] & 0x80) !== 0;
        const opcode = buf[0] & 0x0f;
        const masked = (buf[1] & 0x80) !== 0;
        let len = buf[1] & 0x7f;
        let off = 2;
        if (len === 126) {
          if (buf.length < 4) return;
          len = buf.readUInt16BE(2); off = 4;
        } else if (len === 127) {
          if (buf.length < 10) return;
          const big = buf.readBigUInt64BE(2);
          if (big > BigInt(maxPayload)) { onClose(1009); return; }
          len = Number(big); off = 10;
        }
        if (len > maxPayload) { onClose(1009); return; }
        const maskKey = masked ? buf.subarray(off, off + 4) : null;
        if (masked) off += 4;
        if (buf.length < off + len) return;
        let payload = buf.subarray(off, off + len);
        if (masked) {
          const un = Buffer.from(payload);
          for (let i = 0; i < un.length; i++) un[i] ^= maskKey[i % 4];
          payload = un;
        }
        buf = buf.subarray(off + len);
        if (opcode === 0) { // continuation
          fragBuf = Buffer.concat([fragBuf, payload]);
          if (fin) { onFrame(fragOpcode, fragBuf); fragOpcode = null; fragBuf = Buffer.alloc(0); }
        } else if (opcode === 1 || opcode === 2) {
          if (!fin) { fragOpcode = opcode; fragBuf = Buffer.from(payload); }
          else onFrame(opcode, payload);
        } else {
          onFrame(opcode, payload); // ping/pong/close passthrough
        }
      }
    },
  };
}

/** Attach a WebSocket endpoint to an HTTP server. */
export function attachWebSocketServer(httpServer, { path = '/ws', maxPayload = 256 * 1024, onConnection }) {
  httpServer.on('upgrade', (req, socket) => {
    if ((req.url || '').split('?')[0] !== path) { socket.destroy(); return; }
    const key = req.headers['sec-websocket-key'];
    if (!key || (req.headers.upgrade || '').toLowerCase() !== 'websocket') { socket.destroy(); return; }
    const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    socket.setNoDelay(true);
    const conn = makeConnection(socket, maxPayload);
    onConnection(conn, req);
  });
}

function makeConnection(socket, maxPayload) {
  let open = true;
  const parser = createParser({
    maxPayload,
    onFrame(opcode, payload) {
      if (!open) return;
      if (opcode === 8) { // close
        conn.emitClose(1000);
      } else if (opcode === 9) { // ping -> pong
        socket.write(encodeFrame(10, payload));
      } else if (opcode === 10) {
        conn.onpong?.();
      } else if (opcode === 1 || opcode === 2) {
        conn.onmessage?.(opcode === 1 ? payload.toString('utf8') : payload);
      }
    },
    onClose(code) { conn.emitClose(code); },
  });
  socket.on('data', (c) => { try { parser.feed(c); } catch { conn.emitClose(1002); } });
  socket.on('error', () => conn.emitClose(1011));
  socket.on('close', () => conn.emitClose(1006));
  socket.on('end', () => conn.emitClose(1006));

  const conn = {
    get readyState() { return open && !socket.destroyed ? 1 : 3; },
    onmessage: null,
    onclose: null,
    onpong: null,
    send(data) {
      if (!open) return;
      const payload = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
      if (payload.length > maxPayload) return;
      try { socket.write(encodeFrame(1, payload)); } catch { conn.emitClose(1011); }
    },
    ping() { try { socket.write(encodeFrame(9, Buffer.alloc(0))); } catch { /* socket gone */ } },
    close(code = 1000) {
      if (!open) return;
      const body = Buffer.alloc(2);
      body.writeUInt16BE(code);
      try { socket.write(encodeFrame(8, body)); } catch { /* socket gone */ }
      conn.emitClose(code);
    },
    emitClose(code) {
      if (!open) return;
      open = false;
      try {
        const body = Buffer.alloc(2);
        body.writeUInt16BE(code);
        socket.write(encodeFrame(8, body));
      } catch { /* already gone */ }
      try { socket.end(); } catch { /* already gone */ }
      try { socket.destroy(); } catch { /* already gone */ }
      conn.onclose?.(code);
    },
  };
  return conn;
}

/** Plain ws:// client (used by tests and tooling). Browsers/Electron use native WebSocket. */
export function connectWebSocket(rawUrl, { headers = {} } = {}) {
  const url = new URL(rawUrl);
  const secure = url.protocol === 'wss:';
  if (secure) throw new Error('wss not supported by test client; use native WebSocket');
  const key = crypto.randomBytes(16).toString('base64');
  const req = http.request({
    host: url.hostname,
    port: url.port || 80,
    path: url.pathname + url.search,
    headers: {
      Connection: 'Upgrade', Upgrade: 'websocket',
      'Sec-WebSocket-Key': key, 'Sec-WebSocket-Version': '13', ...headers,
    },
  });
  const conn = {
    readyState: 0,
    onmessage: null, onclose: null, onopen: null,
    send(data) {
      if (conn.readyState !== 1) return;
      const payload = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
      // encodeFrame applies the mask itself — do not pre-mask here.
      const mask = crypto.randomBytes(4);
      try { socket.write(encodeFrame(1, payload, true, mask)); } catch { /* gone */ }
    },
    close() {
      if (conn.readyState !== 1) return;
      conn.readyState = 3;
      const mask = crypto.randomBytes(4);
      const body = Buffer.alloc(2);
      try { socket.write(encodeFrame(8, body, true, mask)); } catch { /* gone */ }
      socket.end();
      conn.onclose?.(1000);
    },
  };
  let socket;
  req.on('upgrade', (res, sock, head) => {
    socket = sock;
    conn.readyState = 1;
    const parser = createParser({
      maxPayload: 1024 * 1024,
      onFrame(op, payload) {
        if (op === 8) {
          conn.readyState = 3;
          const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
          try { socket.end(); } catch { /* gone */ }
          conn.onclose?.(code);
        }
        else if (op === 1) conn.onmessage?.(payload.toString('utf8'));
        else if (op === 2) conn.onmessage?.(payload);
      },
      onClose() { conn.readyState = 3; conn.onclose?.(1006); },
    });
    socket.on('data', (c) => parser.feed(c));
    socket.on('close', () => { if (conn.readyState === 1) { conn.readyState = 3; conn.onclose?.(1006); } });
    socket.on('end', () => { if (conn.readyState === 1) { conn.readyState = 3; conn.onclose?.(1006); } });
    socket.on('error', () => { if (conn.readyState === 1) { conn.readyState = 3; conn.onclose?.(1006); } });
    if (head?.length) parser.feed(head);
    conn.onopen?.();
  });
  req.on('error', (e) => { conn.readyState = 3; conn.onclose?.(1006); });
  req.end();
  return conn;
}

export function wsUrl(req) {
  return `ws://${req.headers.host}${req.url}`;
}
