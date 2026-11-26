import { redirectUri } from './config';
import { db, currentUser, getSettings } from './db';
import { localChange } from './events';
import * as G from './graph';
import { inventoryFolderName, photoFileName, propertyFolderName } from './paths';
import { loadInventoryData, type InventoryData } from './state';
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
  Role,
  Room,
  SignaturePayload,
  StructureOp,
  Tenancy,
  TenantRef,
} from './types';
import type { ProcessedPhoto } from './photos';
import { fileStamp, nowIso, safeSegment, uuid } from './util';

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
  const user = await me();
  const id = uuid();
  const p: Property = {
    id,
    ...input,
    createdAt: nowIso(),
    role: 'landlord',
    landlordId: user.id,
    landlordName: user.name,
    landlordEmail: user.email,
    folderName: propertyFolderName(input.address, id),
    dirty: 1,
  };
  await db.properties.put(p);
  localChange();
  return id;
}

export async function updateProperty(id: string, changes: Partial<PropertyInput> & { coverPhotoId?: string }) {
  await assertLandlord(id);
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
  await assertLandlord(propertyId);
  const id = uuid();
  const t: Tenancy = { id, propertyId, ...input, status: 'active', createdAt: nowIso(), dirty: 1 };
  await db.tenancies.put(t);
  localChange();
  return id;
}

export async function updateTenancy(id: string, input: Partial<TenancyInput>) {
  const t = await db.tenancies.get(id);
  if (t) await assertLandlord(t.propertyId);
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
  await assertLandlord(property.id);
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
      makeEntry(user, inv, 'landlord', { type: 'structure-change', payload: { op: 'create-from-template', rooms, items } }),
    );
  });
  localChange();
  return id;
}

export async function roleFor(propertyId: string): Promise<Role> {
  return (await db.properties.get(propertyId))?.role || 'landlord';
}

async function assertLandlord(propertyId: string) {
  if ((await roleFor(propertyId)) !== 'landlord') throw new Error('Only the landlord can do this.');
}

function makeEntry(
  user: Participant,
  inv: Pick<Inventory, 'id' | 'propertyId'>,
  role: Role,
  e: { type: EntryType; payload: EntryPayload; roomId?: string; itemId?: string; id?: string; createdAt?: string; postSign?: boolean },
): Entry {
  return {
    id: e.id || uuid(),
    inventoryId: inv.id,
    propertyId: inv.propertyId,
    roomId: e.roomId,
    itemId: e.itemId,
    authorId: user.id,
    authorRole: role,
    authorName: user.name,
    createdAt: e.createdAt || nowIso(),
    type: e.type,
    payload: e.payload,
    postSign: e.postSign || undefined,
    dirty: 1,
  };
}

// Who may add what (spec: "Users and roles").
const LANDLORD_ONLY: EntryType[] = ['rating', 'structure-change'];
const TENANT_ONLY: EntryType[] = ['agree', 'dispute'];
// After locking, only these can be added, and they are marked as post-sign.
const AFTER_LOCK: EntryType[] = ['note', 'issue', 'photo', 'reply', 'hide'];

/** Checks the rules and works out whether a new entry is post-sign. Throws with a plain-English reason. */
async function checkEntry(invId: string, type: EntryType): Promise<{ data: InventoryData; role: Role; postSign: boolean }> {
  const data = await loadInventoryData(invId);
  if (!data) throw new Error('Inventory not found');
  const role = data.role;
  if (data.property.accessRevoked) throw new Error('Your access to this property has ended.');
  if (LANDLORD_ONLY.includes(type) && role !== 'landlord') throw new Error('Only the landlord can change ratings, rooms or items.');
  if (TENANT_ONLY.includes(type) && role !== 'tenant') throw new Error('Only the tenant can agree or dispute.');
  if (data.locked) {
    if (!AFTER_LOCK.includes(type)) throw new Error('This inventory is signed and locked. Add a post-sign note instead.');
    return { data, role, postSign: true };
  }
  return { data, role, postSign: false };
}

