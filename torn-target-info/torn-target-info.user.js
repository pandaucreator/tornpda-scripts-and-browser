// ==UserScript==
// @name         Torn Target Info (PDA + Tampermonkey)
// @namespace    torn-target-info
// @version      1.9
// @description  Target info, attack/mug history with MUG/SKIP verdicts, FFScouter battle-stat estimates (with level-based fallback), and a target finder. Works in Torn PDA and Tampermonkey
// @match        https://www.torn.com/profiles.php*
// @match        https://www.torn.com/loader.php*
// @match        https://www.torn.com/page.php?sid=attack*
// @run-at       document-end
// @grant        GM_xmlhttpRequest
// @connect      api.torn.com
// @connect      ffscouter.com
// ==/UserScript==

(function () {
  'use strict';

  // ================= Storage (localStorage works in PDA and Tampermonkey) =================
  const store = {
    get(k, d) {
      try { const v = localStorage.getItem('tt_' + k); return v === null ? d : JSON.parse(v); }
      catch (e) { return d; }
    },
    set(k, v) { try { localStorage.setItem('tt_' + k, JSON.stringify(v)); } catch (e) {} }
  };

  // ================= Keys =================
  // Torn PDA replaces the placeholder below with your own key. A key saved in Settings overrides it.
  // Full Access is needed for mug amounts (log). Attack history works with Limited.
  const pdaKey = '###PDA-APIKEY###';
  const customKey = store.get('api_key', '');
  const key = customKey || (pdaKey.charAt(0) !== '#' ? pdaKey : '');
  // FFScouter is a THIRD-PARTY service: its key is sent to ffscouter.com. Kept separate and opt-in.
  const ffKey = store.get('ff_key', '');

  const params = new URLSearchParams(location.search);
  // loader.php is shared by many Torn pages, so only run on the attack screen there
  const isAttackPage = params.get('sid') === 'attack';
  if (/loader\.php/.test(location.pathname) && !isAttackPage) return;
  const targetId = params.get('XID') || params.get('user2ID') || params.get('userID');
  if (!targetId) return;

  const fmt = n => '$' + Number(n).toLocaleString('en-US');
  const compact = n => {
    n = Number(n);
    if (!isFinite(n)) return '?';
    if (n >= 1e9) return (n / 1e9).toFixed(2) + 'b';
    if (n >= 1e6) return (n / 1e6).toFixed(2) + 'm';
    if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
    return String(Math.round(n));
  };
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const dateStr = ts => ts ? new Date(ts * 1000).toLocaleDateString() : '?';
  const minPayout = () => Number(store.get('min_payout', 250000)) || 250000;
  const SAFE_RATIO = 0.75;  // FF estimate <= 75% of your total stats = "safe"
  const RISK_RATIO = 1.0;   // up to 100% = "risky", above = "too strong"

  // ================= UI (collapsible, phone friendly) =================
  const wrap = document.createElement('div');
  wrap.style.cssText = 'position:fixed;right:8px;bottom:70px;z-index:2147483647;font:12px/1.5 Arial,sans-serif;';
  wrap.innerHTML = `
    <div id="tt-box" style="display:none;position:absolute;right:0;bottom:36px;width:min(92vw,310px);max-height:65vh;overflow-y:auto;
      background:#1b1b1b;color:#ddd;border:1px solid #444;border-radius:6px;padding:10px 12px;box-shadow:0 2px 8px rgba(0,0,0,.6);">
      <div id="tt-target">Loading target...</div><hr style="border-color:#444;margin:6px 0">
      <div id="tt-decision">Checking history...</div><hr style="border-color:#444;margin:6px 0">
      <div id="tt-ff">FF Scouter...</div><hr style="border-color:#444;margin:6px 0">
      <div id="tt-outlook"></div><hr style="border-color:#444;margin:6px 0">
      <div id="tt-mug">Loading your mug stats...</div><hr style="border-color:#444;margin:6px 0">
      <div id="tt-hist"></div><hr style="border-color:#444;margin:6px 0">
      <button id="tt-find" style="width:100%;padding:8px;cursor:pointer;">Find targets</button>
      <div id="tt-out" style="margin-top:6px;"></div><hr style="border-color:#444;margin:6px 0">
      <div id="tt-setbtn" style="color:#8ab4ff;cursor:pointer;">Settings</div>
      <div id="tt-settings" style="display:none;margin-top:6px;">
        <div style="color:#888;font-size:10px;">Torn key in use: ${key ? (customKey ? 'custom key' : 'PDA key') : 'none'}</div>
        <input id="tt-key" type="password" placeholder="Custom Torn API key (optional)" style="width:100%;box-sizing:border-box;padding:6px;margin:4px 0;">
        <button id="tt-savekey" style="padding:6px;margin-right:4px;">Save key</button>
        <button id="tt-clearkey" style="padding:6px;">Use PDA key</button>
        <div style="margin-top:8px;font-weight:bold;">FFScouter</div>
        <div style="color:#e0a050;font-size:10px;">Third-party: this key is sent to ffscouter.com. Use a Limited/Custom key and register it at ffscouter.com first. Status: ${ffKey ? 'key set' : 'not set'}</div>
        <input id="tt-ffkey" type="password" placeholder="FFScouter-registered key" style="width:100%;box-sizing:border-box;padding:6px;margin:4px 0;">
        <button id="tt-saveff" style="padding:6px;margin-right:4px;">Save FF key</button>
        <button id="tt-useffmain" style="padding:6px;margin-right:4px;">Use main key</button>
        <button id="tt-clearff" style="padding:6px;">Remove</button>
        <div style="margin-top:8px;">Min payout to count as MUG ($)</div>
        <input id="tt-minpay" style="width:100%;box-sizing:border-box;padding:6px;margin:4px 0;">
        <button id="tt-savepay" style="padding:6px;">Save</button>
        <div style="margin-top:8px;">Finder: minId,maxId (random ID scan range)</div>
        <input id="tt-fopts" style="width:100%;box-sizing:border-box;padding:6px;margin:4px 0;">
        <button id="tt-savefopts" style="padding:6px;">Save finder</button>
        <div style="margin-top:6px;">
          <button id="tt-resetbase" style="padding:6px;margin-right:4px;">Reset baseline</button>
          <button id="tt-resetledger" style="padding:6px;">Reset ledgers</button>
        </div>
      </div>
    </div>
    <button id="tt-toggle" style="padding:8px 12px;border-radius:18px;border:1px solid #555;background:#222;color:#fff;cursor:pointer;">TT</button>`;
  document.body.appendChild(wrap);
  // Torn's attack page re-renders the body; put the panel back if it gets removed
  setInterval(() => { if (!wrap.isConnected && document.body) document.body.appendChild(wrap); }, 2000);
  const $ = id => wrap.querySelector('#' + id);

  const box = $('tt-box');
  const setOpen = o => { box.style.display = o ? 'block' : 'none'; store.set('open', o); };
  setOpen(store.get('open', false));
  $('tt-toggle').addEventListener('click', () => setOpen(box.style.display === 'none'));

  // Settings handlers
  $('tt-setbtn').addEventListener('click', () => {
    const s = $('tt-settings'); s.style.display = s.style.display === 'none' ? 'block' : 'none';
  });
  $('tt-fopts').value = store.get('finder_opts', '1000000,4000000');
  $('tt-minpay').value = minPayout();
  $('tt-savekey').addEventListener('click', () => {
    const v = $('tt-key').value.trim();
    if (v) { store.set('api_key', v); location.reload(); }
  });
  $('tt-clearkey').addEventListener('click', () => { store.set('api_key', ''); location.reload(); });
  $('tt-saveff').addEventListener('click', () => {
    const v = $('tt-ffkey').value.trim();
    if (v) { store.set('ff_key', v); location.reload(); }
  });
  $('tt-useffmain').addEventListener('click', () => {
    if (key && confirm('This sends your main Torn key to ffscouter.com. A separate Limited/Custom key is safer. Continue?')) {
      store.set('ff_key', key); location.reload();
    }
  });
  $('tt-clearff').addEventListener('click', () => { store.set('ff_key', ''); location.reload(); });
  $('tt-savepay').addEventListener('click', () => { store.set('min_payout', Number($('tt-minpay').value) || 250000); location.reload(); });
  $('tt-savefopts').addEventListener('click', () => { store.set('finder_opts', $('tt-fopts').value); });
  $('tt-resetbase').addEventListener('click', () => { store.set('mug_baseline', null); location.reload(); });
  $('tt-resetledger').addEventListener('click', () => { store.set('mug_ledger', null); store.set('att_ledger', null); location.reload(); });

  if (!key) {
    setOpen(true);
    $('tt-settings').style.display = 'block';
    $('tt-target').textContent = 'No API key. Open Settings and paste one (PDA normally supplies it automatically).';
    ['tt-decision', 'tt-ff', 'tt-outlook', 'tt-mug'].forEach(i => { $(i).textContent = ''; });
    return;
  }

  // ================= HTTP (PDA_httpGet in PDA, GM_xmlhttpRequest in Tampermonkey, fetch otherwise) =================
  function httpGet(url) {
    return new Promise((resolve, reject) => {
      if (typeof PDA_httpGet === 'function') {
        PDA_httpGet(url).then(r => resolve(r.responseText), reject);
      } else if (typeof GM_xmlhttpRequest === 'function') {
        GM_xmlhttpRequest({
          method: 'GET', url,
          onload: r => resolve(r.responseText),
          onerror: () => reject(new Error('Request failed'))
        });
      } else {
        fetch(url).then(r => r.text()).then(resolve, reject);
      }
    });
  }

  async function apiP(path) {
    try {
      const url = `https://api.torn.com/${path}${path.includes('?') ? '&' : '?'}key=${key}`;
      const d = JSON.parse(await httpGet(url));
      return d.error ? { error: d.error } : d;
    } catch (e) {
      return { error: { error: 'Request failed' } };
    }
  }

  // ================= FFScouter =================
  // Endpoint base ffscouter.com/api/v1 with a get-stats path is confirmed by FFScouter's own client docs.
  // Parameter names (key, targets) and response shape are best-effort: errors are shown in the panel.
  let ffLastError = '';
  async function ffStats(ids) {
    const map = {};
    ffLastError = '';
    if (!ffKey) { ffLastError = 'No FFScouter key set'; return map; }
    ids = ids.map(String);
    for (let i = 0; i < ids.length; i += 25) {
      const chunk = ids.slice(i, i + 25);
      try {
        const txt = await httpGet(`https://ffscouter.com/api/v1/get-stats?key=${encodeURIComponent(ffKey)}&targets=${chunk.join(',')}`);
        const d = JSON.parse(txt);
        if (d && d.error) { ffLastError = typeof d.error === 'string' ? d.error : (d.error.error || JSON.stringify(d.error)); break; }
        const arr = Array.isArray(d) ? d : (d.data || d.results || d.targets || []);
        for (const r of arr) {
          const id = r.player_id ?? r.id;
          if (id === undefined) continue;
          map[id] = { ff: r.fair_fight, bs: r.bs_estimate, human: r.bs_estimate_human, updated: r.last_updated };
        }
      } catch (e) { ffLastError = 'FFScouter request failed'; break; }
    }
    return map;
  }

  // Your own total battle stats (needs battlestats access on your key). Cached per page.
  let myTotal = null, myLevel = null;
  async function getMyTotal() {
    if (myTotal !== null) return myTotal;
    const d = await apiP('user/?selections=battlestats');
    if (d.error) { myTotal = 0; return 0; }
    myTotal = (d.strength || 0) + (d.defense || 0) + (d.speed || 0) + (d.dexterity || 0);
    return myTotal;
  }

  function ffVerdict(bs, total) {
    if (!bs || !total) return null;
    const ratio = bs / total;
    if (ratio <= SAFE_RATIO) return { label: 'Defeatable', color: '#7fdb6a', ratio };
    if (ratio <= RISK_RATIO) return { label: 'Risky', color: '#ffd24d', ratio };
    return { label: 'Too strong', color: '#ff6b6b', ratio };
  }

  // Fallback battle-stat estimate for players FFScouter has no data on.
  // Range 200K-2.5M; levels up to CUT map into 200K-400K (the bulk of players),
  // higher levels spread geometrically up to 2.5M. FFScouter always wins when it has data.
  function estimateStatsFallback(level) {
    const MIN = 200000, SPLIT = 400000, MAX = 2500000, CUT = 20;
    const lv = Math.max(1, Number(level) || 1);
    const v = lv <= CUT
      ? MIN + (SPLIT - MIN) * Math.pow(lv / CUT, 1.3)
      : SPLIT * Math.pow(MAX / SPLIT, Math.min(1, (lv - CUT) / 40));
    return Math.round(v / 1000) * 1000;
  }

  // Split a total into four individual stat guesses, sorted high to low.
  // Players start balanced and specialise as they grow, so the spread widens with total:
  // at 200K the shares are ~30/26/24/20%, at 2.5M ~40/30/20/10%.
  // The API gives no per-stat data, so which stat is which is unknown.
  function statSplit(total) {
    const T = Number(total);
    if (!isFinite(T) || T <= 0) return null;
    const k = Math.max(0, Math.min(1, Math.log(T / 200000) / Math.log(12.5)));
    const lo = [0.30, 0.26, 0.24, 0.20], hi = [0.40, 0.30, 0.20, 0.10];
    return lo.map((a, i) => Math.round(T * (a + (hi[i] - a) * k) / 1000) * 1000);
  }
  function statSplitHtml(total) {
    const s = statSplit(total);
    if (!s) return '';
    return `<div style="margin-top:3px;">Per-stat guess (high to low):<br><b>${s.map(compact).join(' / ')}</b></div>
      <div style="color:#888;font-size:10px;">Which stat is which is unknown. Players specialise more as they grow.</div>`;
  }

  // ================= Mug rank (FFScouter x mug outlook) =================
  // rank = outlook score (0-100: networth, last action, history) x strength factor from FF estimate.
  // Strength ratio = their estimated stats / your total. Too strong (>1.0x) = 0, so they never rank.
  // No FF data (rough level estimate) or unknown own stats get a discount.
  function ffFactor(bs, total, rough) {
    if (!bs || !total) return { f: 0.7 };
    const r = bs / total;
    let f = r <= 0.5 ? 1 : r <= SAFE_RATIO ? 0.85 : r <= RISK_RATIO ? 0.4 : 0;
    if (rough) f *= 0.8;
    return { f, ratio: r };
  }
  const mugScore = (base, bs, total, rough) => Math.round(base * ffFactor(bs, total, rough).f);
  const scoreColor = n => n >= 60 ? '#7fdb6a' : n >= 35 ? '#ffd24d' : '#ff9b6b';

  // ================= Ledgers =================
  // mug ledger  = { seen:{logId:1}, victims:{id:{n,total,last,ts}}, nw:{id:networth}, parsed:N }  (amounts, from your log)
  // att ledger  = { seen:{code:1}, byDef:{id:{n,mugs,first,last,lastResult}}, scanned:N }          (attacks you made)
  const getLedger = () => store.get('mug_ledger', null) || { seen: {}, victims: {}, parsed: 0 };
  const getAtt = () => store.get('att_ledger', null) || { seen: {}, byDef: {}, scanned: 0 };

  function updateLedger(logData) {
    const ledger = getLedger();
    const entries = logData.log || {};
    for (const [logId, e] of Object.entries(entries)) {
      if (ledger.seen[logId]) continue;
      const title = String(e.title || '').toLowerCase();
      if (!/mug/.test(title)) continue;
      const d = e.data || {};
      // Field names are best-effort guesses; check the "parsed" count in the panel.
      const victim = d.defender ?? d.target ?? d.user ?? d.defender_id ?? d.victim;
      const amount = d.money_mugged ?? d.money ?? d.amount ?? d.cash ?? d.mugged;
      if (victim === undefined || amount === undefined) continue;
      const v = ledger.victims[victim] || { n: 0, total: 0, last: 0, ts: 0 };
      v.n += 1; v.total += Number(amount); v.last = Number(amount); v.ts = e.timestamp || 0;
      ledger.victims[victim] = v;
      ledger.seen[logId] = 1;
      ledger.parsed += 1;
    }
    store.set('mug_ledger', ledger);
    return ledger;
  }

  // Attack history: API returns your latest ~100 attacks; the ledger accumulates them across visits.
  function updateAttacks(data, myId) {
    const att = getAtt();
    const all = data.attacks || {};
    for (const [k, a] of Object.entries(all)) {
      const code = a.code || k;
      if (att.seen[code]) continue;
      if (String(a.attacker_id) !== String(myId)) continue;
      const def = a.defender_id;
      if (def === undefined) continue;
      const ts = a.timestamp_started || a.timestamp_ended || 0;
      const rec = att.byDef[def] || { n: 0, mugs: 0, first: ts, last: 0, lastResult: '' };
      rec.n += 1;
      if (/mug/i.test(String(a.result || ''))) rec.mugs += 1;
      if (ts && (!rec.first || ts < rec.first)) rec.first = ts;
      if (ts >= rec.last) { rec.last = ts; rec.lastResult = String(a.result || ''); }
      att.byDef[def] = rec;
      att.seen[code] = 1;
      att.scanned += 1;
    }
    store.set('att_ledger', att);
    return att;
  }

  // ================= Decision: MUG / SKIP from past earnings =================
  // history first (attacks + amounts); the heuristic score is only a fallback for players you've never hit.
  function decide(id, state, heuristic) {
    const ledger = getLedger(), att = getAtt();
    const v = ledger.victims[id], a = att.byDef[id];
    const min = minPayout();
    if (state && state !== 'Okay') return { verdict: 'WAIT', color: '#ff6b6b', why: `Status: ${state}` };
    if (v) {
      const avg = v.total / v.n;
      const hrs = v.ts ? (Date.now() / 1000 - v.ts) / 3600 : 999;
      if (hrs < 6) return { verdict: 'SKIP', color: '#ff9b6b', why: `Mugged ${hrs.toFixed(1)}h ago, likely protected` };
      if (avg >= min) return { verdict: 'MUG', color: '#7fdb6a', why: `Past avg ${fmt(Math.round(avg))} over ${v.n} mug(s)` };
      return { verdict: 'SKIP', color: '#ff9b6b', why: `Past avg only ${fmt(Math.round(avg))} (min ${fmt(min)})` };
    }
    if (a && a.mugs > 0) return { verdict: 'UNKNOWN', color: '#ffd24d', why: `Mugged ${a.mugs}x but amounts unknown (needs Full Access key for log)` };
    if (a && a.n > 0) return { verdict: 'TRY?', color: '#ffd24d', why: `Attacked ${a.n}x, never mugged; no payout data` };
    if (heuristic) {
      return heuristic.score >= 35
        ? { verdict: 'TRY', color: '#ffd24d', why: `No history; outlook ${heuristic.score}/100` }
        : { verdict: 'SKIP', color: '#ff9b6b', why: `No history; outlook ${heuristic.score}/100` };
    }
    return { verdict: 'NEW', color: '#aaa', why: 'No history with this player' };
  }

  function renderHistory() {
    const ledger = getLedger(), att = getAtt();
    const v = ledger.victims[targetId], a = att.byDef[targetId];
    const top = Object.entries(ledger.victims)
      .sort((x, y) => y[1].total - x[1].total).slice(0, 5)
      .map(([id, x]) => `<div><a style="color:#8ab4ff" href="/profiles.php?XID=${id}">${id}</a>: ${fmt(x.total)} (${x.n}x)</div>`).join('');
    $('tt-hist').innerHTML = `
      <div style="font-weight:bold;">History with this player</div>
      ${a ? `<div>First attack: <b>${dateStr(a.first)}</b> | Attacks: <b>${a.n}</b> | Mugs: <b>${a.mugs}</b></div>
             <div>Last: <b>${dateStr(a.last)}</b> (${a.lastResult || '?'})</div>`
          : '<div style="color:#999">No attacks by you on this player (last ~100 attacks scanned).</div>'}
      ${v ? `<div>Earned: <b>${fmt(v.total)}</b> | Avg <b>${fmt(Math.round(v.total / v.n))}</b> | Last <b>${fmt(v.last)}</b></div>`
          : '<div style="color:#999">No mug amounts recorded.</div>'}
      <div style="font-weight:bold;margin-top:4px;">Top victims</div>
      ${top || '<div style="color:#999">None yet.</div>'}
      <div style="color:#888;font-size:10px;">Attacks scanned: ${att.scanned} | Log mugs parsed: ${ledger.parsed}</div>`;
  }

  // ================= Mug outlook (fallback heuristic) =================
  // Torn does NOT expose other players' cash. Signals: status, networth, last action, your history.
  function computeOutlook(d, networth, id = targetId) {
    const reasons = [];
    const state = d.status ? d.status.state : '?';
    if (state !== 'Okay') {
      return { score: 0, label: "Can't mug now", color: '#ff6b6b', reasons: [`Status: ${state}`], est: null, samples: 0 };
    }

    let score = 0;
    if (networth < 1e6) { score += 10; reasons.push('Networth under $1M'); }
    else if (networth < 1e7) { score += 25; reasons.push('Networth $1M-$10M'); }
    else if (networth < 1e8) { score += 40; reasons.push('Networth $10M-$100M'); }
    else if (networth < 1e9) { score += 55; reasons.push('Networth $100M-$1B'); }
    else { score += 65; reasons.push('Networth over $1B'); }

    const ts = d.last_action && d.last_action.timestamp;
    if (ts) {
      const hrs = (Date.now() / 1000 - ts) / 3600;
      if (hrs < 0.25) { score -= 5; reasons.push('Active now (may spend/bank soon)'); }
      else if (hrs < 48) { score += 10; reasons.push('Recently offline (cash may be sitting)'); }
      else if (hrs < 24 * 14) { score += 15; reasons.push('Offline days (idle cash likely)'); }
      else if (hrs >= 24 * 30) { score -= 15; reasons.push('Offline 30+ days (maybe abandoned/empty)'); }
    }

    const ledger = getLedger();
    const v = ledger.victims[id];
    if (v) {
      const hrsSince = (Date.now() / 1000 - v.ts) / 3600;
      if (v.ts && hrsSince < 6) { score -= 40; reasons.push('You mugged them <6h ago (likely protected/drained)'); }
      else if (v.ts && hrsSince < 48) { score -= 15; reasons.push('You mugged them <48h ago'); }
      const avg = v.total / v.n;
      if (avg >= 1e6) { score += 15; reasons.push(`Past avg payout ${fmt(Math.round(avg))}`); }
      else if (v.last < 1e5) { score -= 10; reasons.push(`Last mug only ${fmt(v.last)}`); }
    }

    // Payout estimate: median of (your last mug / their networth at last view)
    let est = null;
    const nwMap = ledger.nw || {};
    const ratios = Object.entries(ledger.victims)
      .filter(([id, x]) => nwMap[id] && x.last > 0)
      .map(([id, x]) => x.last / nwMap[id]).sort((a, b) => a - b);
    if (ratios.length >= 3) est = Math.round(networth * ratios[Math.floor(ratios.length / 2)]);

    score = Math.max(0, Math.min(100, score));
    const [label, color] = score >= 60 ? ['Likely worth mugging', '#7fdb6a']
                         : score >= 35 ? ['Maybe', '#ffd24d']
                         : ['Unlikely', '#ff9b6b'];
    return { score, label, color, reasons, est, samples: ratios.length };
  }

  let curTarget = null, curNw = 0, curOutlook = null, curBs = null, curRough = false;
  function renderAll() {
    if (!curTarget) return;
    curOutlook = computeOutlook(curTarget, curNw);
    const o = curOutlook;
    const dec = decide(targetId, curTarget.status && curTarget.status.state, o);
    const fx = ffFactor(curBs, myTotal || 0, curRough);
    const ms = mugScore(o.score, curBs, myTotal || 0, curRough);
    $('tt-decision').innerHTML = `
      <div style="font-size:15px;font-weight:bold;color:${dec.color};">${dec.verdict}</div>
      <div style="color:#bbb;font-size:11px;">${dec.why}</div>
      <div style="margin-top:3px;">Mug rank: <b style="color:${scoreColor(ms)}">${ms}/100</b>
        <span style="color:#888;font-size:10px;">(outlook ${o.score} x stats factor ${fx.f.toFixed(2)}${fx.ratio !== undefined ? ', ' + fx.ratio.toFixed(2) + 'x yours' : ''}${curBs === null ? ', waiting for FF' : curRough ? ', rough' : ''})</span></div>`;
    $('tt-outlook').innerHTML = `
      <div style="font-weight:bold;">Heuristic outlook</div>
      <div><b style="color:${o.color}">${o.label}</b> (score ${o.score}/100)</div>
      ${o.est !== null ? `<div>Est. payout: <b>${fmt(o.est)}</b> <span style="color:#888">(${o.samples} samples)</span></div>`
        : '<div style="color:#888">Est. payout: need 3+ past mugs with networth snapshots</div>'}
      <div style="color:#aaa;font-size:11px;">${o.reasons.join('<br>')}</div>
      <div style="color:#666;font-size:10px;margin-top:2px;">Cash on hand is not visible via API. History decides; this is a fallback.</div>`;
    renderHistory();
  }

  // ================= Target info + FFScouter =================
  (async () => {
    const d = await apiP(`user/${targetId}?selections=profile,personalstats`);
    if (d.error) { $('tt-target').textContent = d.error.error; $('tt-decision').textContent = ''; $('tt-ff').textContent = ''; return; }
    const p = d.personalstats || {};
    const state = d.status ? d.status.state : '?';
    const col = state === 'Okay' ? '#7fdb6a' : '#ff6b6b';

    // Snapshot networth so payouts can be calibrated against it later
    const nw = p.networth !== undefined ? Number(p.networth) : 0;
    if (nw) {
      const l = getLedger();
      l.nw = l.nw || {};
      l.nw[targetId] = nw;
      store.set('mug_ledger', l);
    }
    curTarget = d; curNw = nw;
    renderAll();

    $('tt-target').innerHTML = `
      <div style="font-weight:bold;font-size:13px;">${d.name} [${targetId}]</div>
      <div>Lv <b>${d.level}</b> | <b>${d.rank}</b></div>
      <div>Life: <b>${d.life ? d.life.current.toLocaleString() + ' / ' + d.life.maximum.toLocaleString() : '?'}</b></div>
      <div>Status: <b style="color:${col}">${state}</b></div>
      <div>Last action: <b>${d.last_action ? d.last_action.relative : '?'}</b></div>
      <div>Networth: <b>${p.networth !== undefined ? fmt(p.networth) : 'n/a'}</b></div>`;

    // FFScouter estimate (falls back to a level-based rough estimate, 200K-2.5M)
    const fallbackEst = estimateStatsFallback(d.level);
    if (!ffKey) {
      $('tt-ff').innerHTML = `<div style="font-weight:bold;">Battle stats</div>
        <div>Rough est. (level-based): <b>~${compact(fallbackEst)}</b></div>
        <div style="color:#999">Add an FFScouter-registered key in Settings for better estimates.</div>
        ${statSplitHtml(fallbackEst)}`;
      await getMyTotal(); curBs = fallbackEst; curRough = true; renderAll();
      return;
    }
    const [map, total] = await Promise.all([ffStats([targetId]), getMyTotal()]);
    const r = map[targetId];
    if (!r || !r.bs) {
      const vdFb = ffVerdict(fallbackEst, total);
      $('tt-ff').innerHTML = `
        <div style="font-weight:bold;">Battle stats</div>
        <div style="color:#999">${ffLastError ? 'FF error: ' + ffLastError : 'No FF estimate for this player.'}</div>
        <div>Rough est. (level-based): <b>~${compact(fallbackEst)}</b></div>
        ${vdFb ? `<div>Verdict: <b style="color:${vdFb.color}">${vdFb.label}</b> <span style="color:#888">(rough)</span></div>` : ''}
        ${statSplitHtml(fallbackEst)}`;
      curBs = fallbackEst; curRough = true; renderAll();
      return;
    }
    const vd = ffVerdict(Number(r.bs), total);
    curBs = Number(r.bs); curRough = false; renderAll();
    $('tt-ff').innerHTML = `
      <div style="font-weight:bold;">FF Scouter</div>
      <div>Est. stats: <b>${r.human || compact(r.bs)}</b> | Fair Fight: <b>${r.ff !== undefined ? Number(r.ff).toFixed(2) : '?'}</b></div>
      ${total ? `<div>Your stats: <b>${compact(total)}</b>${vd ? ` | ratio <b>${vd.ratio.toFixed(2)}x</b>` : ''}</div>` : '<div style="color:#888">Your stats unavailable (key needs battlestats access)</div>'}
      ${vd ? `<div>Verdict: <b style="color:${vd.color}">${vd.label}</b></div>` : ''}
      <div style="color:#888;font-size:10px;">Updated: ${r.updated ? (typeof r.updated === 'number' ? dateStr(r.updated) : r.updated) : '?'}. An estimate, not a spy report.</div>
      ${statSplitHtml(Number(r.bs))}`;
  })();

  // ================= Own stats, attack history, mug log =================
  (async () => {
    const d = await apiP('user/?selections=profile,personalstats');
    let myId = null;
    if (d.error) { $('tt-mug').textContent = d.error.error; }
    else {
      myId = d.player_id;
      myLevel = d.level;
      const s = d.personalstats || {};
      let base = store.get('mug_baseline', null);
      if (!base && s.moneymugged !== undefined) { base = { total: s.moneymugged, time: Date.now() }; store.set('mug_baseline', base); }
      $('tt-mug').innerHTML = s.moneymugged === undefined ? 'Mug stats not available.' : `
        <div style="font-weight:bold;">Your mugging</div>
        <div>Lifetime: <b>${fmt(s.moneymugged)}</b></div>
        <div>Biggest: <b>${s.largestmug !== undefined ? fmt(s.largestmug) : 'n/a'}</b></div>
        <div>Since baseline: <b style="color:#7fdb6a">${fmt(s.moneymugged - base.total)}</b></div>`;
    }
    renderHistory();

    // Past attacks: gives first attack date, attack count, mug count per target
    if (myId !== null) {
      const atk = await apiP('user/?selections=attacks');
      if (atk.error) {
        $('tt-hist').insertAdjacentHTML('beforeend', `<div style="color:#ff6b6b">Attacks: ${atk.error.error}</div>`);
      } else { updateAttacks(atk, myId); }
    }

    // Mug amounts: need Full Access
    const log = await apiP('user/?selections=log&limit=100');
    if (log.error) {
      $('tt-hist').insertAdjacentHTML('beforeend', `<div style="color:#ff6b6b">Log: ${log.error.error} (needs Full Access key)</div>`);
    } else { updateLedger(log); }
    renderAll();
  })();

  // ================= Target finder =================
  // 1) Past victims sorted into MUG (past avg >= min payout) and SKIP (low payout / too strong / protected).
  // 2) Random-ID scan: Okay players, estimated with FFScouter and kept only if defeatable.
  //    Players FFScouter has no data on use the level-based fallback estimate (200K-2.5M) and are flagged.
  $('tt-find').addEventListener('click', async () => {
    const out = $('tt-out');
    const btn = $('tt-find');
    btn.disabled = true;
    out.textContent = 'Reading your stats...';
    const me = await apiP('user/?selections=profile');
    if (me.error) { out.textContent = me.error.error; btn.disabled = false; return; }
    const total = await getMyTotal();
    const [minId, maxId] = String(store.get('finder_opts', '1000000,4000000')).split(',');
    const lo = parseInt(minId) || 1000000, hi = parseInt(maxId) || 4000000;
    const min = minPayout();
    const mugList = [], skipList = [], fresh = [];

    // 1) past victims
    const ledger = getLedger();
    const vict = Object.entries(ledger.victims)
      .map(([id, x]) => ({ id, avg: x.total / x.n, ts: x.ts }))
      .sort((a, b) => b.avg - a.avg).slice(0, 15);
    const vinfo = {};
    for (const [i, v] of vict.entries()) {
      out.textContent = `Checking past victims ${i + 1}/${vict.length}...`;
      const d = await apiP(`user/${v.id}?selections=profile`);
      await sleep(700);
      if (d.error || !d.status) continue;
      vinfo[v.id] = d;
    }
    const scanned = [];
    const SCAN = 30;
    for (let i = 0; i < SCAN; i++) {
      out.textContent = `Scanning new players ${i + 1}/${SCAN}...`;
      const id = lo + Math.floor(Math.random() * (hi - lo));
      const d = await apiP(`user/${id}?selections=profile,personalstats`);
      await sleep(700);
      if (d.error || !d.status || d.status.state !== 'Okay') continue;
      scanned.push({ id, name: d.name, level: d.level, nw: (d.personalstats && d.personalstats.networth) || 0, d });
    }

    out.textContent = 'Getting FFScouter estimates...';
    const ffMap = await ffStats([...vict.map(v => v.id), ...scanned.map(s => s.id)]);

    for (const v of vict) {
      const d = vinfo[v.id];
      if (!d) continue;
      const f = ffMap[v.id];
      const vd = f && f.bs ? ffVerdict(Number(f.bs), total) : null;
      const ffTag = f && f.bs ? ` FF ${f.ff !== undefined ? Number(f.ff).toFixed(2) : '?'} ~${f.human || compact(f.bs)}` : '';
      const row = { id: v.id, name: d.name, level: d.level, tag: `avg ${fmt(Math.round(v.avg))}${ffTag}` };
      const hrs = v.ts ? (Date.now() / 1000 - v.ts) / 3600 : 999;
      if (d.status.state !== 'Okay') skipList.push({ ...row, why: d.status.state });
      else if (hrs < 6) skipList.push({ ...row, why: 'mugged <6h ago' });
      else if (vd && vd.label === 'Too strong') skipList.push({ ...row, why: 'too strong' });
      else if (v.avg < min) skipList.push({ ...row, why: 'low past payout' });
      else {
        const base = Math.min(100, Math.round(60 + 10 * v.avg / min));
        const hasFF = !!(f && f.bs);
        const bs = hasFF ? Number(f.bs) : estimateStatsFallback(d.level);
        mugList.push({ ...row, risk: vd ? vd.label : null, score: mugScore(base, bs, total, !hasFF), src: 'history' });
      }
    }
    for (const s of scanned) {
      const f = ffMap[s.id];
      const hasFF = !!(f && f.bs);
      const bs = hasFF ? Number(f.bs) : estimateStatsFallback(s.level);
      const sc = mugScore(computeOutlook(s.d, s.nw, s.id).score, bs, total, !hasFF);
      if (sc <= 0) continue;   // too strong or not mug-able right now
      const vd = ffVerdict(bs, total);
      fresh.push({ id: s.id, name: s.name, level: s.level, score: sc, risk: vd ? vd.label : null, src: 'new',
        tag: hasFF ? `FF ${f.ff !== undefined ? Number(f.ff).toFixed(2) : '?'} ~${f.human || compact(f.bs)} NW ${fmt(s.nw)}` : `no FF, rough ~${compact(bs)} NW ${fmt(s.nw)}` });
    }
    // one list, best mug targets first (history and new players together)
    const ranked = [...mugList, ...fresh].sort((a, b) => b.score - a.score);

    const link = r => `<a style="color:#8ab4ff" href="/loader.php?sid=attack&user2ID=${r.id}">${r.name} [${r.id}]</a> Lv${r.level}`;
    out.innerHTML = `
      <div style="color:#888;font-size:10px;">Your stats: ${total ? compact(total) : 'n/a'} | Lv ${me.level} | min payout ${fmt(min)}${ffKey ? '' : ' | no FF key'}${ffLastError ? ' | FF: ' + ffLastError : ''}</div>
      <div style="font-weight:bold;color:#7fdb6a;margin-top:4px;">Most likely to mug (${ranked.length})</div>
      ${ranked.length ? ranked.map(r => `<div style="margin:3px 0;"><b style="color:${scoreColor(r.score)}">${r.score}</b> ${link(r)} <span style="color:#999">${r.src === 'history' ? '[history] ' : ''}${r.tag}${r.risk ? ' | ' + r.risk : ''}</span></div>`).join('') : '<div style="color:#999">None found. Tap again.</div>'}
      <div style="font-weight:bold;color:#ff9b6b;margin-top:4px;">SKIP (${skipList.length})</div>
      ${skipList.length ? skipList.map(r => `<div style="margin:3px 0;color:#888;">${r.name} [${r.id}] Lv${r.level} <span>${r.tag} | ${r.why}</span></div>`).join('') : '<div style="color:#999">None.</div>'}`;
    btn.disabled = false;
  });
})();
