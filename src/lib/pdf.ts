import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFImage, type PDFPage } from 'pdf-lib';
import { currentUser, db } from './db';
import { localChange } from './events';
import { exportFileName } from './paths';
import { loadInventoryData, ratingSummary, type InventoryData, type ItemState } from './state';
import type { Entry, ExportRecord, IssuePayload, Item, NotePayload, Photo } from './types';
import { formatDate, formatDateTime, inventoryTypeLabel, nowIso, uuid } from './util';

// PDF report generated on the phone with pdf-lib (spec section 8).

const A4 = { w: 595.28, h: 841.89 };
const M = 42; // margin
const BLUE = rgb(0.114, 0.306, 0.847);
const INK = rgb(0.07, 0.09, 0.13);
const MUTED = rgb(0.38, 0.42, 0.5);
const RED = rgb(0.72, 0.11, 0.11);
const RULE = rgb(0.85, 0.87, 0.9);

class Writer {
  page!: PDFPage;
  y = 0;
  private cache = new Map<string, boolean>();
  constructor(
    public doc: PDFDocument,
    public font: PDFFont,
    public bold: PDFFont,
  ) {
    this.newPage();
  }
  get width() {
    return A4.w - M * 2;
  }
  newPage() {
    this.page = this.doc.addPage([A4.w, A4.h]);
    this.y = A4.h - M;
  }
  ensure(h: number) {
    if (this.y - h < M + 24) this.newPage();
  }
  /** Standard PDF fonts only cover Western European characters; swap anything else. */
  safe(s: string) {
    let out = '';
    for (const ch of s.replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\r/g, '')) {
      let ok = this.cache.get(ch);
      if (ok === undefined) {
        try {
          this.font.encodeText(ch);
          ok = true;
        } catch {
          ok = false;
        }
        this.cache.set(ch, ok);
      }
      out += ok || ch === '\n' ? ch : '?';
    }
    return out;
  }
  wrap(text: string, size: number, font: PDFFont, maxW: number): string[] {
    const lines: string[] = [];
    for (const para of this.safe(text).split('\n')) {
      let line = '';
      for (const word of para.split(/\s+/)) {
        const t = line ? line + ' ' + word : word;
        if (font.widthOfTextAtSize(t, size) <= maxW) line = t;
        else {
          if (line) lines.push(line);
          line = word;
          while (font.widthOfTextAtSize(line, size) > maxW && line.length > 1) {
            let cut = line.length - 1;
            while (cut > 1 && font.widthOfTextAtSize(line.slice(0, cut), size) > maxW) cut--;
            lines.push(line.slice(0, cut));
            line = line.slice(cut);
          }
        }
      }
      lines.push(line);
    }
    return lines;
  }
  text(s: string, o: { size?: number; bold?: boolean; color?: ReturnType<typeof rgb>; x?: number; maxW?: number; gap?: number } = {}) {
    const size = o.size ?? 10;
    const font = o.bold ? this.bold : this.font;
    const x = o.x ?? M;
    const lines = this.wrap(s, size, font, o.maxW ?? this.width - (x - M));
    const lh = size * 1.3;
    for (const l of lines) {
      this.ensure(lh);
      this.page.drawText(l, { x, y: this.y - size, size, font, color: o.color ?? INK });
      this.y -= lh;
    }
    this.y -= o.gap ?? 0;
  }
  rule(color = RULE) {
    this.page.drawLine({ start: { x: M, y: this.y }, end: { x: A4.w - M, y: this.y }, thickness: 0.6, color });
    this.y -= 6;
  }
  keyValues(rows: [string, string][], keyW = 130) {
    for (const [k, v] of rows) {
      const lines = this.wrap(v || '-', 10, this.font, this.width - keyW);
      this.ensure(lines.length * 13 + 2);
      this.page.drawText(this.safe(k), { x: M, y: this.y - 10, size: 10, font: this.bold, color: MUTED });
      for (const l of lines) {
        this.page.drawText(l, { x: M + keyW, y: this.y - 10, size: 10, font: this.font, color: INK });
        this.y -= 13;
      }
      this.y -= 3;
    }
  }
  band(title: string, sub?: string) {
    this.ensure(64);
    this.y -= 6;
    this.page.drawRectangle({ x: M, y: this.y - 26, width: this.width, height: 26, color: BLUE });
    this.page.drawText(this.safe(title), { x: M + 10, y: this.y - 18, size: 13, font: this.bold, color: rgb(1, 1, 1) });
    if (sub) {
      const s = this.safe(sub);
      const w = this.font.widthOfTextAtSize(s, 9);
      this.page.drawText(s, { x: A4.w - M - 10 - w, y: this.y - 17, size: 9, font: this.font, color: rgb(0.9, 0.93, 1) });
    }
    this.y -= 36;
  }
}

