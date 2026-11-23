import { db, currentUser, getSettings } from './db';
import { localChange } from './events';
import { inventoryFolderName, photoFileName, propertyFolderName } from './paths';
import { buildRoomsAndItems, type RoomChoice } from './templates';
import type {
  Entry,
  EntryPayload,
  EntryType,
  Furnishing,
  Inventory,
  IssueType,
  Item,
  ItemCategory,
  Participant,
  Photo,
  PhotoSource,
  Property,
  PropertyType,
  RatingPayload,
  Room,
  StructureOp,
  Tenancy,
  TenantRef,
} from './types';
import type { ProcessedPhoto } from './photos';
import { nowIso, uuid } from './util';

// All changes go through here. Every change is saved on the phone first and
// marked dirty; the sync engine uploads it later. Entries are written once and never edited.

async function me(): Promise<Participant> {
  const u = await currentUser();
  if (!u) throw new Error('Please sign in first.');
  return u;
}

// ---------- Properties ----------

export interface PropertyInput {
  address: string;
  postcode: string;
  type: PropertyType;
  bedrooms: number;
  furnishing: Furnishing;
}

export async function createProperty(input: PropertyInput): Promise<string> {
  const id = uuid();
  const p: Property = {
    id,
    ...input,
    createdAt: nowIso(),
    folderName: propertyFolderName(input.address, id),
    dirty: 1,
  };
  await db.properties.put(p);
  localChange();
  return id;
}

export async function updateProperty(id: string, changes: Partial<PropertyInput> & { coverPhotoId?: string }) {
  await db.properties.update(id, { ...changes, dirty: 1 });
  localChange();
}

// ---------- Tenancies ----------

export interface TenancyInput {
  tenants: TenantRef[];
  startDate: string;
  endDate?: string;
  depositRef?: string;
}

export async function createTenancy(propertyId: string, input: TenancyInput): Promise<string> {
  const id = uuid();
  const t: Tenancy = { id, propertyId, ...input, status: 'active', createdAt: nowIso(), dirty: 1 };
  await db.tenancies.put(t);
  localChange();
  return id;
}

export async function updateTenancy(id: string, input: Partial<TenancyInput>) {
  await db.tenancies.update(id, { ...input, dirty: 1 });
  localChange();
}

// ---------- Inventories ----------

export async function startInventory(tenancyId: string, choices: RoomChoice[]): Promise<string> {
  const user = await me();
  const tenancy = await db.tenancies.get(tenancyId);
  if (!tenancy) throw new Error('Tenancy not found');
  const property = await db.properties.get(tenancy.propertyId);
  if (!property) throw new Error('Property not found');
  const settings = await getSettings();
  const id = uuid();
  const createdAt = nowIso();
  const inv: Inventory = {
    id,
    tenancyId,
    propertyId: property.id,
    type: 'check-in',
    status: 'draft',
    version: 1,
    createdAt,
    folderName: inventoryFolderName('check-in', createdAt, id),
    dirty: 1,
  };
  const { rooms, items } = buildRoomsAndItems(id, settings.templates, choices, property.furnishing);
  await db.transaction('rw', [db.inventories, db.rooms, db.items, db.entries], async () => {
    await db.inventories.put(inv);
    await db.rooms.bulkPut(rooms);
    await db.items.bulkPut(items);
    await db.entries.put(
      makeEntry(user, inv, { type: 'structure-change', payload: { op: 'create-from-template', rooms, items } }),
    );
  });
  localChange();
  return id;
}

function makeEntry(
  user: Participant,
  inv: Pick<Inventory, 'id' | 'propertyId'>,
  e: { type: EntryType; payload: EntryPayload; roomId?: string; itemId?: string; id?: string; createdAt?: string },
): Entry {
  return {
    id: e.id || uuid(),
    inventoryId: inv.id,
    propertyId: inv.propertyId,
    roomId: e.roomId,
    itemId: e.itemId,
    authorId: user.id,
    authorRole: user.role,
    authorName: user.name,
    createdAt: e.createdAt || nowIso(),
    type: e.type,
    payload: e.payload,
    dirty: 1,
  };
}

