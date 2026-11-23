// TEST-ONLY in-memory OneDrive that answers the Microsoft Graph calls the app makes,
// plugged into Playwright's network routing. Follows Graph's documented behaviour for
// path-addressed uploads (auto-creating folders), conflictBehavior, If-Match/eTags (412),
// upload sessions, children, delta and pre-authenticated download URLs.
import { createHash } from 'node:crypto';

const DRIVE = 'drive-test-1';
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Allow-Methods': 'GET,PUT,POST,PATCH,DELETE,OPTIONS',
  'Access-Control-Expose-Headers': 'ETag, Retry-After, Location',
};

export class MockDrive {
  constructor() {
    this.items = new Map();
    this.seq = 0;
    this.items.set('root', { id: 'root', name: 'root', parentId: null, folder: true, ver: 1, seq: 0, created: new Date().toISOString() });
    this.sessions = new Map();
    this.offline = false;
    this.fail = { photo503: 0, photo500: 0 };
    this.stats = { requests: 0, puts: 0, failuresInjected: 0, byKind: {} };
    this.user = { id: 'a1b2c3d4e5f60718', displayName: 'Test Landlord', mail: 'landlord@example.com', userPrincipalName: 'landlord@example.com' };
  }
  nextId() {
    return 'I' + createHash('sha1').update(String(Math.random()) + Date.now()).digest('hex').slice(0, 15).toUpperCase();
  }
  child(parentId, name) {
    for (const it of this.items.values()) if (it.parentId === parentId && it.name.toLowerCase() === name.toLowerCase() && !it.deleted) return it;
    return null;
  }
  resolve(startId, segs) {
    let cur = this.items.get(startId);
    for (const s of segs) {
      if (!cur) return null;
      cur = this.child(cur.id, s);
    }
    return cur;
  }
  ensureFolders(startId, segs) {
    let cur = this.items.get(startId);
    for (const s of segs) {
      let c = this.child(cur.id, s);
      if (!c) {
        c = { id: this.nextId(), name: s, parentId: cur.id, folder: true, ver: 1, seq: ++this.seq, created: new Date().toISOString() };
        this.items.set(c.id, c);
      }
      cur = c;
    }
    return cur;
  }
  path(id) {
    const parts = [];
    let cur = this.items.get(id);
    while (cur && cur.parentId) {
      parts.unshift(cur.name);
      cur = this.items.get(cur.parentId);
    }
    return parts;
  }
  meta(it) {
    const parentPath = '/drive/root:' + (it.parentId ? '/' + this.path(it.parentId).join('/') : '');
    const m = {
      id: it.id,
      name: it.name,
      eTag: `"{${it.id}},${it.ver}"`,
      cTag: `"c:{${it.id}},${it.ver}"`,
      createdDateTime: it.created,
      lastModifiedDateTime: it.modified || it.created,
      size: it.folder ? 0 : it.content.length,
      webUrl: `https://onedrive.mock/view/${it.id}`,
      parentReference: it.parentId ? { driveId: DRIVE, id: it.parentId, path: parentPath } : { driveId: DRIVE },
    };
    if (it.folder) m.folder = { childCount: [...this.items.values()].filter((x) => x.parentId === it.id).length };
    else {
      m.file = { mimeType: it.mime };
      m['@microsoft.graph.downloadUrl'] = `https://download.mock/${it.id}?sig=x`;
    }
    return m;
  }
  write(startId, segs, body, mime, conflict, ifMatch) {
    const name = segs[segs.length - 1];
    const parent = this.ensureFolders(startId, segs.slice(0, -1));
    const existing = this.child(parent.id, name);
    if (existing && ifMatch && ifMatch !== '*' && ifMatch !== `"{${existing.id}},${existing.ver}"`)
      return [412, { error: { code: 'resourceModified', message: 'ETag does not match' } }];
    if (!existing && ifMatch && ifMatch !== '*') return [412, { error: { code: 'resourceModified', message: 'Item does not exist' } }];
    if (existing && conflict === 'fail' && !ifMatch) return [409, { error: { code: 'nameAlreadyExists', message: 'The specified item name already exists.' } }];
    const now = new Date().toISOString();
    if (existing) {
      existing.content = body;
      existing.mime = mime;
      existing.ver++;
      existing.seq = ++this.seq;
      existing.modified = now;
      return [200, this.meta(existing)];
    }
    const it = { id: this.nextId(), name, parentId: parent.id, folder: false, content: body, mime, ver: 1, seq: ++this.seq, created: now };
    this.items.set(it.id, it);
    return [201, this.meta(it)];
  }
  descendants(id) {
    const out = [];
    const walk = (pid) => {
      for (const it of this.items.values())
        if (it.parentId === pid) {
          out.push(it);
          if (it.folder) walk(it.id);
        }
    };
    walk(id);
    return out;
  }
  /** Files by path relative to the drive root, for assertions. */
  files() {
    return [...this.items.values()].filter((i) => !i.folder).map((i) => ({ path: this.path(i.id).join('/'), size: i.content.length, item: i }));
  }
  /** Simulate another device editing a file (changes its eTag). */
  touch(pathStr) {
    const it = this.resolve('root', pathStr.split('/'));
    if (it) {
      it.ver++;
      it.seq = ++this.seq;
    }
    return it;
  }

