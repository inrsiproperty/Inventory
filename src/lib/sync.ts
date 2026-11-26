import { useEffect, useState } from 'react';
import { applyStructureOp, lockIfComplete } from './actions';
import { activeAccount, authConfigured, getToken } from './auth';
import { ROOT_FOLDER } from './config';
import { currentUser, db, forRemote, getSettings } from './db';
import { bus } from './events';
import * as G from './graph';
import { ENTRY_FILE_RE, SETTINGS_PATH, entryFileName, inventoryDir, propertyRootPath, tenancyDir } from './paths';
import { makeThumb } from './photos';
import type { AppSettings, Entry, Inventory, Item, Photo, PhotoPayload, Property, Room, SignaturePayload, StructureOp, SyncMeta, Tenancy } from './types';

// Offline-first sync. Everything is already safe on the phone; this uploads it to
// OneDrive, retrying with back-off, and pulls back anything new (delta query).
// Nothing is removed from the phone until OneDrive confirms it.

export type SyncState = 'idle' | 'syncing' | 'offline' | 'needs-sign-in' | 'not-configured' | 'error';

export interface SyncStatus {
  state: SyncState;
  pendingPhotos: number;
  pendingChanges: number;
  lastSyncAt?: string;
  lastError?: string;
  detail?: string;
  counted?: boolean; // false until the queue has been counted, so we never claim "all saved" too early
}

let status: SyncStatus = { state: navigator.onLine ? 'idle' : 'offline', pendingPhotos: 0, pendingChanges: 0, counted: false };
const listeners = new Set<(s: SyncStatus) => void>();

function setStatus(p: Partial<SyncStatus>) {
  status = { ...status, ...p };
  listeners.forEach((l) => l(status));
}

export function getSyncStatus() {
  return status;
}

export function useSyncStatus(): SyncStatus {
  const [s, setS] = useState(status);
  useEffect(() => {
    listeners.add(setS);
    setS(status);
    return () => {
      listeners.delete(setS);
    };
  }, []);
  return s;
}

export async function countPending() {
  const [photos, props, tens, invs, entries, exps, settings, files] = await Promise.all([
    db.photos.where('uploadStatus').equals('pending').count(),
    db.properties.where('dirty').equals(1).count(),
    db.tenancies.where('dirty').equals(1).count(),
    db.inventories.where('dirty').equals(1).count(),
    db.entries.where('dirty').equals(1).count(),
    db.exports.where('uploadStatus').equals('pending').count(),
    db.settings.where('dirty').equals(1).count(),
    db.files.where('uploadStatus').equals('pending').count(),
  ]);
  return { pendingPhotos: photos, pendingChanges: props + tens + invs + entries + exps + settings + files };
}

async function refreshCounts() {
  setStatus({ ...(await countPending()), counted: true });
}

// ---------- retry bookkeeping ----------

function due(rec: { sync?: SyncMeta }) {
  return !rec.sync || !rec.sync.nextTryAt || rec.sync.nextTryAt <= Date.now();
}

function failed(prev: SyncMeta | undefined, err: unknown): SyncMeta {
  const attempts = (prev?.attempts || 0) + 1;
  const retry = err instanceof G.GraphError && err.retryAfterMs ? err.retryAfterMs : Math.min(2000 * 2 ** attempts, 5 * 60_000);
  return { ...prev, attempts, nextTryAt: Date.now() + retry, lastError: err instanceof Error ? err.message : String(err) };
}

/** Errors that should stop the whole cycle rather than just one file. */
function isFatal(e: unknown) {
  return (
    e instanceof G.AuthNeededError ||
    e instanceof G.OfflineError ||
    (e instanceof G.GraphError && (e.status === 429 || e.status === 503 || e.status === 507))
  );
}

