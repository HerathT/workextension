import { mutate, listEntries, deviceId } from './store.js';
import { sync } from './sync.js';
const GATE = chrome.runtime.getURL('log.html');
const web = u => /^https?:/i.test(u || '');

async function closeStale() {            // entries this browser left open in a previous run (never other browsers' entries)
  const me = await deviceId();
  for (const e of await listEntries())
    if (!e.endedAt && (!e.device || e.device === me)) await mutate(e.id, x => { x.endedAt = x.lastActive || x.updatedAt || x.startedAt; }, { touch: false });
}
async function openGate() {
  const { sid } = await chrome.storage.session.get('sid');
  if (sid) return;
  const tabs = (await chrome.tabs.query({})).filter(t => (t.url || '').startsWith(GATE));
  if (tabs.length) { chrome.tabs.update(tabs[0].id, { active: true }); chrome.windows.update(tabs[0].windowId, { focused: true }); }
  else chrome.tabs.create({ url: GATE });
}
async function boot() {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  chrome.alarms.create('dwl-sync', { periodInMinutes: 1 });
  chrome.action.setBadgeText({ text: '' });
  await closeStale(); await openGate();
  sync();
}
chrome.runtime.onInstalled.addListener(boot);
chrome.runtime.onStartup.addListener(boot);

// Sync: push shortly after any local change, and push+pull every minute (the alarm also wakes a sleeping worker).
chrome.alarms.get('dwl-sync', a => { if (!a) chrome.alarms.create('dwl-sync', { periodInMinutes: 1 }); });
chrome.alarms.onAlarm.addListener(a => { if (a.name === 'dwl-sync') sync(); });
let t;
chrome.storage.onChanged.addListener((c, area) => {
  if (area !== 'local') return;
  if (c.pending && Object.keys(c.pending.newValue || {}).length) { clearTimeout(t); t = setTimeout(() => sync({ pull: false }), 2000); }
});
chrome.runtime.onMessage.addListener((m, _s, reply) => {
  if (m && m.type === 'dwl-sync') { sync().then(() => reply(true)); return true; }
});

// Before any website loads: if no work is logged for this browser run, send the tab to the log page first.
chrome.webNavigation.onBeforeNavigate.addListener(async d => {
  if (d.frameId !== 0 || d.tabId < 0 || !web(d.url)) return;
  const { sid } = await chrome.storage.session.get('sid');
  if (!sid) chrome.tabs.update(d.tabId, { url: GATE + '?next=' + encodeURIComponent(d.url) });
});

// Track websites into the active work entry.
async function track(tabId, allowNew) {
  const t = await chrome.tabs.get(tabId).catch(() => null);
  if (!t || !web(t.url)) return;
  const { sid } = await chrome.storage.session.get('sid');
  if (!sid) return;
  const now = Date.now();
  await mutate(sid, e => {
    const v = [...e.visits].reverse().find(x => x.url === t.url);
    if (v && (!allowNew || now - v.t < 30000)) {
      if (!t.title || v.title === t.title) return false;
      v.title = t.title;
    } else if (allowNew) {
      e.visits.push({ t: now, url: t.url, title: t.title || t.url });
      e.lastActive = now;
    } else return false;
  });
}
chrome.webNavigation.onCompleted.addListener(d => { if (d.frameId === 0) track(d.tabId, true); });
chrome.webNavigation.onHistoryStateUpdated.addListener(d => { if (d.frameId === 0) track(d.tabId, true); });
chrome.tabs.onUpdated.addListener((id, ch) => { if (ch.title) track(id, false); });
