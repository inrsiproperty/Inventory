import { currentUser, db, useLive } from './db';
import type {
  Entry,
  HidePayload,
  Inventory,
  Item,
  Participant,
  Photo,
  PhotoPayload,
  Property,
  RatingPayload,
  Role,
  Room,
  SignaturePayload,
  Tenancy,
} from './types';

// The current state of an inventory is built by replaying its log of entries.
// Rules applied here (phase 2):
// - Only the landlord's own (verified) rating entries count. A tenant can't change a rating.
// - "Hide" only hides your own entry from the default view; it stays in the history and the PDF appendix.
// - Entries added after locking are "post-sign" and shown separately.

export interface ItemState {
  rating: RatingPayload;
  ratedAt?: string;
  notes: Entry[];
  photos: Photo[];
  issues: Entry[];
  disputes: Entry[];
  replies: Entry[];
  entries: Entry[]; // visible thread, oldest first
  reviews: Map<string, Entry>; // latest agree/dispute per tenant (authorId)
}

export function emptyState(): ItemState {
  return { rating: {}, notes: [], photos: [], issues: [], disputes: [], replies: [], entries: [], reviews: new Map() };
}

/** Ids of entries hidden by their own author. */
export function hiddenIds(entries: Entry[]): Set<string> {
  const byId = new Map(entries.map((e) => [e.id, e]));
  const out = new Set<string>();
  for (const h of entries) {
    if (h.type !== 'hide') continue;
    const t = byId.get((h.payload as HidePayload).entryId);
    if (t && t.authorId === h.authorId) out.add(t.id);
  }
  return out;
}

export function isLandlordEntry(e: Entry, property?: Pick<Property, 'landlordId'>): boolean {
  if (e.authorVerified === false) return false;
  if (property?.landlordId) return e.authorId === property.landlordId;
  return e.authorRole === 'landlord';
}

export function deriveStates(entries: Entry[], photos: Photo[], property?: Pick<Property, 'landlordId'>): Map<string, ItemState> {
  const map = new Map<string, ItemState>();
  const hidden = hiddenIds(entries);
  const get = (k: string) => {
    let s = map.get(k);
    if (!s) map.set(k, (s = emptyState()));
    return s;
  };
  const sorted = [...entries].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const hiddenPhotoEntries = new Set<string>();
  for (const e of sorted) {
    if (e.type === 'hide' || e.type === 'signature' || e.type === 'structure-change') continue;
    const key = e.itemId || (e.roomId ? `room:${e.roomId}` : 'inventory');
    const s = get(key);
    if (hidden.has(e.id)) {
      if (e.type === 'photo') hiddenPhotoEntries.add(e.id);
      continue;
    }
    if (e.postSign) continue; // shown in their own section
    if (e.type === 'rating') {
      if (!isLandlordEntry(e, property)) {
        s.entries.push(e); // shown in the thread as ignored, never applied: only the landlord sets ratings
        continue;
      }
      const p = e.payload as RatingPayload;
      for (const [k, v] of Object.entries(p)) if (v !== undefined && v !== null && v !== '') (s.rating as Record<string, unknown>)[k] = v;
      s.ratedAt = e.createdAt;
    } else if (e.type === 'note') s.notes.push(e);
    else if (e.type === 'issue') s.issues.push(e);
    else if (e.type === 'dispute') {
      s.disputes.push(e);
      s.reviews.set(e.authorId, e);
    } else if (e.type === 'agree') s.reviews.set(e.authorId, e);
    else if (e.type === 'reply') s.replies.push(e);
    s.entries.push(e);
  }
  for (const p of [...photos].sort((a, b) => a.takenAt.localeCompare(b.takenAt))) {
    if (hiddenPhotoEntries.has(p.entryId)) continue;
    const pe = entries.find((e) => e.id === p.entryId);
    if (pe?.postSign) continue;
    const key = p.itemId || (p.roomId ? `room:${p.roomId}` : 'inventory');
    get(key).photos.push(p);
  }
  return map;
}

