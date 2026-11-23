import imageCompression from 'browser-image-compression';
import { readExifDate } from './exif';
import { nowIso, sha256Hex } from './util';

// Photos are resized on the phone (longest edge 2560 px, JPEG ~80%) and, by default,
// get a small date/time stamp burned into the corner before upload.

export interface ProcessedPhoto {
  blob: Blob; // final JPEG that is uploaded
  thumb: Blob; // ~480 px JPEG used on screen and in the PDF
  width: number;
  height: number;
  sha256: string;
  takenAt: string;
  exifTakenAt?: string;
  stamped: boolean;
}

export interface ProcessOptions {
  stamp: boolean;
  maxEdge: number;
  quality: number;
  label?: string; // second line of the stamp, e.g. "Check-in"
  takenAt?: string;
}

const HARD_LIMIT = 1.9 * 1024 * 1024; // acceptance: every stored photo is under 2 MB
const TARGET_MB = 1.5;

async function decode(blob: Blob): Promise<ImageBitmap | HTMLImageElement> {
  try {
    return await createImageBitmap(blob, { imageOrientation: 'from-image' } as ImageBitmapOptions);
  } catch {
    const url = URL.createObjectURL(blob);
    try {
      const img = new Image();
      img.decoding = 'async';
      img.src = url;
      await img.decode();
      return img;
    } finally {
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
  }
}

function dims(img: ImageBitmap | HTMLImageElement) {
  return 'naturalWidth' in img ? { w: img.naturalWidth, h: img.naturalHeight } : { w: img.width, h: img.height };
}

function toBlob(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not encode photo'))), 'image/jpeg', quality),
  );
}

export function stampText(iso: string) {
  const d = new Date(iso);
  const date = d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
  const time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  return `${date} ${time}`;
}

function drawStamp(ctx: CanvasRenderingContext2D, w: number, h: number, text: string, label?: string) {
  const fs = Math.max(14, Math.round(Math.max(w, h) * 0.022));
  const pad = Math.round(fs * 0.45);
  ctx.font = `600 ${fs}px system-ui, -apple-system, Segoe UI, Roboto, sans-serif`;
  const small = Math.round(fs * 0.62);
  const tw = ctx.measureText(text).width;
  ctx.font = `500 ${small}px system-ui, -apple-system, Segoe UI, Roboto, sans-serif`;
  const lw = label ? ctx.measureText(label).width : 0;
  const boxW = Math.max(tw, lw) + pad * 2;
  const boxH = fs + (label ? small + pad * 0.4 : 0) + pad * 2;
  const x = w - boxW - pad;
  const y = h - boxH - pad;
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  ctx.fillRect(x, y, boxW, boxH);
  ctx.fillStyle = '#ffffff';
  ctx.textBaseline = 'top';
  ctx.font = `600 ${fs}px system-ui, -apple-system, Segoe UI, Roboto, sans-serif`;
  ctx.fillText(text, x + pad, y + pad);
  if (label) {
    ctx.font = `500 ${small}px system-ui, -apple-system, Segoe UI, Roboto, sans-serif`;
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.fillText(label, x + pad, y + pad + fs + pad * 0.4);
  }
}

async function render(src: ImageBitmap | HTMLImageElement, maxEdge: number, stamp: string | null, label?: string) {
  const { w: sw, h: sh } = dims(src);
  const scale = Math.min(1, maxEdge / Math.max(sw, sh));
  const w = Math.max(1, Math.round(sw * scale));
  const h = Math.max(1, Math.round(sh * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, 0, 0, w, h);
  if (stamp) drawStamp(ctx, w, h, stamp, label);
  return canvas;
}

export async function processPhoto(file: Blob, opts: ProcessOptions): Promise<ProcessedPhoto> {
  const takenAt = opts.takenAt || nowIso();
  const exifTakenAt = await readExifDate(file);
  const src = await decode(file);
  const stamp = opts.stamp ? stampText(takenAt) : null;
  const canvas = await render(src, opts.maxEdge, stamp, opts.label);
  let blob = await toBlob(canvas, opts.quality);
  // Busy, detailed photos can still come out large; let browser-image-compression squeeze them.
  if (blob.size > TARGET_MB * 1024 * 1024) {
    const f = new File([blob], 'photo.jpg', { type: 'image/jpeg' });
    blob = await imageCompression(f, {
      maxSizeMB: TARGET_MB,
      maxWidthOrHeight: opts.maxEdge,
      initialQuality: Math.min(opts.quality, 0.75),
      fileType: 'image/jpeg',
      useWebWorker: false, // keeps it working offline (the worker would load the library from a CDN)
    });
  }
  let q = Math.min(opts.quality, 0.7);
  while (blob.size > HARD_LIMIT && q > 0.3) {
    blob = await toBlob(canvas, q);
    q -= 0.1;
  }
  const thumbCanvas = await render(canvas as unknown as HTMLImageElement, 480, null);
  const thumb = await toBlob(thumbCanvas, 0.72);
  if ('close' in src) src.close();
  return {
    blob,
    thumb,
    width: canvas.width,
    height: canvas.height,
    sha256: await sha256Hex(blob),
    takenAt,
    exifTakenAt,
    stamped: !!stamp,
  };
}

/** Make a thumbnail from a full-size photo downloaded from OneDrive. */
export async function makeThumb(blob: Blob): Promise<Blob> {
  const src = await decode(blob);
  const c = await render(src, 480, null);
  return toBlob(c, 0.72);
}
