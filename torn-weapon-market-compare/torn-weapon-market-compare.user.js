// ==UserScript==
// @name         Torn Weapon Market Compare (PDA + Tampermonkey)
// @namespace    torn-weapon-market-compare
// @author       pandaucreator
// @license      All Rights Reserved
// @homepageURL  https://github.com/pandaucreator/tornpda-scripts-and-browser
// @version      1.0
// @description  Compares item market weapon listings against your current weapon on damage, accuracy, stealth and quality, and ranks them by value for the price
// @match        https://www.torn.com/imarket.php*
// @match        https://www.torn.com/page.php?sid=ItemMarket*
// @run-at       document-end
// @grant        GM_xmlhttpRequest
// @connect      api.torn.com
// ==/UserScript==

(function () {
  'use strict';

  // ---------- storage ----------
  const store = {
    get(k, d) { try { const v = localStorage.getItem('tw_' + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem('tw_' + k, JSON.stringify(v)); } catch (e) {} }
  };

  // ---------- key ----------
  // PDA replaces the placeholder with your key. Public access reads the market; equipped weapon needs more.
  const pdaKey = '###PDA-APIKEY###';
  const customKey = store.get('api_key', '');
  const key = customKey || (pdaKey.charAt(0) !== '#' ? pdaKey : '');

  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const money = n => '$' + Math.round(Number(n) || 0).toLocaleString('en-US');
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const numOf = v => (v === undefined || v === null || v === '' ? NaN : Number(String(v).replace(/[^0-9.\-]/g, '')));
  const pct = x => (x >= 0 ? '+' : '') + (x * 100).toFixed(1) + '%';
  const WEAPON_TYPES = ['Primary', 'Secondary', 'Melee'];

  // ---------- UI ----------
  const wrap = document.createElement('div');
  wrap.style.cssText = 'position:fixed;left:8px;bottom:220px;z-index:2147483647;font:12px/1.5 Arial,sans-serif;';
  const inp = (id, ph, w) => `<input id="${id}" type="number" step="any" placeholder="${ph}" style="width:${w || 62}px;padding:4px;">`;
  wrap.innerHTML = `
    <div id="tw-box" style="display:none;position:absolute;left:0;bottom:36px;width:min(94vw,350px);max-height:74vh;overflow-y:auto;
      background:#1b1b1b;color:#ddd;border:1px solid #444;border-radius:6px;padding:10px 12px;box-shadow:0 2px 8px rgba(0,0,0,.6);">
      <div style="font-weight:bold;">Weapon market compare</div>
      <div style="margin:6px 0;">Scan
        <select id="tw-scope" style="padding:4px;">
          <option value="name">Specific weapon (name)</option>
          <option value="Primary">All Primary</option>
          <option value="Secondary">All Secondary</option>
          <option value="Melee">All Melee</option>
          <option value="All">All weapons (slow)</option>
        </select></div>
      <input id="tw-name" placeholder="Weapon name, e.g. Enfield" style="width:100%;box-sizing:border-box;padding:6px;margin:2px 0;">
      <div style="margin:6px 0;">Compare against
        <select id="tw-ref" style="padding:4px;">
          <option value="equipped">My equipped weapon (auto)</option>
          <option value="manual">Manual weapon below</option>
          <option value="median">Market median</option>
        </select></div>
      <div id="tw-manual" style="display:none;margin-bottom:6px;">
        ${inp('tw-mdmg', 'Dmg')} ${inp('tw-macc', 'Acc')} ${inp('tw-mste', 'Stealth')} ${inp('tw-mqua', 'Quality')}
      </div>
      <div style="color:#bbb;">Weights (0 = ignore)</div>
      <div>Dmg ${inp('tw-wdmg', '', 44)} Acc ${inp('tw-wacc', '', 44)} Stealth ${inp('tw-wste', '', 44)} Quality ${inp('tw-wqua', '', 44)}</div>
      <div style="margin:6px 0;">Budget ${inp('tw-budget', 'max $, 0=none', 110)} Show ${inp('tw-top', '', 44)}</div>
      <div style="margin:6px 0;">Rank by
        <select id="tw-sort" style="padding:4px;">
          <option value="value">Best value ($ per +1% upgrade)</option>
          <option value="upgrade">Biggest upgrade within budget</option>
          <option value="score">Highest overall score</option>
          <option value="price">Cheapest</option>
        </select></div>
      <div style="display:flex;gap:6px;">
        <button id="tw-scan" style="flex:1;padding:8px;cursor:pointer;">Scan market</button>
        <button id="tw-stop" style="padding:8px;display:none;">Stop</button>
      </div>
      <div id="tw-out" style="margin-top:8px;color:#999;">Pick a scope and scan. Results rank by value for price against your current weapon.</div>
      <hr style="border-color:#444;margin:8px 0">
      <div id="tw-setbtn" style="color:#8ab4ff;cursor:pointer;">Settings</div>
      <div id="tw-settings" style="display:none;margin-top:6px;">
        <div style="color:#888;font-size:10px;">Key in use: ${key ? (customKey ? 'custom key' : 'PDA key') : 'none'}</div>
        <input id="tw-key" type="password" placeholder="Custom Torn API key (optional)" style="width:100%;box-sizing:border-box;padding:6px;margin:4px 0;">
        <button id="tw-savekey" style="padding:6px;margin-right:4px;">Save key</button>
        <button id="tw-clearkey" style="padding:6px;">Use PDA key</button>
        <div style="margin-top:6px;"><button id="tw-clearcache" style="padding:6px;">Refresh item catalog</button></div>
      </div>
    </div>
    <button id="tw-toggle" style="padding:8px 12px;border-radius:18px;border:1px solid #555;background:#222;color:#fff;cursor:pointer;">Weapons</button>`;
  document.body.appendChild(wrap);
  setInterval(() => { if (!wrap.isConnected && document.body) document.body.appendChild(wrap); }, 2000);
  const $ = id => wrap.querySelector('#' + id);
  const box = $('tw-box');
  const setOpen = o => { box.style.display = o ? 'block' : 'none'; store.set('open', o); };
  setOpen(store.get('open', false));
  $('tw-toggle').addEventListener('click', () => setOpen(box.style.display === 'none'));
  $('tw-setbtn').addEventListener('click', () => { const s = $('tw-settings'); s.style.display = s.style.display === 'none' ? 'block' : 'none'; });
  $('tw-savekey').addEventListener('click', () => { const v = $('tw-key').value.trim(); if (v) { store.set('api_key', v); location.reload(); } });
  $('tw-clearkey').addEventListener('click', () => { store.set('api_key', ''); location.reload(); });
  $('tw-clearcache').addEventListener('click', () => { store.set('catalog', null); $('tw-out').textContent = 'Catalog cleared. Scan again.'; });

  // Persist the form
  const FIELDS = ['tw-scope', 'tw-name', 'tw-ref', 'tw-mdmg', 'tw-macc', 'tw-mste', 'tw-mqua', 'tw-wdmg', 'tw-wacc', 'tw-wste', 'tw-wqua', 'tw-budget', 'tw-top', 'tw-sort'];
  const DEFAULTS = { 'tw-scope': 'name', 'tw-ref': 'equipped', 'tw-wdmg': 1, 'tw-wacc': 0.5, 'tw-wste': 0.25, 'tw-wqua': 0.25, 'tw-top': 15, 'tw-sort': 'value' };
  const saved = store.get('form', {});
  FIELDS.forEach(id => { const v = saved[id] ?? DEFAULTS[id]; if (v !== undefined) $(id).value = v; });
  const saveForm = () => { const o = {}; FIELDS.forEach(id => { o[id] = $(id).value; }); store.set('form', o); };
  const syncManual = () => { $('tw-manual').style.display = $('tw-ref').value === 'manual' ? 'block' : 'none'; };
  syncManual();
  FIELDS.forEach(id => $(id).addEventListener('change', () => { saveForm(); syncManual(); if (items.length) render(); }));

  // ---------- HTTP ----------
  function httpGet(url) {
    return new Promise((resolve, reject) => {
      if (typeof PDA_httpGet === 'function') PDA_httpGet(url).then(r => resolve(r.responseText), reject);
      else if (typeof GM_xmlhttpRequest === 'function') GM_xmlhttpRequest({ method: 'GET', url, onload: r => resolve(r.responseText), onerror: () => reject(new Error('Request failed')) });
      else fetch(url).then(r => r.text()).then(resolve, reject);
    });
  }
  const errors = [];
  async function api(label, paths) {
    for (const p of paths) {
      try {
        const d = JSON.parse(await httpGet(`https://api.torn.com/${p}${p.includes('?') ? '&' : '?'}key=${key}`));
        if (d.error) { errors.push(`${label}: ${d.error.error || JSON.stringify(d.error)}`); continue; }
        return d;
      } catch (e) { errors.push(`${label}: request failed`); }
    }
    return null;
  }
  const toList = x => !x ? [] : Array.isArray(x) ? x : Object.values(x);

  // ---------- item catalog (cached 24h): id -> { name, type } ----------
  async function getCatalog() {
    const c = store.get('catalog', null);
    if (c && Date.now() - c.t < 864e5 && c.items && Object.keys(c.items).length) return c.items;
    const d = await api('Item catalog', ['v2/torn/items', 'torn/?selections=items']);
    if (!d) return null;
    const items = {};
    for (const [k, it] of Object.entries(d.items || d)) {
      if (!it || typeof it !== 'object') continue;
      items[String(it.id ?? k)] = { name: it.name || '?', type: it.type || '' };
    }
    store.set('catalog', { t: Date.now(), items });
    return items;
  }

  // ---------- scoring ----------
  const STATS = [['dmg', 'wdmg', 'Dmg'], ['acc', 'wacc', 'Acc'], ['ste', 'wste', 'Stealth'], ['qua', 'wqua', 'Quality']];
  const weights = () => Object.fromEntries(STATS.map(([, w]) => [w, Math.max(0, Number($('tw-' + w).value) || 0)]));

  // Each stat is compared as a ratio to the reference weapon, then weight-averaged.
  // A stat is skipped if the listing or the reference lacks it (e.g. stealth often missing).
  // score 1.00 = same as reference; 1.10 = 10% better overall.
  function scoreItem(it, ref, w) {
    let sum = 0, ws = 0;
    for (const [k, wk] of STATS) {
      const wt = w[wk];
      if (wt > 0 && isFinite(it[k]) && isFinite(ref[k]) && ref[k] > 0) { sum += wt * it[k] / ref[k]; ws += wt; }
    }
    return ws > 0 ? sum / ws : NaN;
  }
  const median = a => { const s = a.filter(isFinite).sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : NaN; };

  // ---------- equipped weapon detection ----------
  async function getEquippedRefs(cat) {
    const refs = {};
    const d = await api('Equipment', ['v2/user/equipment']);
    if (!d) return refs;
    const walk = o => {
      if (!o || typeof o !== 'object') return;
      const id = o.id !== undefined ? String(o.id) : null;
      const st = o.stats || o.item_details && o.item_details.stats || (o.damage !== undefined ? o : null);
      if (id && st && cat[id] && WEAPON_TYPES.includes(cat[id].type)) {
        refs[cat[id].type] = { name: cat[id].name, dmg: numOf(st.damage), acc: numOf(st.accuracy), ste: numOf(st.stealth),
          qua: numOf(st.quality ?? o.quality) };
      }
      Object.values(o).forEach(walk);
    };
    walk(d);
    return refs;
  }

  // ---------- scan ----------
  let items = [], refs = {}, equipped = {}, stop = false, scanned = 0, totalIds = 0;

  $('tw-stop').addEventListener('click', () => { stop = true; });
  $('tw-scan').addEventListener('click', async () => {
    const out = $('tw-out'), btn = $('tw-scan');
    if (!key) { out.textContent = 'No API key. Open Settings and paste one.'; return; }
    saveForm(); btn.disabled = true; $('tw-stop').style.display = 'inline-block'; stop = false; errors.length = 0; items = [];
    out.textContent = 'Loading item catalog...';
    const cat = await getCatalog();
    if (!cat) { out.innerHTML = `<div style="color:#ff6b6b">Could not load item catalog.</div><div style="color:#888;font-size:10px;">${esc(errors.join(' | '))}</div>`; btn.disabled = false; $('tw-stop').style.display = 'none'; return; }

    const scope = $('tw-scope').value, q = $('tw-name').value.trim().toLowerCase();
    let ids = Object.entries(cat).filter(([, it]) => WEAPON_TYPES.includes(it.type)
      && (scope === 'name' ? (q && it.name.toLowerCase().includes(q)) : scope === 'All' || it.type === scope)).map(([id]) => id);
    if (scope === 'name' && !q) { out.textContent = 'Type a weapon name first.'; btn.disabled = false; $('tw-stop').style.display = 'none'; return; }
    if (scope === 'name') ids = ids.slice(0, 8);
    if (!ids.length) { out.textContent = 'No matching weapons in the catalog.'; btn.disabled = false; $('tw-stop').style.display = 'none'; return; }

    refs = {}; equipped = {};
    if ($('tw-ref').value === 'equipped') { out.textContent = 'Reading your equipped weapons...'; equipped = await getEquippedRefs(cat); refs = { ...equipped }; }

    totalIds = ids.length; scanned = 0;
    for (const id of ids) {
      if (stop) break;
      out.textContent = `Scanning ${cat[id].name} (${++scanned}/${totalIds})...  [Stop to finish early]`;
      const d = await api('Market ' + cat[id].name, [`v2/market/${id}/itemmarket?limit=100`]);
      await sleep(650);   // stay under the 100 requests/min limit
      if (!d) continue;
      const m = d.itemmarket || d;
      for (const l of toList(m.listings || m.items)) {
        const det = l.item_details || l.details || {};
        const st = det.stats || det;
        const price = numOf(l.price);
        if (!isFinite(price)) continue;
        const bonuses = toList(det.bonuses).map(b => (b.title || b.name || '') + (b.value !== undefined ? ' ' + b.value + '%' : '')).filter(Boolean);
        items.push({ id, name: cat[id].name, type: cat[id].type, price, amount: numOf(l.amount) || 1, uid: det.uid ?? null,
          dmg: numOf(st.damage), acc: numOf(st.accuracy), ste: numOf(st.stealth), qua: numOf(st.quality), bonuses, rarity: det.rarity || '' });
      }
    }
    btn.disabled = false; $('tw-stop').style.display = 'none';
    render();
  });

  // ---------- render ----------
  function render() {
    const out = $('tw-out');
    if (!items.length) { out.innerHTML = `<div style="color:#ff9b6b">No listings found.</div><div style="color:#888;font-size:10px;">${esc([...new Set(errors)].join(' | '))}</div>`; return; }
    const w = weights();
    const mode = $('tw-ref').value;
    // Resolve reference per weapon type
    const manual = { dmg: numOf($('tw-mdmg').value), acc: numOf($('tw-macc').value), ste: numOf($('tw-mste').value), qua: numOf($('tw-mqua').value) };
    const refFor = type => {
      if (mode === 'manual') return { ref: manual, label: 'manual weapon' };
      if (mode === 'equipped' && refs[type]) return { ref: refs[type], label: refs[type].name };
      const same = items.filter(i => i.type === type);
      return { ref: { dmg: median(same.map(i => i.dmg)), acc: median(same.map(i => i.acc)), ste: median(same.map(i => i.ste)), qua: median(same.map(i => i.qua)) },
        label: 'market median' + (mode === 'equipped' ? ' (no equipped ' + type + ' found)' : '') };
    };
    const budget = Number($('tw-budget').value) || 0, top = Math.max(1, Number($('tw-top').value) || 15), sort = $('tw-sort').value;
    const rows = items.map(it => {
      const { ref, label } = refFor(it.type);
      const score = scoreItem(it, ref, w);
      const up = score - 1;
      return { ...it, ref, refLabel: label, score, up, perPct: up > 0 ? it.price / (up * 100) : Infinity };
    }).filter(r => isFinite(r.score) && (!budget || r.price <= budget));

    const cmp = {
      value: (a, b) => (a.perPct === b.perPct ? a.price - b.price : a.perPct - b.perPct),
      upgrade: (a, b) => b.up - a.up || a.price - b.price,
      score: (a, b) => b.score - a.score || a.price - b.price,
      price: (a, b) => a.price - b.price
    }[sort];
    const list = rows.sort(cmp).slice(0, top);

    const refNote = mode === 'equipped'
      ? (Object.keys(equipped).length ? 'Equipped detected: ' + Object.entries(equipped).map(([t, r]) => `${t}: ${esc(r.name)}`).join(', ') : 'No equipped weapon detected, using market median')
      : mode === 'manual' ? 'Using your manual weapon' : 'Using market median per slot';
    const diff = (v, r) => (isFinite(v) && isFinite(r) && r > 0 ? ` (${pct(v / r - 1)})` : '');
    let html = `<div style="color:#999;font-size:10px;">${items.length} listings, ${rows.length} comparable. ${refNote}.</div>`;
    html += list.length ? list.map((r, i) => `
      <div style="margin:6px 0;padding:6px;border:1px solid #333;border-radius:4px;">
        <div><b>${i + 1}. ${esc(r.name)}</b> <span style="color:#7fdb6a;">${money(r.price)}</span>${r.amount > 1 ? ' x' + r.amount : ''}
          <span style="color:${r.up > 0 ? '#7fdb6a' : '#ff9b6b'};">${pct(r.up)} vs ${esc(r.refLabel)}</span></div>
        <div style="color:#bbb;">Dmg ${isFinite(r.dmg) ? r.dmg.toFixed(1) : '?'}${diff(r.dmg, r.ref.dmg)} | Acc ${isFinite(r.acc) ? r.acc.toFixed(1) : '?'}${diff(r.acc, r.ref.acc)}
          | Stealth ${isFinite(r.ste) ? r.ste.toFixed(1) : 'n/a'}${diff(r.ste, r.ref.ste)} | Quality ${isFinite(r.qua) ? r.qua.toFixed(1) : '?'}${diff(r.qua, r.ref.qua)}</div>
        <div style="color:#888;font-size:10px;">${r.perPct !== Infinity ? money(r.perPct) + ' per +1% upgrade' : 'not an upgrade'}${r.bonuses.length ? ' | ' + esc(r.bonuses.join(', ')) : ''}${r.rarity ? ' | ' + esc(r.rarity) : ''}</div>
      </div>`).join('') : '<div style="color:#999">Nothing matches (check budget).</div>';
    html += `<div style="color:#666;font-size:10px;">Score = weighted average of each stat divided by your reference weapon's stat. Stats a listing or reference lacks are skipped (stealth is often missing). Weights and budget are editable above.${errors.length ? '<br>Notes: ' + esc([...new Set(errors)].join(' | ')) : ''}</div>`;
    out.innerHTML = html;
  }
})();
