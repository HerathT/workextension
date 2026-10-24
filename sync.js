// Firestore sync over the REST API (no SDK: Manifest V3 forbids remote scripts, and REST works inside the service worker).
// Local chrome.storage stays the working copy; this file pushes pending changes and pulls other browsers' entries.
import { firebaseConfig as C } from './firebase-config.js';
import * as S from './store.js';

const AUTH = 'https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=' + C.apiKey;
const REFRESH = 'https://securetoken.googleapis.com/v1/token?key=' + C.apiKey;
const DOCS = `https://firestore.googleapis.com/v1/projects/${C.projectId}/databases/(default)/documents`;
const get = async k => (await chrome.storage.local.get(k))[k];

// ---- Firestore value <-> JS ----
const enc = v => v == null ? { nullValue: null }
  : typeof v === 'boolean' ? { booleanValue: v }
  : typeof v === 'number' ? (Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v })
  : typeof v === 'string' ? { stringValue: v }
  : Array.isArray(v) ? { arrayValue: { values: v.map(enc) } }
  : { mapValue: { fields: Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined).map(([k, x]) => [k, enc(x)])) } };
const dec = v => 'nullValue' in v ? null : 'integerValue' in v ? Number(v.integerValue) : 'doubleValue' in v ? v.doubleValue
  : 'booleanValue' in v ? v.booleanValue : 'stringValue' in v ? v.stringValue
  : 'arrayValue' in v ? (v.arrayValue.values || []).map(dec)
  : 'mapValue' in v ? Object.fromEntries(Object.entries(v.mapValue.fields || {}).map(([k, x]) => [k, dec(x)])) : null;

async function call(url, opts = {}, token) {
  const r = await fetch(url, { ...opts, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const err = new Error((j.error && (j.error.message || j.error.status)) || ('HTTP ' + r.status)); err.status = r.status; err.code = j.error && j.error.status; throw err; }
  return j;
}

// ---- anonymous auth (one Firebase user per browser profile) ----
async function signUp() {
  const j = await call(AUTH, { method: 'POST', body: JSON.stringify({ returnSecureToken: true }) });
  return save({ uid: j.localId, idToken: j.idToken, refreshToken: j.refreshToken, expiresIn: j.expiresIn });
}
async function save(a) {
  a = { uid: a.uid, idToken: a.idToken, refreshToken: a.refreshToken, expiresAt: Date.now() + Number(a.expiresIn) * 1000 };
  await chrome.storage.local.set({ auth: a });
  return a;
}
async function auth() {
  const a = await get('auth');
  if (a && a.expiresAt - Date.now() > 60000) return a;
  if (!a) return signUp();
  {
    const r = await fetch(REFRESH, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=refresh_token&refresh_token=' + encodeURIComponent(a.refreshToken) });
    const j = await r.json();
    if (r.ok) return save({ uid: j.user_id, idToken: j.id_token, refreshToken: j.refresh_token, expiresIn: j.expires_in });
    if (/USER_NOT_FOUND|INVALID_REFRESH_TOKEN|TOKEN_EXPIRED|USER_DISABLED/.test(j.error && j.error.message || '')) {
      await chrome.storage.local.remove('auth'); await chrome.storage.local.remove('syncInit');   // account gone: start a new one and re-upload
      return signUp();
    }
    throw new Error((j.error && j.error.message) || 'HTTP ' + r.status);
  }
}

function friendly(e) {
  const m = String(e && e.message || e);
  if (e instanceof TypeError || /Failed to fetch|NetworkError/.test(m)) return 'Offline - will retry';
  if (/OPERATION_NOT_ALLOWED|ADMIN_ONLY/.test(m)) return 'Enable Anonymous sign-in in Firebase Authentication';
  if (/PERMISSION_DENIED|insufficient permissions/i.test(m) || e.status === 403) return 'Firestore denied access - publish firestore.rules and create the database';
  if (/NOT_FOUND/.test(e.code || '') || e.status === 404) return 'Create the Firestore database in the Firebase console';
  if (/API_KEY|API key/i.test(m)) return 'Firebase API key rejected';
  return m.slice(0, 120);
}

// ---- push / pull ----
async function push(a, device) {
  const pend = await S.getPending();
  for (const [id, st] of Object.entries(pend)) {
    const e = await S.getLocal(id);
    if (!e) { await S.ackPush(id, st, false); continue; }
    const doc = { ...e, device: e.device || device, browser: e.browser || S.browserName(), deleted: !!e.deleted };
    await call(`${DOCS}/users/${a.uid}/entries/${id}`, { method: 'PATCH',
      body: JSON.stringify({ fields: Object.fromEntries(Object.entries(doc).filter(([, v]) => v !== undefined).map(([k, v]) => [k, enc(v)])) }) }, a.idToken);
    await S.ackPush(id, st, !!e.deleted);          // tombstones are dropped locally once safely stored (kept in Firestore)
  }
}
async function pull(a, device) {
  const since = Math.max(0, ((await get('pullSince')) || 0) - 120000);
  const j = await call(`${DOCS}/users/${a.uid}:runQuery`, { method: 'POST', body: JSON.stringify({ structuredQuery: {
    from: [{ collectionId: 'entries' }],
    where: { fieldFilter: { field: { fieldPath: 'updatedAt' }, op: 'GREATER_THAN', value: { integerValue: String(since) } } },
    orderBy: [{ field: { fieldPath: 'updatedAt' }, direction: 'ASCENDING' }] } }) }, a.idToken);
  const list = j.filter(x => x.document).map(x => dec({ mapValue: { fields: x.document.fields } }));
  await S.applyRemote(list, device);
  if (list.length) await chrome.storage.local.set({ pullSince: Math.max(...list.map(x => x.updatedAt || 0), (await get('pullSince')) || 0) });
}

async function setState(s) {
  const old = await get('syncState');
  if (!old || old.ok !== s.ok || old.error !== s.error || s.ok && Date.now() - old.at > 60000) await chrome.storage.local.set({ syncState: s });
}
export const sync = ({ pull: doPull = true } = {}) => navigator.locks.request('dwl-sync', { ifAvailable: true }, async lock => {
  if (!lock) return;
  try {
    const a = await auth(), device = await S.deviceId();
    if (!(await get('syncInit'))) { await S.markAllPending(); await chrome.storage.local.set({ syncInit: 1, pullSince: 0 }); }  // first run: upload what is already stored locally
    await push(a, device);
    if (doPull) await pull(a, device);
    await setState({ ok: true, at: Date.now(), uid: a.uid });
  } catch (e) { await setState({ ok: false, at: Date.now(), error: friendly(e) }); }
});