async function pool<T>(items: T[], n: number, fn: (x: T) => Promise<void>) {
  let i = 0;
  let fatal: unknown = null;
  const worker = async () => {
    while (i < items.length && !fatal) {
      const x = items[i++];
      try {
        await fn(x);
      } catch (e) {
        if (isFatal(e)) fatal = e;
        else console.warn('sync item failed', e);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  if (fatal) throw fatal;
}

function target(p: Property): G.DriveTarget {
  if (!p.driveId || !p.folderId) throw new Error('Property folder not created yet');
  return { kind: 'folder', driveId: p.driveId, folderId: p.folderId };
}

async function rememberRemote(item: G.DriveItem, propertyId: string) {
  if (item?.id) await db.remoteFiles.put({ id: item.id, eTag: item.eTag || '', name: item.name, propertyId });
}

// ---------- serialisers (what goes into OneDrive) ----------

const serProperty = (p: Property) => JSON.stringify(forRemote(p), null, 2);
const serTenancy = (t: Tenancy) => JSON.stringify(forRemote(t), null, 2);
const serEntry = (e: Entry) => JSON.stringify(forRemote(e), null, 2);
const serSettings = (s: AppSettings) => JSON.stringify(forRemote(s, ['key']), null, 2);

async function serInventory(inv: Inventory) {
  const rooms = await db.rooms.where('inventoryId').equals(inv.id).toArray();
  const items = await db.items.where('inventoryId').equals(inv.id).toArray();
  return JSON.stringify(
    {
      ...forRemote(inv),
      rooms: rooms.sort((a, b) => a.order - b.order),
      items: items.sort((a, b) => a.order - b.order),
    },
    null,
    2,
  );
}

// ---------- push ----------

async function pushSettings() {
  const s = await db.settings.get('app');
  if (!s || !s.dirty || !due(s)) return;
  const props = await db.properties.toArray();
  if (props.length && props.every((p) => p.role === 'tenant')) return; // don't write into a tenant's own OneDrive
  const body = serSettings(s);
  try {
    await G.upload({ kind: 'me-root' }, SETTINGS_PATH, body);
    const cur = await db.settings.get('app');
    if (cur && serSettings(cur) === body) await db.settings.update('app', { dirty: 0, sync: undefined });
  } catch (e) {
    if (isFatal(e)) throw e;
    await db.settings.update('app', { sync: failed(s.sync, e) });
  }
}

async function pushProperties() {
  const list = (await db.properties.where('dirty').equals(1).toArray()).filter((p) => due(p) && p.role !== 'tenant');
  for (const p of list) {
    const body = serProperty(p);
    try {
      let item: G.DriveItem;
      if (!p.folderId) {
        // First upload creates "Property Inventories/{slug}_{id}/" in the landlord's OneDrive.
        item = await G.upload({ kind: 'me-root' }, `${propertyRootPath(p)}/property.json`, body);
        const driveId = item.parentReference?.driveId;
        const folderId = item.parentReference?.id;
        if (!driveId || !folderId) throw new Error('OneDrive did not return the folder');
        await db.properties.update(p.id, { driveId, folderId, landlordDriveUserId: item.createdBy?.user?.id });
      } else {
        item = await G.upload(target(p), 'property.json', body);
        if (!p.landlordDriveUserId && item.createdBy?.user?.id) await db.properties.update(p.id, { landlordDriveUserId: item.createdBy.user.id });
      }
      await rememberRemote(item, p.id);
      const cur = await db.properties.get(p.id);
      if (cur && serProperty(cur) === body) await db.properties.update(p.id, { dirty: 0, sync: undefined });
    } catch (e) {
      if (isFatal(e)) throw e;
      await db.properties.update(p.id, { sync: failed(p.sync, e) });
    }
  }
}

async function pushTenancies() {
  const list = (await db.tenancies.where('dirty').equals(1).toArray()).filter(due);
  for (const t of list) {
    const p = await db.properties.get(t.propertyId);
    if (!p?.folderId || p.role === 'tenant') continue;
    const body = serTenancy(t);
    try {
      const item = await G.upload(target(p), `${tenancyDir(t)}/tenancy.json`, body);
      await rememberRemote(item, p.id);
      const cur = await db.tenancies.get(t.id);
      if (cur && serTenancy(cur) === body) await db.tenancies.update(t.id, { dirty: 0, sync: undefined });
    } catch (e) {
      if (isFatal(e)) throw e;
      await db.tenancies.update(t.id, { sync: failed(t.sync, e) });
    }
  }
}

async function pushInventories() {
  const list = (await db.inventories.where('dirty').equals(1).toArray()).filter(due);
  for (const inv of list) {
    const p = await db.properties.get(inv.propertyId);
    if (!p?.folderId || p.role === 'tenant') continue;
    const rel = `${inventoryDir(inv)}/inventory.json`;
    const write = async (eTag?: string) => {
      const body = await serInventory(inv);
      // Only the landlord writes inventory.json, using its eTag (If-Match) so a stale copy is rejected.
      const item = await G.upload(target(p), rel, body, eTag ? { ifMatch: eTag } : { conflict: 'fail' });
      return { item, body };
    };
    try {
      let res: { item: G.DriveItem; body: string };
      try {
        res = await write(inv.sync?.eTag);
      } catch (e) {
        if (!(e instanceof G.GraphError) || (e.status !== 412 && e.status !== 409)) throw e;
        // Someone else wrote it. Pull their entries first, then write on top of the latest version.
        await pullProperty(p);
        const latest = await G.getItem(target(p), rel);
        res = await write(latest?.eTag);
      }
      await rememberRemote(res.item, p.id);
      const cur = await db.inventories.get(inv.id);
      const meta: SyncMeta = { attempts: 0, nextTryAt: 0, eTag: res.item.eTag };
      const still = cur ? (await serInventory(cur)) === res.body : false;
      await db.inventories.update(inv.id, { dirty: still ? 0 : 1, sync: meta });
    } catch (e) {
      if (isFatal(e)) throw e;
      await db.inventories.update(inv.id, { sync: { ...failed(inv.sync, e), eTag: inv.sync?.eTag } });
    }
  }
}

async function pushPhotos() {
  const list = (await db.photos.where('uploadStatus').equals('pending').toArray()).filter(due);
  const total = list.length;
  let done = 0;
  await pool(list, 3, async (ph) => {
    const p = await db.properties.get(ph.propertyId);
    const inv = await db.inventories.get(ph.inventoryId);
    if (!p?.folderId || !inv || p.accessRevoked) return;
    const full = await db.blobs.get(`${ph.id}:full`);
    if (!full) {
      await db.photos.update(ph.id, { uploadStatus: 'failed', sync: failed(ph.sync, new Error('Photo file missing on this phone')) });
      return;
    }
    const rel = `${inventoryDir(inv)}/${ph.fileName}`;
    try {
      let item: G.DriveItem | null;
      try {
        item = await G.upload(target(p), rel, full.blob, {
          contentType: 'image/jpeg',
          conflict: 'fail',
          resumeUrl: ph.sync?.uploadUrl,
          onSession: (url) => db.photos.update(ph.id, { sync: { ...(ph.sync || { attempts: 0, nextTryAt: 0 }), uploadUrl: url } }).then(() => undefined),
        });
      } catch (e) {
        // Already there from an earlier attempt that lost its reply: confirm and carry on.
        if (!(e instanceof G.GraphError && e.status === 409)) throw e;
        item = await G.getItem(target(p), rel);
        if (!item || item.size !== full.blob.size) throw e;
      }
      await rememberRemote(item, p.id);
      // OneDrive confirmed it: now the full-size copy can leave the phone (the thumbnail stays).
      await db.transaction('rw', [db.photos, db.blobs], async () => {
        await db.photos.update(ph.id, { uploadStatus: 'uploaded', remoteCreatedAt: item!.createdDateTime, hasFull: 0, sync: undefined });
        await db.blobs.delete(`${ph.id}:full`);
      });
      done++;
      setStatus({ detail: `Uploading photos ${done}/${total}` });
      await refreshCounts();
    } catch (e) {
      if (!isFatal(e)) await db.photos.update(ph.id, { sync: failed(ph.sync, e) });
      throw e;
    }
  });
}

async function pushFiles() {
  const list = (await db.files.where('uploadStatus').equals('pending').toArray()).filter(due);
  for (const f of list) {
    const p = await db.properties.get(f.propertyId);
    const inv = await db.inventories.get(f.inventoryId);
    const blob = await db.blobs.get(`${f.id}:file`);
    if (!p?.folderId || !inv || !blob || p.accessRevoked) continue;
    const rel = `${inventoryDir(inv)}/${f.relPath}`;
    try {
      let item: G.DriveItem | null;
      try {
        item = await G.upload(target(p), rel, blob.blob, { contentType: f.contentType, conflict: 'fail' });
      } catch (e) {
        if (!(e instanceof G.GraphError && e.status === 409)) throw e;
        item = await G.getItem(target(p), rel);
      }
      if (item) await rememberRemote(item, p.id);
      await db.files.update(f.id, { uploadStatus: 'uploaded', sync: undefined });
    } catch (e) {
      if (isFatal(e)) throw e;
      await db.files.update(f.id, { sync: failed(f.sync, e) });
    }
  }
}

async function pushEntries() {
  const list = (await db.entries.where('dirty').equals(1).toArray()).filter(due);
  // A photo's entry goes up after the photo itself.
  const pendingPhotoEntries = new Set([
    ...(await db.photos.where('uploadStatus').equals('pending').toArray()).map((p) => p.entryId),
    ...(await db.files.where('uploadStatus').equals('pending').toArray()).map((f) => f.entryId),
  ]);
  const ready = list.filter((e) => !pendingPhotoEntries.has(e.id)).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  await pool(ready, 4, async (e) => {
    const p = await db.properties.get(e.propertyId);
    const inv = await db.inventories.get(e.inventoryId);
    if (!p?.folderId || !inv || p.accessRevoked) return;
    const rel = `${inventoryDir(inv)}/entries/${entryFileName(e)}`;
    try {
      let item: G.DriveItem | null;
      try {
        // Entries are write-once: never overwrite.
        item = await G.upload(target(p), rel, serEntry(e), { conflict: 'fail' });
      } catch (err) {
        if (!(err instanceof G.GraphError && err.status === 409)) throw err;
        item = await G.getItem(target(p), rel);
      }
      if (item) await rememberRemote(item, p.id);
      await db.entries.update(e.id, { dirty: 0, sync: undefined });
    } catch (err) {
      if (!isFatal(err)) await db.entries.update(e.id, { sync: failed(e.sync, err) });
      throw err;
    }
  });
}

async function pushExports() {
  const list = (await db.exports.where('uploadStatus').equals('pending').toArray()).filter(due);
  for (const x of list) {
    const p = await db.properties.get(x.propertyId);
    const inv = await db.inventories.get(x.inventoryId);
    const pdf = await db.blobs.get(`${x.id}:pdf`);
    if (!p?.folderId || !inv || !pdf || p.accessRevoked) continue;
    try {
      const item = await G.upload(target(p), `${inventoryDir(inv)}/${x.fileName}`, pdf.blob, {
        contentType: 'application/pdf',
        conflict: 'replace',
        resumeUrl: x.sync?.uploadUrl,
        onSession: (url) => db.exports.update(x.id, { sync: { ...(x.sync || { attempts: 0, nextTryAt: 0 }), uploadUrl: url } }).then(() => undefined),
      });
      await rememberRemote(item, p.id);
      await db.exports.update(x.id, { uploadStatus: 'uploaded', remoteUrl: item.webUrl, sync: undefined });
    } catch (e) {
      if (isFatal(e)) throw e;
      await db.exports.update(x.id, { sync: failed(x.sync, e) });
    }
  }
}

// ---------- pull ----------

let discovered = false;

async function readJson<T>(driveId: string, itemId: string, url?: string): Promise<T> {
  const b = await G.downloadById(driveId, itemId, url);
  return JSON.parse(await b.text()) as T;
}

/** On a new phone: find property folders already in OneDrive. */
async function discoverProperties() {
  if (discovered) return;
  const s = await db.settings.get('app');
  if (!s || !s.dirty) {
    const remote = await G.downloadByPath({ kind: 'me-root' }, SETTINGS_PATH).catch((e) => {
      if (isFatal(e)) throw e;
      return null;
    });
    if (remote) {
      const r = JSON.parse(await remote.text()) as Partial<AppSettings>;
      const local = await getSettings();
      await db.settings.put({ ...local, ...r, key: 'app', dirty: 0 });
    }
  }
  const folders = await G.listChildren({ kind: 'me-root' }, ROOT_FOLDER);
  const known = await db.properties.toArray();
  const knownFolders = new Set(known.map((p) => p.folderId));
  for (const f of folders) {
    if (!f.folder || f.name === '_app' || knownFolders.has(f.id)) continue;
    const driveId = f.parentReference?.driveId;
    if (!driveId) continue;
    const blob = await G.downloadByPath({ kind: 'folder', driveId, folderId: f.id }, 'property.json').catch(() => null);
    if (!blob) continue;
    const remote = JSON.parse(await blob.text()) as Property;
    if (await db.properties.get(remote.id)) continue;
    await db.properties.put({ ...remote, folderName: remote.folderName || f.name, driveId, folderId: f.id, dirty: 0 });
  }
  discovered = true;
}

const rank = (name: string) => (name === 'property.json' ? 0 : name === 'tenancy.json' ? 1 : name === 'inventory.json' ? 2 : 3);

/** True unless OneDrive says the file was made by someone other than the landlord while claiming to be the landlord. */
function claimsCheck(e: Entry, f: G.DriveItem | undefined, p: Property): boolean {
  const claimsLandlord = e.authorRole === 'landlord' || (!!p.landlordId && e.authorId === p.landlordId);
  const by = f?.createdBy?.user?.id;
  if (!claimsLandlord || !by || !p.landlordDriveUserId) return true;
  return by.toLowerCase() === p.landlordDriveUserId.toLowerCase();
}

async function ingestEntry(e: Entry, f?: G.DriveItem, p?: Property) {
  if (await db.entries.get(e.id)) return;
  const verified = p ? claimsCheck(e, f, p) : true;
  await db.entries.put({ ...e, authorVerified: verified ? undefined : false, dirty: 0, sync: undefined });
  const isLandlord = verified && (p?.landlordId ? e.authorId === p.landlordId : e.authorRole === 'landlord');
  if (e.type === 'structure-change' && isLandlord) await applyStructureOp(e.payload as StructureOp);
  if (e.type === 'signature') {
    const sp = e.payload as SignaturePayload;
    if (sp.fileId && !(await db.files.get(sp.fileId)))
      await db.files.put({
        id: sp.fileId,
        entryId: e.id,
        inventoryId: e.inventoryId,
        propertyId: e.propertyId,
        relPath: sp.imageFile,
        contentType: 'image/png',
        uploadStatus: 'uploaded',
        hasBlob: 0,
      });
  }
  if (e.type === 'photo') {
    const meta = (e.payload as PhotoPayload).photo;
    if (meta && !(await db.photos.get(meta.id))) {
      const photo: Photo = {
        ...meta,
        inventoryId: e.inventoryId,
        propertyId: e.propertyId,
        roomId: e.roomId,
        itemId: e.itemId,
        authorId: e.authorId,
        uploadStatus: 'uploaded',
        hasFull: 0,
        hasThumb: 0,
      };
      await db.photos.put(photo);
    }
  }
}

/** Walks the whole property folder (used when delta isn't available, e.g. on a shared folder). */
async function walkTree(driveId: string, folderId: string): Promise<G.DriveItem[]> {
  const out: G.DriveItem[] = [];
  const queue = [folderId];
  while (queue.length) {
    const id = queue.shift()!;
    for (const c of await G.listChildrenById(driveId, id)) {
      if (c.folder) queue.push(c.id);
      else out.push(c);
    }
  }
  return out;
}

function byLandlord(f: G.DriveItem, p: Property) {
  const by = f.lastModifiedBy?.user?.id || f.createdBy?.user?.id;
  return !by || !p.landlordDriveUserId || by.toLowerCase() === p.landlordDriveUserId.toLowerCase();
}

async function pullProperty(p: Property) {
  if (!p.driveId || !p.folderId) return;
  if (p.role === 'tenant') {
    // Has the landlord removed our access? OneDrive answers 403/404 straight away.
    try {
      await G.getItemById(p.driveId, p.folderId);
      if (p.accessRevoked) await db.properties.update(p.id, { accessRevoked: false });
    } catch (e) {
      if (e instanceof G.GraphError && (e.status === 403 || e.status === 404)) {
        await db.properties.update(p.id, { accessRevoked: true });
        return;
      }
      throw e;
    }
  }
  let items: G.DriveItem[];
  let deltaLink: string | undefined;
  try {
    const res = await G.delta(p.driveId, p.folderId, p.deltaLink);
    items = res.items;
    deltaLink = res.deltaLink;
  } catch (e) {
    if (e instanceof G.GraphError && (e.status === 410 || e.code === 'resyncRequired')) {
      const res = await G.delta(p.driveId, p.folderId);
      items = res.items;
      deltaLink = res.deltaLink;
    } else if (e instanceof G.GraphError && [400, 403, 405, 501].includes(e.status)) {
      items = await walkTree(p.driveId, p.folderId); // delta not offered here
    } else throw e;
  }

  // Files deleted in OneDrive (e.g. by someone using the OneDrive app directly): put entries back.
  for (const d of items.filter((i) => i.deleted)) {
    const known = await db.remoteFiles.get(d.id);
    if (!known) continue;
    await db.remoteFiles.delete(d.id);
    if (ENTRY_FILE_RE.test(known.name)) {
      const e = await db.entries.get(known.name.slice(-41, -5));
      if (e) await db.entries.update(e.id, { dirty: 1, sync: undefined });
    } else if (known.name.endsWith('.jpg')) {
      const photoId = known.name.slice(-40, -4);
      const ph = await db.photos.get(photoId);
      if (ph && (await db.blobs.get(`${photoId}:full`))) await db.photos.update(photoId, { uploadStatus: 'pending' });
    }
  }

  const files = items.filter((i) => i.file && !i.deleted && i.name.endsWith('.json')).sort((a, b) => rank(a.name) - rank(b.name));
  const todo: G.DriveItem[] = [];
  for (const f of files) {
    const known = await db.remoteFiles.get(f.id);
    if (known && known.eTag === f.eTag) continue;
    if (ENTRY_FILE_RE.test(f.name)) {
      const entryId = f.name.slice(-41, -5);
      if (await db.entries.get(entryId)) {
        await rememberRemote(f, p.id);
        continue;
      }
    }
    todo.push(f);
  }
  const driveId = p.driveId;
  const handle = async (f: G.DriveItem) => {
    const url = f['@microsoft.graph.downloadUrl'];
    // property.json, tenancy.json and inventory.json are only ever written by the landlord.
    if (rank(f.name) < 3 && !byLandlord(f, p)) {
      await rememberRemote(f, p.id);
      return;
    }
    if (f.name === 'property.json') {
      const r = await readJson<Property>(driveId, f.id, url);
      const cur = await db.properties.get(p.id);
      if (cur && !cur.dirty)
        await db.properties.put({
          ...cur,
          ...r,
          role: cur.role,
          driveId: cur.driveId,
          folderId: cur.folderId,
          deltaLink: cur.deltaLink,
          landlordDriveUserId: cur.landlordDriveUserId,
          accessRevoked: cur.accessRevoked,
          dirty: 0,
        });
    } else if (f.name === 'tenancy.json') {
      const r = await readJson<Tenancy>(driveId, f.id, url);
      const cur = await db.tenancies.get(r.id);
      if (!cur || !cur.dirty) await db.tenancies.put({ ...r, dirty: 0 });
    } else if (f.name === 'inventory.json') {
      const r = await readJson<Inventory & { rooms: Room[]; items: Item[] }>(driveId, f.id, url);
      const { rooms, items, ...inv } = r;
      const cur = await db.inventories.get(inv.id);
      if (!cur) {
        await db.inventories.put({ ...inv, dirty: 0, sync: { attempts: 0, nextTryAt: 0, eTag: f.eTag } });
        await applyStructureOp({ op: 'create-from-template', rooms, items });
      } else if (!cur.dirty) {
        await db.inventories.put({ ...cur, ...inv, dirty: 0, sync: { attempts: 0, nextTryAt: 0, eTag: f.eTag } });
      }
    } else if (ENTRY_FILE_RE.test(f.name)) {
      await ingestEntry(await readJson<Entry>(driveId, f.id, url), f, (await db.properties.get(p.id)) || p);
    }
    await rememberRemote(f, p.id);
  };
  // Parents first (property, tenancies, inventories), then entries in parallel.
  for (const f of todo.filter((x) => rank(x.name) < 3)) await handle(f);
  await pool(
    todo.filter((x) => rank(x.name) === 3),
    4,
    handle,
  );
  if (deltaLink) await db.properties.update(p.id, { deltaLink });
}

async function fetchMissingFiles() {
  const missing = (await db.files.where('uploadStatus').equals('uploaded').toArray()).filter((f) => !f.hasBlob).slice(0, 10);
  for (const f of missing) {
    const p = await db.properties.get(f.propertyId);
    const inv = await db.inventories.get(f.inventoryId);
    if (!p?.folderId || !inv || p.accessRevoked) continue;
    const blob = await G.downloadByPath(target(p), `${inventoryDir(inv)}/${f.relPath}`).catch((e) => {
      if (isFatal(e)) throw e;
      return null;
    });
    if (!blob) continue;
    await db.blobs.put({ key: `${f.id}:file`, blob });
    await db.files.update(f.id, { hasBlob: 1 });
  }
}

async function fetchMissingThumbs() {
  const missing = (await db.photos.where('uploadStatus').equals('uploaded').toArray()).filter((p) => !p.hasThumb).slice(0, 12);
  await pool(missing, 3, async (ph) => {
    const p = await db.properties.get(ph.propertyId);
    const inv = await db.inventories.get(ph.inventoryId);
    if (!p?.folderId || !inv || p.accessRevoked) return;
    const blob = await G.downloadByPath(target(p), `${inventoryDir(inv)}/${ph.fileName}`);
    if (!blob) return;
    await db.blobs.put({ key: `${ph.id}:thumb`, blob: await makeThumb(blob) });
    await db.photos.update(ph.id, { hasThumb: 1 });
  });
}

async function pullAll() {
  await discoverProperties();
  const props = (await db.properties.toArray()).filter((p) => p.folderId);
  for (const p of props) await pullProperty(p);
  await fetchMissingThumbs();
  await fetchMissingFiles();
  // Landlord's phone: lock anything every party has now signed.
  for (const inv of await db.inventories.toArray()) {
    const p = await db.properties.get(inv.propertyId);
    if (inv.status !== 'locked' && (p?.role || 'landlord') === 'landlord') await lockIfComplete(inv.id);
  }
}

// ---------- engine ----------

let running = false;
let again = false;
let timer: ReturnType<typeof setTimeout> | undefined;

export function scheduleSync(delay = 1500) {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = undefined;
    void syncNow();
  }, delay);
}

export async function syncNow(): Promise<void> {
  if (running) {
    again = true;
    return;
  }
  running = true;
  try {
    do {
      again = false;
      await cycle();
    } while (again);
  } finally {
    running = false;
  }
  // Something still waiting (e.g. backing off after an error)? Try again later.
  const pending = status.pendingPhotos + status.pendingChanges;
  if (pending > 0 && (status.state === 'idle' || status.state === 'error')) scheduleSync(15_000);
}

async function cycle() {
  await refreshCounts();
  if (!authConfigured()) return setStatus({ state: 'not-configured' });
  if (!(await currentUser())) return setStatus({ state: 'needs-sign-in' });
  if (!navigator.onLine) return setStatus({ state: 'offline' });
  if (!activeAccount() || !(await getToken())) return setStatus({ state: navigator.onLine ? 'needs-sign-in' : 'offline' });
  setStatus({ state: 'syncing', lastError: undefined, detail: undefined });
  try {
    await pushSettings();
    await pushProperties();
    await pushTenancies();
    await pushInventories();
    await pushPhotos();
    await pushFiles();
    await pushEntries();
    await pushExports();
    await pullAll();
    // Anything created while we were pulling (including a lock and its signed PDF).
    await pushInventories();
    await pushEntries();
    await pushExports();
    await refreshCounts();
    setStatus({ state: 'idle', lastSyncAt: new Date().toISOString(), detail: undefined });
  } catch (e) {
    console.warn('sync stopped', e);
    await refreshCounts();
    if (e instanceof G.AuthNeededError) setStatus({ state: 'needs-sign-in', detail: undefined });
    else if (e instanceof G.OfflineError) setStatus({ state: 'offline', detail: undefined });
    else setStatus({ state: 'error', lastError: e instanceof Error ? e.message : String(e), detail: undefined });
  }
}

let started = false;
export function startSyncEngine() {
  if (started) return;
  started = true;
  bus.addEventListener('local-change', () => {
    void refreshCounts();
    scheduleSync(1500);
  });
  window.addEventListener('online', () => scheduleSync(300));
  window.addEventListener('offline', () => setStatus({ state: 'offline' }));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') scheduleSync(500);
  });
  setInterval(() => scheduleSync(0), 60_000);
  void refreshCounts().then(() => {
    if (!navigator.onLine) setStatus({ state: 'offline' });
  });
  scheduleSync(500);
}

/** Forget the delta position so the next sync re-reads every property folder. */
export async function resyncFromOneDrive() {
  discovered = false;
  const props = await db.properties.toArray();
  for (const p of props) await db.properties.update(p.id, { deltaLink: undefined });
  await syncNow();
}
