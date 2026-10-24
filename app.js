import * as S from './store.js';
const { fDate, fTime, fFull, groupVisits } = S;
const $ = s => document.querySelector(s), mode = document.body.dataset.mode;
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const next = new URLSearchParams(location.search).get('next');
const deb = (f, ms = 400) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => f(...a), ms); }; };
let sid = null, bsid = null, entries = [], shown = null, started = false;
const open = new Set(), cur = () => entries.find(e => e.id === sid);

async function load() {
  const s = await chrome.storage.session.get(['sid', 'bsid']);
  bsid = s.bsid || null;
  entries = (await S.listEntries()).sort((a, b) => b.startedAt - a.startedAt);
  sid = entries.some(e => e.id === s.sid) ? s.sid : null;
}
async function exportList(list) {                      // Word report of the given entries, any time
  if (!list.length) return;
  try {
    const X = await import('./docx-export.js');
    S.saveFile(X.fileName(list), await X.buildDoc(list, entries, sid));
  } catch (err) { console.error(err); alert('Could not create the Word document: ' + (err && err.message || err)); }
}
async function begin(title, from, notes) {
  started = true;
  const e = await S.startSession(title, from);
  if (notes) await S.mutate(e.id, x => { x.notes = notes; });
  if (mode === 'page') {
    if (next) chrome.tabs.create({ url: next });                       // the page you wanted opens in its own tab
    chrome.tabs.getCurrent(t => t && chrome.tabs.update(t.id, { pinned: true })); // this tab stays pinned as the log + close guard
  }
  await render();
}

