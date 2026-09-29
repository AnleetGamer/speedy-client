/**
 * Anleet identity auth — scrypt password hashing (Node built-in) and HMAC
 * session tokens. No native modules, no external auth service.
 */
import crypto from 'node:crypto';

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return `scrypt$${SCRYPT.N}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(password, stored) {
  try {
    const [scheme, N, salt, hash] = String(stored).split('$');
    if (scheme !== 'scrypt') return false;
    const expect = Buffer.from(hash, 'base64');
    const got = crypto.scryptSync(String(password), Buffer.from(salt, 'base64'), expect.length, { N: +N, r: SCRYPT.r, p: SCRYPT.p });
    return crypto.timingSafeEqual(expect, got);
  } catch {
    return false;
  }
}

/** HMAC-signed session token: base64url(payload).base64url(hmac). */
export function createTokenFactory(secret) {
  const key = Buffer.from(secret, 'utf8');
  return {
    issue(userId, ttlMs = 1000 * 60 * 60 * 24 * 30) {
      const payload = Buffer.from(JSON.stringify({ uid: userId, exp: Date.now() + ttlMs })).toString('base64url');
      const sig = crypto.createHmac('sha256', key).update(payload).digest('base64url');
      return `${payload}.${sig}`;
    },
    verify(token) {
      try {
        const [payload, sig] = String(token).split('.');
        if (!payload || !sig) return null;
        const expect = crypto.createHmac('sha256', key).update(payload).digest('base64url');
        if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return null;
        const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
        if (!data.uid || Date.now() > data.exp) return null;
        return { userId: data.uid };
      } catch {
        return null;
      }
    },
  };
}

export function newId() {
  return crypto.randomUUID().replace(/-/g, '');
}
