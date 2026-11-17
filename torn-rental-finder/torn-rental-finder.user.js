// ==UserScript==
// @name         Torn Rental Finder (PDA + Tampermonkey)
// @namespace    torn-rental-finder
// @version      1.0
// @description  Finds the cheapest property rentals by TRUE daily cost (rent + upkeep), plus cost per happy
// @match        https://www.torn.com/properties.php*
// @run-at       document-end
// @grant        GM_xmlhttpRequest
// @connect      api.torn.com
// ==/UserScript==

(function () {
  'use strict';

  // ---------- storage ----------
  const store = {
    get(k, d) { try { const v = localStorage.getItem('tr_' + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem('tr_' + k, JSON.stringify(v)); } catch (e) {} }
  };

  // ---------- key ----------
  // PDA replaces the placeholder with your key. Public-level access is enough for the rental market.
  const pdaKey = '###PDA-APIKEY###';
  const customKey = store.get('api_key', '');
  const key = customKey || (pdaKey.charAt(0) !== '#' ? pdaKey : '');

  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const money = n => '$' + Math.round(Number(n) || 0).toLocaleString('en-US');
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  // ---------- UI ----------
  const wrap = document.createElement('div');
  wrap.style.cssText = 'position:fixed;left:8px;bottom:120px;z-index:2147483647;font:12px/1.5 Arial,sans-serif;';
  wrap.innerHTML = `
    <div id="tr-box" style="display:none;position:absolute;left:0;bottom:36px;width:min(94vw,340px);max-height:72vh;overflow-y:auto;
      background:#1b1b1b;color:#ddd;border:1px solid #444;border-radius:6px;padding:10px 12px;box-shadow:0 2px 8px rgba(0,0,0,.6);">
      <div style="font-weight:bold;">Cheapest rentals (rent + upkeep)</div>
      <div style="margin:6px 0;">Sort by
        <select id="tr-sort" style="padding:4px;">
          <option value="total">True cost per day</option>
          <option value="perhappy">Cost per happy</option>
          <option value="period">Total for full rental period</option>
        </select>
      </div>
      <div>Property
        <select id="tr-type" style="padding:4px;max-width:190px;"><option value="">All types</option></select>
      </div>
      <div style="margin:6px 0;">Min happy <input id="tr-minhappy" type="number" style="width:70px;padding:4px;" value="0">
        Show <input id="tr-top" type="number" style="width:50px;padding:4px;" value="20"></div>
      <button id="tr-scan" style="width:100%;padding:8px;cursor:pointer;">Scan rental market</button>
      <div id="tr-out" style="margin-top:8px;color:#999;">Tap Scan. Listings are ranked by rent + upkeep per day, not rent alone.</div>
      <hr style="border-color:#444;margin:8px 0">
      <div id="tr-setbtn" style="color:#8ab4ff;cursor:pointer;">Settings</div>
      <div id="tr-settings" style="display:none;margin-top:6px;">
        <div style="color:#888;font-size:10px;">Key in use: ${key ? (customKey ? 'custom key' : 'PDA key') : 'none'}</div>
        <input id="tr-key" type="password" placeholder="Custom Torn API key (optional)" style="width:100%;box-sizing:border-box;padding:6px;margin:4px 0;">
        <button id="tr-savekey" style="padding:6px;margin-right:4px;">Save key</button>
        <button id="tr-clearkey" style="padding:6px;">Use PDA key</button>
        <label style="display:block;margin-top:8px;"><input type="checkbox" id="tr-total"> Listed cost is the TOTAL for the rental period (not per day)</label>
        <label style="display:block;margin-top:4px;"><input type="checkbox" id="tr-nostaff"> Ignore staff upkeep (count property upkeep only)</label>
      </div>
    </div>
    <button id="tr-toggle" style="padding:8px 12px;border-radius:18px;border:1px solid #555;background:#222;color:#fff;cursor:pointer;">Rent</button>`;
  document.body.appendChild(wrap);
  setInterval(() => { if (!wrap.isConnected && document.body) document.body.appendChild(wrap); }, 2000);
  const $ = id => wrap.querySelector('#' + id);
  const box = $('tr-box');
  const setOpen = o => { box.style.display = o ? 'block' : 'none'; store.set('open', o); };
  setOpen(store.get('open', false));
  $('tr-toggle').addEventListener('click', () => setOpen(box.style.display === 'none'));
  $('tr-setbtn').addEventListener('click', () => { const s = $('tr-settings'); s.style.display = s.style.display === 'none' ? 'block' : 'none'; });
  $('tr-savekey').addEventListener('click', () => { const v = $('tr-key').value.trim(); if (v) { store.set('api_key', v); location.reload(); } });
  $('tr-clearkey').addEventListener('click', () => { store.set('api_key', ''); location.reload(); });
  $('tr-total').checked = !!store.get('cost_is_total', false);
  $('tr-nostaff').checked = !!store.get('no_staff', false);
  $('tr-total').addEventListener('change', () => { store.set('cost_is_total', $('tr-total').checked); rebuild(); });
  $('tr-nostaff').addEventListener('change', () => { store.set('no_staff', $('tr-nostaff').checked); rebuild(); });
  $('tr-sort').value = store.get('sort', 'total');
  ['tr-sort', 'tr-type'].forEach(id => $(id).addEventListener('change', () => { store.set('sort', $('tr-sort').value); render(); }));
  ['tr-minhappy', 'tr-top'].forEach(id => $(id).addEventListener('input', render));

  // ---------- HTTP ----------
  function httpGet(url) {
    return new Promise((resolve, reject) => {
      if (typeof PDA_httpGet === 'function') PDA_httpGet(url).then(r => resolve(r.responseText), reject);
      else if (typeof GM_xmlhttpRequest === 'function') GM_xmlhttpRequest({ method: 'GET', url, onload: r => resolve(r.responseText), onerror: () => reject(new Error('Request failed')) });
      else fetch(url).then(r => r.text()).then(resolve, reject);
    });
  }
  const errors = [];
  async function api(label, path) {
    try {
      const d = JSON.parse(await httpGet(`https://api.torn.com/${path}${path.includes('?') ? '&' : '?'}key=${key}`));
      if (d.error) { errors.push(`${label}: ${d.error.error || JSON.stringify(d.error)}`); return null; }
      return d;
    } catch (e) { errors.push(`${label}: request failed`); return null; }
  }
  const toList = x => !x ? [] : Array.isArray(x) ? x : Object.values(x);
  const numOf = v => (v === undefined || v === null || v === '' ? NaN : Number(String(v).replace(/[^0-9.\-]/g, '')));

  // ---------- normalise one listing ----------
  // Field names are best-effort; the first present name wins. Cost per day is assumed unless Settings says total.
  function normalise(x, typeName, typeId, opt) {
    const happy = numOf(x.happy ?? x.happiness);
    const period = numOf(x.rental_period ?? x.period ?? x.days ?? x.rental_period_days);
    let cost = numOf(x.cost_per_day ?? x.cost ?? x.rent ?? x.price);
    if (opt.costIsTotal && period > 0) cost = cost / period;
    let upkeep = 0;
    const u = x.upkeep;
    if (u && typeof u === 'object') {
      upkeep = (numOf(u.property) || 0) + (opt.noStaff ? 0 : (numOf(u.staff) || 0));
    } else {
      upkeep = numOf(u ?? x.upkeep_property ?? x.upkeep_cost);
      if (!isFinite(upkeep)) upkeep = 0;
      if (!opt.noStaff && isFinite(numOf(x.upkeep_staff))) upkeep += numOf(x.upkeep_staff);
    }
    if (!isFinite(cost)) return null;
    const total = cost + upkeep;
    return {
      typeId, type: typeName, happy: isFinite(happy) ? happy : 0, period: isFinite(period) ? period : 0,
      rent: cost, upkeep, total, perHappy: happy > 0 ? total / happy : Infinity,
      periodTotal: isFinite(period) && period > 0 ? total * period : Infinity,
      owner: x.owner && (x.owner.id ?? x.owner) || x.owner_id || x.seller_id || null,
      id: x.id ?? x.listing_id ?? null
    };
  }

  // ---------- scan ----------
  let raw = [];      // raw API listings: { x, typeName, typeId }
  let rows = [];     // normalised
  let typeList = [];

  function rebuild() {
    const opt = { costIsTotal: $('tr-total').checked, noStaff: $('tr-nostaff').checked };
    rows = raw.map(r => normalise(r.x, r.typeName, r.typeId, opt)).filter(Boolean);
    render();
  }

  $('tr-scan').addEventListener('click', async () => {
    const out = $('tr-out'), btn = $('tr-scan');
    if (!key) { out.textContent = 'No API key. Open Settings and paste one.'; return; }
    btn.disabled = true; errors.length = 0; raw = [];
    out.textContent = 'Loading property types...';
    const cat = await api('Property types', 'v2/torn/properties');
    typeList = toList(cat && (cat.properties || cat)).map(p => ({ id: p.id, name: p.name })).filter(p => p.id !== undefined);
    if (!typeList.length) typeList = Array.from({ length: 14 }, (_, i) => ({ id: i + 1, name: 'Property #' + (i + 1) }));
    const sel = $('tr-type'); const cur = sel.value;
    sel.innerHTML = '<option value="">All types</option>' + typeList.map(t => `<option value="${esc(t.id)}">${esc(t.name)}</option>`).join('');
    sel.value = cur;

    let n = 0;
    for (const t of typeList) {
      out.textContent = `Scanning ${t.name} (${++n}/${typeList.length})...`;
      const d = await api('Rentals ' + t.name, `v2/market/${t.id}/rentals?limit=100`);
      await sleep(400);
      if (!d) continue;
      const list = toList(d.rentals && (d.rentals.listings || d.rentals) || d.listings || d.properties || d.market);
      for (const x of list) if (x && typeof x === 'object') raw.push({ x, typeName: t.name, typeId: t.id });
    }
    rebuild();
    btn.disabled = false;
  });

  // ---------- render ----------
  function render() {
    const out = $('tr-out');
    if (!raw.length) { if (errors.length) out.innerHTML = `<div style="color:#ff6b6b">No listings loaded.</div><div style="color:#888;font-size:10px;">${esc([...new Set(errors)].join(' | '))}</div>`; return; }
    const mode = $('tr-sort').value, type = $('tr-type').value;
    const minHappy = Number($('tr-minhappy').value) || 0, top = Math.max(1, Number($('tr-top').value) || 20);
    const key2 = { total: 'total', perhappy: 'perHappy', period: 'periodTotal' }[mode];
    const list = rows.filter(r => (!type || String(r.typeId) === type) && r.happy >= minHappy)
      .sort((a, b) => a[key2] - b[key2]).slice(0, top);

    // How misleading is rent-only ranking? Compare against the rent-only winner.
    const byRent = [...rows].sort((a, b) => a.rent - b.rent)[0];
    const byTotal = [...rows].sort((a, b) => a.total - b.total)[0];
    let html = `<div style="color:#999;font-size:10px;">${rows.length} listings scanned.${byRent && byTotal && byRent !== byTotal
      ? ` Cheapest rent alone: ${esc(byRent.type)} at ${money(byRent.rent)}/day, but with upkeep that is <b>${money(byRent.total)}</b>/day. Best true cost: ${esc(byTotal.type)} ${money(byTotal.total)}/day.` : ''}</div>`;
    html += list.length ? list.map((r, i) => `
      <div style="margin:6px 0;padding:6px;border:1px solid #333;border-radius:4px;">
        <div><b>${i + 1}. ${esc(r.type)}</b> <span style="color:#7fdb6a;">${money(r.total)}/day</span></div>
        <div style="color:#bbb;">Rent ${money(r.rent)} + upkeep ${money(r.upkeep)}${r.happy ? ' | Happy ' + r.happy.toLocaleString() : ''}${r.perHappy !== Infinity ? ' | ' + money(r.perHappy) + '/happy' : ''}</div>
        <div style="color:#888;font-size:10px;">${r.period ? r.period + ' day period = ' + money(r.periodTotal) + ' total' : 'period unknown'}${r.owner ? ` | <a style="color:#8ab4ff" href="/profiles.php?XID=${esc(r.owner)}">owner ${esc(r.owner)}</a>` : ''}</div>
      </div>`).join('') : '<div style="color:#999">No listings match these filters.</div>';
    html += `<div style="color:#666;font-size:10px;">Assumes listed cost is ${$('tr-total').checked ? 'the total for the period' : 'per day'}; staff upkeep ${$('tr-nostaff').checked ? 'ignored' : 'included'}. Change in Settings if numbers look off.${errors.length ? '<br>Notes: ' + esc([...new Set(errors)].join(' | ')) : ''}</div>`;
    out.innerHTML = html;
  }
})();
