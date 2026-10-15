import { createClient } from '@supabase/supabase-js';
import './style.css';

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;
const sb = SUPABASE_URL && SUPABASE_KEY ? createClient(SUPABASE_URL, SUPABASE_KEY) : null;

/* ---------- helpers ---------- */
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const LS = {
  get(k, d) { try { const v = localStorage.getItem('ninja.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('ninja.' + k, JSON.stringify(v)); } catch { /* ignore */ } },
};
const byOrder = (a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0) || String(a.name).localeCompare(b.name);
const bibNum = b => { const n = parseFloat(b); return isNaN(n) ? Infinity : n; };
const byBib = (a, b) => bibNum(a.bib) - bibNum(b.bib) || String(a.bib || '').localeCompare(String(b.bib || '')) || String(a.name).localeCompare(b.name);

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
  event: {}, divisions: [], courses: [], athletes: [], runs: [],
  loaded: false, session: null,
  tab: LS.get('tab', 'board'), viewDiv: LS.get('viewDiv', null),
  boardCourse: 'all', judgeCourse: LS.get('judgeCourse', null),
  search: '', pendingMain: false, saving: new Set(), runsDiv: undefined,
};
const canWrite = () => !!S.session;

function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toast.h); toast.h = setTimeout(() => (t.hidden = true), 2600);
}
function setSync(on, text) { const s = $('#sync'); s.classList.toggle('on', on); s.lastElementChild.textContent = text; }

async function write(fn, ok) {
  if (!sb) { toast('Supabase is not configured.'); return false; }
  if (!canWrite()) { toast('Sign in as a judge to record or change anything.'); setTab('signin'); return false; }
  try {
    const res = await fn();
    const err = Array.isArray(res) ? res.find(r => r && r.error)?.error : res && res.error;
    if (err) throw err;
    if (ok) toast(ok);
    return true;
  } catch (e) {
    toast('Could not save: ' + (e?.message || 'try again'));
    return false;
  }
}

const activeDiv = () => S.divisions.find(d => d.id === S.event.active_division_id) || null;
const viewDiv = () => S.divisions.find(d => d.id === S.viewDiv) || activeDiv() || S.divisions[0] || null;
const courses = () => [...S.courses].sort(byOrder);
const divAthletes = id => S.athletes.filter(a => a.division_id === id).sort(byBib);

