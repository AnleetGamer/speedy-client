/**
 * Anleet presence logic — merges raw presence with privacy settings and the
 * viewer's relationship to decide exactly what may be shown. Shared by the
 * signaling server (server-side enforcement) and the renderer (display).
 * Only information the client can actually determine is ever published;
 * this layer never fabricates data.
 */

export const VISIBILITIES = ['everyone', 'friends', 'nobody'];

export const PRIVACY_KEYS = [
  'showOnline', 'showActivity', 'showServer', 'showWorld', 'showMode',
  'showLobby', 'showPlayers',
];

export const INTERACTION_KEYS = ['allowRequests', 'allowDms', 'allowCalls', 'allowInvites', 'allowGroups'];

export function defaultPrivacy() {
  return {
    showOnline: 'friends',
    showActivity: 'friends',
    showServer: 'friends',
    showWorld: 'friends',
    showMode: 'friends',
    showLobby: 'nobody',
    showPlayers: 'friends',
    allowRequests: 'everyone',
    allowDms: 'friends',
    allowCalls: 'friends',
    allowInvites: 'friends',
    allowGroups: 'friends',
  };
}

function fieldAllowed(visibility, relationship) {
  if (visibility === 'everyone') return true;
  if (visibility === 'friends') return relationship === 'friend' || relationship === 'self';
  return relationship === 'self';
}

/**
 * @param presence raw published presence (may be null)
 * @param privacy  the *publisher's* privacy settings
 * @param relationship 'self' | 'friend' | 'stranger'
 */
export function filterPresence(presence, privacyInput, relationship) {
  const privacy = { ...defaultPrivacy(), ...(privacyInput || {}) };
  if (relationship !== 'self' && privacy.showOnline === 'nobody') {
    return { visible: false, presence: null, canDm: false, canCall: false, canInvite: false };
  }
  if (!presence) {
    return { visible: false, presence: null, canDm: can(privacy.allowDms), canCall: can(privacy.allowCalls), canInvite: can(privacy.allowInvites) };
  }
  const out = { playing: false, launcherOpen: false, inGame: false };
  const show = (key, flag, value) => {
    if (!flag) return;
    if (fieldAllowed(privacy[key], relationship)) out[value === undefined ? key : key] = value;
  };
  out.playing = !!presence.playing;
  out.launcherOpen = !!presence.launcherOpen;
  out.inGame = !!presence.inGame;
  if (presence.status) show('showOnline', true, undefined), out.status = presence.status && fieldAllowed(privacy.showOnline, relationship) ? presence.status : undefined;
  if (presence.server) out.server = fieldAllowed(privacy.showServer, relationship) && privacy.showActivity !== 'nobody' ? presence.server : undefined;
  if (presence.world) out.world = fieldAllowed(privacy.showWorld, relationship) && privacy.showActivity !== 'nobody' ? presence.world : undefined;
  if (presence.mode) out.mode = fieldAllowed(privacy.showMode, relationship) && privacy.showActivity !== 'nobody' ? presence.mode : undefined;
  if (presence.worldDay != null) out.worldDay = fieldAllowed(privacy.showWorld, relationship) ? presence.worldDay : undefined;
  if (presence.lobby) out.lobby = fieldAllowed(privacy.showLobby, relationship) ? presence.lobby : undefined;
  if (presence.players != null) out.players = fieldAllowed(privacy.showPlayers, relationship) ? presence.players : undefined;
  if (privacy.showActivity === 'nobody') {
    // Activity kill-switch strips everything Minecraft-related.
    delete out.server; delete out.world; delete out.mode; delete out.lobby; delete out.players; delete out.worldDay;
    out.playing = false; out.inGame = false;
  }
  const activityVisible = out.server || out.world || out.mode || out.lobby || out.playing;
  return {
    visible: relationship === 'self' || privacy.showOnline !== 'nobody',
    presence: out,
    activityVisible,
    canDm: can(privacy.allowDms),
    canCall: can(privacy.allowCalls),
    canInvite: can(privacy.allowInvites),
  };

  function can(rule) {
    return fieldAllowed(rule, relationship);
  }
}

/** Human-readable activity line from a *filtered* presence. Never invented. */
export function describeActivity(filtered) {
  if (!filtered || !filtered.activityVisible) return null;
  const p = filtered.presence;
  if (p.server) {
    const lines = ['Playing Minecraft', p.server];
    if (p.mode) lines.push(p.mode);
    else if (p.world) lines.push(p.world + (p.worldDay != null ? ' — Day ' + p.worldDay : ''));
    if (p.lobby) lines.push(p.lobby);
    if (p.players != null) lines.push(p.players + ' online');
    return lines;
  }
  if (p.world) return ['Playing Minecraft', 'Singleplayer', p.world + (p.worldDay != null ? ' — Day ' + p.worldDay : '')];
  if (p.playing) return ['Playing Minecraft'];
  return null;
}