async function addEntry(
  invId: string,
  e: { type: EntryType; payload: EntryPayload; roomId?: string; itemId?: string; id?: string; createdAt?: string },
): Promise<Entry> {
  const user = await me();
  const inv = await db.inventories.get(invId);
  if (!inv) throw new Error('Inventory not found');
  if (inv.status === 'locked') throw new Error('This inventory is locked. Add a post-sign note instead.');
  const entry = makeEntry(user, inv, e);
  await db.entries.put(entry);
  localChange();
  return entry;
}

export async function setRating(invId: string, item: Item, rating: RatingPayload) {
  return addEntry(invId, { type: 'rating', roomId: item.roomId, itemId: item.id, payload: rating });
}

export async function addNote(invId: string, text: string, roomId?: string, itemId?: string) {
  if (!text.trim()) return;
  return addEntry(invId, { type: 'note', roomId, itemId, payload: { text: text.trim() } });
}

/** Save a processed photo against a room/item. Returns the photo id. */
export async function addPhoto(
  invId: string,
  roomId: string | undefined,
  itemId: string | undefined,
  p: ProcessedPhoto,
  source: PhotoSource,
): Promise<string> {
  const user = await me();
  const inv = await db.inventories.get(invId);
  if (!inv) throw new Error('Inventory not found');
  const room = roomId ? await db.rooms.get(roomId) : undefined;
  const item = itemId ? await db.items.get(itemId) : undefined;
  const photoId = uuid();
  const entryId = uuid();
  const meta = {
    id: photoId,
    entryId,
    fileName: photoFileName(room?.name, item?.name, p.takenAt, photoId),
    width: p.width,
    height: p.height,
    takenAt: p.takenAt,
    exifTakenAt: p.exifTakenAt,
    source,
    sha256: p.sha256,
    byteSize: p.blob.size,
    stamped: p.stamped,
  };
  const photo: Photo = {
    ...meta,
    inventoryId: invId,
    propertyId: inv.propertyId,
    roomId,
    itemId,
    authorId: user.id,
    uploadStatus: 'pending',
    hasFull: 1,
    hasThumb: 1,
  };
  const entry = makeEntry(user, inv, { id: entryId, type: 'photo', roomId, itemId, payload: { photo: meta }, createdAt: p.takenAt });
  await db.transaction('rw', [db.photos, db.blobs, db.entries], async () => {
    await db.blobs.put({ key: `${photoId}:full`, blob: p.blob });
    await db.blobs.put({ key: `${photoId}:thumb`, blob: p.thumb });
    await db.photos.put(photo);
    await db.entries.put(entry);
  });
  localChange();
  return photoId;
}

export async function reportIssue(
  invId: string,
  issueType: IssueType,
  note: string,
  photoIds: string[],
  roomId?: string,
  itemId?: string,
) {
  return addEntry(invId, {
    type: 'issue',
    roomId,
    itemId,
    payload: { issueType, note: note.trim(), photoIds, status: 'open' },
  });
}

// ---------- Structure changes (rooms and items) ----------

async function structure(invId: string, op: StructureOp, roomId?: string, itemId?: string) {
  await applyStructureOp(op);
  await addEntry(invId, { type: 'structure-change', payload: op, roomId, itemId });
  await db.inventories.update(invId, { dirty: 1 });
  localChange();
}