function formView() {
  $('#work').innerHTML = `<div class="pane"><div class="body"><h1>What are you going to do today?</h1>
    <p class="meta"><i class="fa-regular fa-clock"></i> <span data-clock></span></p>
    <label>Work title<input id="title" class="in big" autocomplete="off" placeholder="Describe the work you are about to start"></label>
    <label>Plan or notes (optional)<textarea id="plan" class="in" rows="4"></textarea></label>
    <div class="row"><button class="btn on" id="start"><i class="fa-solid fa-play"></i> Start work</button><span class="meta">Similar earlier work is listed under Previous work. Select Continue to resume it.</span></div>
    ${next ? `<p class="meta">After you start, you will go to ${esc(S.hostOf(next))}.</p>` : ''}</div></div>`;
  const t = $('#title');
  t.focus();
  t.oninput = () => { t.classList.remove('err'); $('#hq').value = t.value; renderHist(); };
  t.onkeydown = e => { if (e.key === 'Enter') $('#start').click(); };
  $('#start').onclick = () => { const v = t.value.trim(); if (!v) { t.classList.add('err'); t.focus(); return; } begin(v, null, $('#plan').value.trim()); };
}
function dashView() {
  const c = cur();
  $('#work').innerHTML = `<div class="pane"><div class="ph"><span><i class="fa-solid fa-circle dot"></i> Current work</span><span class="meta">Started ${fTime(c.startedAt)} - <span id="dur"></span></span></div><div class="body">
    <label>Title<input id="ct" class="in big" value="${esc(c.title)}"></label>
    <label>Notes <span class="meta" id="saved"></span><textarea id="cn" class="in" rows="6" placeholder="What you did, what is left, links, decisions">${esc(c.notes)}</textarea></label>
    <div class="row"><button class="btn" data-act="finish"><i class="fa-solid fa-flag-checkered"></i> Finish and start new work</button>
    <button class="btn" data-act="dlsess"><i class="fa-solid fa-file-word"></i> Download this session (Word)</button></div></div></div>
    <div id="prev"></div>
    <div class="pane"><div class="ph"><span><i class="fa-solid fa-globe"></i> Websites visited</span><span class="meta" id="ssum"></span></div><div class="sl" id="sites"></div></div>`;
  const sv = deb(async (k, v) => { await S.mutate(sid, x => { x[k] = v; }); $('#saved').textContent = 'Saved ' + fTime(Date.now()); });
  $('#ct').oninput = e => sv('title', e.target.value.trim() || 'Untitled work');
  $('#cn').oninput = e => sv('notes', e.target.value);
  renderSites(); renderPrev();
}
function renderSites() {
  const c = cur(); if (!c || !$('#sites')) return;
  const g = groupVisits(c.visits).sort((a, b) => b.last - a.last);
  $('#ssum').textContent = `${g.length} page${g.length === 1 ? '' : 's'} on ${new Set(g.map(x => x.host)).size} site(s)`;
  $('#sites').innerHTML = g.length ? g.map(v => `<a class="site" href="${esc(v.url)}" target="_blank" rel="noopener"><i class="fa-solid fa-globe"></i><span class="st"><span class="nm">${esc(v.title)}</span><span class="sub">${esc(v.host)} - ${fTime(v.last)}${v.count > 1 ? ' - ' + v.count + ' visits' : ''}</span></span></a>`).join('')
    : '<div class="empty">No websites yet. Pages you open are listed here automatically.</div>';
}
function renderPrev() {
  const c = cur(), p = c && entries.find(e => e.id === c.continuedFrom), el = $('#prev'); if (!el) return;
  if (!p) { el.innerHTML = ''; return; }
  const g = groupVisits(p.visits);
  el.innerHTML = `<div class="pane"><div class="ph"><span><i class="fa-solid fa-link"></i> Continuing: ${esc(p.title)}</span>${g.length ? `<button class="btn" data-act="openall" data-id="${p.id}"><i class="fa-solid fa-arrow-up-right-from-square"></i> Open ${Math.min(g.length, 15)} sites</button>` : ''}</div>
    <div class="det"><div class="meta">${fDate(p.startedAt)}, ${fTime(p.startedAt)}</div>${p.notes.trim() ? `<pre>${esc(p.notes.trim())}</pre>` : ''}${g.slice(0, 8).map(v => `<a href="${esc(v.url)}" target="_blank" rel="noopener">${esc(v.title)}</a>`).join('')}</div></div>`;
}
const dayStart = v => v ? new Date(v + 'T00:00:00').getTime() : null;
let listed = [];
function renderHist() {
  const q = $('#hq').value.trim().toLowerCase(), from = dayStart($('#hf').value), to = dayStart($('#ht').value);
  const hay = e => (e.title + ' ' + e.notes + ' ' + e.visits.map(v => v.url + ' ' + v.title).join(' ')).toLowerCase();
  const list = entries.filter(e => (!q || q.split(/\s+/).every(t => hay(e).includes(t))) && (from == null || e.startedAt >= from) && (to == null || e.startedAt < to + 86400000));
  listed = list; $('#dlabel').textContent = 'Download' + (list.length ? ' (' + list.length + ')' : ''); $('#dlist').disabled = !list.length;
  let h = '', day = '';
  for (const e of list) {
    const d = fDate(e.startedAt); if (d !== day) { day = d; h += `<div class="lh">${d}</div>`; }
    const n = groupVisits(e.visits), act = e.id === sid;
    h += `<div class="item"><div class="hd" data-act="tog" data-id="${e.id}"><div class="tx"><span class="nm">${esc(e.title)}${act ? '<span class="badge live">Active</span>' : ''}</span>
      <span class="sub">${fTime(e.startedAt)} - ${e.endedAt ? fTime(e.endedAt) : 'ongoing'} - ${n.length} page${n.length === 1 ? '' : 's'}</span></div>
      <div class="acts">${act ? '' : `<button class="ico" data-act="cont" data-id="${e.id}" title="Continue this work"><i class="fa-solid fa-play"></i></button>`}
      <button class="ico" data-act="dl" data-id="${e.id}" title="Download"><i class="fa-solid fa-download"></i></button>
      <button class="ico dn" data-act="del" data-id="${e.id}" title="Delete"><i class="fa-solid fa-trash-can"></i></button></div></div>
      ${open.has(e.id) ? `<div class="det">${e.notes.trim() ? `<pre>${esc(e.notes.trim().slice(0, 600))}</pre>` : '<div class="meta">No notes.</div>'}${n.slice(0, 8).map(v => `<a href="${esc(v.url)}" target="_blank" rel="noopener">${esc(v.title)}</a>`).join('')}</div>` : ''}</div>`;
  }
  $('#hist').innerHTML = h || `<div class="empty">${entries.length ? 'No earlier work matches.' : 'Nothing logged yet.'}</div>`;
}
async function renderSync() {
  const el = $('#sync'); if (!el) return;
  const { syncState: st, pending: p } = await chrome.storage.local.get(['syncState', 'pending']);
  const n = Object.keys(p || {}).length;
  if (!st) { el.className = 'sync'; el.innerHTML = '<i class="fa-solid fa-cloud"></i> Connecting to Firestore'; el.title = 'Click to sync now'; return; }
  el.className = 'sync ' + (st.ok ? 'ok' : 'bad');
  el.title = st.ok ? 'Click to sync now' : st.error;
  el.innerHTML = st.ok ? `<i class="fa-solid fa-circle-check"></i> Synced ${fTime(st.at)}${n ? ' - ' + n + ' waiting' : ''}`
    : `<i class="fa-solid fa-triangle-exclamation"></i> ${esc(st.error)}${n ? ' (' + n + ' waiting)' : ''}`;
}
function tick() {
  const n = Date.now(); document.querySelectorAll('[data-clock]').forEach(e => { e.textContent = fFull(n); });
  const c = cur(), d = $('#dur'); if (c && d) d.textContent = S.dur(n - c.startedAt);
}
async function render() {
  await load(); renderSync();
  shown = cur() ? cur().id : 'form';
  cur() ? dashView() : formView();
  renderHist(); tick();
}
async function refresh() {
  await load(); renderHist(); renderSync();
  const c = cur();
  if ((c ? c.id : 'form') !== shown) return render();
  if (!c) return;
  renderSites(); renderPrev();
  const idle = (el, v) => { if (el && document.activeElement !== el && el.value !== v) el.value = v; };
  idle($('#ct'), c.title); idle($('#cn'), c.notes);
}

