import { useEffect, useRef, useState } from 'react';
import { addPhoto, setRating } from '../lib/actions';
import { db, getSettings, useLive } from '../lib/db';
import { processPhoto } from '../lib/photos';
import { deriveStates } from '../lib/state';
import { CONDITIONS, type Condition, type Item, type PhotoSource, type RatingPayload } from '../lib/types';
import { classNames, inventoryTypeLabel } from '../lib/util';
import { Icon, Thumb, pickImages } from './ui';

export interface CameraRequest {
  inventoryId: string;
  /** burst: keep shooting for one room/item. walk: step through items one by one. */
  mode: 'burst' | 'walk';
  roomId?: string;
  itemId?: string;
  itemIds?: string[];
  startIndex?: number;
}

/** Process and file photos in order, in the background, so the shutter never waits. */
function usePhotoQueue(inventoryId: string) {
  const chain = useRef<Promise<void>>(Promise.resolve());
  const [busy, setBusy] = useState(0);
  const [error, setError] = useState<string>();
  const enqueue = (blob: Blob, roomId: string | undefined, itemId: string | undefined, source: PhotoSource, takenAt?: string) => {
    setBusy((b) => b + 1);
    chain.current = chain.current.then(async () => {
      try {
        const s = await getSettings();
        const inv = await db.inventories.get(inventoryId);
        const p = await processPhoto(blob, {
          stamp: s.dateStamp,
          maxEdge: s.maxEdge,
          quality: s.jpegQuality,
          label: inv ? `${inventoryTypeLabel(inv.type)} · Inventory App` : 'Inventory App',
          takenAt,
        });
        await addPhoto(inventoryId, roomId, itemId, p, source);
      } catch (e) {
        console.error(e);
        setError(e instanceof Error ? e.message : 'Photo could not be saved');
      } finally {
        setBusy((b) => b - 1);
      }
    });
  };
  const drain = () => chain.current;
  return { enqueue, busy, error, drain };
}

