import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { addPhoto, reportIssue, updateProperty } from '../lib/actions';
import { db, getSettings, useLive } from '../lib/db';
import * as G from '../lib/graph';
import { inventoryDir } from '../lib/paths';
import { processPhoto } from '../lib/photos';
import { ISSUE_TYPES, type IssueType, type Photo } from '../lib/types';
import { formatDateTime, inventoryTypeLabel } from '../lib/util';
import { CameraView, type CameraRequest } from './Camera';
import { Button, Chip, Icon, Sheet, Thumb, inputCls, pickImages } from './ui';

export interface IssueContext {
  inventoryId?: string;
  roomId?: string;
  itemId?: string;
}

interface UI {
  openCamera: (r: CameraRequest) => void;
  openIssue: (c: IssueContext) => void;
  viewPhoto: (p: Photo) => void;
  toast: (msg: string) => void;
}

const Ctx = createContext<UI | null>(null);
export function useUI() {
  const v = useContext(Ctx);
  if (!v) throw new Error('UI context missing');
  return v;
}

export function UIProvider({ children }: { children: ReactNode }) {
  const [camera, setCamera] = useState<CameraRequest | null>(null);
  const [issue, setIssue] = useState<IssueContext | null>(null);
  const [photo, setPhoto] = useState<Photo | null>(null);
  const [toastMsg, setToast] = useState<string | null>(null);
  const toast = useCallback((m: string) => {
    setToast(m);
    setTimeout(() => setToast((cur) => (cur === m ? null : cur)), 2600);
  }, []);
  const ui = useMemo<UI>(() => ({ openCamera: setCamera, openIssue: setIssue, viewPhoto: setPhoto, toast }), [toast]);
  return (
    <Ctx.Provider value={ui}>
      {children}
      {camera && <CameraView req={camera} onClose={() => setCamera(null)} />}
      {issue && <IssueSheet ctx={issue} onClose={() => setIssue(null)} onSaved={() => toast('Issue saved')} />}
      {photo && <PhotoViewer photo={photo} onClose={() => setPhoto(null)} />}
      {toastMsg && (
        <div role="status" className="fixed z-[60] left-1/2 -translate-x-1/2 bottom-28 rounded-xl bg-slate-900 text-white dark:bg-white dark:text-slate-900 px-4 py-3 font-semibold shadow-lg">
          {toastMsg}
        </div>
      )}
    </Ctx.Provider>
  );
}

/** Floating "Report issue" button, on every screen. */
export function ReportIssueFab({ ctx }: { ctx: IssueContext }) {
  const { openIssue } = useUI();
  return (
    <button
      onClick={() => openIssue(ctx)}
      data-testid="report-issue"
      aria-label="Report issue"
      className="fixed z-30 left-3 bottom-[calc(6.25rem+env(safe-area-inset-bottom))] flex flex-col items-center justify-center rounded-full bg-red-700 text-white h-16 w-16 shadow-lg shadow-black/30 font-semibold active:bg-red-800 ring-2 ring-white dark:ring-slate-950"
    >
      <Icon name="alert" className="w-6 h-6" />
      <span className="text-[11px] leading-none mt-0.5">Issue</span>
    </button>
  );
}

// ---------- Report issue: photo (optional), issue type, optional note, Save ----------