/* ---------- standings: most points wins, ties broken by fastest total time ---------- */
export function standings(divId, courseId) {
  const list = courseId === 'all' ? courses() : courses().filter(c => c.id === courseId);
  const cids = new Set(list.map(c => c.id));
  const by = {};
  for (const r of S.runs) {
    if (r.division_id !== divId || !cids.has(r.course_id)) continue;
    (by[r.athlete_id] ||= {})[r.course_id] = r;
  }
  const rows = [];
  for (const a of divAthletes(divId)) {
    const rs = by[a.id]; if (!rs) continue;
    let pts = 0, time = 0, timed = 0;
    for (const r of Object.values(rs)) {
      pts += Number(r.points) || 0;
      if (r.time_sec != null) { time += Number(r.time_sec); timed++; }
    }
    rows.push({ a, rs, pts: Math.round(pts * 100) / 100, time: timed ? Math.round(time * 100) / 100 : null });
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
  document.title = S.event.name || 'Ninja Tournament Scoreboard';
  document.querySelectorAll('.tab').forEach(t => t.setAttribute('aria-selected', String(t.dataset.tab === S.tab)));
  const ab = $('#authBtn');
  ab.hidden = !sb;
  ab.textContent = S.session ? 'Sign out' : 'Judge sign in';
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
  if (!S.loaded) return;
  if (S.tab === 'signin') { m.innerHTML = signInView(); return; }
  const ro = !canWrite() && S.tab !== 'board'
    ? `<div class="banner">View only. <button class="btn ghost" data-act="tab" data-tab="signin" style="padding:4px 10px;margin-left:6px">Judge sign in</button> to record scores or change setup.</div>` : '';
  m.innerHTML = ro + ({ board: boardView, judge: judgeView, athletes: athletesView, setup: setupView }[S.tab] || boardView)();
  if (S.tab === 'judge') applySearch();
}

function signInView() {
  if (S.session) return `<div class="panel" style="max-width:420px"><h3>Signed in</h3><p class="note">${esc(S.session.user.email)}</p><div><button class="btn" data-act="tab" data-tab="judge">Go to judging</button></div></div>`;
  return `<form class="panel" data-form="signin" style="max-width:420px"><h3>Judge sign in</h3>
    <span class="note">Use the judge account the organizer created for you.</span>
    <label class="f">Email<input id="siEmail" type="email" autocomplete="username" required></label>
    <label class="f">Password<input id="siPass" type="password" autocomplete="current-password" required></label>
    <div class="row"><button class="btn">Sign in</button><button type="button" class="btn ghost" data-act="tab" data-tab="board">Back to winners</button></div></form>`;
}

function boardView() {
  const d = viewDiv();
  if (!d || !S.courses.length) return `<div class="empty"><strong>Set up the event first</strong><span>Add your divisions and courses in Setup, then enter athletes. Winners appear here as judges record runs.</span><button class="btn" data-act="tab" data-tab="setup">Go to Setup</button></div>`;
  const cs = courses();
  if (S.boardCourse !== 'all' && !cs.find(c => c.id === S.boardCourse)) S.boardCourse = 'all';
  const rows = standings(d.id, S.boardCourse);
  const total = divAthletes(d.id).length;
  const live = d.id === S.event.active_division_id, final = !live && d.status === 'final';
  let h = `<div class="head"><div><h2>${esc(d.name)} · ${final ? 'Final results' : 'Live standings'}</h2><div class="sub">${rows.length} of ${total} athletes have recorded runs · most points wins, fastest time breaks ties</div></div></div>`;
  h += `<div class="seg" role="group" aria-label="Standings view"><button data-act="board-course" data-id="all" aria-pressed="${S.boardCourse === 'all'}">Overall</button>${cs.map(c => `<button data-act="board-course" data-id="${c.id}" aria-pressed="${S.boardCourse === c.id}">${esc(c.name)}</button>`).join('')}</div>`;
  if (!rows.length) return h + `<div class="empty"><strong>No runs recorded yet</strong><span>When a judge saves points and a time on the Judge tab, this board fills in on every device.</span></div>`;
  const showCourses = S.boardCourse === 'all' && cs.length > 1;
  h += `<div class="scroll"><table><thead><tr><th>Place</th><th>Athlete</th>${showCourses ? cs.map(c => `<th class="num hide-sm">${esc(c.name)}</th>`).join('') : ''}<th class="num">Points</th><th class="num">Time</th></tr></thead><tbody>`;
  for (const r of rows.slice(0, 20)) {
    h += `<tr class="r${r.rank}"><td class="rank"><span>${r.rank}</span></td><td><span class="bib">${r.a.bib ? '#' + esc(r.a.bib) : ''}</span><span class="name">${esc(r.a.name)}</span>${r.timeBreak ? '<span class="tie">Tie · time</span>' : ''}</td>`;
    if (showCourses) h += cs.map(c => { const x = r.rs[c.id]; return `<td class="num cell hide-sm">${x ? `<b>${fmtPts(Number(x.points) || 0)}</b> <small>${fmtTime(num(x.time_sec))}</small>` : '<small>—</small>'}</td>`; }).join('');
    h += `<td class="num total">${fmtPts(r.pts)}</td><td class="num time">${fmtTime(r.time)}</td></tr>`;
  }
  h += '</tbody></table></div>';
  if (rows.length > 20) h += `<p class="note">Showing the top 20 of ${rows.length}.</p>`;
  return h;
}

function judgeView() {
  const d = viewDiv(), cs = courses();
  if (!d || !cs.length) return `<div class="empty"><strong>Nothing to judge yet</strong><span>Add a division and at least one course in Setup.</span><button class="btn" data-act="tab" data-tab="setup">Go to Setup</button></div>`;
  if (!cs.find(c => c.id === S.judgeCourse)) S.judgeCourse = cs[0].id;
  const c = cs.find(x => x.id === S.judgeCourse);
  const as = divAthletes(d.id);
  const dis = canWrite() ? '' : 'disabled';
  let h = `<div class="head"><div><h2>Judge · ${esc(c.name)}</h2><div class="sub">${esc(d.name)} · type points and time, then tap Return or the next box to save</div></div></div>`;
  h += `<div class="seg" role="group" aria-label="Course">${cs.map(x => `<button data-act="judge-course" data-id="${x.id}" aria-pressed="${x.id === c.id}">${esc(x.name)}</button>`).join('')}</div>`;
  if (!as.length) return h + `<div class="empty"><strong>No athletes in ${esc(d.name)}</strong><span>Add athletes on the Athletes tab.</span><button class="btn" data-act="tab" data-tab="athletes">Add athletes</button></div>`;
  h += `<div class="row" style="margin-bottom:12px"><input id="search" placeholder="Find athlete by name or bib" value="${esc(S.search)}" autocomplete="off" style="max-width:360px"></div>`;
  h += `<div class="scroll"><table class="sheet"><thead><tr><th>Athlete</th><th class="pcol">Points</th><th class="tcol">Time</th><th class="state"><span class="hide-sm">Saved</span></th></tr></thead><tbody>`;
  for (const a of as) {
    const r = S.runs.find(x => x.athlete_id === a.id && x.course_id === c.id);
    const busy = S.saving.has(a.id + '_' + c.id);
    h += `<tr data-aid="${a.id}" data-q="${esc((a.name + ' ' + (a.bib || '')).toLowerCase())}"><td><span class="bib">${a.bib ? '#' + esc(a.bib) : ''}</span><span class="name">${esc(a.name)}</span></td>
    <td><input id="p_${a.id}_${c.id}" class="pts" inputmode="decimal" autocomplete="off" aria-label="Points for ${esc(a.name)}" value="${r ? esc(fmtPts(Number(r.points) || 0)) : ''}" ${dis}></td>
    <td><input id="t_${a.id}_${c.id}" class="tm" inputmode="decimal" autocomplete="off" placeholder="0:00.00" aria-label="Time for ${esc(a.name)}" value="${r && r.time_sec != null ? fmtTime(num(r.time_sec)) : ''}" ${dis}></td>
    <td class="state"><span class="dot ${busy ? 'busy' : r ? 'ok' : ''}" title="${r ? 'Saved' : 'Not recorded'}"></span></td></tr>`;
  }
  h += '</tbody></table></div><p class="note">Time can be entered as 1:23.45 or 83.45 seconds. Clear both boxes to remove a run.</p>';
  return h;
}
function applySearch() {
  const q = S.search.trim().toLowerCase();
  document.querySelectorAll('.sheet tbody tr').forEach(tr => (tr.hidden = !!q && !tr.dataset.q.includes(q)));
}

function athletesView() {
  const d = viewDiv();
  if (!d) return `<div class="empty"><strong>Add a division first</strong><span>Athletes are entered into a division.</span><button class="btn" data-act="tab" data-tab="setup">Go to Setup</button></div>`;
  const as = divAthletes(d.id), divs = [...S.divisions].sort(byOrder);
  const opts = sel => divs.map(x => `<option value="${x.id}" ${x.id === sel ? 'selected' : ''}>${esc(x.name)}</option>`).join('');
  const dis = canWrite() ? '' : 'disabled';
  let h = `<div class="head"><div><h2>Athletes · ${esc(d.name)}</h2><div class="sub">${as.length} entered. Switch divisions with the bar above.</div></div></div><div class="grid2">`;
  h += `<form class="panel" data-form="add-athlete"><h3>Add athlete</h3>
    <div class="row"><label class="f" style="flex:0 0 90px">Bib<input id="newBib" autocomplete="off"></label><label class="f" style="flex:1 1 180px">Name<input id="newName" autocomplete="off" required></label></div>
    <label class="f">Division<select id="newDiv">${opts(d.id)}</select></label>
    <div><button class="btn" ${dis}>Add athlete</button></div></form>`;
  h += `<form class="panel" data-form="bulk"><h3>Paste a list</h3><span class="note">One athlete per line, as <b>bib, name</b> or just a name. They go into ${esc(d.name)}.</span>
    <textarea id="bulk" placeholder="12, Maya Ortiz&#10;13, Jordan Lee"></textarea><div><button class="btn ghost" ${dis}>Add all</button></div></form></div>`;
  if (!as.length) return h + `<div class="empty" style="margin-top:16px"><strong>No athletes in ${esc(d.name)} yet</strong><span>Use the forms above to enter them.</span></div>`;
  h += `<div class="list" style="margin-top:16px">${as.map(a => `<div class="item"><input id="ab_${a.id}" data-edit="athlete-bib" data-id="${a.id}" value="${esc(a.bib || '')}" placeholder="Bib" style="flex:0 0 80px" aria-label="Bib" ${dis}><input id="an_${a.id}" data-edit="athlete-name" data-id="${a.id}" value="${esc(a.name)}" aria-label="Name" ${dis}><select id="ad_${a.id}" data-edit="athlete-div" data-id="${a.id}" style="flex:0 1 170px" aria-label="Division" ${dis}>${opts(a.division_id)}</select><button class="btn danger" data-act="del-athlete" data-id="${a.id}" ${dis}>Remove</button></div>`).join('')}</div>`;
  return h;
}

function setupView() {
  const cs = courses(), divs = [...S.divisions].sort(byOrder);
  const dis = canWrite() ? '' : 'disabled';
  let h = `<div class="head"><div><h2>Event setup</h2><div class="sub">Changes here show up on every device right away.</div></div></div><div class="grid2">`;
  h += `<div class="panel"><h3>Event</h3><label class="f">Event name<input id="evName" data-edit="event-name" value="${esc(S.event.name || '')}" placeholder="Fall Ninja Classic" ${dis}></label></div>`;
  h += `<div class="panel"><h3>Courses</h3><span class="note">Every division runs these same courses. Rename any time.</span><div class="list">${cs.map((c, i) => `<div class="item"><input id="cn_${c.id}" data-edit="course-name" data-id="${c.id}" value="${esc(c.name)}" aria-label="Course name" ${dis}><button class="btn ghost" data-act="move-course" data-id="${c.id}" data-dir="-1" ${i && canWrite() ? '' : 'disabled'} aria-label="Move up">↑</button><button class="btn ghost" data-act="move-course" data-id="${c.id}" data-dir="1" ${i < cs.length - 1 && canWrite() ? '' : 'disabled'} aria-label="Move down">↓</button><button class="btn danger" data-act="del-course" data-id="${c.id}" ${dis}>Delete</button></div>`).join('') || '<span class="muted">No courses yet.</span>'}</div>
    <form class="row" data-form="add-course"><input id="newCourse" placeholder="New course name" style="flex:1 1 180px" ${dis}><button class="btn" ${dis}>Add course</button></form></div>`;
  h += `<div class="panel"><h3>Divisions</h3><span class="note">Set the division that is running now as Live. When it's done, mark it Final to lock its awards view, then make the next one Live.</span><div class="list">${divs.map(d => {
    const live = d.id === S.event.active_division_id, n = S.athletes.filter(a => a.division_id === d.id).length;
    return `<div class="item"><input id="dn_${d.id}" data-edit="div-name" data-id="${d.id}" value="${esc(d.name)}" aria-label="Division name" ${dis}><span class="muted" style="font-size:.85rem">${n} athletes</span>
    ${live ? `<button class="btn" data-act="div-final" data-id="${d.id}" ${dis}>Mark final</button>` : `<button class="btn ghost" data-act="div-live" data-id="${d.id}" ${dis}>Make live</button>`}
    ${!live && d.status === 'final' ? `<button class="btn ghost" data-act="div-reopen" data-id="${d.id}" ${dis}>Reopen</button>` : ''}
    <button class="btn danger" data-act="del-div" data-id="${d.id}" ${n || !canWrite() ? 'disabled' : ''} ${n ? 'title="Move or remove its athletes first"' : ''}>Delete</button></div>`;
  }).join('') || '<span class="muted">No divisions yet.</span>'}</div>
    <form class="row" data-form="add-div"><input id="newDivName" placeholder="Division C" style="flex:1 1 180px" ${dis}><button class="btn" ${dis}>Add division</button></form></div>`;
  h += `<div class="panel"><h3>Using it on iPads and phones</h3><p class="note" style="margin:0">Open the site on every device. Judges sign in, pick their course on the Judge tab, and save. The Winners tab updates live on all screens, signed in or not. On iPad, Share → Add to Home Screen makes it open full screen.</p></div></div>`;
  return h;
}

/* ---------- data loading + realtime ---------- */
async function loadTable(name) {
  if (name === 'runs') return loadRuns();
  const { data, error } = await sb.from(name).select('*');
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
const reloadTimers = {};
function scheduleReload(table) {
  clearTimeout(reloadTimers[table]);
  reloadTimers[table] = setTimeout(async () => { await loadTable(table); render(); }, 150);
}

async function start() {
  render();
  if (!sb) { setSync(false, 'Not set up'); renderMain(); return; }
  const { data: { session } } = await sb.auth.getSession();
  S.session = session;
  sb.auth.onAuthStateChange((_e, s) => { S.session = s; render(); });

  await Promise.all(['event', 'divisions', 'courses', 'athletes'].map(loadTable));
  await loadRuns();
  S.loaded = true;
  render();

  sb.channel('scoreboard')
    .on('postgres_changes', { event: '*', schema: 'public' }, p => scheduleReload(p.table))
    .subscribe(status => {
      if (status === 'SUBSCRIBED') {
        setSync(true, 'Live');
        // catch anything missed while disconnected
        ['event', 'divisions', 'courses', 'athletes', 'runs'].forEach(scheduleReload);
      } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') setSync(false, 'Reconnecting');
    });
  // iPads sleep: refresh everything when the screen wakes up
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') ['event', 'divisions', 'courses', 'athletes', 'runs'].forEach(scheduleReload);
  });
}