export function isRated(item: Item, s?: ItemState): boolean {
  if (!s) return false;
  const r = s.rating;
  switch (item.category) {
    case 'meter':
      return !!r.reading;
    case 'key':
      return r.count !== undefined;
    case 'safety':
      return r.tested !== undefined;
    case 'document':
      return r.handedOver !== undefined;
    default:
      return !!r.condition;
  }
}

export function ratingSummary(item: Item, s?: ItemState): string {
  const r = s?.rating || {};
  switch (item.category) {
    case 'meter':
      return r.reading ? `${r.reading}${r.unit ? ' ' + r.unit : ''}` : 'No reading';
    case 'key':
      return r.count !== undefined ? `${r.count} handed over` : 'Not counted';
    case 'safety':
      return r.tested === undefined ? 'Not tested' : r.tested ? 'Tested: working' : 'Tested: NOT working';
    case 'document':
      return r.handedOver === undefined ? 'Not recorded' : r.handedOver ? 'Handed over' : 'Not handed over';
    default:
      return [r.condition, r.cleanliness].filter(Boolean).join(' · ') || 'Not rated';
  }
}

export type DisputeStatus = 'open' | 'answered' | 'withdrawn';

/** A dispute is answered once the landlord replies or changes the rating after it, and withdrawn if the tenant later agrees. */
export function disputeStatus(d: Entry, s: ItemState | undefined, all: Entry[], property?: Pick<Property, 'landlordId'>): DisputeStatus {
  const later = all.filter((e) => e.createdAt > d.createdAt && e.itemId === d.itemId && !e.postSign);
  if (s?.reviews.get(d.authorId)?.type === 'agree' && s.reviews.get(d.authorId)!.createdAt > d.createdAt) return 'withdrawn';
  if (later.some((e) => (e.type === 'reply' || e.type === 'rating') && isLandlordEntry(e, property))) return 'answered';
  return 'open';
}

// ---------- content fingerprint ----------

function stable(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map((x) => (x === undefined ? 'null' : stable(x))).join(',') + ']';
  const o = v as Record<string, unknown>;
  return (
    '{' +
    Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => JSON.stringify(k) + ':' + stable(o[k]))
      .join(',') +
    '}'
  );
}

/** Entries that make up the signed content (everything except signatures, hides and post-sign additions). */
export function contentEntries(entries: Entry[]): Entry[] {
  return entries.filter((e) => e.type !== 'signature' && e.type !== 'hide' && !e.postSign && e.authorVerified !== false).sort((a, b) => a.id.localeCompare(b.id));
}

