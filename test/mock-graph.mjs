// TEST-ONLY in-memory OneDrive for several users, plugged into Playwright's network routing.
// Follows Graph's documented behaviour for path-addressed uploads (auto-creating folders),
// conflictBehavior, If-Match/eTags (412), upload sessions, children, delta, pre-authenticated
// download URLs, sharing invitations (invite), permissions (list/delete) and access checks:
// a user can reach another user's item only through a permission on it or a parent folder.
import { createHash } from 'node:crypto';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Allow-Methods': 'GET,PUT,POST,PATCH,DELETE,OPTIONS',
  'Access-Control-Expose-Headers': 'ETag, Retry-After, Location',
};

export const USERS = {
  'fake-token': { id: 'a1b2c3d4e5f60718', displayName: 'Test Landlord', mail: 'landlord@example.com', drive: 'drive-landlord' },
  'fake-token-tenant': { id: 'b2c3d4e5f6071829', displayName: 'Alex Morgan', mail: 'alex.morgan@example.com', drive: 'drive-tenant' },
  'fake-token-stranger': { id: 'c3d4e5f607182930', displayName: 'Sam Stranger', mail: 'sam.stranger@example.com', drive: 'drive-stranger' },
};

export class MockDrive {
  constructor() {
    this.items = new Map();
    this.seq = 0;
    for (const u of Object.values(USERS)) this.items.set('root-' + u.drive, { id: 'root-' + u.drive, driveId: u.drive, name: 'root', parentId: null, folder: true, ver: 1, seq: 0, created: new Date().toISOString(), owner: u });
    this.sessions = new Map();
    this.permissions = []; // {id, itemId, driveId, email, roles, revoked}
    this.offline = false;
    this.fail = { photo503: 0, photo500: 0 };
    this.stats = { requests: 0, puts: 0, failuresInjected: 0, byKind: {}, denied: [] };
    this.user = USERS['fake-token']; // landlord, kept for phase 1 tests
  }
  nextId() {
    return 'I' + createHash('sha1').update(String(Math.random()) + Date.now()).digest('hex').slice(0, 15).toUpperCase();
  }
  rootOf(driveId) {
    return this.items.get('root-' + driveId);
  }
  child(parentId, name) {
    for (const it of this.items.values()) if (it.parentId === parentId && !it.deleted && it.name.toLowerCase() === name.toLowerCase()) return it;
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
  ensureFolders(startId, segs, user) {
    let cur = this.items.get(startId);
    for (const s of segs) {
      let c = this.child(cur.id, s);
      if (!c) {
        c = { id: this.nextId(), driveId: cur.driveId, name: s, parentId: cur.id, folder: true, ver: 1, seq: ++this.seq, created: new Date().toISOString(), createdBy: user, modifiedBy: user };
        this.items.set(c.id, c);
      }
      cur = c;
    }
    return cur;
  }
  ancestors(id) {
    const out = [];
    let cur = this.items.get(id);
    while (cur) {
      out.push(cur);
      cur = cur.parentId ? this.items.get(cur.parentId) : null;
    }
    return out;
  }
  path(id) {
    return this.ancestors(id)
      .filter((x) => x.parentId)
      .map((x) => x.name)
      .reverse();
  }
  /** Owner, or a live permission for the user's email on the item or a parent. */
  canAccess(user, item) {
    if (!item) return false;
    if (item.driveId === user.drive) return true;
    const ids = new Set(this.ancestors(item.id).map((x) => x.id));
    return this.permissions.some((p) => !p.revoked && ids.has(p.itemId) && p.email === user.mail.toLowerCase());
  }
  meta(it) {
    const by = (u) => (u ? { user: { id: u.id.toUpperCase(), email: u.mail, displayName: u.displayName } } : undefined);
    const m = {
      id: it.id,
      name: it.name,
      eTag: `"{${it.id}},${it.ver}"`,
      cTag: `"c:{${it.id}},${it.ver}"`,
      createdDateTime: it.created,
      lastModifiedDateTime: it.modified || it.created,
      size: it.folder ? 0 : it.content?.length || 0,
      webUrl: `https://onedrive.mock/view/${it.id}`,
      createdBy: by(it.createdBy),
      lastModifiedBy: by(it.modifiedBy || it.createdBy),
      parentReference: it.parentId ? { driveId: it.driveId, id: it.parentId, path: '/drive/root:/' + this.path(it.parentId).join('/') } : { driveId: it.driveId },
    };
    if (it.deleted) m.deleted = { state: 'deleted' };
    if (it.folder) m.folder = { childCount: [...this.items.values()].filter((x) => x.parentId === it.id && !x.deleted).length };
    else {
      m.file = { mimeType: it.mime };
      m['@microsoft.graph.downloadUrl'] = `https://download.mock/${it.id}?sig=x`;
    }
    return m;
  }
  write(startId, segs, body, mime, conflict, ifMatch, user) {
    const name = segs[segs.length - 1];
    const parent = this.ensureFolders(startId, segs.slice(0, -1), user);
    const existing = this.child(parent.id, name);
    if (existing && ifMatch && ifMatch !== '*' && ifMatch !== `"{${existing.id}},${existing.ver}"`)
      return [412, { error: { code: 'resourceModified', message: 'ETag does not match' } }];
    if (!existing && ifMatch && ifMatch !== '*') return [412, { error: { code: 'resourceModified', message: 'Item does not exist' } }];
    if (existing && conflict === 'fail' && !ifMatch) return [409, { error: { code: 'nameAlreadyExists', message: 'The specified item name already exists.' } }];
    const now = new Date().toISOString();
    if (existing) {
      Object.assign(existing, { content: body, mime, ver: existing.ver + 1, seq: ++this.seq, modified: now, modifiedBy: user });
      return [200, this.meta(existing)];
    }
    const it = { id: this.nextId(), driveId: parent.driveId, name, parentId: parent.id, folder: false, content: body, mime, ver: 1, seq: ++this.seq, created: now, createdBy: user, modifiedBy: user };
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
  /** Files in the landlord's drive by path, for assertions (phase 1 tests). */
  files(drive = 'drive-landlord') {
    return [...this.items.values()].filter((i) => !i.folder && !i.deleted && i.driveId === drive).map((i) => ({ path: this.path(i.id).join('/'), size: i.content.length, item: i }));
  }
  touch(pathStr, drive = 'drive-landlord') {
    const it = this.resolve('root-' + drive, pathStr.split('/'));
    if (it) {
      it.ver++;
      it.seq = ++this.seq;
    }
    return it;
  }
  livePermissions(itemId) {
    return this.permissions.filter((p) => p.itemId === itemId && !p.revoked);
  }

  async handle(route) {
    const req = route.request();
    const method = req.method();
    if (method === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
    if (this.offline) return route.abort('internetdisconnected');
    this.stats.requests++;
    const url = new URL(req.url());
    const json = (status, obj, extra = {}) =>
      route.fulfill({ status, headers: { ...CORS, 'Content-Type': 'application/json', ...extra }, body: obj === null ? '' : JSON.stringify(obj) });
    const hdr = req.headers();
    const kind = (k) => (this.stats.byKind[k] = (this.stats.byKind[k] || 0) + 1);

    if (url.host === 'download.mock') {
      kind('download');
      const it = this.items.get(url.pathname.slice(1));
      if (!it || it.deleted) return json(404, { error: { code: 'itemNotFound' } });
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
      const [st, out] = this.write(s.startId, s.segs, Buffer.concat(s.chunks), s.mime, s.conflict, undefined, s.user);
      this.sessions.delete(s.id);
      return json(st, out);
    }
    if (url.host !== 'graph.microsoft.com') return route.continue();
    const user = USERS[(hdr.authorization || '').replace(/^Bearer /, '')];
    if (!user) return json(401, { error: { code: 'InvalidAuthenticationToken', message: 'Access token is empty.' } });
    const deny = (what) => {
      this.stats.denied.push({ user: user.mail, what, method });
      return json(403, { error: { code: 'accessDenied', message: 'Access denied' } });
    };

    const p = decodeURIComponent(url.pathname);
    if (p === '/v1.0/me') {
      kind('me');
      return json(200, { id: user.id, displayName: user.displayName, mail: user.mail, userPrincipalName: user.mail });
    }
    let m = /^\/v1\.0\/(?:me\/drive\/root|drives\/([^/]+)\/items\/([^/:]+)):\/(.+?):(\/content|\/createUploadSession|\/children)?$/.exec(p);
    if (m) {
      const startId = m[2] || 'root-' + user.drive;
      const start = this.items.get(startId);
      if (!start || start.deleted) return json(404, { error: { code: 'itemNotFound' } });
      if (!this.canAccess(user, start)) return deny(p);
      const segs = m[3].split('/').filter(Boolean);
      const suffix = m[4] || '';
      if (suffix === '/content' && method === 'PUT') {
        this.stats.puts++;
        const isPhoto = segs[segs.length - 1].endsWith('.jpg');
        kind(isPhoto ? 'put-photo' : segs[segs.length - 1].endsWith('.pdf') ? 'put-pdf' : segs[segs.length - 1].endsWith('.png') ? 'put-png' : 'put-json');
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
        const [st, out] = this.write(startId, segs, body, hdr['content-type'] || 'application/octet-stream', conflict, hdr['if-match'], user);
        return json(st, out);
      }
      if (suffix === '/createUploadSession' && method === 'POST') {
        kind('create-session');
        const b = JSON.parse(req.postData() || '{}');
        const id = this.nextId();
        this.sessions.set(id, {
          id,
          startId,
          segs,
          user,
          received: 0,
          chunks: [],
          mime: segs.at(-1).endsWith('.pdf') ? 'application/pdf' : 'image/jpeg',
          conflict: b?.item?.['@microsoft.graph.conflictBehavior'] || 'replace',
        });
        return json(200, { uploadUrl: `https://upload.mock/session/${id}`, expirationDateTime: new Date(Date.now() + 864e5).toISOString() });
      }
      const it = this.resolve(startId, segs);
      if (!it) return json(404, { error: { code: 'itemNotFound', message: 'The resource could not be found.' } });
      if (suffix === '/children') {
        kind('children');
        return json(200, { value: [...this.items.values()].filter((x) => x.parentId === it.id && !x.deleted).map((x) => this.meta(x)) });
      }
      kind('get-meta');
      return json(200, this.meta(it));
    }
    m = /^\/v1\.0\/drives\/([^/]+)\/items\/([^/]+)(\/delta|\/children|\/invite|\/permissions(?:\/([^/]+))?)?$/.exec(p);
    if (m) {
      const it = this.items.get(m[2]);
      if (!it || it.driveId !== m[1] || (it.deleted && m[3] !== '/delta')) return json(404, { error: { code: 'itemNotFound' } });
      if (!this.canAccess(user, it)) return deny(p);
      const owner = it.driveId === user.drive;
      const sub = m[3] || '';
      if (sub === '/delta') {
        kind('delta');
        if (!owner) return json(400, { error: { code: 'invalidRequest', message: 'Delta is not supported on this shared item' } });
        const token = Number(url.searchParams.get('token') || 0);
        const changed = this.descendants(m[2]).filter((i) => i.seq > token);
        const value = (token ? [] : [it]).concat(changed).map((i) => this.meta(i));
        const page = Number(url.searchParams.get('page') || 0);
        const slice = value.slice(page * 200, page * 200 + 200);
        const base = `https://graph.microsoft.com/v1.0/drives/${m[1]}/items/${m[2]}/delta`;
        if ((page + 1) * 200 < value.length) return json(200, { value: slice, '@odata.nextLink': `${base}?token=${token}&page=${page + 1}` });
        return json(200, { value: slice, '@odata.deltaLink': `${base}?token=${this.seq}` });
      }
      if (sub === '/children') {
        kind('children');
        return json(200, { value: [...this.items.values()].filter((x) => x.parentId === it.id && !x.deleted).map((x) => this.meta(x)) });
      }
      if (sub === '/invite' && method === 'POST') {
        kind('invite');
        if (!owner) return deny('invite');
        if (!it.parentId) return json(400, { error: { code: 'invalidRequest', message: "Permissions can't be created on the root of a personal drive" } });
        const b = JSON.parse(req.postData() || '{}');
        if (!b.requireSignIn || !Array.isArray(b.roles) || !b.recipients?.length) return json(400, { error: { code: 'invalidRequest', message: 'bad invite' } });
        const out = b.recipients.map((r) => {
          const perm = { id: 'P' + this.nextId(), itemId: it.id, driveId: it.driveId, email: r.email.toLowerCase(), roles: b.roles, message: b.message, revoked: false };
          this.permissions.push(perm);
          return { id: perm.id, roles: perm.roles, grantedToV2: { user: { email: perm.email, displayName: perm.email } }, invitation: { email: perm.email } };
        });
        return json(200, { value: out });
      }
      if (sub.startsWith('/permissions')) {
        if (!owner) return deny('permissions');
        if (method === 'GET' && !m[4]) {
          kind('permissions');
          return json(200, {
            value: this.livePermissions(it.id).map((x) => ({ id: x.id, roles: x.roles, grantedToV2: { user: { email: x.email } }, invitation: { email: x.email } })),
          });
        }
        if (method === 'DELETE' && m[4]) {
          kind('delete-permission');
          const perm = this.permissions.find((x) => x.id === m[4] && x.itemId === it.id && !x.revoked);
          if (!perm) return json(404, { error: { code: 'itemNotFound' } });
          perm.revoked = true;
          return json(204, null);
        }
      }
      if (!sub && method === 'DELETE') {
        kind('delete-item');
        it.deleted = true;
        it.seq = ++this.seq;
        for (const d of this.descendants(it.id)) Object.assign(d, { deleted: true, seq: ++this.seq });
        return json(204, null);
      }
      if (!sub) {
        kind('get-meta');
        return json(200, this.meta(it));
      }
    }
    return json(400, { error: { code: 'invalidRequest', message: 'Mock does not know ' + method + ' ' + p } });
  }
}
