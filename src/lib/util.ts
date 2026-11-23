export function uuid(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  // Fallback for older browsers.
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

/** 2026-11-23T18:01:02.123Z -> 20261123T180102123Z (sortable, file-name safe) */
export function fileStamp(iso: string = nowIso()): string {
  return iso.replace(/[-:]/g, '').replace('.', '');
}

export function isoDate(iso: string = nowIso()): string {
  return iso.slice(0, 10);
}

/** Lower-case slug for folder names: "12 High St, York" -> "12-high-st-york" */
export function slugify(s: string, max = 48): string {
  const out = s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/g, '');
  return out || 'property';
}

/** Keeps a name human-readable but safe as a OneDrive path segment. */
export function safeSegment(s: string, max = 60): string {
  const out = s
    .replace(/[\\/:*?"<>|#%'~&{}]+/g, '-')
    .replace(/[\u0000-\u001f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
    .replace(/[.\s]+$/g, '');
  return out || 'General';
}

export function formatDateTime(iso?: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function formatDate(iso?: string): string {
  if (!iso) return '';
  const d = new Date(iso.length === 10 ? iso + 'T12:00:00' : iso);
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

export function plural(n: number, one: string, many = one + 's'): string {
  return `${n} ${n === 1 ? one : many}`;
}

export function inventoryTypeLabel(t: string): string {
  return t === 'check-in' ? 'Check-in' : t === 'check-out' ? 'Check-out' : 'Mid-term inspection';
}

export function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

export async function sha256Hex(blob: Blob): Promise<string> {
  const buf = await blob.arrayBuffer();
  const hash = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function classNames(...c: (string | false | null | undefined)[]): string {
  return c.filter(Boolean).join(' ');
}
