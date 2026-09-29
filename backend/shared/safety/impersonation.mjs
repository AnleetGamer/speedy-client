/**
 * Anleet chat safety — impersonation heuristics.
 * Detects visually confusable usernames (Unicode homoglyphs, digit swaps,
 * one-character substitutions) against a user's existing friends/self.
 * Produces a warning only — never a ban.
 */

// Latin + common Cyrillic/Greek/fullwidth homoglyphs -> canonical latin letter.
const CONFUSABLES = new Map(Object.entries({
  '0': 'o', '1': 'l', '3': 'e', '4': 'a', '5': 's', '6': 'b', '7': 't', '8': 'b', '9': 'g',
  '@': 'a', '$': 's', '|': 'l', '!': 'i', '+': 't', '€': 'e', '£': 'l', '¥': 'y',
  'а': 'a', 'е': 'e', 'о': 'o', 'р': 'p', 'с': 'c', 'у': 'y', 'х': 'x', 'і': 'i', 'ѕ': 's',
  'ԁ': 'd', 'ɡ': 'g', 'һ': 'h', 'ј': 'j', 'қ': 'k', 'ӆ': 'l', 'м': 'm', 'ң': 'n',
  'ν': 'v', 'κ': 'k', 'ο': 'o', 'α': 'a', 'ε': 'e', 'τ': 't', 'ι': 'i', 'ρ': 'p',
  'ａ': 'a', 'ｅ': 'e', 'ｏ': 'o', 'ｐ': 'p', 'ｃ': 'c',
  'ᴅ': 'd', 'ʟ': 'l', 'ʀ': 'r', 'ꜰ': 'f', 'ɴ': 'n',
}));

export function normalizeName(input) {
  let s = String(input ?? '');
  try { s = s.normalize('NFKC'); } catch { /* keep as-is */ }
  s = s.toLowerCase();
  let out = '';
  for (const ch of s) out += CONFUSABLES.get(ch) ?? ch;
  return out.replace(/[^a-z0-9]/g, '');
}

export function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const prev = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    let last = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, last + (a[i - 1] === b[j - 1] ? 0 : 1));
      last = tmp;
    }
  }
  return prev[b.length];
}

/**
 * Compare a candidate against known names.
 * @returns {{suspicious:boolean, match?:{name:string, kind:string, distance:number, ratio:number}}}
 */
export function checkImpersonation(candidate, knownNames) {
  const cand = normalizeName(candidate);
  if (!cand) return { suspicious: false };
  let worst = null;
  for (const known of knownNames) {
    const kn = normalizeName(known);
    if (!kn || kn === cand) {
      if (kn === cand && String(candidate).toLowerCase() !== String(known).toLowerCase()) {
        return { suspicious: true, match: { name: known, kind: 'exact-normalized', distance: 0, ratio: 1 } };
      }
      continue;
    }
    const d = levenshtein(cand, kn);
    const maxLen = Math.max(cand.length, kn.length);
    const ratio = 1 - d / maxLen;
    const kind =
      (cand.length >= 4 && d <= 1) ? 'one-character-substitution' :
      (cand.length >= 8 && d <= 2) ? 'near-identical' :
      (cand.length >= 6 && ratio >= 0.9) ? 'high-similarity' : null;
    if (kind && (!worst || ratio > worst.ratio)) {
      worst = { name: known, kind, distance: d, ratio };
    }
  }
  return worst ? { suspicious: true, match: worst } : { suspicious: false };
}

/** Suspicious Unicode tricks inside a name (RTL override, zero-width, tag chars). */
export function hasNameTricks(name) {
  return /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF\u{1F1E6}-\u{1F1FF}\u{E0000}-\u{E007F}]/u.test(String(name ?? ''));
}
