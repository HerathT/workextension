// Builds a clean, professional Word (.docx) report from work entries. Loaded only when you press Download.
import { Document, Packer, Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell, WidthType, ShadingType,
  BorderStyle, ExternalHyperlink, Footer, PageNumber, AlignmentType, LevelFormat, VerticalAlign } from './vendor/docx.js';
import { fTime, groupVisits, hostOf, slug } from './store.js';

const NAVY = '1F2A44', BLUE = '1F5AA6', GREY = '667085', LINE = 'D5D9DF', HEAD = 'E8EEF7';
const WIDTH = 9638;                                     // A4 with 2 cm margins, in DXA
const COLS = [1300, 4938, 2500, 900];                   // Time | Page | Site | Visits  (sums to WIDTH)
const pad2 = n => String(n).padStart(2, '0');
const ymd = t => { const d = new Date(t); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; };
const longDay = t => new Date(t).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
const shortDay = t => new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
export const span = ms => { const m = Math.round(ms / 60000); return m < 1 ? 'under 1 min' : m < 60 ? m + ' min' : Math.floor(m / 60) + ' h' + (m % 60 ? ' ' + (m % 60) + ' min' : ''); };
const cut = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

const run = (text, o = {}) => new TextRun({ text, ...o });
const meta = (text, after = 80) => new Paragraph({ spacing: { after }, children: [run(text, { color: GREY, size: 20 })] });
const border = { style: BorderStyle.SINGLE, size: 4, color: LINE };
const borders = { top: border, bottom: border, left: border, right: border };

function cell(i, children, fill) {
  return new TableCell({ width: { size: COLS[i], type: WidthType.DXA }, borders, verticalAlign: VerticalAlign.CENTER,
    margins: { top: 70, bottom: 70, left: 110, right: 110 },
    shading: fill ? { fill, type: ShadingType.CLEAR, color: 'auto' } : undefined, children });
}
const para = (kids, align) => new Paragraph({ spacing: { after: 0 }, alignment: align, children: kids });

function sitesTable(visits) {
  const g = groupVisits(visits);
  const head = new TableRow({ tableHeader: true, cantSplit: true, children: ['Time', 'Page', 'Site', 'Visits'].map((t, i) =>
    cell(i, [para([run(t, { bold: true, size: 20, color: NAVY })], i === 3 ? AlignmentType.CENTER : undefined)], HEAD)) });
  const rows = g.map(v => new TableRow({ cantSplit: true, children: [
    cell(0, [para([run(fTime(v.first), { size: 20 })])]),
    cell(1, [para([/^https?:/i.test(v.url)
      ? new ExternalHyperlink({ link: v.url, children: [run(cut(v.title || v.url, 90), { size: 20, color: BLUE, underline: {} })] })
      : run(cut(v.title || v.url, 90), { size: 20 })])]),
    cell(2, [para([run(v.host, { size: 20, color: GREY })])]),
    cell(3, [para([run(String(v.count), { size: 20 })], AlignmentType.CENTER)]) ] }));
  return new Table({ width: { size: WIDTH, type: WidthType.DXA }, columnWidths: COLS, rows: [head, ...rows] });
}

function notesBlock(notes) {
  const out = [];
  for (const raw of String(notes || '').split(/\r?\n/)) {
    const line = raw.trim(); if (!line) continue;
    const b = /^[-*•]\s+(.*)$/.exec(line);
    out.push(b ? new Paragraph({ numbering: { reference: 'bul', level: 0 }, spacing: { after: 60 }, children: [run(b[1])] })
               : new Paragraph({ spacing: { after: 80 }, children: [run(line)] }));
  }
  return out;
}

export function fileName(list) {
  const a = [...list].sort((x, y) => x.startedAt - y.startedAt), f = ymd(a[0].startedAt), l = ymd(a[a.length - 1].startedAt);
  return a.length === 1 ? `work-log-${f}-${slug(a[0].title)}.docx` : f === l ? `work-log-${f}.docx` : `work-log-${f}_to_${l}.docx`;
}