export function CameraView({ req, onClose }: { req: CameraRequest; onClose: () => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [ready, setReady] = useState(false);
  const [camError, setCamError] = useState<string>();
  const [count, setCount] = useState(0);
  const [flash, setFlash] = useState(false);
  const [index, setIndex] = useState(req.startIndex || 0);
  const q = usePhotoQueue(req.inventoryId);

  const walkItems = useLive(async () => {
    if (req.mode !== 'walk' || !req.itemIds) return [] as Item[];
    const list = await db.items.bulkGet(req.itemIds);
    return list.filter(Boolean) as Item[];
  }, [req.mode, req.itemIds?.join(',')], [] as Item[]);

  const item: Item | undefined = useLive(
    async () => (req.mode === 'walk' ? walkItems?.[index] : req.itemId ? db.items.get(req.itemId) : undefined),
    [req.mode, req.itemId, index, walkItems],
  );
  const roomId = req.mode === 'walk' ? item?.roomId : req.roomId || item?.roomId;
  const room = useLive(async () => (roomId ? db.rooms.get(roomId) : undefined), [roomId]);
  const photos = useLive(
    async () => {
      if (item) return db.photos.where('itemId').equals(item.id).toArray();
      if (roomId) return (await db.photos.where('roomId').equals(roomId).toArray()).filter((p) => !p.itemId);
      return [];
    },
    [item?.id, roomId],
    [],
  );
  const rating = useLive(
    async () => {
      if (!item) return {} as RatingPayload;
      const entries = await db.entries.where('itemId').equals(item.id).toArray();
      return deriveStates(entries, []).get(item.id)?.rating || {};
    },
    [item?.id],
    {} as RatingPayload,
  );

  useEffect(() => {
    let stream: MediaStream | null = null;
    let cancelled = false;
    (async () => {
      try {
        if (!navigator.mediaDevices?.getUserMedia) throw new Error('This browser has no in-app camera.');
        stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: { facingMode: { ideal: 'environment' }, width: { ideal: 3840 }, height: { ideal: 2160 } },
        });
        if (cancelled) return stream.getTracks().forEach((t) => t.stop());
        const v = videoRef.current!;
        v.srcObject = stream;
        await v.play().catch(() => undefined);
        setReady(true);
      } catch (e) {
        setCamError(e instanceof Error ? e.message : 'Camera not available');
      }
    })();
    return () => {
      cancelled = true;
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  const target = () => ({ roomId: roomId, itemId: item?.id });

  const shoot = () => {
    const v = videoRef.current;
    if (!v || !ready || !v.videoWidth) return;
    const c = document.createElement('canvas');
    c.width = v.videoWidth;
    c.height = v.videoHeight;
    c.getContext('2d')!.drawImage(v, 0, 0);
    const takenAt = new Date().toISOString();
    const { roomId: r, itemId: i } = target();
    c.toBlob((b) => b && q.enqueue(b, r, i, 'camera', takenAt), 'image/jpeg', 0.92);
    setCount((n) => n + 1);
    setFlash(true);
    setTimeout(() => setFlash(false), 120);
    navigator.vibrate?.(15);
  };

  const systemCamera = async (capture: boolean) => {
    const files = await pickImages({ capture, multiple: !capture });
    const { roomId: r, itemId: i } = target();
    for (const f of files) q.enqueue(f, r, i, capture ? 'camera' : 'gallery');
    setCount((n) => n + files.length);
  };

  const close = async () => {
    await q.drain();
    onClose();
  };

  const total = walkItems?.length || 0;
  const rate = async (c: Condition) => {
    if (item) await setRating(req.inventoryId, item, { condition: c });
  };

  return (
    <div className="fixed inset-0 z-50 bg-black text-white flex flex-col" role="dialog" aria-modal="true" aria-label="Camera">
      <div className="flex items-center gap-2 px-3 pt-[max(0.5rem,env(safe-area-inset-top))] pb-2">
        <button className="tap rounded-xl px-3 bg-white/15 font-semibold" onClick={close} data-testid="camera-done">
          Done
        </button>
        <div className="flex-1 min-w-0 text-center">
          <div className="text-xs text-white/70 truncate">
            {room?.name || 'General'}
            {req.mode === 'walk' && total ? ` · item ${Math.min(index + 1, total)} of ${total}` : ''}
          </div>
          <div className="font-semibold truncate" data-testid="camera-item">
            {item?.name || (room ? 'Room photos' : 'Photos')}
          </div>
        </div>
        <div className="rounded-xl bg-white/15 px-3 py-2 text-sm font-semibold min-w-16 text-center" aria-live="polite" data-testid="burst-count">
          {count} {count === 1 ? 'photo' : 'photos'}
        </div>
      </div>

      <div className="relative flex-1 min-h-0 bg-black">
        <video ref={videoRef} playsInline muted autoPlay className="absolute inset-0 h-full w-full object-contain" />
        {flash && <div className="absolute inset-0 bg-white/70" />}
        {!ready && !camError && <p className="absolute inset-0 flex items-center justify-center text-white/80">Starting camera…</p>}
        {camError && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-6 text-center">
            <p className="text-white/90">The in-app camera isn't available ({camError}).</p>
            <button className="tap rounded-xl bg-blue-600 px-5 font-semibold" onClick={() => systemCamera(true)} data-testid="system-camera">
              Use the phone's camera
            </button>
          </div>
        )}
        <p className="absolute top-2 inset-x-0 text-center text-xs text-white/75 px-4">Tip: keep people and personal belongings out of shot.</p>
        {(q.busy > 0 || q.error) && (
          <p className="absolute bottom-2 inset-x-0 text-center text-sm">
            {q.error ? <span className="bg-red-700 px-2 py-1 rounded">{q.error}</span> : <span className="bg-black/60 px-2 py-1 rounded">Saving {q.busy}…</span>}
          </p>
        )}
      </div>

      <div className="flex gap-2 overflow-x-auto px-3 py-2 min-h-16" data-testid="camera-strip" aria-label="Photos of this item">
        {(photos || []).slice(-12).map((p) => (
          <Thumb key={p.id} photoId={p.id} className="h-14 w-14 rounded-lg shrink-0" />
        ))}
      </div>

      {req.mode === 'walk' && item && item.category === 'general' && (
        <div className="grid grid-cols-3 gap-2 px-3 pb-2" role="group" aria-label="Condition">
          {CONDITIONS.map((c) => (
            <button
              key={c}
              aria-pressed={rating?.condition === c}
              onClick={() => rate(c)}
              className={classNames(
                'tap rounded-xl border-2 font-semibold text-sm',
                rating?.condition === c ? 'bg-white text-black border-white' : 'border-white/40 text-white',
              )}
            >
              {rating?.condition === c ? '✓ ' : ''}
              {c}
            </button>
          ))}
        </div>
      )}

      <div className="flex items-center justify-between gap-3 px-4 pt-1 pb-[max(1rem,env(safe-area-inset-bottom))]">
        {req.mode === 'walk' ? (
          <button
            className="tap rounded-xl px-4 bg-white/15 font-semibold disabled:opacity-40"
            disabled={index === 0}
            onClick={() => setIndex((i) => Math.max(0, i - 1))}
          >
            Back
          </button>
        ) : (
          <button className="tap rounded-xl px-4 bg-white/15 font-semibold" onClick={() => systemCamera(false)} aria-label="Add from gallery">
            Gallery
          </button>
        )}
        <button
          onClick={shoot}
          disabled={!ready}
          aria-label="Take photo"
          data-testid="shutter"
          className="h-20 w-20 rounded-full border-4 border-white bg-white/90 active:scale-95 disabled:opacity-40 shrink-0"
        />
        {req.mode === 'walk' ? (
          <button
            className="tap rounded-xl px-4 bg-blue-600 font-semibold"
            data-testid="next-item"
            onClick={() => (index + 1 < total ? setIndex(index + 1) : close())}
          >
            {index + 1 < total ? 'Next item' : 'Finish'}
            <Icon name="next" className="w-5 h-5" />
          </button>
        ) : (
          <button className="tap rounded-xl px-4 bg-white/15 font-semibold" onClick={close}>
            Done
          </button>
        )}
      </div>
    </div>
  );
}
