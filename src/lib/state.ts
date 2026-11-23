import { db, useLive } from './db';
import type { Entry, Inventory, IssuePayload, Item, Photo, Property, RatingPayload, Room, Tenancy } from './types';

// The current state of an inventory is built by replaying its log of entries.

export interface ItemState {
  rating: RatingPayload;
  ratedAt?: string;
  notes: Entry[];
  photos: Photo[];
  issues: Entry[];
  entries: Entry[];
}

export function emptyState(): ItemState {
  return { rating: {}, notes: [], photos: [], issues: [], entries: [] };
}

export function deriveStates(entries: Entry[], photos: Photo[]): Map<string, ItemState> {
  const map = new Map<string, ItemState>();
  const get = (k: string) => {
    let s = map.get(k);
    if (!s) map.set(k, (s = emptyState()));
    return s;
  };
  const sorted = [...entries].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  for (const e of sorted) {
    const key = e.itemId || (e.roomId ? `room:${e.roomId}` : 'inventory');
    const s = get(key);
    s.entries.push(e);
    if (e.type === 'rating') {
      const p = e.payload as RatingPayload;
      for (const [k, v] of Object.entries(p)) if (v !== undefined && v !== null && v !== '') (s.rating as Record<string, unknown>)[k] = v;
      s.ratedAt = e.createdAt;
    } else if (e.type === 'note') s.notes.push(e);
    else if (e.type === 'issue') s.issues.push(e);
  }
  for (const p of [...photos].sort((a, b) => a.takenAt.localeCompare(b.takenAt))) {
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

export interface InventoryData {
  inventory: Inventory;
  property: Property;
  tenancy: Tenancy;
  rooms: Room[];
  items: Item[];
  entries: Entry[];
  photos: Photo[];
  states: Map<string, ItemState>;
  issues: Entry[];
  ratedCount: number;
  itemCount: number;
}

export async function loadInventoryData(inventoryId: string): Promise<InventoryData | null> {
  const inventory = await db.inventories.get(inventoryId);
  if (!inventory) return null;
  const [property, tenancy, rooms, items, entries, photos] = await Promise.all([
    db.properties.get(inventory.propertyId),
    db.tenancies.get(inventory.tenancyId),
    db.rooms.where('inventoryId').equals(inventoryId).toArray(),
    db.items.where('inventoryId').equals(inventoryId).toArray(),
    db.entries.where('inventoryId').equals(inventoryId).toArray(),
    db.photos.where('inventoryId').equals(inventoryId).toArray(),
  ]);
  if (!property || !tenancy) return null;
  const liveRooms = rooms.filter((r) => !r.removed).sort((a, b) => a.order - b.order);
  const roomIds = new Set(liveRooms.map((r) => r.id));
  const liveItems = items.filter((i) => !i.removed && roomIds.has(i.roomId)).sort((a, b) => a.order - b.order);
  const states = deriveStates(entries, photos);
  const issues = entries.filter((e) => e.type === 'issue').sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const ratedCount = liveItems.filter((i) => isRated(i, states.get(i.id))).length;
  return {
    inventory,
    property,
    tenancy,
    rooms: liveRooms,
    items: liveItems,
    entries,
    photos,
    states,
    issues,
    ratedCount,
    itemCount: liveItems.length,
  };
}

export function useInventory(inventoryId: string | undefined) {
  return useLive(() => (inventoryId ? loadInventoryData(inventoryId) : null), [inventoryId]);
}

export function issueLabel(e: Entry) {
  const p = e.payload as IssuePayload;
  return p.issueType;
}