export async function contentHash(entries: Entry[]): Promise<string> {
  const text = contentEntries(entries)
    .map((e) => stable([e.id, e.inventoryId, e.roomId ?? null, e.itemId ?? null, e.authorId, e.authorRole, e.createdAt, e.type, e.payload]))
    .join('\n');
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ---------- signatures ----------

export interface Signer {
  key: string;
  role: Role;
  name: string;
  email: string;
  signature?: Entry;
  valid: boolean; // signed the current content
  stale: boolean; // signed, but the content changed afterwards
}

export function signers(property: Property, tenancy: Tenancy, entries: Entry[], hash: string): Signer[] {
  const sigs = entries.filter((e) => e.type === 'signature' && e.authorVerified !== false).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const out: Signer[] = [];
  const landlordSig = sigs.find((s) => (s.payload as SignaturePayload).role === 'landlord' && isLandlordEntry(s, property));
  out.push(mk('landlord', 'landlord', property.landlordName || 'Landlord', property.landlordEmail || '', landlordSig));
  for (const t of tenancy.tenants.filter((x) => !x.removedAt)) {
    const email = t.email.toLowerCase();
    const sig = sigs.find((s) => {
      const p = s.payload as SignaturePayload;
      return p.role === 'tenant' && ((email && p.email?.toLowerCase() === email) || (!!t.msAccountId && s.authorId === t.msAccountId));
    });
    out.push(mk('tenant:' + email, 'tenant', t.name || t.email, t.email, sig));
  }
  return out;
  function mk(key: string, role: Role, name: string, email: string, signature?: Entry): Signer {
    const ok = !!signature && (signature.payload as SignaturePayload).contentHash === hash;
    return { key, role, name, email, signature, valid: ok, stale: !!signature && !ok };
  }
}

// ---------- whole inventory ----------

export interface InventoryData {
  inventory: Inventory;
  property: Property;
  tenancy: Tenancy;
  role: Role;
  me?: Participant;
  rooms: Room[];
  items: Item[];
  entries: Entry[];
  photos: Photo[];
  states: Map<string, ItemState>;
  issues: Entry[];
  disputes: { entry: Entry; status: DisputeStatus }[];
  openDisputes: number;
  postSign: Entry[];
  hidden: Entry[];
  ratedCount: number;
  itemCount: number;
  reviewedByMe: number;
  reviewed: Map<string, { name: string; count: number; agreed: number; disputed: number }>;
  hash: string;
  signers: Signer[];
  allSigned: boolean;
  locked: boolean;
  readOnly: boolean;
}

export async function loadInventoryData(inventoryId: string): Promise<InventoryData | null> {
  const inventory = await db.inventories.get(inventoryId);
  if (!inventory) return null;
  const [property, tenancy, rooms, items, entries, photos, me] = await Promise.all([
    db.properties.get(inventory.propertyId),
    db.tenancies.get(inventory.tenancyId),
    db.rooms.where('inventoryId').equals(inventoryId).toArray(),
    db.items.where('inventoryId').equals(inventoryId).toArray(),
    db.entries.where('inventoryId').equals(inventoryId).toArray(),
    db.photos.where('inventoryId').equals(inventoryId).toArray(),
    currentUser(),
  ]);
  if (!property || !tenancy) return null;
  const role: Role = property.role || 'landlord';
  const liveRooms = rooms.filter((r) => !r.removed).sort((a, b) => a.order - b.order);
  const roomIds = new Set(liveRooms.map((r) => r.id));
  const liveItems = items.filter((i) => !i.removed && roomIds.has(i.roomId)).sort((a, b) => a.order - b.order);
  const states = deriveStates(entries, photos, property);
  const hidden = hiddenIds(entries);
  const visible = entries.filter((e) => !hidden.has(e.id));
  const issues = visible.filter((e) => e.type === 'issue').sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const disputes = visible
    .filter((e) => e.type === 'dispute' && !e.postSign)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map((entry) => ({ entry, status: disputeStatus(entry, states.get(entry.itemId || ''), visible, property) }));
  const ratedCount = liveItems.filter((i) => isRated(i, states.get(i.id))).length;
  const reviewed = new Map<string, { name: string; count: number; agreed: number; disputed: number }>();
  for (const i of liveItems) {
    for (const [author, e] of states.get(i.id)?.reviews || []) {
      const r = reviewed.get(author) || { name: e.authorName || 'Tenant', count: 0, agreed: 0, disputed: 0 };
      r.count++;
      if (e.type === 'agree') r.agreed++;
      else r.disputed++;
      reviewed.set(author, r);
    }
  }
  const hash = inventory.status === 'locked' && inventory.contentHash ? inventory.contentHash : await contentHash(entries);
  const sg = signers(property, tenancy, entries, hash);
  const allSigned = sg.length > 1 && sg.every((s) => s.valid);
  const locked = inventory.status === 'locked' || allSigned;
  return {
    inventory,
    property,
    tenancy,
    role,
    me,
    rooms: liveRooms,
    items: liveItems,
    entries,
    photos: photos.filter((p) => !hidden.has(p.entryId)),
    states,
    issues,
    disputes,
    openDisputes: disputes.filter((d) => d.status === 'open').length,
    postSign: visible.filter((e) => e.postSign && e.type !== 'photo').sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    hidden: entries.filter((e) => hidden.has(e.id)),
    ratedCount,
    itemCount: liveItems.length,
    reviewedByMe: me ? reviewed.get(me.id)?.count || 0 : 0,
    reviewed,
    hash,
    signers: sg,
    allSigned,
    locked,
    readOnly: locked || !!property.accessRevoked,
  };
}

export function useInventory(inventoryId: string | undefined) {
  return useLive(() => (inventoryId ? loadInventoryData(inventoryId) : null), [inventoryId]);
}

export function photoOfEntry(e: Entry): PhotoPayload['photo'] | undefined {
  return e.type === 'photo' ? (e.payload as PhotoPayload).photo : undefined;
}
