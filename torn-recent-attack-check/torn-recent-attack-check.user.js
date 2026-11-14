// ==UserScript==
// @name         Torn Recent Attack Check
// @namespace    torn.recent.attack.check
// @version      2.1.0
// @description  Shows if a player was attacked (by you or anyone else) in the last 16 hours, on profile and attack pages. Works in Torn PDA (uses its API key) and Tampermonkey.
// @match        https://www.torn.com/profiles.php*
// @match        https://www.torn.com/loader.php*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @connect      api.torn.com
// ==/UserScript==

(function () {
  'use strict';

  const HOURS = 16;
  const WINDOW = HOURS * 3600;
  const CACHE_MS = 30 * 1000;
  const STATS = 'defendswon,defendslost,defendsstalemated';
  const now = () => Math.floor(Date.now() / 1000);

  // ---------- storage (GM_* if present, else localStorage) ----------
  const store = {
    get(k, d) {
      try {
        if (typeof GM_getValue === 'function') {
          const v = GM_getValue(k, undefined);
          if (v !== undefined) return v;
        }
        const raw = localStorage.getItem('rac_' + k);
        return raw === null ? d : JSON.parse(raw);
      } catch (e) { return d; }
    },
    set(k, v) {
      try {
        if (typeof GM_setValue === 'function') GM_setValue(k, v);
        else localStorage.setItem('rac_' + k, JSON.stringify(v));
      } catch (e) { /* ignore */ }
    }
  };

  // ---------- API key ----------
  // Torn PDA replaces the placeholder below with the key from its own settings.
  // (The check uses "PDA-APIKEY" without the ### so PDA doesn't rewrite it too.)
  const PDA_KEY = '###PDA-APIKEY###';
  const IS_PDA = !PDA_KEY.includes('PDA-APIKEY');

  function getKey(forcePrompt) {
    if (IS_PDA) return PDA_KEY;
    let key = store.get('apikey', '');
    if (!key || forcePrompt) {
      key = (prompt('Torn Recent Attack Check: enter your Torn API key (Limited Access or higher):') || '').trim();
      store.set('apikey', key);
    }
    return key;
  }
  if (!IS_PDA && typeof GM_registerMenuCommand === 'function') {
    GM_registerMenuCommand('Set Torn API key', () => { getKey(true); location.reload(); });
  }

  // ---------- badge ----------
  let badge;
  function show(text, color) {
    if (!badge || !document.body.contains(badge)) {
      badge = document.createElement('div');
      Object.assign(badge.style, {
        position: 'fixed', top: '70px', right: '10px', zIndex: 99999,
        padding: '6px 10px', borderRadius: '6px', font: '12px/1.35 Arial, sans-serif',
        color: '#fff', boxShadow: '0 2px 6px rgba(0,0,0,.5)', maxWidth: '260px',
        cursor: 'pointer', whiteSpace: 'pre-line'
      });
      badge.title = 'Tap to refresh';
      badge.addEventListener('click', () => run(true));
      document.body.appendChild(badge);
    }
    badge.textContent = text;
    badge.style.background = color;
  }

  // ---------- page detection ----------
  function getTargetId() {
    const p = new URLSearchParams(location.search);
    if (location.pathname.includes('profiles.php')) return p.get('XID');
    if (location.pathname.includes('loader.php') && p.get('sid') === 'attack') return p.get('user2ID');
    return null;
  }

  // ---------- API helpers ----------
  async function httpGet(url) {
    // Torn PDA's native HTTP bridge avoids any webview CORS issues
    if (typeof PDA_httpGet === 'function') {
      const r = await PDA_httpGet(url);
      return JSON.parse(r.responseText);
    }
    const res = await fetch(url);
    return res.json();
  }

  async function api(path, params, cacheKey, force) {
    if (cacheKey && !force) {
      const c = store.get(cacheKey, null);
      if (c && Date.now() - c.t < CACHE_MS) return c.data;
    }
    const qs = new URLSearchParams({ ...params, key: getKey(false), comment: 'RecentAttackCheck' });
    const data = await httpGet(`https://api.torn.com/${path}?${qs}`);
    if (cacheKey && !data.error) store.set(cacheKey, { t: Date.now(), data });
    return data;
  }

  const defends = ps => ps ? (ps.defendswon || 0) + (ps.defendslost || 0) + (ps.defendsstalemated || 0) : null;

  function ago(ts) {
    const s = Math.max(0, now() - ts);
    return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m ago`;
  }

  function apiError(err) {
    if (!IS_PDA && [2, 10, 16].includes(err.code)) store.set('apikey', '');
    show('RAC API error: ' + err.error, '#a33');
  }

  // ---------- main ----------
  async function run(force) {
    const target = getTargetId();
    if (!target) return;
    if (!getKey(false)) return show('RAC: no API key set', '#a33');
    show('Checking recent attacks…', '#555');

    try {
      const t = now();
      const from = t - WINDOW;

      // 1) Target profile + current defend counters (all attacks ever made ON them)
      const tData = await api(`user/${target}`, { selections: 'profile,personalstats', stat: STATS },
        'tcache_' + target, force);
      if (tData.error) return apiError(tData.error);
      const cur = defends(tData.personalstats);
      if (cur === null) return show('RAC: target stats unavailable', '#a33');

      // 2) Local snapshots of that counter
      const sk = 'snaps_' + target;
      let snaps = store.get(sk, []).filter(s => s.t > t - 48 * 3600);
      const last = snaps[snaps.length - 1];
      if (last && t - last.t < 30) last.d = cur; else snaps.push({ t, d: cur });
      snaps = snaps.slice(-40);
      store.set(sk, snaps);

      // 3) Baseline: exact local snapshot at/before window start, else daily historical stats, else partial local
      let baseline = null, approx = false, partialSince = null;
      const old = snaps.filter(s => s.t <= from);
      if (old.length) {
        baseline = old[old.length - 1].d;
      } else {
        const h = await api(`user/${target}`, { selections: 'personalstats', stat: STATS, timestamp: from },
          'hcache_' + target, force);
        const hd = h && !h.error ? defends(h.personalstats) : null;
        if (hd !== null) { baseline = hd; approx = true; }
        else if (snaps.length > 1) { baseline = snaps[0].d; partialSince = snaps[0].t; }
      }

      // 4) Your own attacks on them (exact) -> split "you" vs "others"
      let mineCount = 0, theirsToMe = null, lastMine = null;
      const mine = await api('user/', { selections: 'attacks', from, limit: 100 }, 'acache', force);
      if (!mine.error) {
        for (const a of Object.values(mine.attacks || {})) {
          const ts = a.timestamp_ended || a.timestamp_started;
          if (!ts || ts < from) continue;
          if (String(a.defender_id) === String(target)) {
            mineCount++;
            if (!lastMine || ts > lastMine) lastMine = ts;
          } else if (String(a.attacker_id) === String(target)) {
            if (!theirsToMe || ts > theirsToMe) theirsToMe = ts;
          }
        }
      }

      // 5) Build message
      const lines = [];
      let color = '#2e7d32';

      if (baseline === null) {
        lines.push('No baseline yet - revisit later for the total count');
        color = '#555';
      } else {
        const total = Math.max(0, cur - baseline);
        const others = Math.max(0, total - mineCount);
        const win = partialSince ? `since ${ago(partialSince)}` : `last ${HOURS}h`;
        if (total === 0) {
          lines.push(`✅ Not attacked in ${win}${approx ? ' (~approx)' : ''}`);
        } else {
          color = others > 0 ? '#8a3b3b' : '#b8860b';
          lines.push(`⚠ Attacked ${total}x in ${win}${approx ? ' (~approx)' : ''}`);
          lines.push(`   you: ${mineCount} | others: ${others}`);
        }
      }
      if (lastMine) lines.push(`You last hit them ${ago(lastMine)}`);
      if (theirsToMe) lines.push(`They hit you ${ago(theirsToMe)}`);

      const st = tData.status;
      if (st && st.state === 'Hospital') {
        lines.push('🏥 ' + String(st.details || 'In hospital').replace(/<[^>]+>/g, ''));
      }
      show(lines.join('\n'), color);
    } catch (e) {
      show('RAC error: ' + e.message, '#a33');
    }
  }

  // Attack page is a SPA; re-run when the URL changes.
  let lastUrl = location.href;
  setInterval(() => {
    if (location.href !== lastUrl) { lastUrl = location.href; run(false); }
  }, 1000);

  run(false);
})();
