import { createClient } from '@supabase/supabase-js';
import './style.css';
import { parseTable, mapColumns } from './importer.js';
import QRCode from 'qrcode';

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;
const sb = SUPABASE_URL && SUPABASE_KEY ? createClient(SUPABASE_URL, SUPABASE_KEY) : null;

// Parent / spectator mode: open the site with ?live (this is what the QR code points to).
const PARENT = new URLSearchParams(location.search).has('live');
const parentUrl = () => location.origin + location.pathname + '?live';

/* ---------- helpers ---------- */
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const LS = {
  get(k, d) { try { const v = localStorage.getItem('ninja.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('ninja.' + k, JSON.stringify(v)); } catch { /* ignore */ } },
};
const byOrder = (a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0) || String(a.name).localeCompare(b.name);
const numKey = v => { const n = parseFloat(v); return isNaN(n) ? Infinity : n; };
const cmpText = (a, b) => numKey(a) - numKey(b) || String(a || '').localeCompare(String(b || ''));
const byBib = (a, b) => cmpText(a.bib, b.bib) || String(a.name).localeCompare(b.name);
const byFlightBib = (a, b) => (a.flight ? 0 : 1) - (b.flight ? 0 : 1) || cmpText(a.flight, b.flight) || byBib(a, b);
const norm = s => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
const cleanFlight = s => String(s || '').trim().replace(/^(flight|flt|heat|wave)\s*#?\s*/i, '');
const flightLabel = f => (f ? `Flight ${f}` : 'No flight');

export function parseTime(s) {
  s = String(s).trim(); if (!s) return null;
  const m = s.match(/^(?:(\d+):)?(\d+(?:\.\d+)?)$/); if (!m) return NaN;
  return Math.round(((m[1] ? +m[1] * 60 : 0) + +m[2]) * 100) / 100;
}
export function fmtTime(t) {
  if (t == null || !isFinite(t)) return '—';
  const m = Math.floor(t / 60), s = t - m * 60;
  return m ? `${m}:${s.toFixed(2).padStart(5, '0')}` : s.toFixed(2);
}
const fmtPts = p => (Number.isInteger(p) ? String(p) : p.toFixed(1));
const num = v => (v == null ? null : Number(v));

/* ---------- state ---------- */
const S = {
  event: {}, divisions: [], athletes: [], runs: [], loaded: false, session: null, authChecked: false, qr: '',
  tab: LS.get('tab', 'board'), viewDiv: LS.get('viewDiv', null), judgeFlight: LS.get('judgeFlight', 'all'),
  search: '', pendingMain: false, saving: new Set(), runsDiv: undefined,
  importText: '', importDiv: null, preview: null, importing: false,
};

function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toast.h); toast.h = setTimeout(() => (t.hidden = true), 3000);
}
function setSync(on, text) { const s = $('#sync'); s.classList.toggle('on', on); s.lastElementChild.textContent = text; }

async function write(fn, ok) {
  if (!sb) { toast('Supabase is not configured.'); return false; }
  if (PARENT || !S.session) { toast('Sign in with the staff login to make changes.'); return false; }
  try {
    const res = await fn();
    const err = Array.isArray(res) ? res.find(r => r && r.error)?.error : res && res.error;
    if (err) throw err;
    if (ok) toast(ok);
    return true;
  } catch (e) {
    const msg = String(e?.message || '');
    if (/row-level security|permission denied|JWT/i.test(msg)) toast('Not saved: this device is not signed in with the staff login.');
    else toast('Could not save: ' + (msg || 'check the connection and try again'));
    return false;
  }
}

const activeDiv = () => S.divisions.find(d => d.id === S.event.active_division_id) || null;
const viewDiv = () => S.divisions.find(d => d.id === S.viewDiv) || activeDiv() || [...S.divisions].sort(byOrder)[0] || null;
const divAthletes = id => S.athletes.filter(a => a.division_id === id).sort(byFlightBib);
const divFlights = id => [...new Set(divAthletes(id).map(a => a.flight || ''))].sort((a, b) => (a ? 0 : 1) - (b ? 0 : 1) || cmpText(a, b));
const courseName = d => (d && d.course_name) || 'Course';

/* ---------- standings: overall per division, most points wins, ties broken by fastest time ---------- */
export function standings(divId) {
  const runBy = {};
  for (const r of S.runs) if (r.division_id === divId) runBy[r.athlete_id] = r;
  const rows = [];
  for (const a of divAthletes(divId)) {
    const r = runBy[a.id]; if (!r) continue;
    rows.push({ a, r, pts: Math.round((Number(r.points) || 0) * 100) / 100, time: r.time_sec == null ? null : Math.round(Number(r.time_sec) * 100) / 100 });
  }
  rows.sort((x, y) => (y.pts - x.pts) || ((x.time ?? Infinity) - (y.time ?? Infinity)) || String(x.a.name).localeCompare(y.a.name));
  rows.forEach((r, i) => {
    const p = rows[i - 1], n = rows[i + 1];
    r.rank = p && p.pts === r.pts && p.time === r.time ? p.rank : i + 1;
    r.timeBreak = !!((p && p.pts === r.pts && p.time !== r.time) || (n && n.pts === r.pts && n.time !== r.time));
  });
  return rows;
}

/* ---------- rendering ---------- */
function isEditing() {
  const a = document.activeElement;
  return !!(a && $('#main').contains(a) && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName));
}
function render() {
  $('#eventName').textContent = S.event.name || 'Ninja Tournament';
  document.title = (S.event.name || 'Ninja Tournament') + (PARENT ? ' · Live results' : '');
  document.querySelectorAll('.tab').forEach(t => t.setAttribute('aria-selected', String(t.dataset.tab === S.tab)));
  const gated = !PARENT && sb && S.authChecked && !S.session;
  $('#tabs').hidden = PARENT || gated;
  $('.rail').hidden = gated;
  $('#signOut').hidden = PARENT || !S.session;
  document.body.classList.toggle('parent', PARENT);
  renderRail();
  syncRunsDivision();
  if (isEditing() && S.tab !== 'board') { S.pendingMain = true; return; }
  renderMain();
}
function renderRail() {
  const v = viewDiv(), act = activeDiv();
  let h = '<span class="lbl">Division</span>';
  for (const d of [...S.divisions].sort(byOrder)) {
    const st = d.id === S.event.active_division_id ? 'live' : d.status === 'final' ? 'final' : 'upcoming';
    h += `<button class="chip" data-act="view-div" data-id="${d.id}" aria-pressed="${!!v && v.id === d.id}">${esc(d.name)} <span class="pill ${st}">${st === 'live' ? 'Live' : st === 'final' ? 'Final' : 'Up next'}</span></button>`;
  }
  if (!S.divisions.length) h += '<span class="muted">No divisions yet. Add them in Setup.</span>';
  if (S.viewDiv && act && S.viewDiv !== act.id) h += '<button class="btn ghost" data-act="follow-live" style="padding:6px 12px">Follow live division</button>';
  $('#rail').innerHTML = h;
}
function renderMain() {
  S.pendingMain = false;
  const m = $('#main');
  if (!sb) {
    m.innerHTML = `<div class="banner">Supabase isn't configured. Set <b>VITE_SUPABASE_URL</b> and <b>VITE_SUPABASE_ANON_KEY</b> (see README), then redeploy.</div>`;
    return;
  }
  if (PARENT) { if (S.loaded) m.innerHTML = boardView(); return; }
  if (!S.authChecked) return;
  if (!S.session) { m.innerHTML = signInView(); return; }
  if (!S.loaded) return;
  m.innerHTML = ({ board: boardView, judge: judgeView, athletes: athletesView, setup: setupView }[S.tab] || boardView)();
  if (S.tab === 'judge') applySearch();
}

function signInView() {
  return `<form class="panel signin" data-form="signin"><h2>Staff sign in</h2>
    <span class="note">Judges and the host use the shared staff login. Each device only needs to sign in once.</span>
    <label class="f">Email<input id="siEmail" type="email" autocomplete="username" required></label>
    <label class="f">Password<input id="siPass" type="password" autocomplete="current-password" required></label>
    <div class="row"><button class="btn">Sign in</button><a class="btn ghost" href="?live">View live results instead</a></div></form>`;
}

function boardView() {
  const d = viewDiv();
  if (!d) return PARENT ? `<div class="empty"><strong>Results will appear here</strong><span>This page updates on its own once the competition starts.</span></div>`
    : `<div class="empty"><strong>Set up the event first</strong><span>Add your divisions in Setup, then enter athletes. Winners appear here as judges record runs.</span><button class="btn" data-act="tab" data-tab="setup">Go to Setup</button></div>`;
  const rows = standings(d.id);
  const total = divAthletes(d.id).length;
  const hasFlights = divFlights(d.id).some(Boolean);
  const live = d.id === S.event.active_division_id, final = !live && d.status === 'final';
  let h = `<div class="head"><div><h2>${esc(d.name)} · ${final ? 'Final results' : 'Overall standings'}</h2><div class="sub">${esc(courseName(d))} · ${rows.length} of ${total} athletes have run${hasFlights ? ', all flights combined' : ''} · most points wins, fastest time breaks ties</div></div></div>`;
  if (PARENT) h = h.replace('<div class="head">', `<div class="head">${live ? '<span class="pill live big">Live now</span>' : ''}`);
  if (!rows.length) return h + `<div class="empty"><strong>No runs recorded yet</strong><span>${PARENT ? 'Scores appear here as soon as the judges record them. No need to refresh.' : 'When a judge saves points and a time on the Judge tab, this board fills in on every device.'}</span></div>`;
  h += `<div class="scroll"><table><thead><tr><th>Place</th><th>Athlete</th>${hasFlights ? '<th class="hide-sm">Flight</th>' : ''}<th class="num">Points</th><th class="num">Time</th></tr></thead><tbody>`;
  for (const r of rows.slice(0, 20)) {
    h += `<tr class="r${r.rank}"><td class="rank"><span>${r.rank}</span></td><td><span class="bib">${r.a.bib ? '#' + esc(r.a.bib) : ''}</span><span class="name">${esc(r.a.name)}</span>${r.timeBreak ? '<span class="tie">Tie · time</span>' : ''}</td>`;
    if (hasFlights) h += `<td class="hide-sm muted">${r.a.flight ? esc(r.a.flight) : '—'}</td>`;
    h += `<td class="num total">${fmtPts(r.pts)}</td><td class="num time">${fmtTime(r.time)}</td></tr>`;
  }
  h += '</tbody></table></div>';
  if (rows.length > 20) h += `<p class="note">Showing the top 20 of ${rows.length}.</p>`;
  if (PARENT) h += `<p class="note">Updates automatically. Tap a division above to see its results.</p>`;
  return h;
}

function judgeView() {
  const d = viewDiv();
  if (!d) return `<div class="empty"><strong>Nothing to judge yet</strong><span>Add a division in Setup.</span><button class="btn" data-act="tab" data-tab="setup">Go to Setup</button></div>`;
  const flights = divFlights(d.id);
  if (S.judgeFlight !== 'all' && !flights.includes(S.judgeFlight)) S.judgeFlight = 'all';
  const as = divAthletes(d.id).filter(a => S.judgeFlight === 'all' || (a.flight || '') === S.judgeFlight);
  let h = `<div class="head"><div><h2>Judge · ${esc(courseName(d))}</h2><div class="sub">${esc(d.name)}${S.judgeFlight !== 'all' ? ' · ' + esc(flightLabel(S.judgeFlight)) : ''} · type points and time, then tap Return or the next box to save</div></div></div>`;
  if (flights.length > 1 || flights[0]) {
    h += `<div class="seg" role="group" aria-label="Flight"><button data-act="judge-flight" data-id="all" aria-pressed="${S.judgeFlight === 'all'}">All flights</button>${flights.map(f => {
      const fa = divAthletes(d.id).filter(a => (a.flight || '') === f), done = fa.filter(a => S.runs.some(r => r.athlete_id === a.id)).length;
      return `<button data-act="judge-flight" data-id="${esc(f)}" aria-pressed="${S.judgeFlight === f}">${esc(flightLabel(f))} <small class="muted">${done}/${fa.length}</small></button>`;
    }).join('')}</div>`;
  }
  if (!as.length) return h + `<div class="empty"><strong>No athletes in ${esc(d.name)}</strong><span>Add or import athletes on the Athletes tab.</span><button class="btn" data-act="tab" data-tab="athletes">Add athletes</button></div>`;
  h += `<div class="row" style="margin-bottom:12px"><input id="search" placeholder="Find athlete by name or bib" value="${esc(S.search)}" autocomplete="off" style="max-width:360px"></div>`;
  h += `<div class="scroll"><table class="sheet"><thead><tr><th>Athlete</th><th class="pcol">Points</th><th class="tcol">Time</th><th class="state"><span class="hide-sm">Saved</span></th></tr></thead><tbody>`;
  let lastFlight = null;
  for (const a of as) {
    if (S.judgeFlight === 'all' && (flights.length > 1 || flights[0]) && (a.flight || '') !== lastFlight) {
      lastFlight = a.flight || '';
      h += `<tr class="group"><td colspan="4">${esc(flightLabel(lastFlight))}</td></tr>`;
    }
    const r = S.runs.find(x => x.athlete_id === a.id);
    const busy = S.saving.has(a.id);
    h += `<tr data-aid="${a.id}" data-q="${esc((a.name + ' ' + (a.bib || '')).toLowerCase())}"><td><span class="bib">${a.bib ? '#' + esc(a.bib) : ''}</span><span class="name">${esc(a.name)}</span></td>
    <td><input id="p_${a.id}" class="pts" inputmode="decimal" autocomplete="off" aria-label="Points for ${esc(a.name)}" value="${r ? esc(fmtPts(Number(r.points) || 0)) : ''}"></td>
    <td><input id="t_${a.id}" class="tm" inputmode="decimal" autocomplete="off" placeholder="0:00.00" aria-label="Time for ${esc(a.name)}" value="${r && r.time_sec != null ? fmtTime(num(r.time_sec)) : ''}"></td>
    <td class="state"><span class="dot ${busy ? 'busy' : r ? 'ok' : ''}" title="${r ? 'Saved' : 'Not recorded'}"></span></td></tr>`;
  }
  h += '</tbody></table></div><p class="note">Time can be entered as 1:23.45 or 83.45 seconds. Clear both boxes to remove a run.</p>';
  return h;
}
function applySearch() {
  const q = S.search.trim().toLowerCase();
  document.querySelectorAll('.sheet tbody tr[data-aid]').forEach(tr => (tr.hidden = !!q && !tr.dataset.q.includes(q)));
  document.querySelectorAll('.sheet tbody tr.group').forEach(tr => (tr.hidden = !!q));
}

function divOptions(sel) {
  return [...S.divisions].sort(byOrder).map(x => `<option value="${x.id}" ${x.id === sel ? 'selected' : ''}>${esc(x.name)}</option>`).join('');
}

function importPanel(d) {
  const p = S.preview;
  let h = `<div class="panel import"><h3>Import from Excel or Google Sheets</h3>
    <span class="note">Copy the rows in your spreadsheet (include the header row) and paste them below, or choose a CSV file. Columns it understands: <b>Name</b> (or First + Last), <b>Bib</b>, <b>Division</b>, <b>Flight</b>.</span>
    <textarea id="importText" placeholder="Bib&#9;Name&#9;Division&#9;Flight&#10;12&#9;Maya Ortiz&#9;Division A&#9;1&#10;13&#9;Jordan Lee&#9;Division A&#9;2">${esc(S.importText)}</textarea>
    <div class="row">
      <label class="btn ghost file-btn">Choose CSV file<input id="importFile" type="file" accept=".csv,.tsv,.txt,text/csv" hidden></label>
      <label class="f" style="flex:1 1 200px">Athletes with no division go into<select id="importDiv">${divOptions(S.importDiv || d.id)}</select></label>
      <button class="btn" data-act="import-preview">Preview</button>
    </div>`;
  if (p) {
    if (p.error) h += `<div class="banner">${esc(p.error)}</div>`;
    else {
      const ready = p.items.filter(i => !i.dup && !i.bad), dups = p.items.filter(i => i.dup), bad = p.items.filter(i => i.bad);
      const newDivs = [...new Set(ready.filter(i => i.newDiv).map(i => i.divName))];
      h += `<div class="summary"><b>${ready.length} athletes ready to import.</b>`;
      if (dups.length) h += ` ${dups.length} already entered will be skipped.`;
      if (bad.length) h += ` ${bad.length} rows have no name and will be skipped.`;
      if (newDivs.length) h += ` New ${newDivs.length === 1 ? 'division' : 'divisions'} will be created: ${newDivs.map(esc).join(', ')}.`;
      h += `<div class="muted" style="font-size:.85rem">Columns found: ${esc(p.found)}</div></div>`;
      h += `<div class="scroll preview"><table><thead><tr><th>Bib</th><th>Name</th><th>Division</th><th>Flight</th><th></th></tr></thead><tbody>${p.items.slice(0, 300).map(i => `<tr class="${i.dup || i.bad ? 'skip' : ''}"><td class="bib">${esc(i.bib)}</td><td>${esc(i.name) || '<span class="muted">(blank)</span>'}</td><td>${esc(i.divName)}</td><td>${esc(i.flight)}</td><td>${i.bad ? '<span class="tag">Skip</span>' : i.dup ? '<span class="tag">Already entered</span>' : i.newDiv ? '<span class="tag new">New division</span>' : ''}</td></tr>`).join('')}</tbody></table></div>`;
      if (p.items.length > 300) h += `<span class="note">Showing the first 300 of ${p.items.length} rows.</span>`;
      h += `<div class="row"><button class="btn" data-act="import-run" ${ready.length && !S.importing ? '' : 'disabled'}>${S.importing ? 'Importing…' : `Import ${ready.length} athletes`}</button><button class="btn ghost" data-act="import-cancel">Cancel</button></div>`;
    }
  }
  return h + '</div>';
}

function athletesView() {
  const d = viewDiv();
  if (!d) return `<div class="empty"><strong>Add a division first</strong><span>Athletes are entered into a division.</span><button class="btn" data-act="tab" data-tab="setup">Go to Setup</button></div>`;
  const as = divAthletes(d.id);
  const flights = divFlights(d.id);
  let h = `<div class="head"><div><h2>Athletes · ${esc(d.name)}</h2><div class="sub">${as.length} in this division${flights.some(Boolean) ? ` across ${flights.filter(Boolean).length} flights` : ''} · ${S.athletes.length} total. Switch divisions with the bar above.</div></div></div><div class="grid2">`;
  h += importPanel(d);
  h += `<form class="panel" data-form="add-athlete"><h3>Add one athlete</h3>
    <div class="row"><label class="f" style="flex:0 0 80px">Bib<input id="newBib" autocomplete="off"></label><label class="f" style="flex:1 1 160px">Name<input id="newName" autocomplete="off" required></label></div>
    <div class="row"><label class="f" style="flex:1 1 160px">Division<select id="newDiv">${divOptions(d.id)}</select></label><label class="f" style="flex:0 0 90px">Flight<input id="newFlight" inputmode="numeric" autocomplete="off" value="${S.judgeFlight !== 'all' ? esc(S.judgeFlight) : ''}"></label></div>
    <div><button class="btn">Add athlete</button></div></form>`;
  h += `<form class="panel" data-form="split"><h3>Split into flights</h3>
    <span class="note">Puts the ${as.length} athletes in ${esc(d.name)} into flights in bib order. This replaces their current flights.</span>
    <div class="row"><label class="f" style="flex:0 0 150px">Athletes per flight<input id="perFlight" inputmode="numeric" autocomplete="off" placeholder="10"></label><button class="btn ghost" ${as.length ? '' : 'disabled'}>Split into flights</button></div></form></div>`;
  if (!as.length) return h + `<div class="empty" style="margin-top:16px"><strong>No athletes in ${esc(d.name)} yet</strong><span>Import a list or add them one at a time above.</span></div>`;
  h += '<div class="list" style="margin-top:16px">';
  let last = null;
  for (const a of as) {
    if ((a.flight || '') !== last) { last = a.flight || ''; h += `<div class="list-head">${esc(flightLabel(last))} <span class="muted">· ${as.filter(x => (x.flight || '') === last).length}</span></div>`; }
    h += `<div class="item"><input id="ab_${a.id}" data-edit="athlete-bib" data-id="${a.id}" value="${esc(a.bib || '')}" placeholder="Bib" style="flex:0 0 70px" aria-label="Bib"><input id="an_${a.id}" data-edit="athlete-name" data-id="${a.id}" value="${esc(a.name)}" aria-label="Name"><input id="af_${a.id}" data-edit="athlete-flight" data-id="${a.id}" value="${esc(a.flight || '')}" placeholder="Flight" inputmode="numeric" style="flex:0 0 70px" aria-label="Flight"><select id="ad_${a.id}" data-edit="athlete-div" data-id="${a.id}" style="flex:0 1 160px" aria-label="Division">${divOptions(a.division_id)}</select><button class="btn danger" data-act="del-athlete" data-id="${a.id}">Remove</button></div>`;
  }
  return h + '</div>';
}

function setupView() {
  const divs = [...S.divisions].sort(byOrder);
  let h = `<div class="head"><div><h2>Event setup</h2><div class="sub">Changes here show up on every device right away.</div></div></div><div class="grid2">`;
  h += `<div class="panel"><h3>Event</h3><label class="f">Event name<input id="evName" data-edit="event-name" value="${esc(S.event.name || '')}" placeholder="Fall Ninja Classic"></label></div>`;
  h += `<div class="panel span2"><h3>Divisions and courses</h3><span class="note">Each division runs one course in one or more flights. Set the division that's running now to Live. When all its flights are done, mark it Final to lock its awards view, then make the next one Live.</span><div class="list">${divs.map(d => {
    const live = d.id === S.event.active_division_id, n = S.athletes.filter(a => a.division_id === d.id).length, nf = divFlights(d.id).filter(Boolean).length;
    return `<div class="item div-item">
      <label class="f" style="flex:1 1 160px">Division<input id="dn_${d.id}" data-edit="div-name" data-id="${d.id}" value="${esc(d.name)}"></label>
      <label class="f" style="flex:1 1 160px">Course<input id="dc_${d.id}" data-edit="div-course" data-id="${d.id}" value="${esc(d.course_name || '')}" placeholder="Course name"></label>
      <span class="muted" style="font-size:.85rem">${n} athletes${nf ? ` · ${nf} flights` : ''}</span>
      ${live ? `<button class="btn" data-act="div-final" data-id="${d.id}">Mark final</button>` : `<button class="btn ghost" data-act="div-live" data-id="${d.id}">Make live</button>`}
      ${!live && d.status === 'final' ? `<button class="btn ghost" data-act="div-reopen" data-id="${d.id}">Reopen</button>` : ''}
      <button class="btn danger" data-act="del-div" data-id="${d.id}" ${n ? 'disabled title="Move or remove its athletes first"' : ''}>Delete</button></div>`;
  }).join('') || '<span class="muted">No divisions yet.</span>'}</div>
    <form class="row" data-form="add-div"><input id="newDivName" placeholder="Division name" style="flex:1 1 160px"><input id="newDivCourse" placeholder="Course name" style="flex:1 1 160px"><button class="btn">Add division</button></form></div>`;
  h += `<div class="panel qr-panel"><h3>Live results for parents</h3>
    <span class="note">Parents scan this code to watch the top 20 for each division update live. Their page has no edit buttons, and the database refuses changes from anyone not signed in with the staff login.</span>
    <div class="qr-row">${S.qr ? `<img class="qr" src="${S.qr}" alt="QR code for live results" width="180" height="180">` : '<div class="qr qr-wait">Making code…</div>'}
    <div class="qr-side"><code class="link" id="parentLink">${esc(parentUrl())}</code>
    <div class="row"><button class="btn ghost" data-act="copy-link">Copy link</button><button class="btn" data-act="show-qr">Show big QR code</button></div></div></div></div>`;
  h += `<div class="panel"><h3>Using it on iPads and phones</h3><p class="note" style="margin:0">Open the site on every device. Judges score on the Judge tab and can pick their flight. The Winners tab shows the overall top 20 for the division and updates live on all screens. On iPad, Share → Add to Home Screen makes it open full screen.</p></div></div>`;
  return h;
}

/* ---------- import ---------- */
function matchDivision(name) {
  const n = norm(name); if (!n) return null;
  return S.divisions.find(d => norm(d.name) === n || norm(d.name) === 'division ' + n || 'division ' + norm(d.name) === n) || null;
}
function buildPreview() {
  S.importText = $('#importText')?.value ?? S.importText;
  S.importDiv = $('#importDiv')?.value || S.importDiv;
  const rows = parseTable(S.importText);
  if (!rows.length) { S.preview = { error: 'Paste some rows or choose a CSV file first.' }; return; }
  const map = mapColumns(rows);
  if (map.error) { S.preview = { error: map.error }; return; }
  const def = S.divisions.find(d => d.id === S.importDiv) || viewDiv();
  const existing = new Set(S.athletes.map(a => a.division_id + '|' + norm(a.name)));
  const seen = new Set();
  const items = map.records.map(rec => {
    const m = rec.division ? matchDivision(rec.division) : def;
    const divName = m ? m.name : rec.division.trim();
    const key = (m ? m.id : 'new:' + norm(divName)) + '|' + norm(rec.name);
    const dup = !!rec.name && (existing.has(key) || seen.has(key));
    seen.add(key);
    return { name: rec.name, bib: rec.bib, flight: cleanFlight(rec.flight), divName, divId: m ? m.id : null, newDiv: !m, dup, bad: !rec.name };
  });
  S.preview = { items, found: map.found };
}
async function runImport() {
  const ready = S.preview?.items.filter(i => !i.dup && !i.bad) || [];
  if (!ready.length) return;
  S.importing = true; renderMain();
  const ok = await write(async () => {
    const newNames = [...new Set(ready.filter(i => i.newDiv).map(i => i.divName))];
    const ids = {};
    if (newNames.length) {
      let order = S.divisions.reduce((m, x) => Math.max(m, x.sort_order ?? 0), 0);
      const r = await sb.from('divisions').insert(newNames.map(name => ({ name, sort_order: ++order, course_name: 'Course' }))).select();
      if (r.error) return r;
      for (const d of r.data) ids[norm(d.name)] = d.id;
    }
    const rows = ready.map(i => ({ name: i.name, bib: i.bib, flight: i.flight, division_id: i.divId || ids[norm(i.divName)] }));
    for (let k = 0; k < rows.length; k += 500) {
      const r = await sb.from('athletes').insert(rows.slice(k, k + 500));
      if (r.error) return r;
    }
    return null;
  }, `Imported ${ready.length} athletes`);
  S.importing = false;
  if (ok) { S.preview = null; S.importText = ''; }
  renderMain();
}

/* ---------- data loading + realtime ---------- */
async function loadTable(name) {
  if (name === 'runs') return loadRuns();
  const { data, error } = await sb.from(name).select('*').range(0, 9999);
  if (error) { setSync(false, 'Offline'); toast('Could not load ' + name + ': ' + error.message); return; }
  if (name === 'event') S.event = data[0] || {};
  else S[name] = data;
}
async function loadRuns() {
  const d = viewDiv();
  S.runsDiv = d ? d.id : null;
  if (!d) { S.runs = []; return; }
  const { data, error } = await sb.from('runs').select('*').eq('division_id', d.id).range(0, 9999);
  if (error) { toast('Could not load scores: ' + error.message); return; }
  if (S.runsDiv === d.id) S.runs = data;
}
function syncRunsDivision() {
  const d = viewDiv(), id = d ? d.id : null;
  if (S.loaded && id !== S.runsDiv) { S.runs = []; loadRuns().then(render); }
}
const ALL = ['event', 'divisions', 'athletes', 'runs'];
const reloadTimers = {};
function scheduleReload(table) {
  if (!ALL.includes(table)) return;
  clearTimeout(reloadTimers[table]);
  reloadTimers[table] = setTimeout(async () => { await loadTable(table); render(); }, 150);
}

async function start() {
  render();
  if (!sb) { setSync(false, 'Not set up'); renderMain(); return; }
  if (!PARENT) {
    const { data: { session } } = await sb.auth.getSession();
    S.session = session; S.authChecked = true;
    sb.auth.onAuthStateChange((_e, s2) => { const was = !!S.session; S.session = s2; if (was !== !!s2) render(); });
    QRCode.toDataURL(parentUrl(), { margin: 1, width: 360, errorCorrectionLevel: 'M' }).then(u => { S.qr = u; if (S.tab === 'setup') render(); }).catch(() => {});
  }
  await Promise.all(['event', 'divisions', 'athletes'].map(loadTable));
  await loadRuns();
  S.loaded = true;
  render();

  sb.channel('scoreboard')
    .on('postgres_changes', { event: '*', schema: 'public' }, p => scheduleReload(p.table))
    .subscribe(status => {
      if (status === 'SUBSCRIBED') { setSync(true, 'Live'); ALL.forEach(scheduleReload); }
      else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') setSync(false, 'Reconnecting');
    });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') ALL.forEach(scheduleReload);
  });
}

