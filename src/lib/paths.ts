// OneDrive folder structure, exactly as in the spec:
//
// OneDrive/
//   Property Inventories/
//     _app/settings.json
//     {address-slug}_{propertyId}/
//       property.json
//       tenancies/{tenancyId}/
//         tenancy.json
//         inventories/{type}_{date}_{inventoryId}/
//           inventory.json
//           entries/{timestamp}_{authorId}_{entryId}.json
//           photos/{room}/{item}/{timestamp}_{photoId}.jpg
//           signatures/{role}_{name}_{timestamp}.png
//           exports/Inventory_{address}_{type}_{date}_v{n}.pdf
//
// Paths below are relative to the property folder unless noted.

import { ROOT_FOLDER } from './config';
import type { Entry, Inventory, Property, Tenancy } from './types';
import { fileStamp, isoDate, safeSegment, slugify } from './util';

export const SETTINGS_PATH = `${ROOT_FOLDER}/_app/settings.json`; // relative to drive root

export function propertyFolderName(address: string, id: string) {
  return `${slugify(address)}_${id}`;
}

export function propertyRootPath(p: Property) {
  return `${ROOT_FOLDER}/${p.folderName}`; // relative to drive root
}

export function tenancyDir(t: Pick<Tenancy, 'id'>) {
  return `tenancies/${t.id}`;
}

export function inventoryFolderName(type: string, createdAt: string, id: string) {
  return `${type}_${isoDate(createdAt)}_${id}`;
}

export function inventoryDir(inv: Pick<Inventory, 'tenancyId' | 'folderName'>) {
  return `tenancies/${inv.tenancyId}/inventories/${inv.folderName}`;
}

export function entryFileName(e: Pick<Entry, 'createdAt' | 'authorId' | 'id'>) {
  return `${fileStamp(e.createdAt)}_${safeSegment(e.authorId, 40)}_${e.id}.json`;
}

/** Relative to the inventory folder. */
export function photoFileName(roomName: string | undefined, itemName: string | undefined, takenAt: string, photoId: string) {
  return `photos/${safeSegment(roomName || 'General')}/${safeSegment(itemName || 'General')}/${fileStamp(takenAt)}_${photoId}.jpg`;
}

/** Relative to the inventory folder. */
export function exportFileName(address: string, type: string, date: string, version: number) {
  return `exports/Inventory_${slugify(address, 40)}_${type}_${isoDate(date)}_v${version}.pdf`;
}

export const ENTRY_FILE_RE = /^\d{8}T\d{6,9}Z_.+_[0-9a-f-]{36}\.json$/i;

export function encodePath(path: string) {
  return path
    .split('/')
    .filter(Boolean)
    .map((s) => encodeURIComponent(s))
    .join('/');
}
