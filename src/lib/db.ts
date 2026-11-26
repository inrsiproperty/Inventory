import Dexie, { liveQuery, type Table } from 'dexie';
import { useEffect, useState } from 'react';
import type {
  AppSettings,
  BlobRecord,
  Entry,
  ExportRecord,
  FileRecord,
  Inventory,
  Item,
  KV,
  Participant,
  Photo,
  Property,
  RemoteFile,
  Room,
  Tenancy,
} from './types';
import { DEFAULT_TEMPLATES } from './templates';
import { nowIso } from './util';

// Everything is saved on the phone first (IndexedDB via Dexie), then synced to OneDrive.
export class InventoryDB extends Dexie {
  properties!: Table<Property, string>;
  tenancies!: Table<Tenancy, string>;
  inventories!: Table<Inventory, string>;
  rooms!: Table<Room, string>;
  items!: Table<Item, string>;
  entries!: Table<Entry, string>;
  photos!: Table<Photo, string>;
  blobs!: Table<BlobRecord, string>;
  participants!: Table<Participant, string>;
  exports!: Table<ExportRecord, string>;
  settings!: Table<AppSettings, string>;
  kv!: Table<KV, string>;
  remoteFiles!: Table<RemoteFile, string>;
  files!: Table<FileRecord, string>;

  constructor() {
    super('inventory-app');
    this.version(1).stores({
      properties: 'id, dirty',
      tenancies: 'id, propertyId, dirty',
      inventories: 'id, tenancyId, propertyId, dirty',
      rooms: 'id, inventoryId',
      items: 'id, roomId, inventoryId',
      entries: 'id, inventoryId, itemId, roomId, propertyId, type, dirty',
      photos: 'id, inventoryId, itemId, roomId, propertyId, uploadStatus, entryId',
      blobs: 'key',
      participants: 'id',
      exports: 'id, inventoryId, uploadStatus',
      settings: 'key, dirty',
      kv: 'key',
      remoteFiles: 'id, propertyId',
    });
    // Phase 2: signature images and other entry attachments.
    this.version(2).stores({
      files: 'id, uploadStatus, inventoryId, entryId',
    });
  }
}

export const db = new InventoryDB();

/** Read-only version, safe inside live queries (falls back to defaults without writing). */
export async function readSettings(): Promise<AppSettings> {
  return (
    (await db.settings.get('app')) || { key: 'app', dateStamp: true, maxEdge: 2560, jpegQuality: 0.8, templates: DEFAULT_TEMPLATES, updatedAt: nowIso(), dirty: 0 }
  );
}

export async function getSettings(): Promise<AppSettings> {
  const s = await db.settings.get('app');
  if (s) return s;
  const fresh: AppSettings = {
    key: 'app',
    dateStamp: true,
    maxEdge: 2560,
    jpegQuality: 0.8,
    templates: DEFAULT_TEMPLATES,
    updatedAt: nowIso(),
    dirty: 0,
  };
  await db.settings.put(fresh);
  return fresh;
}

export async function getKV<T>(key: string): Promise<T | undefined> {
  return (await db.kv.get(key))?.value as T | undefined;
}
export async function setKV(key: string, value: unknown) {
  await db.kv.put({ key, value });
}

export async function currentUser(): Promise<Participant | undefined> {
  const id = await getKV<string>('currentUserId');
  return id ? db.participants.get(id) : undefined;
}

/** React hook: re-runs the query whenever the data it read changes. */
export function useLive<T>(query: () => Promise<T> | T, deps: unknown[] = [], initial?: T): T | undefined {
  const [value, setValue] = useState<T | undefined>(initial);
  useEffect(() => {
    const sub = liveQuery(query).subscribe({
      next: (v) => setValue(v),
      error: (e) => console.error('liveQuery failed', e),
    });
    return () => sub.unsubscribe();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return value;
}

/** Strip local-only fields before writing a record to OneDrive. */
export function forRemote<T extends object>(rec: T, extra: string[] = []): Partial<T> {
  const drop = new Set([
    'dirty',
    'sync',
    'deltaLink',
    'driveId',
    'folderId',
    'hasFull',
    'hasThumb',
    'role',
    'accessRevoked',
    'landlordDriveUserId',
    'authorVerified',
    ...extra,
  ]);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rec)) if (!drop.has(k)) out[k] = v;
  return out as Partial<T>;
}
