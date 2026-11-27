/**
 * Speedy Client — AI Assistant & Unlimited Crash Helper
 *
 * Supports:
 *   - GEMINI_API_KEY (default model: gemini-2.5-flash)
 *   - OPENAI_API_KEY (OpenAI-compatible /v1/chat/completions, optional AI_BASE_URL & AI_MODEL)
 *
 * Rate limiting:
 *   - mode === 'chat'  : Subject to daily per-device/IP limit (AI_DAILY_CHAT_LIMIT, default 15/day UTC)
 *   - mode === 'crash' : Unlimited (never counts against daily chat quota)
 */

const DAILY_LIMIT = Math.max(1, Number(process.env.AI_DAILY_CHAT_LIMIT || 15));
const usageByDay = new Map(); // key -> { day: 'YYYY-MM-DD', count: number }

function todayUtc() {
  return new Date().toISOString().slice(0, 10);
}

function getUsageKey(deviceId, req) {
  const dev = typeof deviceId === 'string' ? deviceId.trim().slice(0, 64) : '';
  if (dev) return `dev:${dev}`;
  const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  const ip = fwd || req.socket?.remoteAddress || 'anon';
  return `ip:${ip}`;
}

function getUsage(key) {
  const day = todayUtc();
  const entry = usageByDay.get(key);
  if (!entry || entry.day !== day) {
    return { day, count: 0, remaining: DAILY_LIMIT, limit: DAILY_LIMIT };
  }
  const remaining = Math.max(0, DAILY_LIMIT - entry.count);
  return { day, count: entry.count, remaining, limit: DAILY_LIMIT };
}

function incrementUsage(key) {
  const day = todayUtc();
  const cur = usageByDay.get(key);
  const nextCount = (!cur || cur.day !== day) ? 1 : cur.count + 1;
  usageByDay.set(key, { day, count: nextCount });
  // Prune stale days if map grows
  if (usageByDay.size > 10000) {
    for (const [k, v] of usageByDay.entries()) {
      if (v.day !== day) usageByDay.delete(k);
    }
  }
  return { count: nextCount, remaining: Math.max(0, DAILY_LIMIT - nextCount), limit: DAILY_LIMIT };
}

function isConfigured() {
  return Boolean(
    (process.env.GROQ_API_KEY || '').trim() ||
    (process.env.GEMINI_API_KEY || '').trim() ||
    (process.env.OPENAI_API_KEY || '').trim()
  );
}

const CHAT_SYSTEM_PROMPT = `You are Speedy AI, the helpful built-in assistant for Speedy Client (a modern Minecraft Fabric launcher and client).
Be concise, friendly, and practical.
Key Speedy Client features you can help with:
- Launching & Instances: Manage Minecraft 1.8.9 and 1.19.4-1.21.11 Fabric instances in the Instances tab.
- Mods, Shaders, Resource Packs, Modpacks: Install and toggle directly in their tabs.
- Cosmetics & Nametags: Press K in-game to open Cosmetics (capes, 3D hats/wings). Speedy Client players see each other's nametag logos and cosmetics automatically.
- Social & Voice: Press O in-game for the Social overlay; chat and voice calls work in the Friends tab.
- Performance: Performance tab shows live FPS/frametime/memory; use Sodium, Lithium, ImmediatelyFast, FerriteCore.
If you are unsure about something specific, be honest rather than guessing.`;

const CRASH_SYSTEM_PROMPT = `You are Speedy AI Crash Helper for Speedy Client (Minecraft Fabric launcher).
A user's Minecraft game just crashed. Give a short, clear, beginner-friendly explanation of:
1. What caused the crash (in plain English, 1-2 sentences).
2. Exact step-by-step instructions to fix it in Speedy Client (e.g., which tab to open: Mods, Instances, Settings -> Java, or Settings -> Memory, and which mod/setting to change).
Keep it under 140 words and avoid raw stack trace jargon.`;

