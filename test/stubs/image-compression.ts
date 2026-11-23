// TEST-ONLY stand-in for browser-image-compression: same call signature, canvas-based,
// steps quality and size down until the file is under maxSizeMB.
interface Opts {
  maxSizeMB?: number;
  maxWidthOrHeight?: number;
  initialQuality?: number;
  fileType?: string;
  useWebWorker?: boolean;
}
export default async function imageCompression(file: File, o: Opts): Promise<File> {
  (window as unknown as { __compressionCalls: number }).__compressionCalls =
    ((window as unknown as { __compressionCalls: number }).__compressionCalls || 0) + 1;
  const bmp = await createImageBitmap(file);
  let scale = Math.min(1, (o.maxWidthOrHeight || 99999) / Math.max(bmp.width, bmp.height));
  let q = o.initialQuality ?? 0.8;
  const max = (o.maxSizeMB ?? 1) * 1024 * 1024;
  for (let i = 0; i < 12; i++) {
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * scale);
    c.height = Math.round(bmp.height * scale);
    c.getContext('2d')!.drawImage(bmp, 0, 0, c.width, c.height);
    const b: Blob = await new Promise((r) => c.toBlob((x) => r(x!), o.fileType || 'image/jpeg', q));
    if (b.size <= max || i === 11) return new File([b], file.name, { type: b.type });
    if (q > 0.45) q -= 0.08;
    else scale *= 0.9;
  }
  return file;
}