async function thumbImage(doc: PDFDocument, photo: Photo, cache: Map<string, PDFImage | null>): Promise<PDFImage | null> {
  if (cache.has(photo.id)) return cache.get(photo.id)!;
  const rec = await db.blobs.get(`${photo.id}:thumb`);
  let img: PDFImage | null = null;
  if (rec) {
    try {
      img = await doc.embedJpg(new Uint8Array(await rec.blob.arrayBuffer()));
    } catch {
      img = null;
    }
  }
  cache.set(photo.id, img);
  return img;
}

interface GridOpts {
  x?: number;
  width?: number;
  cols?: number;
}

/** Draws photo thumbnails in a grid starting at the writer's current y. Returns the height used. */
async function photoGrid(w: Writer, photos: Photo[], cache: Map<string, PDFImage | null>, o: GridOpts = {}, dryRun = false): Promise<number> {
  if (!photos.length) return 0;
  const x0 = o.x ?? M;
  const width = o.width ?? w.width;
  const cols = o.cols ?? 5;
  const gap = 6;
  const cw = (width - gap * (cols - 1)) / cols;
  const boxH = cw * 0.75;
  const rowH = boxH + 15;
  const rows = Math.ceil(photos.length / cols);
  if (dryRun) return rows * rowH;
  for (let i = 0; i < photos.length; i += cols) {
    const row = photos.slice(i, i + cols);
    const imgs = await Promise.all(row.map((p) => thumbImage(w.doc, p, cache)));
    w.ensure(rowH);
    row.forEach((p, j) => {
      const x = x0 + j * (cw + gap);
      const img = imgs[j];
      let capY = w.y - boxH - 9;
      if (img) {
        const s = Math.min(cw / img.width, boxH / img.height);
        const iw = img.width * s;
        const ih = img.height * s;
        w.page.drawImage(img, { x, y: w.y - ih, width: iw, height: ih });
        capY = w.y - ih - 8;
      } else {
        w.page.drawRectangle({ x, y: w.y - boxH, width: cw, height: boxH, borderColor: RULE, borderWidth: 1 });
        w.page.drawText('Photo in OneDrive', { x: x + 4, y: w.y - boxH / 2, size: 6.5, font: w.font, color: MUTED });
      }
      const cap = w.safe(`${formatDateTime(p.takenAt)}${p.source === 'gallery' ? ' (gallery)' : ''}`);
      w.page.drawText(cap, { x, y: capY, size: 6, font: w.font, color: MUTED });
    });
    w.y -= rowH;
  }
  return rows * rowH;
}

function noteLines(w: Writer, notes: Entry[]) {
  for (const n of notes) {
    const p = n.payload as NotePayload;
    w.text(`Note (${n.authorName || n.authorRole}, ${formatDateTime(n.createdAt)}): ${p.text}`, { size: 9, color: INK, x: M + 8 });
  }
}

function issueLines(w: Writer, issues: Entry[]) {
  for (const e of issues) {
    const p = e.payload as IssuePayload;
    w.text(`Issue - ${p.issueType}${p.note ? ': ' + p.note : ''} (reported ${formatDateTime(e.createdAt)} by ${e.authorName || e.authorRole}; ${p.status})`, {
      size: 9,
      color: RED,
      x: M + 8,
    });
  }
}

