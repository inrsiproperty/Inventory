// Data model, as defined in the spec's "Data model" section.
// Fields that start with "_" or are listed in LOCAL_FIELDS are local sync bookkeeping
// and are never written to OneDrive.

export type Role = 'landlord' | 'tenant';
export type PropertyType = 'flat' | 'house';
export type Furnishing = 'furnished' | 'part' | 'unfurnished';
export type InventoryType = 'check-in' | 'mid-term' | 'check-out';
export type InventoryStatus = 'draft' | 'in-review' | 'signed' | 'locked';
export type ItemCategory = 'general' | 'meter' | 'key' | 'safety' | 'document';
export type Condition = 'New' | 'Good' | 'Fair' | 'Poor' | 'Damaged' | 'Missing';
export type Cleanliness = 'Professionally clean' | 'Clean' | 'Needs cleaning';
export type PhotoSource = 'camera' | 'gallery';
export type UploadStatus = 'pending' | 'uploaded' | 'failed';
export type IssueType =
  | 'Broken'
  | 'Stained'
  | 'Scratched or chipped'
  | 'Missing'
  | 'Not working'
  | 'Damp or mould'
  | 'Other';
export type IssueStatus = 'open' | 'acknowledged' | 'fixed';
export type EntryType =
  | 'rating'
  | 'note'
  | 'photo'
  | 'issue'
  | 'agree'
  | 'dispute'
  | 'reply'
  | 'fixed'
  | 'signature'
  | 'structure-change'
  | 'hide';

export const CONDITIONS: Condition[] = ['New', 'Good', 'Fair', 'Poor', 'Damaged', 'Missing'];
export const CLEANLINESS: Cleanliness[] = ['Professionally clean', 'Clean', 'Needs cleaning'];
export const ISSUE_TYPES: IssueType[] = [
  'Broken',
  'Stained',
  'Scratched or chipped',
  'Missing',
  'Not working',
  'Damp or mould',
  'Other',
];

/** Local-only sync bookkeeping. */
export interface SyncMeta {
  attempts: number;
  nextTryAt: number;
  lastError?: string;
  eTag?: string;
  uploadUrl?: string; // resumable Graph upload session
}

export interface Property {
  id: string;
  address: string;
  postcode: string;
  type: PropertyType;
  bedrooms: number;
  furnishing: Furnishing;
  coverPhotoId?: string;
  createdAt: string;
  landlordId?: string; // Graph /me id of the landlord who owns the folder
  landlordName?: string;
  landlordEmail?: string;
  // local
  role?: Role; // this user's role for this property (default landlord)
  accessRevoked?: boolean; // tenant: the landlord removed access
  landlordDriveUserId?: string; // OneDrive "createdBy" id of the landlord, to verify authorship
  folderName: string; // {address-slug}_{propertyId}
  driveId?: string;
  folderId?: string;
  deltaLink?: string;
  dirty: 0 | 1;
  sync?: SyncMeta;
}

export interface TenantRef {
  name: string;
  email: string;
  msAccountId?: string;
  invitedAt?: string;
  permissionIds?: string[];
  removedAt?: string;
}

export interface Tenancy {
  id: string;
  propertyId: string;
  tenants: TenantRef[];
  startDate: string;
  endDate?: string;
  depositRef?: string;
  status: 'active' | 'ended';
  createdAt: string;
  dirty: 0 | 1;
  sync?: SyncMeta;
}

export interface Inventory {
  id: string;
  tenancyId: string;
  propertyId: string;
  type: InventoryType;
  basedOnInventoryId?: string;
  status: InventoryStatus;
  version: number;
  lockedAt?: string;
  reviewDeadline?: string;
  sentAt?: string;
  lockReason?: 'all-signed' | 'issued-not-signed-by-tenant';
  contentHash?: string; // SHA-256 of the signed content, printed on the PDF
  createdAt: string;
  folderName: string; // {type}_{date}_{inventoryId}
  dirty: 0 | 1;
  sync?: SyncMeta;
}

export interface Room {
  id: string;
  inventoryId: string;
  name: string;
  order: number;
  templateKey: string;
  removed?: boolean;
}

export interface Item {
  id: string;
  roomId: string;
  inventoryId: string;
  name: string;
  description: string;
  quantity: number;
  order: number;
  category: ItemCategory;
  removed?: boolean;
}

export interface Entry {
  id: string;
  inventoryId: string;
  propertyId: string;
  roomId?: string;
  itemId?: string;
  authorId: string;
  authorRole: Role;
  authorName?: string;
  createdAt: string; // device time, ISO
  type: EntryType;
  payload: EntryPayload;
  postSign?: boolean; // added after the inventory was locked; shown separately
  // local
  authorVerified?: boolean; // false if OneDrive says someone else created the file
  dirty: 0 | 1;
  sync?: SyncMeta;
}