/* ---------- actions ---------- */
function setTab(t) { S.tab = t; LS.set('tab', t); S.search = ''; render(); }
const nextOrder = list => list.reduce((m, x) => Math.max(m, x.sort_order ?? 0), 0) + 1;

async function saveRun(aid) {
  const pIn = document.getElementById(`p_${aid}`), tIn = document.getElementById(`t_${aid}`);
  if (!pIn || !tIn) return;
  const pv = pIn.value.trim(), tv = tIn.value.trim();
  let points = null, time = null;
  if (pv !== '') { points = Number(pv); if (!isFinite(points) || points < 0) { pIn.classList.add('bad'); toast('Points must be a number, like 7 or 7.5'); return; } }
  if (tv !== '') { time = parseTime(tv); if (!isFinite(time) || time < 0) { tIn.classList.add('bad'); toast('Enter time as 1:23.45 or 83.45'); return; } }
  pIn.classList.remove('bad'); tIn.classList.remove('bad');
  const cur = S.runs.find(r => r.athlete_id === aid);
  const a = S.athletes.find(x => x.id === aid); if (!a) return;
  const dot = pIn.closest('tr')?.querySelector('.dot');

  if (points == null && time == null) {
    if (!cur) return;
    S.saving.add(aid);
    const ok = await write(() => sb.from('runs').delete().eq('athlete_id', aid));
    S.saving.delete(aid);
    if (ok) { S.runs = S.runs.filter(r => r !== cur); if (dot) dot.className = 'dot'; }
    return;
  }
  const body = { athlete_id: aid, division_id: a.division_id, points: points ?? 0, time_sec: time, updated_at: new Date().toISOString() };
  if (cur && Number(cur.points) === body.points && num(cur.time_sec) === body.time_sec && cur.division_id === body.division_id) return;

  S.saving.add(aid); if (dot) dot.className = 'dot busy';
  let saved = null;
  const ok = await write(async () => {
    const res = await sb.from('runs').upsert(body, { onConflict: 'athlete_id' }).select().single();
    saved = res.data; return res;
  });
  S.saving.delete(aid);
  if (dot) dot.className = 'dot ' + (ok ? 'ok' : '');
  if (ok && saved) {
    S.runs = [...S.runs.filter(r => r.athlete_id !== aid), saved];
    toast(`Saved ${a.name}: ${fmtPts(body.points)} pts${time != null ? ' · ' + fmtTime(time) : ''}`);
  }
}