async function itemBlock(w: Writer, item: Item, s: ItemState | undefined, cache: Map<string, PDFImage | null>) {
  const summary = ratingSummary(item, s);
  const photos = s?.photos || [];
  // Two columns: text on the left, thumbnails on the right.
  const leftW = w.width * 0.42;
  const gridX = M + leftW + 12;
  const gridW = w.width - leftW - 12;
  const gridH = await photoGrid(w, photos, cache, { x: gridX, width: gridW, cols: 3 }, true);
  const textLines =
    w.wrap(item.name, 11, w.bold, leftW).length +
    2 +
    (item.description ? w.wrap(item.description, 9, w.font, leftW).length : 0) +
    (s ? [...s.notes, ...s.issues].reduce((n, e) => n + w.wrap(JSON.stringify(e.payload), 9, w.font, leftW - 8).length, 0) : 0);
  const textH = textLines * 12.5;
  const sideBySide = gridH < A4.h - 2 * M - 80;
  w.ensure(Math.max(sideBySide ? gridH : 0, Math.min(textH, 300)) + 12);
  w.rule();
  const top = w.y;
  const pageAtTop = w.page;
  const color = summary.includes('NOT') || /Damaged|Missing/.test(summary) ? RED : BLUE;
  w.text(item.name + (item.quantity > 1 ? ` (x${item.quantity})` : ''), { size: 11, bold: true, maxW: leftW });
  w.text(summary, { size: 10, bold: true, color, maxW: leftW });
  if (item.description) w.text(item.description, { size: 9, color: MUTED, maxW: leftW });
  if (s) {
    for (const n of s.notes) {
      const p = n.payload as NotePayload;
      w.text(`Note (${n.authorName || n.authorRole}, ${formatDateTime(n.createdAt)}): ${p.text}`, { size: 9, maxW: leftW });
    }
    for (const e of s.issues) {
      const p = e.payload as IssuePayload;
      w.text(`Issue - ${p.issueType}${p.note ? ': ' + p.note : ''} (${formatDateTime(e.createdAt)}, ${e.authorName || e.authorRole}; ${p.status})`, {
        size: 9,
        color: RED,
        maxW: leftW,
      });
    }
  }
  if (!photos.length) {
    w.y -= 4;
    return;
  }
  if (sideBySide && w.page === pageAtTop) {
    const textEnd = w.y;
    const pageNow = w.page;
    w.y = top;
    await photoGrid(w, photos, cache, { x: gridX, width: gridW, cols: 3 });
    if (w.page === pageNow) w.y = Math.min(textEnd, w.y) - 4;
  } else {
    await photoGrid(w, photos, cache);
  }
}

