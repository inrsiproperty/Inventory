import { GRAPH_BASE } from './config';
import { getToken } from './auth';
import { encodePath } from './paths';

// Thin Microsoft Graph client for the OneDrive endpoints the app needs.
// The phone talks to OneDrive directly; there is no app server.

export interface DriveItem {
  id: string;
  name: string;
  eTag?: string;
  size?: number;
  createdDateTime?: string;
  lastModifiedDateTime?: string;
  webUrl?: string;
  file?: { mimeType?: string };
  folder?: { childCount?: number };
  deleted?: { state?: string };
  parentReference?: { driveId?: string; id?: string; path?: string };
  createdBy?: { user?: { id?: string; email?: string; displayName?: string } };
  lastModifiedBy?: { user?: { id?: string; email?: string; displayName?: string } };
  '@microsoft.graph.downloadUrl'?: string;
}

export interface Permission {
  id: string;
  roles?: string[];
  grantedToV2?: { user?: { id?: string; email?: string; displayName?: string } };
  grantedToIdentitiesV2?: { user?: { id?: string; email?: string; displayName?: string } }[];
  invitation?: { email?: string };
  link?: { webUrl?: string };
}

/** Where to write: either a path from the drive root of /me/drive, or a folder item in any drive. */
export type DriveTarget = { kind: 'me-root' } | { kind: 'folder'; driveId: string; folderId: string };

export class AuthNeededError extends Error {
  constructor() {
    super('Sign in to sync');
  }
}
export class OfflineError extends Error {
  constructor() {
    super('No connection');
  }
}
export class GraphError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public retryAfterMs?: number,
  ) {
    super(message);
  }
}

const SIMPLE_UPLOAD_LIMIT = 4 * 1024 * 1024; // 4 MB per spec
const CHUNK = 320 * 1024 * 10; // 3.125 MiB, a multiple of 320 KiB as Graph requires

async function call(url: string, init: RequestInit = {}, auth = true): Promise<Response> {
  const headers = new Headers(init.headers);
  if (auth) {
    const token = await getToken();
    if (!token) throw new AuthNeededError();
    headers.set('Authorization', `Bearer ${token}`);
  }
  let res: Response;
  try {
    res = await fetch(url.startsWith('http') ? url : GRAPH_BASE + url, { ...init, headers });
  } catch {
    throw new OfflineError();
  }
  if (res.ok) return res;
  let code = String(res.status);
  let message = res.statusText;
  try {
    const j = await res.json();
    code = j?.error?.code || code;
    message = j?.error?.message || message;
  } catch {
    /* not json */
  }
  if (res.status === 401) throw new AuthNeededError();
  const ra = res.headers.get('Retry-After');
  throw new GraphError(res.status, code, message, ra ? Number(ra) * 1000 : undefined);
}

function itemPathUrl(target: DriveTarget, relPath: string, suffix = '') {
  const p = encodePath(relPath);
  if (target.kind === 'me-root') return `/me/drive/root:/${p}:${suffix}`;
  return `/drives/${target.driveId}/items/${target.folderId}:/${p}:${suffix}`;
}

export async function getMe(): Promise<{ id: string; displayName: string; mail?: string; userPrincipalName?: string }> {
  const r = await call('/me?$select=id,displayName,mail,userPrincipalName');
  return r.json();
}

export interface UploadOptions {
  contentType?: string;
  /** replace (default), fail (write-once files: a 409 means it is already there), or an eTag for If-Match */
  conflict?: 'replace' | 'fail';
  ifMatch?: string;
  /** called with the upload session URL so an interrupted upload can resume later */
  onSession?: (url: string) => void | Promise<void>;
  resumeUrl?: string;
}

/** Upload a file. Small files use a simple PUT; files over 4 MB use a resumable upload session. */
export async function upload(target: DriveTarget, relPath: string, body: Blob | string, opts: UploadOptions = {}): Promise<DriveItem> {
  const blob = typeof body === 'string' ? new Blob([body], { type: opts.contentType || 'application/json' }) : body;
  if (blob.size <= SIMPLE_UPLOAD_LIMIT) {
    const q = `?@microsoft.graph.conflictBehavior=${opts.conflict || 'replace'}`;
    const headers: Record<string, string> = { 'Content-Type': opts.contentType || blob.type || 'application/octet-stream' };
    if (opts.ifMatch) headers['If-Match'] = opts.ifMatch;
    const r = await call(itemPathUrl(target, relPath, '/content') + q, { method: 'PUT', body: blob, headers });
    return r.json();
  }
  return uploadLarge(target, relPath, blob, opts);
}