function arm(btn, label) { // two-tap confirm
  if (btn.dataset.armed) return true;
  btn.dataset.armed = '1'; const old = btn.textContent; btn.textContent = label; btn.classList.add('armed');
  setTimeout(() => { if (btn.isConnected) { delete btn.dataset.armed; btn.textContent = old; btn.classList.remove('armed'); } }, 3000);
  return false;
}

document.addEventListener('click', async e => {
  if (e.target.closest('#signOut')) {
    const so = $('#signOut');
    if (!arm(so, 'Tap again to sign out')) return;
    await sb.auth.signOut(); S.session = null; toast('Signed out'); render(); return;
  }
  const b = e.target.closest('[data-act],.tab'); if (!b) return;
  if (b.classList.contains('tab')) { setTab(b.dataset.tab); return; }
  const id = b.dataset.id;
  switch (b.dataset.act) {
    case 'tab': setTab(b.dataset.tab); break;
    case 'view-div': S.viewDiv = id === S.event.active_division_id ? null : id; LS.set('viewDiv', S.viewDiv); render(); break;
    case 'follow-live': S.viewDiv = null; LS.set('viewDiv', null); render(); break;
    case 'copy-link': {
      const url = parentUrl();
      try { await navigator.clipboard.writeText(url); toast('Link copied'); }
      catch { const el = $('#parentLink'); if (el) { const r = document.createRange(); r.selectNodeContents(el); const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r); } toast('Select the link and copy it'); }
      break;
    }
    case 'show-qr': $('#qrBig').hidden = false; $('#qrBigImg').src = S.qr; $('#qrBigEvent').textContent = S.event.name || 'Ninja Tournament'; $('#qrBigUrl').textContent = parentUrl(); break;
    case 'hide-qr': $('#qrBig').hidden = true; break;
    case 'judge-flight': S.judgeFlight = id; LS.set('judgeFlight', id); renderMain(); break;
    case 'import-preview': buildPreview(); renderMain(); break;
    case 'import-cancel': S.preview = null; renderMain(); break;
    case 'import-run': runImport(); break;
    case 'div-live': {
      const prev = activeDiv();
      await write(async () => {
        if (prev && prev.id !== id && prev.status !== 'final') { const r = await sb.from('divisions').update({ status: 'final' }).eq('id', prev.id); if (r.error) return r; }
        const r1 = await sb.from('divisions').update({ status: 'live' }).eq('id', id); if (r1.error) return r1;
        return sb.from('event').upsert({ id: 1, name: S.event.name || 'Ninja Tournament', active_division_id: id });
      });
      S.viewDiv = null; LS.set('viewDiv', null); render(); break;
    }
    case 'div-final':
      await write(async () => {
        const r = await sb.from('divisions').update({ status: 'final' }).eq('id', id); if (r.error) return r;
        return sb.from('event').update({ active_division_id: null }).eq('id', 1);
      }, 'Marked final');
      S.viewDiv = id; LS.set('viewDiv', id); render(); break;
    case 'div-reopen': await write(() => sb.from('divisions').update({ status: 'upcoming' }).eq('id', id)); break;
    case 'del-div': if (!arm(b, 'Tap again to delete')) break;
      await write(() => sb.from('divisions').delete().eq('id', id), 'Division deleted'); break;
    case 'del-athlete': {
      if (!arm(b, 'Tap again to remove')) break;
      const a = S.athletes.find(x => x.id === id);
      await write(() => sb.from('athletes').delete().eq('id', id), `Removed ${a ? a.name : 'athlete'}`); break;
    }
  }
});

