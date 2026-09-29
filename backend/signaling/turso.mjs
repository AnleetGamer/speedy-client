/**
 * Turso (libSQL) HTTP client — pure fetch, zero dependencies, no native
 * modules. The signaling server is the ONLY component that holds these
 * credentials; launchers never talk to the database directly.
 */
export function createTurso({ url, token, timeoutMs = 8000, retries = 2 }) {
  if (!url) throw new Error('Turso: TURSO_DATABASE_URL is required');
  const base = url.replace(/^libsql:\/\//i, 'https://').replace(/\/+$/, '');

  async function once(requests) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(base + '/v2/pipeline', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ requests: requests.map(toRequest) }),
        signal: ctrl.signal,
      });
      if (!res.ok) throw new Error(`Turso HTTP ${res.status}`);
      const body = await res.json();
      return body.results.map((r) => {
        if (r.type === 'error') throw new Error('Turso: ' + (r.error?.message || 'query error'));
        return r.response?.result ?? { rows: [] };
      });
    } finally {
      clearTimeout(t);
    }
  }

  async function exec(sql, args = []) {
    let lastErr;
    for (let i = 0; i <= retries; i++) {
      try {
        const [result] = await once([{ sql, args }]);
        return result;
      } catch (e) {
        lastErr = e;
        await new Promise(r => setTimeout(r, 250 * (i + 1)));
      }
    }
    throw lastErr;
  }

  async function batch(stmts) {
    let lastErr;
    for (let i = 0; i <= retries; i++) {
      try { return await once(stmts); } catch (e) { lastErr = e; await new Promise(r => setTimeout(r, 250 * (i + 1))); }
    }
    throw lastErr;
  }

  return { exec, batch };
}

function toRequest(stmt) {
  return {
    type: 'execute',
    stmt: {
      sql: stmt.sql,
      args: (stmt.args || []).map((a) => {
        if (a == null) return { type: 'null', value: null };
        if (typeof a === 'number') return Number.isInteger(a) ? { type: 'integer', value: a } : { type: 'real', value: a };
        if (typeof a === 'boolean') return { type: 'integer', value: a ? 1 : 0 };
        return { type: 'text', value: String(a) };
      }),
    },
  };
}

/** Rows come back as arrays of {type,value} — convert to plain objects. */
export function rowsToObjects(result) {
  const cols = result.cols.map(c => c.name);
  return (result.rows || []).map(row => Object.fromEntries(row.map((cell, i) => [cols[i], cell?.value])));
}
