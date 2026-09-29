/**
 * Anleet protocol kernel — tiny schema validator + rate limiter.
 * Used by the signaling server, the launcher main process, the renderer and
 * (mirrored as Java DTOs) by the Minecraft mods. Zero dependencies.
 */

export const v = {
  string: (opts = {}) => ({ k: 'string', min: opts.min ?? 0, max: opts.max ?? 4096, pattern: opts.pattern }),
  number: (opts = {}) => ({ k: 'number', min: opts.min ?? -Infinity, max: opts.max ?? Infinity, int: !!opts.int }),
  boolean: () => ({ k: 'boolean' }),
  literal: (val) => ({ k: 'literal', val }),
  array: (item, opts = {}) => ({ k: 'array', item, max: opts.max ?? 256 }),
  object: (shape, opts = {}) => ({ k: 'object', shape, strict: !!opts.strict }),
  optional: (inner) => ({ k: 'optional', inner }),
  any: () => ({ k: 'any' }),
};

export function validate(schema, data, path = '$', errors = []) {
  if (schema.k === 'optional') {
    if (data === undefined || data === null) return errors;
    return validate(schema.inner, data, path, errors);
  }
  if (schema.k === 'any') return errors;
  if (schema.k === 'literal') {
    if (data !== schema.val) errors.push({ path, msg: `expected ${JSON.stringify(schema.val)}` });
    return errors;
  }
  if (schema.k === 'string') {
    if (typeof data !== 'string') { errors.push({ path, msg: 'expected string' }); return errors; }
    if (data.length < schema.min) errors.push({ path, msg: `shorter than ${schema.min}` });
    if (data.length > schema.max) errors.push({ path, msg: `longer than ${schema.max}` });
    if (schema.pattern && !schema.pattern.test(data)) errors.push({ path, msg: 'pattern mismatch' });
    return errors;
  }
  if (schema.k === 'number') {
    if (typeof data !== 'number' || Number.isNaN(data)) { errors.push({ path, msg: 'expected number' }); return errors; }
    if (schema.int && !Number.isInteger(data)) errors.push({ path, msg: 'expected integer' });
    if (data < schema.min) errors.push({ path, msg: `below ${schema.min}` });
    if (data > schema.max) errors.push({ path, msg: `above ${schema.max}` });
    return errors;
  }
  if (schema.k === 'boolean') {
    if (typeof data !== 'boolean') errors.push({ path, msg: 'expected boolean' });
    return errors;
  }
  if (schema.k === 'array') {
    if (!Array.isArray(data)) { errors.push({ path, msg: 'expected array' }); return errors; }
    if (data.length > schema.max) { errors.push({ path, msg: `more than ${schema.max} items` }); return errors; }
    data.forEach((item, i) => validate(schema.item, item, `${path}[${i}]`, errors));
    return errors;
  }
  if (schema.k === 'object') {
    if (typeof data !== 'object' || data === null || Array.isArray(data)) { errors.push({ path, msg: 'expected object' }); return errors; }
    for (const [key, sub] of Object.entries(schema.shape)) validate(sub, data[key], `${path}.${key}`, errors);
    if (schema.strict) {
      for (const key of Object.keys(data)) {
        if (!(key in schema.shape)) errors.push({ path: `${path}.${key}`, msg: 'unexpected key' });
      }
    }
    return errors;
  }
  errors.push({ path, msg: 'unknown schema' });
  return errors;
}

export function check(schema, data) {
  const errors = validate(schema, data);
  return errors.length === 0 ? { ok: true, errors } : { ok: false, errors };
}

/** Token-bucket rate limiter (per-connection use). */
export function createRateLimiter(rules) {
  const buckets = new Map();
  return {
    take(name) {
      const rule = rules.find(r => r.name === name);
      if (!rule) return true;
      const now = Date.now();
      let b = buckets.get(name);
      if (!b) { b = { tokens: rule.capacity, last: now }; buckets.set(name, b); }
      b.tokens = Math.min(rule.capacity, b.tokens + ((now - b.last) / 1000) * rule.refillPerSec);
      b.last = now;
      if (b.tokens >= 1) { b.tokens -= 1; return true; }
      return false;
    },
  };
}
