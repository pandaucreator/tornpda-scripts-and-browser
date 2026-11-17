// ==UserScript==
// @name         Torn Gear Finder (PDA + Tampermonkey)
// @namespace    torn-gear-finder
// @author       pandaucreator
// @license      All Rights Reserved
// @homepageURL  https://github.com/pandaucreator/tornpda-scripts-and-browser
// @version      1.0.1
// @description  Finds better weapons/armor and missing enhancers across your inventory and faction armory
// @match        https://www.torn.com/*
// @run-at       document-end
// @grant        GM_xmlhttpRequest
// @connect      api.torn.com
// ==/UserScript==

(function () {
  'use strict';

  // ---------- storage ----------
  const store = {
    get(k, d) { try { const v = localStorage.getItem('tg_' + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem('tg_' + k, JSON.stringify(v)); } catch (e) {} }
  };

  // ---------- key ----------
  // PDA replaces the placeholder. Faction armory needs a key with faction API access (Limited or higher).
  const pdaKey = '###PDA-APIKEY###';
  const customKey = store.get('api_key', '');
  const key = customKey || (pdaKey.charAt(0) !== '#' ? pdaKey : '');

  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const money = n => '$' + Number(n || 0).toLocaleString('en-US');
  const num = (n, d = 1) => (isFinite(n) ? Number(n).toFixed(d) : '?');

  // ---------- UI ----------
  const wrap = document.createElement('div');
  wrap.style.cssText = 'position:fixed;left:8px;bottom:70px;z-index:2147483647;font:12px/1.5 Arial,sans-serif;';
  wrap.innerHTML = `
    <div id="tg-box" style="display:none;position:absolute;left:0;bottom:36px;width:min(92vw,330px);max-height:70vh;overflow-y:auto;
      background:#1b1b1b;color:#ddd;border:1px solid #444;border-radius:6px;padding:10px 12px;box-shadow:0 2px 8px rgba(0,0,0,.6);">
      <button id="tg-scan" style="width:100%;padding:8px;cursor:pointer;">Scan gear</button>
      <div id="tg-out" style="margin-top:8px;color:#999;">Tap Scan to compare your gear with inventory and faction armory.</div>
      <hr style="border-color:#444;margin:8px 0">
      <div id="tg-setbtn" style="color:#8ab4ff;cursor:pointer;">Settings</div>
      <div id="tg-settings" style="display:none;margin-top:6px;">
        <div style="color:#888;font-size:10px;">Key in use: ${key ? (customKey ? 'custom key' : 'PDA key') : 'none'}</div>
        <input id="tg-key" type="password" placeholder="Custom Torn API key (optional)" style="width:100%;box-sizing:border-box;padding:6px;margin:4px 0;">
        <button id="tg-savekey" style="padding:6px;margin-right:4px;">Save key</button>
        <button id="tg-clearkey" style="padding:6px;">Use PDA key</button>
        <div style="margin-top:6px;"><button id="tg-clearcache" style="padding:6px;">Refresh item catalog</button></div>
      </div>
    </div>
    <button id="tg-toggle" style="padding:8px 12px;border-radius:18px;border:1px solid #555;background:#222;color:#fff;cursor:pointer;">Gear</button>`;
  document.body.appendChild(wrap);
  setInterval(() => { if (!wrap.isConnected && document.body) document.body.appendChild(wrap); }, 2000);
  const $ = id => wrap.querySelector('#' + id);
  const box = $('tg-box');
  const setOpen = o => { box.style.display = o ? 'block' : 'none'; store.set('open', o); };
  setOpen(store.get('open', false));
  $('tg-toggle').addEventListener('click', () => setOpen(box.style.display === 'none'));
  $('tg-setbtn').addEventListener('click', () => { const s = $('tg-settings'); s.style.display = s.style.display === 'none' ? 'block' : 'none'; });
  $('tg-savekey').addEventListener('click', () => { const v = $('tg-key').value.trim(); if (v) { store.set('api_key', v); location.reload(); } });
  $('tg-clearkey').addEventListener('click', () => { store.set('api_key', ''); location.reload(); });
  $('tg-clearcache').addEventListener('click', () => { store.set('catalog', null); $('tg-out').textContent = 'Catalog cleared. Scan again.'; });

  // ---------- HTTP ----------
  function httpGet(url) {
    return new Promise((resolve, reject) => {
      if (typeof PDA_httpGet === 'function') PDA_httpGet(url).then(r => resolve(r.responseText), reject);
      else if (typeof GM_xmlhttpRequest === 'function') GM_xmlhttpRequest({ method: 'GET', url, onload: r => resolve(r.responseText), onerror: () => reject(new Error('Request failed')) });
      else fetch(url).then(r => r.text()).then(resolve, reject);
    });
  }
  // Try several endpoint spellings; return first that works. Errors are collected for the diagnostics line.
  const errors = [];
  async function api(label, paths) {
    for (const p of paths) {
      try {
        const url = `https://api.torn.com/${p}${p.includes('?') ? '&' : '?'}key=${key}`;
        const d = JSON.parse(await httpGet(url));
        if (d.error) { errors.push(`${label}: ${d.error.error || JSON.stringify(d.error)}`); continue; }
        return d;
      } catch (e) { errors.push(`${label}: request failed`); }
    }
    return null;
  }
  const toList = x => !x ? [] : Array.isArray(x) ? x : Object.values(x);

  // ---------- item catalog (cached 24h) ----------
  // id -> { name, type, dmg, acc, arm, val }
  async function getCatalog() {
    const c = store.get('catalog', null);
    if (c && Date.now() - c.t < 864e5 && c.items && Object.keys(c.items).length) return c.items;
    const d = await api('Item catalog', ['v2/torn/items', 'torn/?selections=items']);
    if (!d) return null;
    const items = {};
    const raw = d.items || d;
    for (const [k, it] of Object.entries(raw)) {
      if (!it || typeof it !== 'object') continue;
      const id = String(it.id ?? k);
      const bs = (it.details && it.details.base_stats) || {};
      items[id] = {
        name: it.name || '?', type: it.type || '',
        dmg: Number(bs.damage ?? it.damage ?? 0), acc: Number(bs.accuracy ?? it.accuracy ?? 0), arm: Number(bs.armor ?? it.armor ?? 0),
        val: Number((it.value && it.value.market_price) ?? it.market_value ?? 0)
      };
    }
    store.set('catalog', { t: Date.now(), items });
    return items;
  }

  // ---------- scoring / slots ----------
  const WEAPON = { Primary: 1, Secondary: 1, Melee: 1, Temporary: 1 };
  const isArmor = t => t === 'Defensive' || t === 'Armor';
  function armorSlot(name) {
    const n = name.toLowerCase();
    if (/helmet|hat|mask|cap|balaclava|hood/.test(n)) return 'Head';
    if (/glove|gauntlet/.test(n)) return 'Hands';
    if (/boot|shoe/.test(n)) return 'Feet';
    if (/pant|trouser|legging|greave/.test(n)) return 'Legs';
    return 'Body';
  }
  function slotOf(it) {
    if (WEAPON[it.type]) return it.type;
    if (isArmor(it.type)) return 'Armor: ' + armorSlot(it.name);
    return null;
  }
  // Base stats only; quality and bonuses on owned copies are not included.
  const score = it => WEAPON[it.type] ? it.dmg + it.acc * 0.5 : it.arm;
  const statTxt = it => WEAPON[it.type] ? `Dmg ${num(it.dmg)} / Acc ${num(it.acc)}` : `Armor ${num(it.arm)}`;

  // ---------- scan ----------
  $('tg-scan').addEventListener('click', async () => {
    const out = $('tg-out'), btn = $('tg-scan');
    if (!key) { out.textContent = 'No API key. Open Settings and paste one.'; return; }
    btn.disabled = true; errors.length = 0;
    out.textContent = 'Loading item catalog...';
    const cat = await getCatalog();
    if (!cat) { out.innerHTML = `<div style="color:#ff6b6b">Could not load item catalog.</div><div style="color:#888;font-size:10px;">${esc(errors.join(' | '))}</div>`; btn.disabled = false; return; }

    out.textContent = 'Reading inventory...';
    const invRaw = await api('Inventory', ['v2/user/inventory?cat=All&limit=100', 'v2/user/inventory', 'user/?selections=inventory']);
    const inv = {};     // id -> { count, equipped }
    const invAll = invRaw ? toList(invRaw.inventory && invRaw.inventory.items || invRaw.inventory || invRaw.items) : [];
    for (const x of invAll) {
      const id = String(x.id ?? x.ID ?? ''); if (!id) continue;
      const r = inv[id] || { count: 0, equipped: false };
      r.count += Number(x.quantity ?? 1); r.equipped = r.equipped || !!x.equipped; inv[id] = r;
    }

    out.textContent = 'Reading equipped gear...';
    const eqRaw = await api('Equipment', ['v2/user/equipment']);
    const equipped = {};  // id set
    if (eqRaw) {
      const walk = o => { if (!o || typeof o !== 'object') return; if (o.id !== undefined && o.name !== undefined) equipped[String(o.id)] = 1; Object.values(o).forEach(walk); };
      walk(eqRaw);
    }
    for (const [id, r] of Object.entries(inv)) if (r.equipped) equipped[id] = 1;

    out.textContent = 'Reading faction armory...';
    const fac = {};     // id -> available count
    for (const sel of ['armor', 'weapons', 'temporary', 'utilities']) {
      const d = await api('Faction ' + sel, [`v2/faction/${sel}`, `faction/?selections=${sel}`]);
      if (!d) continue;
      for (const x of toList(d[sel] || d.armory || d)) {
        if (!x || typeof x !== 'object') continue;
        const id = String(x.id ?? x.ID ?? ''); if (!id || !cat[id]) continue;
        const avail = x.available !== undefined ? Number(x.available) : Number(x.quantity ?? 1);
        if (avail > 0) fac[id] = (fac[id] || 0) + avail;
      }
    }

    // ----- gear upgrades per slot -----
    const slots = {};
    const add = (id, src, n) => {
      const it = cat[id]; if (!it) return;
      const s = slotOf(it); if (!s) return;
      (slots[s] = slots[s] || { eq: null, cands: [] });
      const row = { id, it, sc: score(it), src, n };
      if (src === 'Equipped') { if (!slots[s].eq || row.sc > slots[s].eq.sc) slots[s].eq = row; } else slots[s].cands.push(row);
    };
    for (const id of Object.keys(equipped)) add(id, 'Equipped', 1);
    for (const [id, r] of Object.entries(inv)) if (!equipped[id] || r.count > 1) add(id, 'Inventory', r.count - (equipped[id] ? 1 : 0));
    for (const [id, n] of Object.entries(fac)) add(id, 'Faction', n);

    let html = '';
    const order = Object.keys(slots).sort();
    for (const s of order) {
      const { eq, cands } = slots[s];
      const base = eq ? eq.sc : 0;
      const better = cands.filter(c => c.sc > base * 1.02).sort((a, b) => b.sc - a.sc).slice(0, 3);
      html += `<div style="margin-top:6px;"><b>${esc(s)}</b> <span style="color:#999">${eq ? esc(eq.it.name) + ' (' + statTxt(eq.it) + ')' : 'nothing detected equipped'}</span></div>`;
      html += better.length
        ? better.map(c => `<div style="margin-left:8px;color:#7fdb6a;">+ ${esc(c.it.name)} <span style="color:#999">${statTxt(c.it)} | ${c.src}${c.n > 1 ? ' x' + c.n : ''}</span></div>`).join('')
        : '<div style="margin-left:8px;color:#888;">No better option found.</div>';
    }
    if (!order.length) html += '<div style="color:#ff9b6b;">No weapon or armor data found. See diagnostics.</div>';

    // ----- enhancers -----
    const enh = Object.entries(cat).filter(([, it]) => it.type === 'Enhancer');
    const have = [], inFac = [], missing = [];
    for (const [id, it] of enh) {
      if (inv[id] && inv[id].count > 0) have.push({ id, it, n: inv[id].count });
      else if (fac[id]) inFac.push({ id, it, n: fac[id] });
      else missing.push({ id, it });
    }
    missing.sort((a, b) => b.it.val - a.it.val);
    html += `<hr style="border-color:#444;margin:8px 0"><div style="font-weight:bold;">Enhancers</div>
      <div style="color:#999">Owned ${have.length} | In faction armory (not owned) ${inFac.length} | Missing ${missing.length}</div>`;
    if (inFac.length) html += '<div style="margin-top:4px;color:#ffd24d;">Borrow from faction:</div>' +
      inFac.map(r => `<div style="margin-left:8px;">${esc(r.it.name)} <span style="color:#999">x${r.n} avail</span></div>`).join('');
    if (missing.length) html += '<div style="margin-top:4px;color:#ff9b6b;">Missing (top by market value):</div>' +
      missing.slice(0, 15).map(r => `<div style="margin-left:8px;">${esc(r.it.name)} <span style="color:#999">${r.it.val ? money(r.it.val) : ''}</span></div>`).join('');
    if (!enh.length) html += '<div style="color:#888;">No enhancer items found in the catalog.</div>';

    // ----- diagnostics -----
    html += `<div style="color:#666;font-size:10px;margin-top:8px;">Inventory items: ${invAll.length} | Equipped detected: ${Object.keys(equipped).length} | Faction items available: ${Object.keys(fac).length}.
      Scores use base stats (Dmg + 0.5 x Acc for weapons, Armor for armor); quality/bonuses of your copies are not counted.
      Armor slots are guessed from item names.${errors.length ? '<br>Notes: ' + esc([...new Set(errors)].join(' | ')) : ''}</div>`;
    out.innerHTML = html;
    btn.disabled = false;
  });
})();