async function addEntry(
  invId: string,
  e: { type: EntryType; payload: EntryPayload; roomId?: string; itemId?: string; id?: string; createdAt?: string },
): Promise<Entry> {
  const user = await me();
  const { data, role, postSign } = await checkEntry(invId, e.type);
  const entry = makeEntry(user, data.inventory, role, { ...e, postSign });
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
  const { data, role, postSign } = await checkEntry(invId, 'photo');
  const inv = data.inventory;
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
  const entry = makeEntry(user, inv, role, { id: entryId, type: 'photo', roomId, itemId, payload: { photo: meta }, createdAt: p.takenAt, postSign });
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
  await addEntry(invId, { type: 'structure-change', payload: op, roomId, itemId });
  await applyStructureOp(op);
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

// ---------- Phase 2: review, disputes, replies, hiding ----------

export async function agreeItem(invId: string, item: Item) {
  return addEntry(invId, { type: 'agree', roomId: item.roomId, itemId: item.id, payload: {} });
}

export async function disputeItem(invId: string, item: Item, reason: string, photoIds: string[]) {
  if (!reason.trim()) throw new Error('Please say briefly what is not right.');
  return addEntry(invId, { type: 'dispute', roomId: item.roomId, itemId: item.id, payload: { reason: reason.trim(), photoIds } });
}

export async function addReply(invId: string, text: string, roomId?: string, itemId?: string, replyTo?: string) {
  if (!text.trim()) return;
  return addEntry(invId, { type: 'reply', roomId, itemId, payload: { text: text.trim(), replyTo } });
}

/** Hide your own entry from the default view. It stays in the history and in the PDF appendix. */
export async function hideEntry(entryId: string) {
  const user = await me();
  const target = await db.entries.get(entryId);
  if (!target) return;
  if (target.authorId !== user.id) throw new Error('You can only hide your own entries.');
  return addEntry(target.inventoryId, { type: 'hide', roomId: target.roomId, itemId: target.itemId, payload: { entryId } });
}

// ---------- Phase 2: signing and locking ----------

export async function signInventory(invId: string, typedName: string, png: Blob, reviewed: boolean) {
  if (!reviewed) throw new Error('Please tick the box to confirm you have reviewed the inventory.');
  if (!typedName.trim()) throw new Error('Please type your full name.');
  const user = await me();
  const { data, role } = await checkEntry(invId, 'signature');
  const signedAt = nowIso();
  const fileId = uuid();
  const entryId = uuid();
  const relPath = `signatures/${role}_${safeSegment(typedName, 40)}_${fileStamp(signedAt)}.png`;
  const payload: SignaturePayload = {
    signerId: user.id,
    role,
    typedName: typedName.trim(),
    email: user.email,
    imageFile: relPath,
    fileId,
    signedAt,
    inventoryVersion: data.inventory.version,
    contentHash: data.hash,
    reviewed: true,
  };
  await db.transaction('rw', [db.files, db.blobs, db.entries], async () => {
    await db.blobs.put({ key: `${fileId}:file`, blob: png });
    await db.files.put({
      id: fileId,
      entryId,
      inventoryId: invId,
      propertyId: data.property.id,
      relPath,
      contentType: 'image/png',
      uploadStatus: 'pending',
      hasBlob: 1,
    });
    await db.entries.put(makeEntry(user, data.inventory, role, { id: entryId, type: 'signature', payload, createdAt: signedAt }));
  });
  localChange();
  if (role === 'landlord') await lockIfComplete(invId);
}

/** When every party has signed the current content, lock it and save the signed PDF. Landlord's phone only. */
export async function lockIfComplete(invId: string): Promise<boolean> {
  const data = await loadInventoryData(invId);
  if (!data || data.role !== 'landlord' || data.inventory.status === 'locked' || !data.allSigned) return false;
  await lockInventory(invId, 'all-signed');
  return true;
}

export async function lockInventory(invId: string, reason: 'all-signed' | 'issued-not-signed-by-tenant') {
  const data = await loadInventoryData(invId);
  if (!data) throw new Error('Inventory not found');
  if (data.role !== 'landlord') throw new Error('Only the landlord can lock an inventory.');
  if (data.inventory.status === 'locked') return;
  if (reason === 'all-signed' && !data.allSigned) throw new Error('Not everyone has signed the current version yet.');
  if (reason === 'issued-not-signed-by-tenant') {
    const landlordSigned = data.signers.find((s) => s.role === 'landlord')?.valid;
    if (!landlordSigned) throw new Error('Sign it yourself first.');
    if (data.inventory.reviewDeadline && data.inventory.reviewDeadline > nowIso())
      throw new Error('The tenant still has time to review. You can lock it after the 7-day review window ends.');
  }
  await db.inventories.update(invId, {
    status: 'locked',
    lockedAt: nowIso(),
    lockReason: reason,
    contentHash: data.hash,
    dirty: 1,
  });
  localChange();
  // The signed PDF is generated on the phone and queued for OneDrive.
  const { createExport } = await import('./pdf');
  await createExport(invId);
}

// ---------- Phase 2: sharing with the tenant ----------

export function joinLink(p: Pick<Property, 'driveId' | 'folderId'>) {
  return `${redirectUri()}#/join/${encodeURIComponent(p.driveId || '')}/${encodeURIComponent(p.folderId || '')}`;
}

/** Shares the property folder with the tenancy's tenants (write access, sign-in required) and starts the 7-day review. */
export async function sendToTenant(tenancyId: string, inventoryId: string): Promise<string> {
  const user = await me();
  const t = await db.tenancies.get(tenancyId);
  if (!t) throw new Error('Tenancy not found');
  const p = await db.properties.get(t.propertyId);
  if (!p) throw new Error('Property not found');
  await assertLandlord(p.id);
  if (!p.driveId || !p.folderId) throw new Error('This property has not reached OneDrive yet. Connect to the internet, wait for "All saved to OneDrive", then try again.');
  if (!navigator.onLine) throw new Error('You need a connection to send the inventory to the tenant.');
  const targets = t.tenants.filter((x) => !x.removedAt);
  const missing = targets.filter((x) => !x.email.trim());
  if (!targets.length || missing.length) throw new Error('Add an email address for every tenant first (Edit tenancy).');
  const link = joinLink(p);
  const message =
    `${user.name} has shared the inventory for ${p.address}, ${p.postcode} with you. ` +
    `Open it in Inventory App to review each item, add photos and sign: ${link} ` +
    `Sign in with this email address. A free Microsoft account is fine.`;
  const perms = await G.invite(p.driveId, p.folderId, targets.map((x) => x.email.trim()), message);
  const tenants = t.tenants.map((x) => {
    if (x.removedAt) return x;
    const ids = perms.filter((pm) => G.permissionEmails(pm).includes(x.email.trim().toLowerCase())).map((pm) => pm.id);
    return { ...x, invitedAt: nowIso(), permissionIds: [...new Set([...(x.permissionIds || []), ...ids])] };
  });
  await db.tenancies.update(tenancyId, { tenants, dirty: 1 });
  const inv = await db.inventories.get(inventoryId);
  if (inv && inv.status === 'draft') {
    const sentAt = nowIso();
    await db.inventories.update(inventoryId, {
      status: 'in-review',
      sentAt,
      reviewDeadline: new Date(Date.now() + 7 * 864e5).toISOString(),
      dirty: 1,
    });
  }
  localChange();
  return link;
}

/** Removes a tenant's access to the property folder in OneDrive. Takes effect immediately. */
export async function removeTenantAccess(tenancyId: string, email: string) {
  const t = await db.tenancies.get(tenancyId);
  if (!t) throw new Error('Tenancy not found');
  const p = await db.properties.get(t.propertyId);
  if (!p?.driveId || !p.folderId) throw new Error('This property has not reached OneDrive yet.');
  await assertLandlord(p.id);
  const lower = email.trim().toLowerCase();
  const tenant = t.tenants.find((x) => x.email.trim().toLowerCase() === lower);
  const perms = await G.listPermissions(p.driveId, p.folderId);
  const targets = perms.filter((pm) => (tenant?.permissionIds || []).includes(pm.id) || G.permissionEmails(pm).includes(lower));
  for (const pm of targets) await G.deletePermission(p.driveId, p.folderId, pm.id);
  const tenants = t.tenants.map((x) => (x.email.trim().toLowerCase() === lower ? { ...x, removedAt: nowIso() } : x));
  await db.tenancies.update(tenancyId, { tenants, dirty: 1 });
  localChange();
  return targets.length;
}

/** Tenant: open a property folder shared through an invite link. */
export async function joinProperty(driveId: string, folderId: string): Promise<string> {
  const user = await me();
  let folder: G.DriveItem;
  try {
    folder = await G.getItemById(driveId, folderId);
  } catch (e) {
    if (e instanceof G.GraphError && (e.status === 403 || e.status === 404))
      throw new Error(
        `This property hasn't been shared with ${user.email}. Sign in with the email address your landlord invited, or ask them to send it again.`,
      );
    throw e;
  }
  const blob = await G.downloadByPath({ kind: 'folder', driveId, folderId }, 'property.json');
  if (!blob) throw new Error('That link is not an Inventory App property.');
  const remote = JSON.parse(await blob.text()) as Property;
  const existing = await db.properties.get(remote.id);
  if (existing && existing.role !== 'tenant') return existing.id; // the landlord opened their own link
  await db.properties.put({
    ...remote,
    role: 'tenant',
    driveId,
    folderId,
    folderName: remote.folderName || folder.name,
    landlordDriveUserId: folder.createdBy?.user?.id,
    accessRevoked: false,
    deltaLink: undefined,
    dirty: 0,
  });
  localChange();
  return remote.id;
}

/** Properties made in phase 1 don't record who the landlord is; fill it in. */
export async function migrateLandlordInfo() {
  const user = await currentUser();
  if (!user) return;
  for (const p of await db.properties.toArray()) {
    if ((p.role || 'landlord') === 'landlord' && !p.landlordId) {
      await db.properties.update(p.id, { role: 'landlord', landlordId: user.id, landlordName: user.name, landlordEmail: user.email, dirty: 1 });
    }
  }
}