document.addEventListener('submit', async e => {
  const f = e.target.closest('[data-form]'); if (!f) return; e.preventDefault();
  const kind = f.dataset.form;
  if (kind === 'signin') {
    const btn = f.querySelector('button'); btn.disabled = true;
    const { data, error } = await sb.auth.signInWithPassword({ email: $('#siEmail').value.trim(), password: $('#siPass').value });
    btn.disabled = false;
    if (error) { toast('Sign in failed: ' + error.message); return; }
    S.session = data.session; toast('Signed in'); render();
    return;
  }
  if (kind === 'add-athlete') {
    const name = $('#newName').value.trim(), bib = $('#newBib').value.trim(), div = $('#newDiv').value, flight = cleanFlight($('#newFlight').value);
    if (!name) { toast('Enter a name'); return; }
    if (await write(() => sb.from('athletes').insert({ name, bib, flight, division_id: div }), `Added ${name}`)) {
      $('#newName').value = ''; $('#newBib').value = ''; $('#newBib').focus();
    }
  }
  if (kind === 'split') {
    const per = parseInt($('#perFlight').value, 10);
    if (!(per > 0)) { toast('Enter how many athletes go in each flight'); return; }
    const btn = f.querySelector('button');
    if (!arm(btn, 'Tap again to split')) return;
    const d = viewDiv();
    const list = S.athletes.filter(a => a.division_id === d.id).sort(byBib);
    const rows = list.map((a, i) => ({ id: a.id, name: a.name, bib: a.bib, division_id: a.division_id, flight: String(Math.floor(i / per) + 1) }));
    await write(() => sb.from('athletes').upsert(rows), `Split into ${Math.ceil(list.length / per)} flights`);
  }
  if (kind === 'add-div') {
    const name = $('#newDivName').value.trim(), course = $('#newDivCourse').value.trim() || 'Course';
    if (!name) return;
    if (await write(() => sb.from('divisions').insert({ name, course_name: course, sort_order: nextOrder(S.divisions) }), `Added ${name}`)) {
      $('#newDivName').value = ''; $('#newDivCourse').value = '';
    }
  }
});

