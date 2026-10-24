export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const lock = fn => navigator.locks.request('dwl-store', fn);
const get = async k => (await chrome.storage.local.get(k))[k];

// ---- sync bookkeeping (Firestore sync lives in sync.js; everything is written locally first) ----
const PEND = 'pending';                                   // { entryId: stamp } entries waiting to be pushed to Firestore
const stamp = () => Date.now() + Math.random();
export const deviceId = () => lock(async () => {          // one id per browser profile install
  let d = await get('device');
  if (!d) { d = uid() + uid(); await chrome.storage.local.set({ device: d }); }
  return d;
});
export function browserName() {
  const u = (typeof navigator !== 'undefined' && navigator.userAgent) || '';
  return /Edg\//.test(u) ? 'Edge' : /OPR\//.test(u) ? 'Opera' : (typeof navigator !== 'undefined' && navigator.brave) ? 'Brave' : /Chrome\//.test(u) ? 'Chrome' : 'Chromium';
}

export async function listEntries() {
  const ids = (await get('ids')) || [];
  const o = await chrome.storage.local.get(ids.map(i => 'e:' + i));
  return ids.map(i => o['e:' + i]).filter(e => e && !e.deleted);
}
export const createEntry = async d => {
  const device = await deviceId();
  return lock(async () => {
    const t = Date.now();
    const e = { id: uid(), title: d.title, notes: '', startedAt: t, endedAt: null, lastActive: t, updatedAt: t,
                continuedFrom: d.continuedFrom || null, bsid: d.bsid, visits: [],
                device, browser: browserName(), deleted: false };
    const ids = (await get('ids')) || [];
    const p = (await get(PEND)) || {};
    p[e.id] = stamp();
    await chrome.storage.local.set({ ['e:' + e.id]: e, ids: [...ids, e.id], [PEND]: p });
    return e;
  });
};
export const mutate = (id, fn, { touch = true } = {}) => lock(async () => {
  const k = 'e:' + id, e = await get(k);
  if (!e || fn(e) === false) return e || null;
  if (e.deleted) return null;
  if (touch) e.updatedAt = Date.now();
  const p = (await get(PEND)) || {};
  p[id] = stamp();
  await chrome.storage.local.set({ [k]: e, [PEND]: p });
  return e;
});
// Soft delete: the entry is hidden here and flagged deleted=true in Firestore (never erased from the cloud).
export const remove = id => lock(async () => {
  const k = 'e:' + id, e = await get(k);
  if (!e) return;
  e.deleted = true; e.updatedAt = Date.now();
  const p = (await get(PEND)) || {};
  p[id] = stamp();
  await chrome.storage.local.set({ [k]: e, [PEND]: p });
});

// ---- helpers used only by sync.js ----
export const getPending = async () => (await get(PEND)) || {};
export const getLocal = async id => get('e:' + id);
const purge = async (id, p) => {
  const ids = ((await get('ids')) || []).filter(x => x !== id);
  await chrome.storage.local.remove('e:' + id);
  await chrome.storage.local.set({ ids });
  delete p[id];
};
export const markAllPending = () => lock(async () => {
  const ids = (await get('ids')) || [], p = (await get(PEND)) || {};
  ids.forEach(i => { p[i] = stamp(); });
  await chrome.storage.local.set({ [PEND]: p });
});
// Called after a successful push. If the entry changed while we were pushing, it stays pending.
export const ackPush = (id, st, drop) => lock(async () => {
  const p = (await get(PEND)) || {};
  if (p[id] !== st) return;
  delete p[id];
  if (drop) await purge(id, p);
  await chrome.storage.local.set({ [PEND]: p });
});
// Merge entries pulled from Firestore (last write wins by updatedAt; local unsynced edits are never overwritten).
export const applyRemote = (list, device) => lock(async () => {
  const p = (await get(PEND)) || {};
  for (const r of list) {
    const k = 'e:' + r.id, l = await get(k);
    if (r.deleted) { if (l && (!p[r.id] || r.updatedAt >= l.updatedAt)) await purge(r.id, p); continue; }
    if (!l) {
      const ids = (await get('ids')) || [];
      await chrome.storage.local.set({ [k]: r, ids: [...ids, r.id] });
    } else if (!p[r.id] && r.updatedAt > l.updatedAt) await chrome.storage.local.set({ [k]: r });
  }
  await chrome.storage.local.set({ [PEND]: p });
});
// A browser session = everything logged between browser start and close. Ending a work entry starts the next one.
export async function startSession(title, continuedFrom = null) {
  const s = await chrome.storage.session.get(['sid', 'bsid']);
  const bsid = s.bsid || uid();
  if (s.sid) await mutate(s.sid, e => { if (e.endedAt) return false; e.endedAt = Date.now(); }, { touch: false });
  const e = await createEntry({ title, continuedFrom, bsid });
  await chrome.storage.session.set({ sid: e.id, bsid });
  return e;
}

export const fDate = t => new Date(t).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
export const fTime = t => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
export const fFull = t => new Date(t).toLocaleString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
export const dur = ms => { const m = Math.floor(ms / 60000); return m < 1 ? 'just started' : m < 60 ? m + ' min' : Math.floor(m / 60) + ' h ' + (m % 60) + ' min'; };
export const hostOf = u => { try { return new URL(u).hostname; } catch { return u; } };
export const slug = s => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'work';

export function groupVisits(visits) {
  const m = new Map();
  for (const v of visits) {
    const g = m.get(v.url);
    if (g) { g.count++; g.last = v.t; g.title = v.title || g.title; }
    else m.set(v.url, { url: v.url, host: hostOf(v.url), title: v.title || v.url, first: v.t, last: v.t, count: 1 });
  }
  return [...m.values()];
}
export function saveFile(name, blob) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
