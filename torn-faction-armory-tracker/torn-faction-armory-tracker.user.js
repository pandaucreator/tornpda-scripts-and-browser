// ==UserScript==
// @name         Torn Faction Armory Tracker (PDA + Tampermonkey)
// @namespace    torn-faction-armory-tracker
// @author       pandaucreator
// @license      All Rights Reserved
// @homepageURL  https://github.com/pandaucreator/tornpda-scripts-and-browser
// @version      1.0.0
// @description  Search your faction armory log to see which items you've taken and returned
// @match        https://www.torn.com/factions.php*
// @run-at       document-end
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  // TornPDA replaces this placeholder with your API key automatically.
  // On desktop (Tampermonkey) you'll be prompted once and it's saved locally.
  let API_KEY = '###PDA-APIKEY###';
  if (API_KEY.startsWith('###')) {
    API_KEY = localStorage.getItem('fat_api_key') || '';
  }

  const PAGE_LIMIT = 100;   // entries per request
  const MAX_PAGES = 15;     // safety cap (~1500 log entries)

  // ---------- helpers ----------
  const stripHtml = (s) => s.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
  const fmtDate = (ts) => new Date(ts * 1000).toLocaleString();

  async function api(url) {
    const r = await fetch(url);
    const j = await r.json();
    if (j.error) throw new Error(`API error ${j.error.code}: ${j.error.error}`);
    return j;
  }

  async function getSelf() {
    const j = await api(`https://api.torn.com/user/?selections=basic&key=${API_KEY}`);
    return j.name;
  }

  function normalise(j) {
    const raw = j.news || j.armorynews || [];
    const arr = Array.isArray(raw)
      ? raw
      : Object.entries(raw).map(([id, v]) => ({ id, ...v }));
    return arr.map((n) => ({
      ts: n.timestamp,
      text: stripHtml(n.text || n.news || ''),
    }));
  }

  async function fetchLog(onProgress) {
    const all = [];
    try {
      // v2 with pagination
      let url = `https://api.torn.com/v2/faction/news?cat=armoryAction&limit=${PAGE_LIMIT}&sort=desc&key=${API_KEY}`;
      for (let i = 0; i < MAX_PAGES && url; i++) {
        const j = await api(url);
        const batch = normalise(j);
        all.push(...batch);
        onProgress(all.length);
        const next = j._metadata && j._metadata.links && j._metadata.links.next;
        url = batch.length && next ? `${next}&key=${API_KEY}` : null;
      }
      if (all.length) return all;
    } catch (e) {
      console.warn('[FAT] v2 failed, falling back to v1:', e.message);
    }
    // v1 fallback (last ~100 entries only)
    const j = await api(`https://api.torn.com/faction/?selections=armorynews&key=${API_KEY}`);
    const batch = normalise(j);
    onProgress(batch.length);
    return batch;
  }

  // ---------- parsing ----------
  // Armory log lines look roughly like:
  //   "Bob used one of the faction's Xanax items."
  //   "Alice loaned 1 x Box of Chocolate Bars to Bob."
  //   "Bob returned 1 x Item."  /  "Alice retrieved 1 x Item from Bob."
  // Anything that doesn't match is counted as "unparsed" so you can check it.
  const RULES = [
    { type: 'used',     re: /^(.+?) used one of the faction's (.+?) items?\.?$/i, f: (m) => ({ who: m[1], item: m[2], qty: 1 }) },
    { type: 'loan',     re: /^(.+?) (?:loaned|lent) (?:(\d+) x )?(.+?) to (.+?)\.?$/i, f: (m) => ({ from: m[1], qty: +m[2] || 1, item: m[3], who: m[4] }) },
    { type: 'retrieve', re: /^(.+?) retrieved (?:(\d+) x )?(.+?) from (.+?)\.?$/i, f: (m) => ({ by: m[1], qty: +m[2] || 1, item: m[3], who: m[4] }) },
    { type: 'return',   re: /^(.+?) returned (?:(\d+) x )?(.+?)\.?$/i, f: (m) => ({ who: m[1], qty: +m[2] || 1, item: m[3] }) },
  ];

  function parse(entries) {
    const events = [];
    let unparsed = 0;
    for (const e of entries) {
      let hit = false;
      for (const r of RULES) {
        const m = e.text.match(r.re);
        if (m) {
          events.push({ ...r.f(m), type: r.type, ts: e.ts, text: e.text });
          hit = true;
          break;
        }
      }
      if (!hit) unparsed++;
    }
    return { events, unparsed };
  }

  function summarise(events, me) {
    const meL = me.toLowerCase();
    const items = {};
    const row = (name) => (items[name] ||= { item: name, taken: 0, returned: 0, used: 0, last: 0 });
    for (const ev of events) {
      if ((ev.who || '').toLowerCase() !== meL) continue;
      const r = row(ev.item);
      r.last = Math.max(r.last, ev.ts);
      if (ev.type === 'loan') r.taken += ev.qty;
      else if (ev.type === 'used') r.used += ev.qty;
      else if (ev.type === 'return' || ev.type === 'retrieve') r.returned += ev.qty;
    }
    return Object.values(items).sort((a, b) => b.last - a.last);
  }

  // ---------- UI ----------
  const css = `
    #fat-btn{position:fixed;bottom:80px;right:12px;z-index:99999;background:#333;color:#fff;border:1px solid #666;border-radius:6px;padding:8px 10px;font-size:13px}
    #fat-panel{position:fixed;top:60px;left:2%;width:96%;max-height:75vh;overflow:auto;z-index:99999;background:#222;color:#ddd;border:1px solid #666;border-radius:8px;padding:10px;font-size:12px;display:none}
    #fat-panel input{background:#111;color:#fff;border:1px solid #555;border-radius:4px;padding:5px;margin:2px 4px 6px 0;width:42%}
    #fat-panel button{background:#444;color:#fff;border:1px solid #777;border-radius:4px;padding:5px 8px;margin:2px}
    #fat-panel table{width:100%;border-collapse:collapse;margin-top:6px}
    #fat-panel th,#fat-panel td{border-bottom:1px solid #444;padding:4px;text-align:left}
    #fat-panel .out{color:#ff8a65;font-weight:bold}
    #fat-panel .ok{color:#81c784}
    #fat-status{margin:4px 0;color:#aaa}
  `;
  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);

  const btn = document.createElement('button');
  btn.id = 'fat-btn';
  btn.textContent = 'Armory Log';
  document.body.appendChild(btn);

  const panel = document.createElement('div');
  panel.id = 'fat-panel';
  panel.innerHTML = `
    <b>Faction Armory Tracker</b><br>
    <input id="fat-user" placeholder="Your name (auto)">
    <input id="fat-item" placeholder="Filter item…">
    <button id="fat-go">Search</button>
    <button id="fat-raw">Raw log</button>
    <div id="fat-status"></div>
    <div id="fat-out"></div>`;
  document.body.appendChild(panel);

  const $ = (id) => document.getElementById(id);
  let cache = null;

  btn.onclick = () => {
    panel.style.display = panel.style.display === 'block' ? 'none' : 'block';
  };

  async function run(showRaw) {
    if (!API_KEY) {
      const k = prompt('Enter a Torn API key (needs faction access):');
      if (!k) return;
      API_KEY = k.trim();
      localStorage.setItem('fat_api_key', API_KEY);
    }
    const status = $('fat-status');
    const out = $('fat-out');
    out.innerHTML = '';
    try {
      if (!$('fat-user').value) $('fat-user').value = await getSelf();
      const me = $('fat-user').value.trim();
      if (!cache) {
        status.textContent = 'Fetching armory log…';
        cache = await fetchLog((n) => (status.textContent = `Fetched ${n} entries…`));
      }
      const filter = $('fat-item').value.trim().toLowerCase();

      if (showRaw) {
        const lines = cache
          .filter((e) => e.text.toLowerCase().includes(me.toLowerCase()))
          .filter((e) => !filter || e.text.toLowerCase().includes(filter))
          .slice(0, 200);
        status.textContent = `${lines.length} raw lines mentioning ${me}`;
        out.innerHTML = '<table>' + lines.map((e) => `<tr><td>${fmtDate(e.ts)}</td><td>${e.text}</td></tr>`).join('') + '</table>';
        return;
      }

      const { events, unparsed } = parse(cache);
      let rows = summarise(events, me);
      if (filter) rows = rows.filter((r) => r.item.toLowerCase().includes(filter));
      const oldest = cache.length ? fmtDate(cache[cache.length - 1].ts) : 'n/a';
      status.textContent = `${cache.length} entries (back to ${oldest}), ${unparsed} unparsed. Use "Raw log" to verify.`;

      if (!rows.length) {
        out.textContent = 'No matching armory activity found for that name/item.';
        return;
      }
      out.innerHTML =
        '<table><tr><th>Item</th><th>Taken</th><th>Returned</th><th>Out</th><th>Used</th><th>Last</th></tr>' +
        rows
          .map((r) => {
            const outstanding = Math.max(0, r.taken - r.returned);
            return `<tr><td>${r.item}</td><td>${r.taken}</td><td>${r.returned}</td>` +
              `<td class="${outstanding ? 'out' : 'ok'}">${outstanding}</td><td>${r.used}</td><td>${fmtDate(r.last)}</td></tr>`;
          })
          .join('') +
        '</table>';
    } catch (e) {
      status.textContent = 'Error: ' + e.message;
    }
  }

  $('fat-go').onclick = () => run(false);
  $('fat-raw').onclick = () => run(true);
})();