/** Applies a structure change to the local room/item tables. Idempotent; also used when pulling from OneDrive. */
export async function applyStructureOp(op: StructureOp) {
  switch (op.op) {
    case 'create-from-template': {
      const haveRooms = new Set((await db.rooms.bulkGet(op.rooms.map((r) => r.id))).filter(Boolean).map((r) => r!.id));
      const haveItems = new Set((await db.items.bulkGet(op.items.map((i) => i.id))).filter(Boolean).map((i) => i!.id));
      await db.rooms.bulkPut(op.rooms.filter((r) => !haveRooms.has(r.id)));
      await db.items.bulkPut(op.items.filter((i) => !haveItems.has(i.id)));
      break;
    }
    case 'add-room':
      if (!(await db.rooms.get(op.room.id))) await db.rooms.put(op.room);
      break;
    case 'update-room':
      await db.rooms.update(op.roomId, op.changes);
      break;
    case 'remove-room':
      await db.rooms.update(op.roomId, { removed: true });
      break;
    case 'add-item':
      if (!(await db.items.get(op.item.id))) await db.items.put(op.item);
      break;
    case 'update-item':
      await db.items.update(op.itemId, op.changes);
      break;
    case 'remove-item':
      await db.items.update(op.itemId, { removed: true });
      break;
  }
}

export async function addRoom(invId: string, name: string, templateKey = 'custom') {
  const rooms = await db.rooms.where('inventoryId').equals(invId).toArray();
  const order = rooms.length ? Math.max(...rooms.map((r) => r.order)) + 1 : 0;
  const room: Room = { id: uuid(), inventoryId: invId, name: name.trim() || 'Room', order, templateKey };
  await structure(invId, { op: 'add-room', room }, room.id);
  return room.id;
}

export async function renameRoom(invId: string, roomId: string, name: string) {
  await structure(invId, { op: 'update-room', roomId, changes: { name: name.trim() } }, roomId);
}

export async function removeRoom(invId: string, roomId: string) {
  await structure(invId, { op: 'remove-room', roomId }, roomId);
}

export async function addItem(invId: string, roomId: string, name: string, category: ItemCategory = 'general') {
  const items = await db.items.where('roomId').equals(roomId).toArray();
  const order = items.length ? Math.max(...items.map((i) => i.order)) + 1 : 0;
  const item: Item = { id: uuid(), roomId, inventoryId: invId, name: name.trim() || 'Item', description: '', quantity: 1, order, category };
  await structure(invId, { op: 'add-item', item }, roomId, item.id);
  return item.id;
}

export async function updateItem(invId: string, item: Item, changes: Partial<Pick<Item, 'name' | 'description' | 'quantity'>>) {
  const real: typeof changes = {};
  if (changes.name !== undefined && changes.name.trim() && changes.name.trim() !== item.name) real.name = changes.name.trim();
  if (changes.description !== undefined && changes.description.trim() !== item.description) real.description = changes.description.trim();
  if (changes.quantity !== undefined && changes.quantity !== item.quantity) real.quantity = changes.quantity;
  if (!Object.keys(real).length) return;
  await structure(invId, { op: 'update-item', itemId: item.id, changes: real }, item.roomId, item.id);
}

export async function removeItem(invId: string, item: Item) {
  await structure(invId, { op: 'remove-item', itemId: item.id }, item.roomId, item.id);
}

/** Move an item up or down within its room. */
export async function moveItem(invId: string, item: Item, dir: -1 | 1) {
  const siblings = (await db.items.where('roomId').equals(item.roomId).toArray())
    .filter((i) => !i.removed)
    .sort((a, b) => a.order - b.order);
  const idx = siblings.findIndex((i) => i.id === item.id);
  const other = siblings[idx + dir];
  if (!other) return;
  // Renumber everything so orders are unique, then swap.
  const ordered = siblings.map((s) => s.id);
  [ordered[idx], ordered[idx + dir]] = [ordered[idx + dir], ordered[idx]];
  for (let i = 0; i < ordered.length; i++) {
    const s = siblings.find((x) => x.id === ordered[i])!;
    if (s.order !== i) await structure(invId, { op: 'update-item', itemId: s.id, changes: { order: i } }, s.roomId, s.id);
  }
}