// list: entries to include; all: every entry (to name the work an entry continues); activeId: entry still running now.
export async function buildDoc(list, all = [], activeId = null) {
  const asc = [...list].sort((a, b) => a.startedAt - b.startedAt), byId = new Map(all.map(e => [e.id, e]));
  const endOf = e => e.endedAt || (e.id === activeId ? Date.now() : e.lastActive || e.startedAt);
  const total = asc.reduce((n, e) => n + Math.max(0, endOf(e) - e.startedAt), 0);
  const pages = asc.reduce((n, e) => n + groupVisits(e.visits).length, 0);
  const first = asc[0].startedAt, last = asc[asc.length - 1].startedAt;
  const kids = [
    new Paragraph({ heading: HeadingLevel.TITLE, children: [run('Daily Work Log')] }),
    meta(ymd(first) === ymd(last) ? longDay(first) : `${shortDay(first)} – ${shortDay(last)}`, 40),
    meta(`${asc.length} work ${asc.length === 1 ? 'entry' : 'entries'}  ·  ${span(total)} logged  ·  ${pages} ${pages === 1 ? 'page' : 'pages'} visited`, 40),
    meta(`Generated ${new Date().toLocaleString(undefined, { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' })}`, 200),
  ];
  let day = '';
  for (const e of asc) {
    const d = ymd(e.startedAt);
    if (d !== day) { day = d; kids.push(new Paragraph({ heading: HeadingLevel.HEADING_1, children: [run(longDay(e.startedAt))] })); }
    const running = !e.endedAt && e.id === activeId, g = groupVisits(e.visits), prev = byId.get(e.continuedFrom);
    kids.push(new Paragraph({ heading: HeadingLevel.HEADING_2, children: [run(e.title || 'Untitled work')] }));
    const hosts = new Set(g.map(x => x.host)).size;
    kids.push(meta(`${fTime(e.startedAt)} – ${e.endedAt ? fTime(e.endedAt) : running ? 'ongoing' : fTime(endOf(e))}   (${span(endOf(e) - e.startedAt)})`
      + (g.length ? `  ·  ${g.length} ${g.length === 1 ? 'page' : 'pages'} on ${hosts} ${hosts === 1 ? 'site' : 'sites'}` : ''), 60));
    if (e.continuedFrom) kids.push(meta(prev ? `Continues: ${prev.title}` : 'Continuation of earlier work', 60));
    const notes = notesBlock(e.notes);
    if (notes.length) kids.push(new Paragraph({ heading: HeadingLevel.HEADING_3, children: [run('Notes')] }), ...notes);
    if (g.length) kids.push(new Paragraph({ heading: HeadingLevel.HEADING_3, children: [run(`Websites visited (${g.length})`)] }), sitesTable(e.visits), new Paragraph({ spacing: { after: 120 }, children: [] }));
  }
  const H = (id, name, size, color, before, after, lvl, extra = {}) => ({ id, name, basedOn: 'Normal', next: 'Normal', quickFormat: true,
    run: { size, bold: true, color, ...extra.run }, paragraph: { keepNext: true, spacing: { before, after }, outlineLevel: lvl, ...extra.paragraph } });
  const doc = new Document({
    creator: 'Daily Work Log', title: 'Daily Work Log', description: 'Work log export',
    styles: {
      default: { document: { run: { font: 'Calibri', size: 22 }, paragraph: { spacing: { after: 100, line: 276 } } } },
      paragraphStyles: [
        { id: 'Title', name: 'Title', basedOn: 'Normal', next: 'Normal', quickFormat: true, run: { size: 52, bold: true, color: NAVY }, paragraph: { spacing: { after: 80 } } },
        H('Heading1', 'Heading 1', 32, NAVY, 360, 140, 0, { paragraph: { border: { bottom: { style: BorderStyle.SINGLE, size: 8, color: BLUE, space: 4 } } } }),
        H('Heading2', 'Heading 2', 26, BLUE, 260, 40, 1),
        H('Heading3', 'Heading 3', 22, NAVY, 160, 60, 2),
      ],
    },
    numbering: { config: [{ reference: 'bul', levels: [{ level: 0, format: LevelFormat.BULLET, text: '•', alignment: AlignmentType.LEFT,
      style: { paragraph: { indent: { left: 540, hanging: 270 } } } }] }] },
    sections: [{
      properties: { page: { size: { width: 11906, height: 16838 }, margin: { top: 1134, bottom: 1134, left: 1134, right: 1134 } } },
      footers: { default: new Footer({ children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [
        run('Daily Work Log  ·  Page ', { size: 18, color: GREY }), new TextRun({ children: [PageNumber.CURRENT], size: 18, color: GREY }),
        run(' of ', { size: 18, color: GREY }), new TextRun({ children: [PageNumber.TOTAL_PAGES], size: 18, color: GREY })] })] }) },
      children: kids }],
  });
  return Packer.toBlob(doc);
}