export async function buildPdf(data: InventoryData): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const w = new Writer(doc, font, bold);
  const user = await currentUser();
  const { inventory: inv, property: p, tenancy: t } = data;
  const cache = new Map<string, PDFImage | null>();
  doc.setTitle(`${inventoryTypeLabel(inv.type)} inventory - ${p.address}`);
  doc.setAuthor(user?.name || 'Inventory App');
  doc.setCreator('Inventory App');
  doc.setProducer('Inventory App (pdf-lib)');

  // ----- Cover -----
  w.text('INVENTORY APP', { size: 9, bold: true, color: BLUE, gap: 6 });
  w.text(`${inventoryTypeLabel(inv.type)} inventory`, { size: 26, bold: true, gap: 4 });
  w.text(p.address, { size: 15, gap: 0 });
  w.text(p.postcode, { size: 15, color: MUTED, gap: 14 });
  w.rule(BLUE);
  const statusLabel =
    inv.status === 'locked' ? 'Locked (signed)' : inv.status === 'signed' ? 'Signed' : inv.status === 'in-review' ? 'With tenant for review' : 'Draft - not yet signed';
  w.keyValues([
    ['Property', `${p.type === 'flat' ? 'Flat' : 'House'}, ${p.bedrooms} bedroom${p.bedrooms === 1 ? '' : 's'}, ${p.furnishing === 'part' ? 'part furnished' : p.furnishing}`],
    ['Tenancy', `${formatDate(t.startDate)}${t.endDate ? ' to ' + formatDate(t.endDate) : ' (no end date set)'}`],
    ['Deposit scheme ref', t.depositRef || '-'],
    ['Landlord', user ? `${user.name}${user.email ? ' (' + user.email + ')' : ''}` : '-'],
    ['Tenant(s)', t.tenants.map((x) => `${x.name}${x.email ? ' (' + x.email + ')' : ''}`).join('\n') || '-'],
    ['Inventory type', inventoryTypeLabel(inv.type)],
    ['Status', statusLabel],
    ['Version', `v${inv.version}`],
    ['Lock date', inv.lockedAt ? formatDateTime(inv.lockedAt) : 'Not locked'],
    ['Started', formatDateTime(inv.createdAt)],
    ['Report generated', formatDateTime(nowIso())],
  ]);
  w.y -= 8;
  const photoCount = data.photos.length;
  w.keyValues([
    ['Rooms', String(data.rooms.filter((r) => !isSpecial(r.templateKey)).length)],
    ['Items recorded', `${data.ratedCount} of ${data.itemCount}`],
    ['Photos', String(photoCount)],
    ['Issues reported', String(data.issues.length)],
  ]);
  w.y -= 10;
  w.text(
    'About the evidence: every entry in this report was saved with the date, time and the signed-in Microsoft account of the person who made it. ' +
      'Entries are never edited or deleted; corrections are added as new entries. Each photo shows the date and time it was taken and has a SHA-256 ' +
      'fingerprint stored with it, so any later change to the image file can be detected. Photos marked "from gallery" were chosen from the phone\'s ' +
      'gallery rather than taken in the app. Signatures are simple electronic signatures (drawn mark, typed name, time and signed-in account).',
    { size: 8.5, color: MUTED },
  );

  // ----- Rooms -----
  const normal = data.rooms.filter((r) => !isSpecial(r.templateKey));
  const special = data.rooms.filter((r) => isSpecial(r.templateKey));
  for (const room of normal) {
    w.newPage();
    const items = data.items.filter((i) => i.roomId === room.id);
    const rated = items.filter((i) => ratingSummary(i, data.states.get(i.id)) !== 'Not rated').length;
    w.band(room.name, `${rated}/${items.length} items recorded`);
    const rs = data.states.get(`room:${room.id}`);
    if (rs && (rs.photos.length || rs.notes.length || rs.issues.length)) {
      w.text('Room photos and notes', { size: 10, bold: true, color: MUTED });
      noteLines(w, rs.notes);
      issueLines(w, rs.issues);
      await photoGrid(w, rs.photos, cache);
    }
    for (const item of items) await itemBlock(w, item, data.states.get(item.id), cache);
  }

  // ----- Appendix -----
  w.newPage();
  w.text('Appendix', { size: 20, bold: true, gap: 8 });
  for (const room of special) {
    w.band(room.name);
    const items = data.items.filter((i) => i.roomId === room.id);
    if (!items.length) w.text('Nothing recorded.', { size: 9, color: MUTED });
    for (const item of items) await itemBlock(w, item, data.states.get(item.id), cache);
  }
  w.band('All issues', `${data.issues.length}`);
  if (!data.issues.length) w.text('No issues reported.', { size: 9, color: MUTED });
  for (const e of data.issues) {
    const ip = e.payload as IssuePayload;
    const room = data.rooms.find((r) => r.id === e.roomId)?.name;
    const item = data.items.find((i) => i.id === e.itemId)?.name;
    w.text(`${formatDateTime(e.createdAt)} - ${[room, item].filter(Boolean).join(' / ') || 'General'}: ${ip.issueType}${ip.note ? ' - ' + ip.note : ''} (${ip.status})`, {
      size: 9,
    });
  }
  w.band('Signatures');
  const sigs = data.entries.filter((e) => e.type === 'signature');
  if (!sigs.length) w.text('Not yet signed by any party. This report is a draft.', { size: 9, color: MUTED });

  // Footer on every page.
  const pages = doc.getPages();
  pages.forEach((pg, i) => {
    const left = w.safe(`${p.address}, ${p.postcode} - ${inventoryTypeLabel(inv.type)} v${inv.version}`).slice(0, 90);
    pg.drawText(left, { x: M, y: 22, size: 7.5, font, color: MUTED });
    const right = `Page ${i + 1} of ${pages.length}`;
    pg.drawText(right, { x: A4.w - M - font.widthOfTextAtSize(right, 7.5), y: 22, size: 7.5, font, color: MUTED });
  });
  return doc.save();
}

function isSpecial(key: string) {
  return key === 'meters' || key === 'keys' || key === 'safety' || key === 'documents';
}

/** Generate the PDF, keep it on the phone and queue it for upload to the inventory's exports folder. */
export async function createExport(inventoryId: string): Promise<ExportRecord> {
  const data = await loadInventoryData(inventoryId);
  if (!data) throw new Error('Inventory not found');
  const bytes = await buildPdf(data);
  const blob = new Blob([bytes as BlobPart], { type: 'application/pdf' });
  const createdAt = nowIso();
  const rec: ExportRecord = {
    id: uuid(),
    inventoryId,
    propertyId: data.property.id,
    fileName: exportFileName(data.property.address, data.inventory.type, createdAt, data.inventory.version),
    version: data.inventory.version,
    createdAt,
    byteSize: blob.size,
    uploadStatus: 'pending',
  };
  await db.transaction('rw', [db.exports, db.blobs], async () => {
    await db.blobs.put({ key: `${rec.id}:pdf`, blob });
    await db.exports.put(rec);
  });
  localChange();
  return rec;
}