export interface RatingPayload {
  condition?: Condition;
  cleanliness?: Cleanliness;
  reading?: string; // meters
  unit?: string; // meters
  count?: number; // keys
  tested?: boolean; // safety
  handedOver?: boolean; // documents
}
export interface NotePayload {
  text: string;
}
export interface PhotoPayload {
  photo: PhotoMeta;
}
export interface IssuePayload {
  issueType: IssueType;
  note: string;
  photoIds: string[];
  status: IssueStatus;
}
export interface ReviewPayload {
  reason?: string; // dispute only
  photoIds?: string[];
}
export interface ReplyPayload {
  text: string;
  replyTo?: string; // entry id
}
export interface HidePayload {
  entryId: string;
}
export interface SignaturePayload {
  signerId: string;
  role: Role;
  typedName: string;
  email: string;
  imageFile: string; // relative to the inventory folder
  fileId: string;
  signedAt: string;
  inventoryVersion: number;
  contentHash: string;
  reviewed: boolean;
}

export type StructureOp =
  | { op: 'create-from-template'; rooms: Room[]; items: Item[] }
  | { op: 'add-room'; room: Room }
  | { op: 'update-room'; roomId: string; changes: Partial<Pick<Room, 'name' | 'order'>> }
  | { op: 'remove-room'; roomId: string }
  | { op: 'add-item'; item: Item }
  | {
      op: 'update-item';
      itemId: string;
      changes: Partial<Pick<Item, 'name' | 'description' | 'quantity' | 'order'>>;
    }
  | { op: 'remove-item'; itemId: string };

export type EntryPayload =
  | RatingPayload
  | ReviewPayload
  | ReplyPayload
  | HidePayload
  | SignaturePayload
  | NotePayload
  | PhotoPayload
  | IssuePayload
  | StructureOp
  | Record<string, unknown>;

/** Photo metadata as stored in OneDrive (inside the photo entry). */
export interface PhotoMeta {
  id: string;
  entryId: string;
  fileName: string; // path relative to the inventory folder, e.g. photos/Kitchen/Oven/2026..._id.jpg
  width: number;
  height: number;
  takenAt: string; // app time at capture
  exifTakenAt?: string; // camera time from EXIF, if any
  source: PhotoSource;
  sha256: string;
  byteSize: number;
  stamped: boolean;
}

export interface Photo extends PhotoMeta {
  inventoryId: string;
  propertyId: string;
  roomId?: string;
  itemId?: string;
  authorId: string;
  uploadStatus: UploadStatus;
  remoteCreatedAt?: string; // OneDrive's created time
  hasFull: 0 | 1; // full-size blob still on the phone
  hasThumb: 0 | 1;
  sync?: SyncMeta;
}

export interface BlobRecord {
  key: string; // `${id}:full` | `${id}:thumb` | `${exportId}:pdf`
  blob: Blob;
}

/** Non-photo files that belong to entries (signature images). */
export interface FileRecord {
  id: string;
  entryId: string;
  inventoryId: string;
  propertyId: string;
  relPath: string; // relative to the inventory folder
  contentType: string;
  uploadStatus: UploadStatus;
  hasBlob: 0 | 1;
  sync?: SyncMeta;
}

export interface Participant {
  id: string; // Microsoft account id
  name: string;
  email: string;
  role: Role;
  msAccountId: string;
}

export interface ExportRecord {
  id: string;
  inventoryId: string;
  propertyId: string;
  fileName: string; // relative to the inventory folder: exports/Inventory_...pdf
  version: number;
  createdAt: string;
  byteSize: number;
  uploadStatus: UploadStatus;
  remoteUrl?: string;
  sync?: SyncMeta;
}

export interface RoomTemplate {
  key: string;
  name: string;
  items: string[]; // "*" suffix = only for furnished / part-furnished
  category?: ItemCategory;
  special?: boolean; // always included (meters, keys, safety, documents)
}

export interface AppSettings {
  key: 'app';
  dateStamp: boolean;
  maxEdge: number;
  jpegQuality: number;
  templates: RoomTemplate[];
  updatedAt: string;
  dirty: 0 | 1;
  sync?: SyncMeta;
}

export interface KV {
  key: string;
  value: unknown;
}

export interface RemoteFile {
  id: string; // drive item id
  eTag: string;
  name: string;
  propertyId: string;
}