function IssueSheet({ ctx, onClose, onSaved }: { ctx: IssueContext; onClose: () => void; onSaved: () => void }) {
  // Default to the inventory you are in; otherwise the most recently started one.
  const inventories = useLive(async () => (await db.inventories.toArray()).sort((a, b) => b.createdAt.localeCompare(a.createdAt)), [], []);
  const [invId, setInvId] = useState(ctx.inventoryId);
  useEffect(() => {
    if (!invId && inventories?.length) setInvId(inventories[0].id);
  }, [inventories, invId]);
  const [roomId, setRoomId] = useState(ctx.roomId);
  const [itemId, setItemId] = useState(ctx.itemId);
  useEffect(() => {
    if (ctx.itemId && !ctx.roomId) db.items.get(ctx.itemId).then((i) => i && setRoomId(i.roomId));
  }, [ctx.itemId, ctx.roomId]);
  const rooms = useLive(async () => (invId ? (await db.rooms.where('inventoryId').equals(invId).toArray()).filter((r) => !r.removed).sort((a, b) => a.order - b.order) : []), [invId], []);
  const items = useLive(async () => (roomId ? (await db.items.where('roomId').equals(roomId).toArray()).filter((i) => !i.removed).sort((a, b) => a.order - b.order) : []), [roomId], []);
  const properties = useLive(() => db.properties.toArray(), [], []);
  const [type, setType] = useState<IssueType>();
  const [note, setNote] = useState('');
  const [photoIds, setPhotoIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();

  const takePhoto = async (capture: boolean) => {
    if (!invId) return;
    const files = await pickImages({ capture });
    if (!files.length) return;
    setBusy(true);
    try {
      const s = await getSettings();
      for (const f of files) {
        const p = await processPhoto(f, { stamp: s.dateStamp, maxEdge: s.maxEdge, quality: s.jpegQuality, label: 'Issue · Inventory App' });
        const id = await addPhoto(invId, roomId, itemId, p, capture ? 'camera' : 'gallery');
        setPhotoIds((x) => [...x, id]);
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Photo failed');
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    if (!invId || !type) return;
    setBusy(true);
    try {
      await reportIssue(invId, type, note, photoIds, roomId, itemId);
      onSaved();
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not save');
      setBusy(false);
    }
  };

  if (inventories && !inventories.length)
    return (
      <Sheet open onClose={onClose} title="Report an issue">
        <p className="mb-4">Start an inventory first, then you can report issues against its rooms and items.</p>
        <Button kind="primary" className="w-full" onClick={onClose}>
          OK
        </Button>
      </Sheet>
    );

  const inv = inventories?.find((i) => i.id === invId);
  const prop = properties?.find((p) => p.id === inv?.propertyId);

  return (
    <Sheet open onClose={onClose} title="Report an issue">
      <div className="mb-3 text-sm text-slate-700 dark:text-slate-300">
        {!ctx.inventoryId && inventories && inventories.length > 1 && (
          <select className={inputCls + ' mb-2'} value={invId} onChange={(e) => (setInvId(e.target.value), setRoomId(undefined), setItemId(undefined))} aria-label="Inventory">
            {inventories.map((i) => (
              <option key={i.id} value={i.id}>
                {(properties?.find((p) => p.id === i.propertyId)?.address || 'Property') + ' · ' + inventoryTypeLabel(i.type)}
              </option>
            ))}
          </select>
        )}
        {prop && <p className="font-semibold">{prop.address}</p>}
        <div className="grid grid-cols-2 gap-2 mt-2">
          <select className={inputCls} value={roomId || ''} onChange={(e) => (setRoomId(e.target.value || undefined), setItemId(undefined))} aria-label="Room">
            <option value="">Whole property</option>
            {rooms?.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
          <select className={inputCls} value={itemId || ''} onChange={(e) => setItemId(e.target.value || undefined)} aria-label="Item" disabled={!roomId}>
            <option value="">Whole room</option>
            {items?.map((i) => (
              <option key={i.id} value={i.id}>
                {i.name}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="flex gap-2 mb-4 items-center flex-wrap">
        <Button onClick={() => takePhoto(true)} disabled={busy} data-testid="issue-photo">
          <Icon name="camera" /> Photo
        </Button>
        <Button kind="ghost" onClick={() => takePhoto(false)} disabled={busy}>
          Gallery
        </Button>
        {photoIds.map((id) => (
          <Thumb key={id} photoId={id} className="h-12 w-12 rounded-lg" />
        ))}
        {busy && <span className="text-sm">Saving photo…</span>}
      </div>

      <p className="font-semibold mb-2" id="issue-type-label">
        What's wrong?
      </p>
      <div className="grid grid-cols-2 gap-2 mb-4" role="group" aria-labelledby="issue-type-label">
        {ISSUE_TYPES.map((t) => (
          <Chip key={t} selected={type === t} onClick={() => setType(t)} tone="red">
            {t}
          </Chip>
        ))}
      </div>

      <label className="block mb-4">
        <span className="block font-semibold mb-1">Note (optional)</span>
        <textarea
          className={inputCls + ' min-h-20'}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Type, or tap the microphone on your keyboard to dictate"
        />
      </label>
      {err && <p className="text-red-700 mb-2">{err}</p>}
      <Button kind="primary" className="w-full text-lg" disabled={!type || busy || !invId} onClick={save} data-testid="issue-save">
        Save issue
      </Button>
    </Sheet>
  );
}

// ---------- Photo viewer ----------

function PhotoViewer({ photo, onClose }: { photo: Photo; onClose: () => void }) {
  const [url, setUrl] = useState<string>();
  const [note, setNote] = useState('');
  const author = useLive(() => db.participants.get(photo.authorId), [photo.authorId]);
  useEffect(() => {
    let u: string | undefined;
    let alive = true;
    (async () => {
      const full = await db.blobs.get(`${photo.id}:full`);
      let blob = full?.blob;
      if (!blob && navigator.onLine) {
        const p = await db.properties.get(photo.propertyId);
        const inv = await db.inventories.get(photo.inventoryId);
        if (p?.driveId && p.folderId && inv) {
          setNote('Loading full size from OneDrive…');
          blob =
            (await G.downloadByPath({ kind: 'folder', driveId: p.driveId, folderId: p.folderId }, `${inventoryDir(inv)}/${photo.fileName}`).catch(() => null)) ||
            undefined;
          setNote('');
        }
      }
      if (!blob) blob = (await db.blobs.get(`${photo.id}:thumb`))?.blob;
      if (blob && alive) setUrl((u = URL.createObjectURL(blob)));
    })();
    return () => {
      alive = false;
      if (u) URL.revokeObjectURL(u);
    };
  }, [photo]);
  const useAsCover = async () => {
    await updateProperty(photo.propertyId, { coverPhotoId: photo.id });
    onClose();
  };
  return (
    <div className="fixed inset-0 z-50 bg-black text-white flex flex-col" role="dialog" aria-modal="true" aria-label="Photo">
      <div className="flex justify-between items-center px-3 pt-[max(0.5rem,env(safe-area-inset-top))] pb-2">
        <span className="font-semibold">{formatDateTime(photo.takenAt)}</span>
        <button className="tap rounded-full p-2" onClick={onClose} aria-label="Close">
          <Icon name="x" />
        </button>
      </div>
      <div className="flex-1 min-h-0 flex items-center justify-center">
        {url ? <img src={url} alt="Inventory photo" className="max-h-full max-w-full object-contain" /> : <p>{note || 'Loading…'}</p>}
      </div>
      <div className="px-4 py-3 text-sm space-y-1 pb-[max(1rem,env(safe-area-inset-bottom))]">
        <p>
          {photo.source === 'gallery' ? 'From gallery' : 'Taken in app'} · by {author?.name || 'unknown'} · {photo.width}×{photo.height} ·{' '}
          {(photo.byteSize / 1024 / 1024).toFixed(2)} MB
        </p>
        <p>App time: {formatDateTime(photo.takenAt)}</p>
        {photo.exifTakenAt && <p>Camera time: {photo.exifTakenAt.replace('T', ' ')}</p>}
        <p>OneDrive: {photo.uploadStatus === 'uploaded' ? `saved ${formatDateTime(photo.remoteCreatedAt)}` : 'waiting to upload'}</p>
        <p className="break-all text-white/70">SHA-256 {photo.sha256}</p>
        <Button className="mt-2" onClick={useAsCover}>
          Use as property cover photo
        </Button>
      </div>
    </div>
  );
}
