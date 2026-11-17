// ==UserScript==
// @name         Torn Loss & Escape Ledger (PDA + Tampermonkey)
// @namespace    torn-loss-escape-ledger
// @author       pandaucreator
// @license      All Rights Reserved
// @homepageURL  https://github.com/pandaucreator/tornpda-scripts-and-browser
// @version      1.0
// @description  Tracks losses and escapes you deliver to buyers: orders, delivered counts from your attack history, what is owed, payments and balance. Read-only, never clicks anything.
// @match        https://www.torn.com/profiles.php*
// @match        https://www.torn.com/loader.php*
// @run-at       document-end
// @grant        GM_xmlhttpRequest
// @connect      api.torn.com
// ==/UserScript==

(function () {
  'use strict';

  // This script only READS your attack history and keeps a local ledger. It does not press
  // attack/leave/escape buttons. Check Torn's rules yourself on pre-arranged attacks.

  // ---------- storage ----------
  const store = {
    get(k, d) { try { const v = localStorage.getItem('tl_' + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem('tl_' + k, JSON.stringify(v)); } catch (e) {} }
  };

  // ---------- page ----------
  const params = new URLSearchParams(location.search);
  if (/loader\.php/.test(location.pathname) && params.get('sid') !== 'attack') return;
  const pageTarget = params.get('XID') || params.get('user2ID') || params.get('userID') || null;

  // ---------- key ----------
  // PDA replaces the placeholder with your key. Limited access is enough (attacks + profile).
  const pdaKey = '###PDA-APIKEY###';
  const customKey = store.get('api_key', '');
  const key = customKey || (pdaKey.charAt(0) !== '#' ? pdaKey : '');

  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const money = n => (n < 0 ? '-$' : '$') + Math.abs(Math.round(Number(n) || 0)).toLocaleString('en-US');
  const dateStr = ts => ts ? new Date(ts * 1000).toLocaleDateString() : '?';

  // ---------- data ----------
  // buyers[id] = { name, pLoss, pEsc, oLoss, oEsc, start, dLoss, dEsc, paid }
  const getBuyers = () => store.get('buyers', {});
  const saveBuyers = b => store.set('buyers', b);
  let seen = new Set(store.get('seen', []));
  const saveSeen = () => { const a = [...seen]; store.set('seen', a.slice(-2000)); };

  // Billable counts never exceed the order (0 = unlimited). Extras are shown but not billed.
  function bill(b) {
    const cap = (d, o) => (o > 0 ? Math.min(d, o) : d);
    const lossN = cap(b.dLoss, b.oLoss), escN = cap(b.dEsc, b.oEsc);
    const owed = lossN * b.pLoss + escN * b.pEsc;
    return {
      lossN, escN, owed, balance: owed - b.paid,
      extraLoss: b.dLoss - lossN, extraEsc: b.dEsc - escN,
      leftLoss: b.oLoss > 0 ? Math.max(0, b.oLoss - b.dLoss) : null,
      leftEsc: b.oEsc > 0 ? Math.max(0, b.oEsc - b.dEsc) : null
    };
  }

  // ---------- UI ----------
  const wrap = document.createElement('div');
  wrap.style.cssText = 'position:fixed;left:8px;bottom:170px;z-index:2147483647;font:12px/1.5 Arial,sans-serif;';
  wrap.innerHTML = `
    <div id="tl-box" style="display:none;position:absolute;left:0;bottom:36px;width:min(94vw,340px);max-height:72vh;overflow-y:auto;
      background:#1b1b1b;color:#ddd;border:1px solid #444;border-radius:6px;padding:10px 12px;box-shadow:0 2px 8px rgba(0,0,0,.6);">
      <div style="font-weight:bold;">Loss & escape ledger</div>
      <div id="tl-status" style="color:#888;font-size:10px;margin:2px 0 6px;"></div>
      <button id="tl-sync" style="width:100%;padding:8px;cursor:pointer;">Sync from attack history</button>
      <div id="tl-list" style="margin-top:8px;"></div>
      <hr style="border-color:#444;margin:8px 0">
      <div id="tl-addbtn" style="color:#8ab4ff;cursor:pointer;">+ Add buyer / order</div>
      <div id="tl-add" style="display:none;margin-top:6px;">
        <input id="tl-id" placeholder="Buyer player ID" value="${esc(pageTarget || '')}" style="width:100%;box-sizing:border-box;padding:6px;margin:2px 0;">
        <div style="display:flex;gap:4px;">
          <input id="tl-ploss" type="number" placeholder="Price / loss $" style="flex:1;min-width:0;padding:6px;">
          <input id="tl-pesc" type="number" placeholder="Price / escape $" style="flex:1;min-width:0;padding:6px;">
        </div>
        <div style="display:flex;gap:4px;margin-top:4px;">
          <input id="tl-oloss" type="number" placeholder="Losses ordered (0=any)" style="flex:1;min-width:0;padding:6px;">
          <input id="tl-oesc" type="number" placeholder="Escapes ordered (0=any)" style="flex:1;min-width:0;padding:6px;">
        </div>
        <button id="tl-save" style="width:100%;padding:8px;margin-top:6px;">Save order (counts start now)</button>
      </div>
      <hr style="border-color:#444;margin:8px 0">
      <div id="tl-setbtn" style="color:#8ab4ff;cursor:pointer;">Settings</div>
      <div id="tl-settings" style="display:none;margin-top:6px;">
        <div style="color:#888;font-size:10px;">Key in use: ${key ? (customKey ? 'custom key' : 'PDA key') : 'none'}</div>
        <input id="tl-key" type="password" placeholder="Custom Torn API key (optional)" style="width:100%;box-sizing:border-box;padding:6px;margin:4px 0;">
        <button id="tl-savekey" style="padding:6px;margin-right:4px;">Save key</button>
        <button id="tl-clearkey" style="padding:6px;">Use PDA key</button>
        <div style="margin-top:6px;"><button id="tl-reset" style="padding:6px;">Reset all ledger data</button></div>
      </div>
    </div>
    <button id="tl-toggle" style="padding:8px 12px;border-radius:18px;border:1px solid #555;background:#222;color:#fff;cursor:pointer;">Sales</button>`;
  document.body.appendChild(wrap);
  setInterval(() => { if (!wrap.isConnected && document.body) document.body.appendChild(wrap); }, 2000);
  const $ = id => wrap.querySelector('#' + id);
  const box = $('tl-box');
  const setOpen = o => { box.style.display = o ? 'block' : 'none'; store.set('open', o); };
  setOpen(store.get('open', false));
  $('tl-toggle').addEventListener('click', () => setOpen(box.style.display === 'none'));
  $('tl-addbtn').addEventListener('click', () => { const s = $('tl-add'); s.style.display = s.style.display === 'none' ? 'block' : 'none'; });
  $('tl-setbtn').addEventListener('click', () => { const s = $('tl-settings'); s.style.display = s.style.display === 'none' ? 'block' : 'none'; });
  $('tl-savekey').addEventListener('click', () => { const v = $('tl-key').value.trim(); if (v) { store.set('api_key', v); location.reload(); } });
  $('tl-clearkey').addEventListener('click', () => { store.set('api_key', ''); location.reload(); });
  $('tl-reset').addEventListener('click', () => {
    if (confirm('Delete all buyers, counts and payments stored by this script?')) { store.set('buyers', {}); store.set('seen', []); store.set('last_sync', 0); location.reload(); }
  });

  // ---------- HTTP ----------
  function httpGet(url) {
    return new Promise((resolve, reject) => {
      if (typeof PDA_httpGet === 'function') PDA_httpGet(url).then(r => resolve(r.responseText), reject);
      else if (typeof GM_xmlhttpRequest === 'function') GM_xmlhttpRequest({ method: 'GET', url, onload: r => resolve(r.responseText), onerror: () => reject(new Error('Request failed')) });
      else fetch(url).then(r => r.text()).then(resolve, reject);
    });
  }
  async function apiP(path) {
    try {
      const d = JSON.parse(await httpGet(`https://api.torn.com/${path}${path.includes('?') ? '&' : '?'}key=${key}`));
      return d.error ? { error: d.error } : d;
    } catch (e) { return { error: { error: 'Request failed' } }; }
  }

  // ---------- add order ----------
  $('tl-save').addEventListener('click', async () => {
    const id = $('tl-id').value.trim().replace(/\D/g, '');
    if (!id) { $('tl-status').textContent = 'Enter the buyer player ID.'; return; }
    const n = x => Math.max(0, Number($(x).value) || 0);
    const b = getBuyers();
    const old = b[id];
    let name = old ? old.name : id;
    if (!old && key) { const p = await apiP(`user/${id}?selections=profile`); if (!p.error && p.name) name = p.name; }
    // A new order resets delivered counts and payments for that buyer from now on.
    b[id] = { name, pLoss: n('tl-ploss'), pEsc: n('tl-pesc'), oLoss: n('tl-oloss'), oEsc: n('tl-oesc'),
              start: Math.floor(Date.now() / 1000), dLoss: 0, dEsc: 0, paid: 0 };
    saveBuyers(b);
    ['tl-ploss', 'tl-pesc', 'tl-oloss', 'tl-oesc'].forEach(x => { $(x).value = ''; });
    $('tl-add').style.display = 'none';
    render();
  });

  // ---------- sync from attack history ----------
  // API returns your latest ~100 attacks, so sync regularly. Only attacks since the order start count.
  async function sync() {
    if (!key) { $('tl-status').textContent = 'No API key. Open Settings.'; return; }
    const btn = $('tl-sync'); btn.disabled = true;
    $('tl-status').textContent = 'Syncing...';
    const me = await apiP('user/?selections=profile');
    if (me.error) { $('tl-status').textContent = 'Error: ' + me.error.error; btn.disabled = false; return; }
    const atk = await apiP('user/?selections=attacks');
    if (atk.error) { $('tl-status').textContent = 'Error: ' + atk.error.error; btn.disabled = false; return; }
    const b = getBuyers();
    let added = 0;
    for (const [k, a] of Object.entries(atk.attacks || {})) {
      const code = String(a.code || k);
      if (seen.has(code)) continue;
      if (String(a.attacker_id) !== String(me.player_id)) continue;
      const buyer = b[a.defender_id];
      if (!buyer) continue;
      const ts = a.timestamp_started || a.timestamp_ended || 0;
      if (ts < buyer.start) continue;
      const r = String(a.result || '').toLowerCase();
      if (/escape/.test(r)) buyer.dEsc += 1;
      else if (/^los[et]/.test(r)) buyer.dLoss += 1;
      else continue;
      seen.add(code); added++;
    }
    saveBuyers(b); saveSeen(); store.set('last_sync', Math.floor(Date.now() / 1000));
    $('tl-status').textContent = `Synced: ${added} new delivery(ies) counted.`;
    btn.disabled = false;
    render();
  }
  $('tl-sync').addEventListener('click', sync);

  // ---------- render ----------
  function render() {
    const b = getBuyers();
    const ids = Object.keys(b);
    const last = store.get('last_sync', 0);
    if (!$('tl-status').textContent) $('tl-status').textContent = last ? 'Last sync: ' + new Date(last * 1000).toLocaleString() : 'Not synced yet.';
    let totOwed = 0, totPaid = 0;
    const html = ids.map(id => {
      const x = b[id], v = bill(x);
      totOwed += v.owed; totPaid += x.paid;
      const here = pageTarget && String(pageTarget) === String(id);
      const left = [v.leftLoss !== null ? v.leftLoss + ' losses' : null, v.leftEsc !== null ? v.leftEsc + ' escapes' : null].filter(Boolean).join(', ');
      return `<div style="margin:6px 0;padding:6px;border:1px solid ${here ? '#7fdb6a' : '#333'};border-radius:4px;">
        <div><a style="color:#8ab4ff" href="/profiles.php?XID=${esc(id)}">${esc(x.name)} [${esc(id)}]</a>${here ? ' <b style="color:#7fdb6a">(this page)</b>' : ''}</div>
        <div style="color:#bbb;">Losses ${x.dLoss}${x.oLoss ? '/' + x.oLoss : ''} @ ${money(x.pLoss)} | Escapes ${x.dEsc}${x.oEsc ? '/' + x.oEsc : ''} @ ${money(x.pEsc)}</div>
        <div>Owed <b>${money(v.owed)}</b> | Paid <b>${money(x.paid)}</b> | Balance <b style="color:${v.balance > 0 ? '#ffd24d' : '#7fdb6a'}">${money(v.balance)}</b></div>
        ${left ? `<div style="color:#888;font-size:10px;">Still to deliver: ${esc(left)}</div>` : '<div style="color:#888;font-size:10px;">No cap set (open order)</div>'}
        ${v.extraLoss + v.extraEsc > 0 ? `<div style="color:#ff9b6b;font-size:10px;">Over order: ${v.extraLoss} extra losses, ${v.extraEsc} extra escapes (not billed)</div>` : ''}
        <div style="color:#666;font-size:10px;">Order started ${dateStr(x.start)}</div>
        <div style="display:flex;gap:4px;margin-top:4px;">
          <input data-pay="${esc(id)}" type="number" placeholder="Payment received $" style="flex:1;min-width:0;padding:5px;">
          <button data-act="pay" data-id="${esc(id)}" style="padding:5px;">Add</button>
          <button data-act="del" data-id="${esc(id)}" style="padding:5px;">Remove</button>
        </div></div>`;
    }).join('');
    $('tl-list').innerHTML = (html || '<div style="color:#999">No buyers yet. Use "Add buyer / order" below.</div>') +
      (ids.length ? `<div style="margin-top:4px;">Total owed <b>${money(totOwed)}</b> | Paid <b>${money(totPaid)}</b> | Outstanding <b>${money(totOwed - totPaid)}</b></div>` : '');
    // Show the open balance on the toggle when the current page's player is a buyer
    const hereBuyer = pageTarget && b[pageTarget];
    $('tl-toggle').textContent = hereBuyer ? 'Sales: ' + money(bill(hereBuyer).balance) : 'Sales';
  }
  $('tl-list').addEventListener('click', e => {
    const act = e.target.dataset && e.target.dataset.act; if (!act) return;
    const id = e.target.dataset.id, b = getBuyers(); if (!b[id]) return;
    if (act === 'pay') {
      const inp = $('tl-list').querySelector(`input[data-pay="${id}"]`);
      const amt = Number(inp && inp.value) || 0;
      if (amt > 0) { b[id].paid += amt; saveBuyers(b); render(); }
    } else if (act === 'del' && confirm('Remove ' + b[id].name + ' and their counts?')) { delete b[id]; saveBuyers(b); render(); }
  });

  render();
  // Auto-sync once when opening a page where the player is a buyer, so the count is current
  if (key && pageTarget && getBuyers()[pageTarget]) sync();
})();