document.addEventListener('change', e => {
  const t = e.target;
  if (t.matches('.sheet input')) { saveRun(t.closest('tr').dataset.aid); return; }
  if (t.id === 'importFile') {
    const file = t.files && t.files[0]; if (!file) return;
    if (/\.(xlsx|xls|numbers)$/i.test(file.name)) { toast('Save the spreadsheet as CSV first (File → Save As → CSV), or copy and paste the rows.'); t.value = ''; return; }
    const reader = new FileReader();
    reader.onload = () => { S.importText = String(reader.result || ''); const ta = $('#importText'); if (ta) ta.value = S.importText; buildPreview(); renderMain(); };
    reader.onerror = () => toast('Could not read that file.');
    reader.readAsText(file);
    return;
  }
  if (t.id === 'importDiv') { S.importDiv = t.value; if (S.preview) { buildPreview(); renderMain(); } return; }
  const k = t.dataset.edit, id = t.dataset.id, v = t.value.trim(); if (!k) return;
  if (k === 'event-name') write(() => sb.from('event').upsert({ id: 1, name: v || 'Ninja Tournament', active_division_id: S.event.active_division_id ?? null }));
  if (k === 'div-name' && v) write(() => sb.from('divisions').update({ name: v }).eq('id', id));
  if (k === 'div-course') write(() => sb.from('divisions').update({ course_name: v || 'Course' }).eq('id', id));
  if (k === 'athlete-name' && v) write(() => sb.from('athletes').update({ name: v }).eq('id', id));
  if (k === 'athlete-bib') write(() => sb.from('athletes').update({ bib: v }).eq('id', id));
  if (k === 'athlete-flight') write(() => sb.from('athletes').update({ flight: cleanFlight(v) }).eq('id', id));
  if (k === 'athlete-div') {
    const a = S.athletes.find(x => x.id === id);
    write(async () => {
      const r = await sb.from('athletes').update({ division_id: v }).eq('id', id); if (r.error) return r;
      return sb.from('runs').update({ division_id: v }).eq('athlete_id', id);
    }, `Moved ${a ? a.name : 'athlete'}`);
  }
});
document.addEventListener('keydown', e => {
  if (e.key !== 'Enter' || !e.target.matches('.sheet input')) return;
  e.preventDefault();
  const ins = [...document.querySelectorAll('.sheet tbody tr:not([hidden]) input')];
  const i = ins.indexOf(e.target);
  if (ins[i + 1]) ins[i + 1].focus(); else e.target.blur();
});
document.addEventListener('input', e => {
  if (e.target.id === 'search') { S.search = e.target.value; applySearch(); }
  if (e.target.id === 'importText') { S.importText = e.target.value; }
  if (e.target.classList.contains('bad')) e.target.classList.remove('bad');
});
$('#main').addEventListener('focusout', () => setTimeout(() => { if (S.pendingMain && !isEditing()) renderMain(); }, 80));

start();
