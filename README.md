# Daily Work Log (Chrome / Edge / Brave extension)

Asks what you are going to work on every time the browser starts, tracks the sites you visit, and **syncs everything to Firestore** (project `eximius-quiz`). Nothing has to be downloaded: you can export a **Word report** whenever you want.

## One-time Firebase setup
1. Firebase console > **Build > Authentication > Get started > Sign-in method > Anonymous > Enable**.
2. **Build > Firestore Database > Create database** (production mode).
3. Firestore > **Rules**: paste the contents of `firestore.rules` and **Publish**.

Data layout: `users/{uid}/entries/{entryId}` (one document per work entry, including notes and visited sites).
Each browser profile gets its own anonymous `uid`, shown in the extension header as "Synced HH:MM".
Nothing is ever deleted from Firestore: "Delete" in the extension sets `deleted: true`, and the rules block real deletes.

## Put it on GitHub
```bash
cd daily-work-log-extension
git init && git add . && git commit -m "Daily Work Log extension"
git branch -M main
git remote add origin https://github.com/<you>/<repo>.git
git push -u origin main
```

## Install in each browser
`git clone` the repo to a folder that stays on disk, then open `chrome://extensions` (or `edge://extensions`), turn on **Developer mode**, **Load unpacked**, choose the folder.
Do not move or delete that folder afterwards, or the browser drops the extension. To update: `git pull`, then press reload on the extension card.

## Downloading a Word report
Anytime, no warnings or reminders. Use **Download** in the *Previous work* panel (exports everything listed, so search text or the From/To dates narrow it), the download icon on one entry, or **Download this session (Word)** under current work.
The .docx has a title block, a heading per day, a heading per work entry (time, duration, notes, bullet points), and a table of visited websites with clickable links, plus page numbers.

## Behaviour
- On the first start of every browser session the log page opens before any website loads; once you start work it stays pinned and is never closed or navigated away by the extension.
- Data is written to the browser first, then pushed to Firestore within seconds (and retried every minute when offline). Other browsers using the same account pull it back every minute.
- No "not downloaded" warnings, badge, or close-tab prompt: Firestore is the record.
- The Word export uses the MIT-licensed [`docx`](https://github.com/dolanmiu/docx) library, bundled in `vendor/docx.js` (extensions cannot load remote scripts).
- Firestore documents are limited to 1 MiB, which is roughly 5,000 visited pages in a single work entry.