  async handle(route) {
    const req = route.request();
    const method = req.method();
    if (method === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
    if (this.offline) return route.abort('internetdisconnected');
    this.stats.requests++;
    const url = new URL(req.url());
    const json = (status, obj, extra = {}) => route.fulfill({ status, headers: { ...CORS, 'Content-Type': 'application/json', ...extra }, body: JSON.stringify(obj) });
    const hdr = req.headers();
    const kind = (k) => (this.stats.byKind[k] = (this.stats.byKind[k] || 0) + 1);

    if (url.host === 'download.mock') {
      kind('download');
      const it = this.items.get(url.pathname.slice(1));
      if (!it) return json(404, { error: { code: 'itemNotFound' } });
      return route.fulfill({ status: 200, headers: { ...CORS, 'Content-Type': it.mime }, body: it.content });
    }
    if (url.host === 'upload.mock') {
      kind('session');
      const s = this.sessions.get(url.pathname.split('/').pop());
      if (!s) return json(404, { error: { code: 'itemNotFound' } });
      if (method === 'GET') return json(200, { nextExpectedRanges: [`${s.received}-`] });
      if (hdr.authorization) return json(400, { error: { code: 'invalidRequest', message: 'Do not send Authorization to upload URL' } });
      const m = /bytes (\d+)-(\d+)\/(\d+)/.exec(hdr['content-range'] || '');
      const body = req.postDataBuffer() || Buffer.alloc(0);
      if (!m || Number(m[1]) !== s.received) return json(416, { error: { code: 'invalidRange' } });
      s.chunks.push(body);
      s.received += body.length;
      if (s.received < Number(m[3])) return json(202, { nextExpectedRanges: [`${s.received}-`] });
      const [st, out] = this.write(s.startId, s.segs, Buffer.concat(s.chunks), s.mime, s.conflict);
      this.sessions.delete(s.id);
      return json(st, out);
    }
    if (url.host !== 'graph.microsoft.com') return route.continue();
    if (hdr.authorization !== 'Bearer fake-token') return json(401, { error: { code: 'InvalidAuthenticationToken', message: 'Access token is empty.' } });

    const p = decodeURIComponent(url.pathname);
    if (p === '/v1.0/me') {
      kind('me');
      return json(200, this.user);
    }
    let m = /^\/v1\.0\/(?:me\/drive\/root|drives\/[^/]+\/items\/([^/:]+)):\/(.+?):(\/content|\/createUploadSession|\/children)?$/.exec(p);
    if (m) {
      const startId = m[1] || 'root';
      if (!this.items.get(startId)) return json(404, { error: { code: 'itemNotFound' } });
      const segs = m[2].split('/').filter(Boolean);
      const suffix = m[3] || '';
      if (suffix === '/content' && method === 'PUT') {
        this.stats.puts++;
        const isPhoto = segs[segs.length - 1].endsWith('.jpg');
        kind(isPhoto ? 'put-photo' : segs[segs.length - 1].endsWith('.pdf') ? 'put-pdf' : 'put-json');
        if (isPhoto && this.fail.photo503 > 0) {
          this.fail.photo503--;
          this.stats.failuresInjected++;
          return json(503, { error: { code: 'serviceNotAvailable', message: 'Service unavailable' } }, { 'Retry-After': '1' });
        }
        if (isPhoto && this.fail.photo500 > 0) {
          this.fail.photo500--;
          this.stats.failuresInjected++;
          return json(500, { error: { code: 'generalException', message: 'Injected server error' } });
        }
        const body = req.postDataBuffer() || Buffer.alloc(0);
        if (body.length > 4 * 1024 * 1024) return json(413, { error: { code: 'requestTooLarge', message: 'Use an upload session over 4 MB' } });
        const conflict = url.searchParams.get('@microsoft.graph.conflictBehavior') || 'replace';
        const [st, out] = this.write(startId, segs, body, hdr['content-type'] || 'application/octet-stream', conflict, hdr['if-match']);
        return json(st, out);
      }
      if (suffix === '/createUploadSession' && method === 'POST') {
        kind('create-session');
        const b = JSON.parse(req.postData() || '{}');
        const id = this.nextId();
        this.sessions.set(id, { id, startId, segs, received: 0, chunks: [], mime: segs.at(-1).endsWith('.pdf') ? 'application/pdf' : 'image/jpeg', conflict: b?.item?.['@microsoft.graph.conflictBehavior'] || 'replace' });
        return json(200, { uploadUrl: `https://upload.mock/session/${id}`, expirationDateTime: new Date(Date.now() + 864e5).toISOString() });
      }
      const it = this.resolve(startId, segs);
      if (!it) return json(404, { error: { code: 'itemNotFound', message: 'The resource could not be found.' } });
      if (suffix === '/children') {
        kind('children');
        return json(200, { value: [...this.items.values()].filter((x) => x.parentId === it.id).map((x) => this.meta(x)) });
      }
      kind('get-meta');
      return json(200, this.meta(it));
    }
    m = /^\/v1\.0\/drives\/[^/]+\/items\/([^/]+)\/delta$/.exec(p);
    if (m) {
      kind('delta');
      const token = Number(url.searchParams.get('token') || 0);
      const changed = this.descendants(m[1]).filter((i) => i.seq > token);
      const root = this.items.get(m[1]);
      const value = (token ? [] : [root]).concat(changed).map((i) => this.meta(i));
      // Page in chunks of 200 like Graph does.
      const page = Number(url.searchParams.get('page') || 0);
      const slice = value.slice(page * 200, page * 200 + 200);
      const base = `https://graph.microsoft.com/v1.0/drives/${DRIVE}/items/${m[1]}/delta`;
      if ((page + 1) * 200 < value.length) return json(200, { value: slice, '@odata.nextLink': `${base}?token=${token}&page=${page + 1}` });
      return json(200, { value: slice, '@odata.deltaLink': `${base}?token=${this.seq}` });
    }
    m = /^\/v1\.0\/drives\/[^/]+\/items\/([^/]+)$/.exec(p);
    if (m) {
      kind('get-meta');
      const it = this.items.get(m[1]);
      return it ? json(200, this.meta(it)) : json(404, { error: { code: 'itemNotFound' } });
    }
    return json(400, { error: { code: 'invalidRequest', message: 'Mock does not know ' + p } });
  }
}