async function uploadLarge(target: DriveTarget, relPath: string, blob: Blob, opts: UploadOptions): Promise<DriveItem> {
  let url = opts.resumeUrl;
  let start = 0;
  if (url) {
    // Resume: ask the session which bytes it still needs.
    try {
      const st = await call(url, {}, false).then((r) => r.json());
      const next: string | undefined = st?.nextExpectedRanges?.[0];
      start = next ? Number(next.split('-')[0]) : 0;
    } catch {
      url = undefined; // session expired; start again
    }
  }
  if (!url) {
    const r = await call(itemPathUrl(target, relPath, '/createUploadSession'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ item: { '@microsoft.graph.conflictBehavior': opts.conflict || 'replace' } }),
    });
    url = (await r.json()).uploadUrl as string;
    await opts.onSession?.(url);
    start = 0;
  }
  while (start < blob.size) {
    const end = Math.min(start + CHUNK, blob.size);
    // The upload URL is pre-authorised: no Authorization header is sent.
    const r = await call(
      url,
      {
        method: 'PUT',
        body: blob.slice(start, end),
        headers: { 'Content-Range': `bytes ${start}-${end - 1}/${blob.size}` },
      },
      false,
    );
    if (r.status === 200 || r.status === 201) return r.json();
    const j = await r.json();
    const next: string | undefined = j?.nextExpectedRanges?.[0];
    start = next ? Number(next.split('-')[0]) : end;
  }
  throw new Error('Upload session ended without a file');
}

export async function getItem(target: DriveTarget, relPath: string): Promise<DriveItem | null> {
  try {
    const r = await call(itemPathUrl(target, relPath));
    return r.json();
  } catch (e) {
    if (e instanceof GraphError && e.status === 404) return null;
    throw e;
  }
}

export async function listChildren(target: DriveTarget, relPath: string): Promise<DriveItem[]> {
  const out: DriveItem[] = [];
  let next: string | undefined = itemPathUrl(target, relPath, '/children') + '?$top=200';
  try {
    while (next) {
      const j: { value: DriveItem[]; '@odata.nextLink'?: string } = await call(next).then((r) => r.json());
      out.push(...j.value);
      next = j['@odata.nextLink'];
    }
  } catch (e) {
    if (e instanceof GraphError && e.status === 404) return [];
    throw e;
  }
  return out;
}

/** Delta query on a property folder: only what changed since the last sync. */
export async function delta(driveId: string, folderId: string, deltaLink?: string): Promise<{ items: DriveItem[]; deltaLink: string }> {
  const items: DriveItem[] = [];
  let next: string | undefined = deltaLink || `/drives/${driveId}/items/${folderId}/delta`;
  let finalLink = '';
  while (next) {
    const j: { value: DriveItem[]; '@odata.nextLink'?: string; '@odata.deltaLink'?: string } = await call(next).then((r) => r.json());
    items.push(...j.value);
    next = j['@odata.nextLink'];
    if (j['@odata.deltaLink']) finalLink = j['@odata.deltaLink'];
  }
  return { items, deltaLink: finalLink };
}

/** Download a file's bytes. Uses the pre-authenticated download URL (the /content redirect is blocked by CORS in browsers). */
export async function downloadById(driveId: string, itemId: string, knownUrl?: string): Promise<Blob> {
  if (knownUrl) {
    try {
      return await call(knownUrl, {}, false).then((r) => r.blob());
    } catch (e) {
      if (e instanceof OfflineError) throw e; // otherwise the short-lived URL expired: fetch a fresh one
    }
  }
  const meta: DriveItem = await call(`/drives/${driveId}/items/${itemId}`).then((r) => r.json());
  const url = meta['@microsoft.graph.downloadUrl'];
  if (!url) throw new Error('No download URL for ' + meta.name);
  return call(url, {}, false).then((r) => r.blob());
}

export async function downloadByPath(target: DriveTarget, relPath: string): Promise<Blob | null> {
  const meta = await getItem(target, relPath);
  const url = meta?.['@microsoft.graph.downloadUrl'];
  if (!url) return null;
  return call(url, {}, false).then((r) => r.blob());
}

export async function getItemById(driveId: string, itemId: string): Promise<DriveItem> {
  return call(`/drives/${driveId}/items/${itemId}`).then((r) => r.json());
}

export async function listChildrenById(driveId: string, itemId: string): Promise<DriveItem[]> {
  const out: DriveItem[] = [];
  let next: string | undefined = `/drives/${driveId}/items/${itemId}/children?$top=200`;
  while (next) {
    const j: { value: DriveItem[]; '@odata.nextLink'?: string } = await call(next).then((r) => r.json());
    out.push(...j.value);
    next = j['@odata.nextLink'];
  }
  return out;
}

/** Share a folder with people by email (write access, sign-in required). Returns the new permissions. */
export async function invite(driveId: string, itemId: string, emails: string[], message: string): Promise<Permission[]> {
  const r = await call(`/drives/${driveId}/items/${itemId}/invite`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      recipients: emails.map((email) => ({ email })),
      message: message.slice(0, 2000),
      requireSignIn: true,
      sendInvitation: true,
      roles: ['write'],
    }),
  });
  return (await r.json()).value || [];
}

export async function listPermissions(driveId: string, itemId: string): Promise<Permission[]> {
  const r = await call(`/drives/${driveId}/items/${itemId}/permissions`);
  return (await r.json()).value || [];
}

export async function deletePermission(driveId: string, itemId: string, permissionId: string): Promise<void> {
  try {
    await call(`/drives/${driveId}/items/${itemId}/permissions/${permissionId}`, { method: 'DELETE' });
  } catch (e) {
    if (e instanceof GraphError && e.status === 404) return; // already gone
    throw e;
  }
}

export function permissionEmails(p: Permission): string[] {
  const out = [p.grantedToV2?.user?.email, p.invitation?.email, ...(p.grantedToIdentitiesV2 || []).map((g) => g.user?.email)];
  return out.filter((x): x is string => !!x).map((x) => x.toLowerCase());
}