async function callLlm(systemPrompt, messages) {
  const groqKey = (process.env.GROQ_API_KEY || '').trim();
  if (groqKey) {
    const model = (process.env.GROQ_MODEL || 'qwen/qwen3.8-27b').trim();
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${groqKey}`,
      },
      body: JSON.stringify({
        model,
        temperature: 0.4,
        max_tokens: 600,
        messages: [
          { role: 'system', content: systemPrompt },
          ...messages.map((m) => ({
            role: m.role === 'assistant' ? 'assistant' : 'user',
            content: String(m.content || '').slice(0, 6000),
          })),
        ],
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data?.error?.message || `Groq HTTP ${res.status}`);
    }
    const rawText = data?.choices?.[0]?.message?.content?.trim() || '';
    const text = rawText.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
    if (!text) throw new Error('Empty response from Groq AI');
    return text;
  }

  const geminiKey = (process.env.GEMINI_API_KEY || '').trim();
  if (geminiKey) {
    const model = (process.env.GEMINI_MODEL || 'gemini-2.5-flash').trim();
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(geminiKey)}`;
    const contents = messages.map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: String(m.content || '').slice(0, 6000) }],
    }));
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents,
        generationConfig: { temperature: 0.4, maxOutputTokens: 600 },
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data?.error?.message || `Gemini HTTP ${res.status}`);
    }
    const text = data?.candidates?.[0]?.content?.parts?.map((p) => p?.text || '').join('').trim();
    if (!text) throw new Error('Empty response from AI');
    return text;
  }

  const openaiKey = (process.env.OPENAI_API_KEY || '').trim();
  if (openaiKey) {
    const baseUrl = (process.env.AI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '');
    const model = (process.env.AI_MODEL || 'gpt-4o-mini').trim();
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${openaiKey}`,
      },
      body: JSON.stringify({
        model,
        temperature: 0.4,
        max_tokens: 600,
        messages: [
          { role: 'system', content: systemPrompt },
          ...messages.map((m) => ({
            role: m.role === 'assistant' ? 'assistant' : 'user',
            content: String(m.content || '').slice(0, 6000),
          })),
        ],
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data?.error?.message || `AI HTTP ${res.status}`);
    }
    const text = data?.choices?.[0]?.message?.content?.trim();
    if (!text) throw new Error('Empty response from AI');
    return text;
  }

  throw new Error('AI is not configured on the server yet (set GEMINI_API_KEY or OPENAI_API_KEY).');
}

export function handleAiRoutes(req, res, url) {
  const json = (status, data) => {
    res.writeHead(status, {
      'content-type': 'application/json',
      'access-control-allow-origin': '*',
      'cache-control': 'no-cache',
    });
    res.end(JSON.stringify(data));
  };

  if (url.startsWith('/api/ai/status') && req.method === 'GET') {
    const parsedUrl = new URL(req.url || '/', 'http://localhost');
    const deviceId = parsedUrl.searchParams.get('deviceId') || '';
    const usage = getUsage(getUsageKey(deviceId, req));
    json(200, {
      ok: true,
      configured: isConfigured(),
      remaining: usage.remaining,
      limit: usage.limit,
      crashUnlimited: true,
    });
    return true;
  }

  if (url === '/api/ai/chat' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => {
      if (body.length < 65536) body += c;
    });
    req.on('end', async () => {
      try {
        const parsed = JSON.parse(body || '{}');
        const mode = parsed?.mode === 'crash' ? 'crash' : 'chat';
        const usageKey = getUsageKey(parsed?.deviceId, req);

        if (mode === 'chat') {
          const cur = getUsage(usageKey);
          if (cur.remaining <= 0) {
            return json(429, {
              ok: false,
              error: `Daily AI chat limit reached (${cur.limit}/${cur.limit}). Resets at midnight UTC. Crash analysis is always unlimited!`,
              remaining: 0,
              limit: cur.limit,
            });
          }
        }

        if (!isConfigured()) {
          return json(503, {
            ok: false,
            error: 'AI is not configured on the server yet. Add GEMINI_API_KEY in Render Environment variables.',
            remaining: getUsage(usageKey).remaining,
            limit: DAILY_LIMIT,
          });
        }

        let messages = [];
        let sysPrompt = CHAT_SYSTEM_PROMPT;

        if (mode === 'crash') {
          sysPrompt = CRASH_SYSTEM_PROMPT;
          const reason = String(parsed?.crashReason || 'Unknown crash').slice(0, 1500);
          const logTail = String(parsed?.crashLog || '').slice(-3500);
          const mcVer = String(parsed?.mcVersion || 'unknown');
          const loader = String(parsed?.fabricLoader || 'unknown');
          messages = [{
            role: 'user',
            content: `Minecraft Version: ${mcVer}\nFabric Loader: ${loader}\nCrash Summary: ${reason}\n\nLog/Report Tail:\n${logTail}`,
          }];
        } else {
          const userMsg = String(parsed?.message || '').trim();
          if (!userMsg) {
            return json(400, { ok: false, error: 'Message is required.' });
          }
          const history = Array.isArray(parsed?.history) ? parsed.history.slice(-8) : [];
          for (const h of history) {
            if (h && (h.role === 'user' || h.role === 'assistant') && h.content) {
              messages.push({ role: h.role, content: String(h.content).slice(0, 2000) });
            }
          }
          messages.push({ role: 'user', content: userMsg.slice(0, 2000) });
        }

        const reply = await callLlm(sysPrompt, messages);

        if (mode === 'crash') {
          const cur = getUsage(usageKey);
          return json(200, {
            ok: true,
            reply,
            unlimited: true,
            remaining: cur.remaining,
            limit: cur.limit,
          });
        } else {
          const updated = incrementUsage(usageKey);
          return json(200, {
            ok: true,
            reply,
            unlimited: false,
            remaining: updated.remaining,
            limit: updated.limit,
          });
        }
      } catch (e) {
        return json(500, { ok: false, error: e?.message || 'AI request failed' });
      }
    });
    return true;
  }

  return false;
}