/* ---------- actions ---------- */
function setTab(t) { S.tab = t; if (t !== 'signin') LS.set('tab', t); S.search = ''; render(); }
const nextOrder = list => list.reduce((m, x) => Math.max(m, x.sort_order ?? 0), 0) + 1;

async function saveRun(aid, cid) {
  const pIn = document.getElementById(`p_${aid}_${cid}`), tIn = document.getElementById(`t_${aid}_${cid}`);
  if (!pIn || !tIn) return;
  const pv = pIn.value.trim(), tv = tIn.value.trim();
  let points = null, time = null;
  if (pv !== '') { points = Number(pv); if (!isFinite(points) || points < 0) { pIn.classList.add('bad'); toast('Points must be a number, like 7 or 7.5'); return; } }
  if (tv !== '') { time = parseTime(tv); if (!isFinite(time) || time < 0) { tIn.classList.add('bad'); toast('Enter time as 1:23.45 or 83.45'); return; } }
  pIn.classList.remove('bad'); tIn.classList.remove('bad');
  const key = `${aid}_${cid}`;
  const cur = S.runs.find(r => r.athlete_id === aid && r.course_id === cid);
  const a = S.athletes.find(x => x.id === aid); if (!a) return;
  const dot = pIn.closest('tr')?.querySelector('.dot');

  if (points == null && time == null) {
    if (!cur) return;
    S.saving.add(key);
    const ok = await write(() => sb.from('runs').delete().eq('athlete_id', aid).eq('course_id', cid));
    S.saving.delete(key);
    if (ok) { S.runs = S.runs.filter(r => r !== cur); if (dot) dot.className = 'dot'; }
    return;
  }
  const body = { athlete_id: aid, course_id: cid, division_id: a.division_id, points: points ?? 0, time_sec: time, updated_at: new Date().toISOString() };
  if (cur && Number(cur.points) === body.points && num(cur.time_sec) === body.time_sec && cur.division_id === body.division_id) return;

  S.saving.add(key); if (dot) dot.className = 'dot busy';
  let saved = null;
  const ok = await write(async () => {
    const res = await sb.from('runs').upsert(body, { onConflict: 'athlete_id,course_id' }).select().single();
    saved = res.data; return res;
  });
  S.saving.delete(key);
  if (dot) dot.className = 'dot ' + (ok ? 'ok' : '');
  if (ok && saved) {
    S.runs = [...S.runs.filter(r => !(r.athlete_id === aid && r.course_id === cid)), saved];
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
  if (e.target.closest('#authBtn')) {
    if (S.session) { await sb.auth.signOut(); toast('Signed out'); } else setTab('signin');
    return;
  }
  const b = e.target.closest('[data-act],.tab'); if (!b) return;
  if (b.classList.contains('tab')) { setTab(b.dataset.tab); return; }
  const id = b.dataset.id;
  switch (b.dataset.act) {
    case 'tab': setTab(b.dataset.tab); break;
    case 'view-div': S.viewDiv = id === S.event.active_division_id ? null : id; LS.set('viewDiv', S.viewDiv); S.boardCourse = 'all'; render(); break;
    case 'follow-live': S.viewDiv = null; LS.set('viewDiv', null); render(); break;
    case 'board-course': S.boardCourse = id; renderMain(); break;
    case 'judge-course': S.judgeCourse = id; LS.set('judgeCourse', id); renderMain(); break;
    case 'move-course': {
      const cs = courses(), i = cs.findIndex(c => c.id === id), j = i + Number(b.dataset.dir);
      if (j < 0 || j >= cs.length) break;
      const A = cs[i], B = cs[j];
      let oa = A.sort_order ?? i, ob = B.sort_order ?? j; if (oa === ob) { oa = i; ob = j; }
      await write(() => Promise.all([
        sb.from('courses').update({ sort_order: ob }).eq('id', A.id),
        sb.from('courses').update({ sort_order: oa }).eq('id', B.id),
      ]));
      break;
    }
    case 'del-course': if (!arm(b, 'Tap again to delete')) break;
      await write(() => sb.from('courses').delete().eq('id', id), 'Course deleted'); break;
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
    const { error } = await sb.auth.signInWithPassword({ email: $('#siEmail').value.trim(), password: $('#siPass').value });
    if (error) { toast('Sign in failed: ' + error.message); return; }
    toast('Signed in'); setTab('judge');
  }
  if (kind === 'add-athlete') {
    const name = $('#newName').value.trim(), bib = $('#newBib').value.trim(), div = $('#newDiv').value;
    if (!name) { toast('Enter a name'); return; }
    if (await write(() => sb.from('athletes').insert({ name, bib, division_id: div }), `Added ${name}`)) {
      $('#newName').value = ''; $('#newBib').value = ''; $('#newBib').focus();
    }
  }
  if (kind === 'bulk') {
    const d = viewDiv();
    const rows = $('#bulk').value.split('\n').map(s => s.trim()).filter(Boolean).map(l => {
      const m = l.match(/^\s*#?([\w-]+)\s*[,\t]\s*(.+)$/);
      return { bib: m ? m[1] : '', name: (m ? m[2] : l).trim(), division_id: d.id };
    });
    if (!rows.length) return;
    if (await write(() => sb.from('athletes').insert(rows), `Added ${rows.length} athletes`)) $('#bulk').value = '';
  }
  if (kind === 'add-course') {
    const name = $('#newCourse').value.trim(); if (!name) return;
    if (await write(() => sb.from('courses').insert({ name, sort_order: nextOrder(S.courses) }), `Added ${name}`)) $('#newCourse').value = '';
  }
  if (kind === 'add-div') {
    const name = $('#newDivName').value.trim(); if (!name) return;
    if (await write(() => sb.from('divisions').insert({ name, sort_order: nextOrder(S.divisions) }), `Added ${name}`)) $('#newDivName').value = '';
  }
});

document.addEventListener('change', e => {
  const t = e.target;
  if (t.matches('.sheet input')) { saveRun(t.closest('tr').dataset.aid, S.judgeCourse); return; }
  const k = t.dataset.edit, id = t.dataset.id, v = t.value.trim(); if (!k) return;
  if (k === 'event-name') write(() => sb.from('event').upsert({ id: 1, name: v || 'Ninja Tournament', active_division_id: S.event.active_division_id ?? null }));
  if (k === 'course-name' && v) write(() => sb.from('courses').update({ name: v }).eq('id', id));
  if (k === 'div-name' && v) write(() => sb.from('divisions').update({ name: v }).eq('id', id));
  if (k === 'athlete-name' && v) write(() => sb.from('athletes').update({ name: v }).eq('id', id));
  if (k === 'athlete-bib') write(() => sb.from('athletes').update({ bib: v }).eq('id', id));
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
  if (e.target.classList.contains('bad')) e.target.classList.remove('bad');
});
$('#main').addEventListener('focusout', () => setTimeout(() => { if (S.pendingMain && !isEditing()) renderMain(); }, 80));

start();