document.addEventListener('click', async ev => {
  const t = ev.target.closest('[data-act]'); if (!t) return;
  const a = t.dataset.act, id = t.dataset.id, e = entries.find(x => x.id === id);
  if (a === 'tog') { open.has(id) ? open.delete(id) : open.add(id); renderHist(); }
  else if (a === 'cont' && e) begin(e.title, e.id, '');
  else if (a === 'dl' && e) { await exportList([e]); }
  else if (a === 'del' && e) {
    if (!confirm(`Delete "${e.title}" from the log? (A copy stays in Firestore.)`)) return;
    if (id === sid) await chrome.storage.session.remove('sid');
    await S.remove(id); render();
  }
  else if (a === 'finish') { await S.mutate(sid, x => { x.endedAt = Date.now(); }, { touch: false }); await chrome.storage.session.remove('sid'); render(); }
  else if (a === 'dlsess') exportList(entries.filter(x => x.bsid === bsid));
  else if (a === 'openall' && e) groupVisits(e.visits).slice(0, 15).forEach(v => chrome.tabs.create({ url: v.url, active: false }));
});
$('#hq').oninput = renderHist; $('#hf').oninput = $('#ht').oninput = renderHist;
$('#dlist').onclick = () => exportList(listed);
chrome.storage.onChanged.addListener((ch, area) => {
  if (area === 'session' && ch.sid) {
    if (ch.sid.newValue && !started && next && mode === 'page') { location.replace(next); return; } // another tab logged the work
    render();
  } else if (area === 'local') {
    if (Object.keys(ch).some(k => k !== 'syncState')) refresh(); else renderSync();
  }
});
$('#sync').onclick = () => { $('#sync').textContent = 'Syncing...'; chrome.runtime.sendMessage({ type: 'dwl-sync' }, () => { void chrome.runtime.lastError; renderSync(); }); };
setInterval(tick, 1000);
render();
