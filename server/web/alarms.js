// Audio-cue alarm engine.
//
//   fireAlarm(level)        — one-shot play of the configured warn/crit clip.
//   startCritLoop / stop…   — keep the crit clip looping continuously while
//                             any node is crit; stop when it clears.
//   primeAudio              — preload + unlock <audio> elements on the first
//                             user gesture (Chrome/Safari autoplay policy).
//
// The dashboard (app.jsx) decides *when* to call these; this module only
// owns the audio cache, the loop state, and the cooldown floor for one-shots.

(function () {
  const _cache = new Map();          // url → preloaded HTMLAudioElement
  let _lastFire = 0;
  const ONESHOT_COOLDOWN_MS = 1500;  // protects against duplicate fire within a tick

  let _critLoopUrl = null;           // url of the audio element currently looping

  function clamp01(v) {
    if (typeof v !== "number" || Number.isNaN(v)) return 0.7;
    return Math.max(0, Math.min(1, v));
  }

  function getAudio(url) {
    let a = _cache.get(url);
    if (a) return a;
    a = new Audio(url);
    a.preload = "auto";
    _cache.set(url, a);
    return a;
  }

  function fireAlarm(level, alarms) {
    if (!alarms || !alarms.enabled) return;
    const now = Date.now();
    if (now - _lastFire < ONESHOT_COOLDOWN_MS) return;
    _lastFire = now;

    const url = level === "crit" ? alarms.critSound : alarms.warnSound;
    if (!url) return;                // empty string disables that level

    const a = getAudio(url);
    a.loop = false;
    a.volume = clamp01(alarms.volume);
    try { a.currentTime = 0; } catch {}
    a.play().catch(err => console.warn(`alarm play failed (${url}):`, err));
  }

  // Continuously loops the crit clip until stopCritLoop() is called. Idempotent
  // — calling again with the same url is a no-op; with a different url it
  // swaps to the new sound.
  function startCritLoop(alarms) {
    if (!alarms || !alarms.enabled) return;
    const url = alarms.critSound;
    if (!url) return;
    if (_critLoopUrl === url) {
      const cur = _cache.get(url);
      if (cur) cur.volume = clamp01(alarms.volume); // refresh volume edits
      return;
    }
    stopCritLoop();
    _critLoopUrl = url;
    const a = getAudio(url);
    a.loop = true;
    a.volume = clamp01(alarms.volume);
    try { a.currentTime = 0; } catch {}
    a.play().catch(err => console.warn(`crit loop failed (${url}):`, err));
  }

  function stopCritLoop() {
    if (!_critLoopUrl) return;
    const a = _cache.get(_critLoopUrl);
    if (a) {
      a.loop = false;
      try { a.pause(); a.currentTime = 0; } catch {}
    }
    _critLoopUrl = null;
  }

  // Chrome/Safari require .play() to happen inside a user-gesture handler at
  // least once per <audio> element before any auto-fire is allowed. Pausing
  // immediately doesn't always count — the most reliable unlock is to start
  // playback at zero volume and let the element finish (or pause it after a
  // brief delay), then restore the real volume.
  //
  // primeAudio() is called both from the global first-click listener AND
  // from any topbar button (bell, snooze, theme) so the user effectively
  // can't interact with the page without unlocking audio.
  function primeAudio(alarms) {
    if (!alarms) return;
    for (const url of [alarms.warnSound, alarms.critSound]) {
      if (!url) continue;
      const a = getAudio(url);
      if (a.dataset.primed === "1") continue;
      a.dataset.primed = "1";       // optimistic — prevents re-entry
      const restoreVol = clamp01(a.volume);
      a.muted = true;               // stronger than volume=0 on iOS Safari
      a.volume = 0;
      a.loop = false;
      try { a.currentTime = 0; } catch {}
      const p = a.play();
      const finish = () => {
        try { a.pause(); a.currentTime = 0; } catch {}
        a.muted = false;
        a.volume = restoreVol;
      };
      if (p && typeof p.then === "function") {
        p.then(finish).catch(err => {
          a.dataset.primed = "";    // unlock failed; let next gesture retry
          a.muted = false;
          a.volume = restoreVol;
          console.warn(`alarm prime failed (${url}):`, err);
        });
      } else {
        finish();
      }
    }
  }

  window.cockpitAlarms = { fireAlarm, startCritLoop, stopCritLoop, primeAudio };
})();
