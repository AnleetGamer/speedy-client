/**
 * Anleet default configuration — single source of truth for every setting the
 * product exposes. The renderer, main process and mods all start from here.
 */

export function defaultLauncherSettings() {
  return {
    version: 1,
    appearance: {
      theme: 'dark',
      motion: 'full',              // 'full' | 'reduced' (also honors OS reduced-motion)
      customTitlebar: true,
      closeToTray: true,           // §34: closing the window keeps Anleet alive in tray
    },
    minecraft: {
      defaultRamMb: 4096,
      jvmArgs: '',
      width: 1280,
      height: 720,
      fullscreen: false,
      keepLauncherOpen: true,
      javaRuntime: 'auto',         // 'auto' | absolute path
    },
    performance: {
      mode: 'balanced',            // 'quality' | 'balanced' | 'performance' (§12)
      showHudChanges: true,        // surface what Thermal Guard changed (§12)
      menuFpsCap: 60,              // 0 = uncapped, 15, 30, 60, 120, 144, 240
      unfocusedFpsCap: 30,         // 0 = uncapped, 15, 30, 60
    },
    thermal: {
      enabled: true,
      tempTarget: 78,
      tempWarn: 82,
      tempCritical: 88,
      preferredRenderDistance: 12,
      minRenderDistance: 6,
      maxRenderDistance: 16,
      adaptiveRenderDistance: true,
      fpsCeilingSafeguard: 60,
      adaptiveSimulation: true,    // integrated/local worlds only
    },
    social: {
      serverUrl: 'wss://speedy-signaling.onrender.com',
      autoConnect: true,
      notificationsEnabled: true,
    },
    privacy: null,                 // lives server-side; cached copy here when connected
    voice: {
      inputDevice: 'default',
      outputDevice: 'default',
      inputVolume: 1.0,
      outputVolume: 1.0,
      noiseSuppression: true,
    },
    discord: {
      richPresence: true,
      showServer: true,
      showWorld: true,
      elapsedTime: true,
    },
    advanced: {
      logLevel: 'info',
      stagedStartup: true,
      profileDeepMonitoring: false,
    },
  };
}

export function defaultInstanceMeta(name) {
  return {
    version: 1,
    id: null,                      // set at creation
    name,
    createdAt: Date.now(),
    mcVersion: '1.21.1',
    fabricLoader: 'stable',
    ramMb: 4096,
    jvmArgs: '',
    width: 1280,
    height: 720,
    fullscreen: false,
    javaRuntime: 'auto',
    serverShortcuts: [],           // {name, address}
    performanceStack: true,        // install curated Sodium-era stack
    performanceMode: 'balanced',
    lastPlayed: null,
    notes: '',
  };
}

/** Curated, justified performance stack (§13). Pinned; launcher verifies game-version compat at install time. */
export function performanceStack() {
  return [
    { id: 'sodium',            projectId: 'AANobbMI', reason: 'Modern rendering pipeline; major FPS and frame-time gains without visual changes', configProfile: 'anleet-default' },
    { id: 'immediatelyfast',   projectId: '5Zjdkc0Q', reason: 'Optimizes immediate-mode rendering (HUD/GUI) — directly targets the CPU-spike class under investigation', configProfile: 'anleet-default' },
    { id: 'entityculling',     projectId: 'NNAalCyq', reason: 'Skips rendering entities that cannot be seen; visually correct culling', configProfile: 'none' },
    { id: 'moreculling',       projectId: 'ujzRJGnh', reason: 'Culls redundant block faces; visually equivalent output', configProfile: 'none' },
    { id: 'lithium',           projectId: 'gvQqBUaZ', reason: 'Game-logic optimizations (physics, ticking); no visual impact', configProfile: 'none' },
    { id: 'ferritecore',       projectId: 'uXXizfIs', reason: 'Memory footprint reduction (world data structures)', configProfile: 'none' },
    { id: 'modernfix',         projectId: 'nmDcBDEA', reason: 'Load-time and memory fixes across modded + vanilla scenarios', configProfile: 'none' },
  ];
}

/** Deep-merge that never creates data users did not configure (used for settings load). */
export function mergeDefaults(defaults, overrides) {
  if (overrides == null) return structuredClone(defaults);
  if (Array.isArray(defaults) || typeof defaults !== 'object') return overrides ?? structuredClone(defaults);
  const out = { ...structuredClone(defaults) };
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) continue;
    out[k] = defaults && typeof defaults[k] === 'object' && defaults[k] !== null && !Array.isArray(defaults[k])
      ? mergeDefaults(defaults[k], v)
      : v;
  }
  return out;
}
