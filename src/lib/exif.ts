// Reads the camera's own capture time (EXIF DateTimeOriginal) from a JPEG, if present.
// Returns "YYYY-MM-DDTHH:MM:SS" in the camera's local time (EXIF has no time zone).

export async function readExifDate(file: Blob): Promise<string | undefined> {
  try {
    const buf = await file.slice(0, 256 * 1024).arrayBuffer();
    const v = new DataView(buf);
    if (v.byteLength < 4 || v.getUint16(0) !== 0xffd8) return undefined;
    let off = 2;
    while (off + 4 < v.byteLength) {
      const marker = v.getUint16(off);
      const size = v.getUint16(off + 2);
      if (marker === 0xffe1 && v.getUint32(off + 4) === 0x45786966) {
        return parseTiff(v, off + 10);
      }
      if ((marker & 0xff00) !== 0xff00) break;
      off += 2 + size;
    }
  } catch {
    /* not a readable JPEG */
  }
  return undefined;
}

function parseTiff(v: DataView, start: number): string | undefined {
  const little = v.getUint16(start) === 0x4949;
  const u16 = (o: number) => v.getUint16(start + o, little);
  const u32 = (o: number) => v.getUint32(start + o, little);
  const readIfd = (ifdOff: number): Map<number, { type: number; count: number; valOff: number }> => {
    const m = new Map<number, { type: number; count: number; valOff: number }>();
    const n = u16(ifdOff);
    for (let i = 0; i < n; i++) {
      const e = ifdOff + 2 + i * 12;
      m.set(u16(e), { type: u16(e + 2), count: u32(e + 4), valOff: e + 8 });
    }
    return m;
  };
  const ascii = (tag: { count: number; valOff: number }) => {
    const off = tag.count > 4 ? u32(tag.valOff) : tag.valOff;
    let s = '';
    for (let i = 0; i < tag.count - 1; i++) s += String.fromCharCode(v.getUint8(start + off + i));
    return s;
  };
  const ifd0 = readIfd(u32(4));
  const exifPtr = ifd0.get(0x8769);
  let raw: string | undefined;
  if (exifPtr) {
    const exif = readIfd(u32(exifPtr.valOff));
    const dto = exif.get(0x9003) || exif.get(0x9004);
    if (dto) raw = ascii(dto);
  }
  if (!raw) {
    const dt = ifd0.get(0x0132);
    if (dt) raw = ascii(dt);
  }
  const m = raw?.match(/^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}` : undefined;
}
