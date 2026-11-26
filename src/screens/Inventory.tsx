import { useEffect, useState } from 'react';
import { useUI } from '../components/Overlays';
import { SyncBadge } from '../components/SyncBadge';
import { Button, Card, Chip, Empty, Field, Header, Icon, Progress, Screen, SectionTitle, Sheet, Thumb, inputCls, pickImages } from '../components/ui';
import {
  addItem,
  addNote,
  addPhoto,
  addReply,
  addRoom,
  agreeItem,
  disputeItem,
  hideEntry,
  moveItem,
  removeItem,
  removeRoom,
  renameRoom,
  setRating,
  updateItem,
} from '../lib/actions';
import { db, getSettings, useLive } from '../lib/db';
import { createExport } from '../lib/pdf';
import { processPhoto } from '../lib/photos';
import { go } from '../lib/router';
import { disputeStatus, isRated, ratingSummary, useInventory, type InventoryData, type ItemState } from '../lib/state';
import {
  CLEANLINESS,
  CONDITIONS,
  type Entry,
  type IssuePayload,
  type Item,
  type NotePayload,
  type PhotoPayload,
  type RatingPayload,
  type ReplyPayload,
  type ReviewPayload,
  type SignaturePayload,
  type StructureOp,
} from '../lib/types';
import { classNames, formatDate, formatDateTime, inventoryTypeLabel, plural } from '../lib/util';
import { statusLabel } from './Properties';

const SPECIAL = new Set(['meters', 'keys', 'safety', 'documents']);

function walkItems(data: InventoryData, roomId?: string) {
  const rooms = data.rooms.filter((r) => !SPECIAL.has(r.templateKey) && (!roomId || r.id === roomId));
  return rooms.flatMap((r) => data.items.filter((i) => i.roomId === r.id && i.category === 'general'));
}

function myReview(data: InventoryData, itemId: string): Entry | undefined {
  return data.me ? data.states.get(itemId)?.reviews.get(data.me.id) : undefined;
}

function firstUnreviewed(data: InventoryData): Item | undefined {
  return data.items.find((i) => !myReview(data, i.id)) || data.items[0];
}

// ---------- Inventory overview ----------

export function InventoryScreen({ id }: { id: string }) {
  const data = useInventory(id);
  const { openCamera } = useUI();
  const [addingRoom, setAddingRoom] = useState(false);
  const [postSign, setPostSign] = useState(false);
  if (data === undefined) return null;
  if (!data) return <Header title="Inventory not found" back="/" />;
  const landlord = data.role === 'landlord';
  const startWalk = () => {
    const list = walkItems(data);
    const first = Math.max(0, list.findIndex((i) => !isRated(i, data.states.get(i.id))));
    openCamera({ inventoryId: id, mode: 'walk', itemIds: list.map((i) => i.id), startIndex: first });
  };
  const roomTile = (r: InventoryData['rooms'][number]) => {
    const items = data.items.filter((i) => i.roomId === r.id);
    const rated = items.filter((i) => isRated(i, data.states.get(i.id))).length;
    const reviewed = items.filter((i) => myReview(data, i.id)).length;
    const issues = data.issues.filter((e) => e.roomId === r.id && !e.postSign).length;
    const disputes = data.disputes.filter((d) => d.entry.roomId === r.id && d.status === 'open').length;
    const photos = data.photos.filter((p) => p.roomId === r.id).length;
    const done = landlord ? rated : reviewed;
    return (
      <Card key={r.id} onClick={() => go(`/inventory/${id}/room/${r.id}`)} className="!p-3">
        <p className="font-semibold leading-tight">{r.name}</p>
        <p className="text-sm text-slate-600 dark:text-slate-400 mt-1">
          {done}/{items.length} {landlord ? 'done' : 'reviewed'}
        </p>
        <div className="h-1.5 rounded-full bg-slate-200 dark:bg-slate-800 mt-2 overflow-hidden">
          <div className="h-full bg-blue-700" style={{ width: `${items.length ? (done / items.length) * 100 : 0}%` }} />
        </div>
        <p className="text-xs mt-2 text-slate-600 dark:text-slate-400">
          {plural(photos, 'photo')}
          {issues ? <span className="text-red-700 dark:text-red-300 font-semibold"> · {plural(issues, 'issue')}</span> : null}
          {disputes ? <span className="text-red-700 dark:text-red-300 font-semibold"> · {plural(disputes, 'dispute')}</span> : null}
        </p>
      </Card>
    );
  };
  const disputesBadge = data.openDisputes;
  return (
    <>
      <Header title={`${inventoryTypeLabel(data.inventory.type)} inventory`} sub={data.property.address} back={`/property/${data.property.id}`} />
      <Screen
        bottom={
          <>
            {data.readOnly ? (
              <Button kind="primary" className="flex-1 text-lg" onClick={() => setPostSign(true)} disabled={data.property.accessRevoked} data-testid="post-sign-note">
                <Icon name="edit" /> Post-sign note
              </Button>
            ) : landlord ? (
              <Button kind="primary" className="flex-1 text-lg" onClick={startWalk} data-testid="walk-through">
                <Icon name="walk" /> Walk-through
              </Button>
            ) : (
              <Button
                kind="primary"
                className="flex-1 text-lg"
                onClick={() => {
                  const i = firstUnreviewed(data);
                  if (i) go(`/inventory/${id}/item/${i.id}`);
                }}
                data-testid="start-review"
              >
                <Icon name="check" /> Review items
              </Button>
            )}
            <Button onClick={() => go(`/inventory/${id}/issues`)} aria-label={`Issues and disputes${disputesBadge ? `, ${disputesBadge} open disputes` : ''}`} className="relative">
              <Icon name="list" /> {data.issues.length + data.disputes.length}
              {landlord && disputesBadge > 0 && (
                <span className="absolute -top-1 -right-1 min-w-5 h-5 rounded-full bg-red-700 text-white text-[11px] font-bold flex items-center justify-center px-1" data-testid="dispute-count">
                  {disputesBadge}
                </span>
              )}
            </Button>
            <Button onClick={() => go(`/inventory/${id}/export`)} aria-label="Export PDF" data-testid="export">
              <Icon name="file" /> PDF
            </Button>
          </>
        }
      >
        <SyncBadge />
        <StatusCard data={data} />
        <div className="mt-4">
          {landlord ? (
            <Progress value={data.ratedCount} total={data.itemCount} label="Items recorded" />
          ) : (
            <Progress value={data.reviewedByMe} total={data.itemCount} label="Items you've reviewed" />
          )}
          {landlord &&
            [...data.reviewed.entries()].map(([author, r]) => (
              <div key={author} className="mt-3">
                <Progress value={r.count} total={data.itemCount} label={`Reviewed by ${r.name}`} />
                <p className="text-xs text-slate-600 dark:text-slate-400 mt-1">
                  {r.agreed} agreed · {r.disputed} not right
                </p>
              </div>
            ))}
          <p className="text-sm text-slate-600 dark:text-slate-400 mt-2">
            {plural(data.photos.length, 'photo')} · {plural(data.issues.length, 'issue')} · {plural(data.disputes.length, 'dispute')}
          </p>
        </div>
        {data.postSign.length > 0 && (
          <>
            <SectionTitle>Post-sign notes</SectionTitle>
            <p className="text-sm text-slate-600 dark:text-slate-400 mb-2">Added after signing. Kept separately from the signed inventory.</p>
            <div className="space-y-2" data-testid="post-sign-list">
              {data.postSign.map((e) => (
                <ThreadEntry key={e.id} e={e} data={data} />
              ))}
            </div>
          </>
        )}
        <SectionTitle right={landlord && !data.readOnly ? <Button kind="ghost" onClick={() => setAddingRoom(true)}>+ Room</Button> : undefined}>Rooms</SectionTitle>
        <div className="grid grid-cols-2 gap-3">{data.rooms.filter((r) => !SPECIAL.has(r.templateKey)).map(roomTile)}</div>
        <SectionTitle>Meters, keys and safety</SectionTitle>
        <div className="grid grid-cols-2 gap-3">{data.rooms.filter((r) => SPECIAL.has(r.templateKey)).map(roomTile)}</div>
      </Screen>
      {addingRoom && <AddRoomSheet inventoryId={id} onClose={() => setAddingRoom(false)} />}
      {postSign && <PostSignSheet inventoryId={id} onClose={() => setPostSign(false)} />}
    </>
  );
}

/** Where the inventory is in its life: draft, with the tenant, signed and locked. */
function StatusCard({ data }: { data: InventoryData }) {
  const inv = data.inventory;
  const landlord = data.role === 'landlord';
  const deadline = inv.reviewDeadline ? new Date(inv.reviewDeadline) : undefined;
  const daysLeft = deadline ? Math.ceil((deadline.getTime() - Date.now()) / 864e5) : undefined;
  return (
    <Card className={classNames('mt-4', data.locked && '!border-green-600')}>
      <p className="font-semibold text-lg" data-testid="inventory-status">
        {data.locked ? '🔒 ' : ''}
        {statusLabel(inv, data.locked).replace(/^./, (c) => c.toUpperCase())}
      </p>
      {data.locked ? (
        <p className="text-sm mt-1">
          {inv.lockedAt ? `Locked ${formatDateTime(inv.lockedAt)} · v${inv.version}. ` : 'Signed by everyone. The landlord’s phone will lock it and save the PDF. '}
          Read-only. Anything found now goes in a post-sign note.
        </p>
      ) : inv.status === 'in-review' && deadline ? (
        <p className="text-sm mt-1">
          Review by {formatDate(inv.reviewDeadline)}
          {daysLeft !== undefined ? (daysLeft >= 0 ? ` (${plural(daysLeft, 'day')} left)` : ' (review window ended)') : ''}
        </p>
      ) : landlord ? (
        <p className="text-sm mt-1">When it's ready, send it to your tenant from the property page.</p>
      ) : null}
      {data.property.accessRevoked && <p className="text-sm mt-1 font-semibold text-amber-800 dark:text-amber-200">Your access to this property has ended.</p>}
      <ul className="mt-3 space-y-1" aria-label="Signatures">
        {data.signers.map((s) => (
          <li key={s.key} className="flex items-center gap-2 text-sm" data-testid="signer">
            <span aria-hidden="true">{s.valid ? '✅' : s.stale ? '⚠️' : '⬜'}</span>
            <span className="flex-1 min-w-0 truncate">
              {s.name} ({s.role})
            </span>
            <span className="text-slate-600 dark:text-slate-400">
              {s.valid ? `signed ${formatDate((s.signature!.payload as SignaturePayload).signedAt)}` : s.stale ? 'needs to sign again' : 'not signed'}
            </span>
          </li>
        ))}
      </ul>
      {!data.locked && !data.property.accessRevoked && (inv.status !== 'draft' || landlord) && (
        <div className="flex gap-2 mt-3">
          {landlord && inv.status === 'draft' && (
            <Button kind="primary" onClick={() => go(`/property/${data.property.id}`)}>
              <Icon name="share" /> Send to tenant
            </Button>
          )}
          {inv.status !== 'draft' && (
            <Button kind="primary" onClick={() => go(`/inventory/${inv.id}/sign`)} data-testid="review-and-sign">
              <Icon name="edit" /> {data.role === 'tenant' ? 'Review complete: sign' : 'Review and sign'}
            </Button>
          )}
        </div>
      )}
    </Card>
  );
}

function PostSignSheet({ inventoryId, onClose, roomId, itemId }: { inventoryId: string; onClose: () => void; roomId?: string; itemId?: string }) {
  const [text, setText] = useState('');
  const [err, setErr] = useState<string>();
  return (
    <Sheet open onClose={onClose} title="Post-sign note">
      <p className="text-sm mb-3 text-slate-600 dark:text-slate-400">
        The inventory is signed and can't be changed. A post-sign note is dated, shows who added it, and is kept separately from the signed content.
      </p>
      <textarea className={inputCls + ' min-h-28 mb-3'} value={text} onChange={(e) => setText(e.target.value)} placeholder="What did you find?" aria-label="Post-sign note" />
      {err && <p className="text-red-700 mb-2">{err}</p>}
      <Button
        kind="primary"
        className="w-full"
        disabled={!text.trim()}
        data-testid="save-post-sign"
        onClick={async () => {
          try {
            await addNote(inventoryId, text, roomId, itemId);
            onClose();
          } catch (e) {
            setErr(e instanceof Error ? e.message : 'Could not save');
          }
        }}
      >
        Save note
      </Button>
    </Sheet>
  );
}

function AddRoomSheet({ inventoryId, onClose }: { inventoryId: string; onClose: () => void }) {
  const [name, setName] = useState('');
  return (
    <Sheet open onClose={onClose} title="Add a room">
      <Field label="Room name">
        <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} autoFocus placeholder="e.g. Study" />
      </Field>
      <Button
        kind="primary"
        className="w-full"
        disabled={!name.trim()}
        onClick={async () => {
          const rid = await addRoom(inventoryId, name);
          onClose();
          go(`/inventory/${inventoryId}/room/${rid}`);
        }}
      >
        Add room
      </Button>
    </Sheet>
  );
}

function ReviewIcon({ e }: { e?: Entry }) {
  if (!e) return <span className="text-xs rounded-full px-2 py-0.5 bg-slate-100 dark:bg-slate-800">not reviewed</span>;
  return e.type === 'agree' ? (
    <span className="text-xs rounded-full px-2 py-0.5 bg-green-100 text-green-900 dark:bg-green-950 dark:text-green-100 font-semibold">✓ agreed</span>
  ) : (
    <span className="text-xs rounded-full px-2 py-0.5 bg-red-100 text-red-900 dark:bg-red-950 dark:text-red-100 font-semibold">✗ not right</span>
  );
}

// ---------- Room ----------

export function RoomScreen({ id, roomId }: { id: string; roomId: string }) {
  const data = useInventory(id);
  const { openCamera, viewPhoto } = useUI();
  const [edit, setEdit] = useState(false);
  const [newItem, setNewItem] = useState('');
  const [name, setName] = useState<string | null>(null);
  if (!data) return null;
  const room = data.rooms.find((r) => r.id === roomId);
  if (!room) return <Header title="Room not found" back={`/inventory/${id}`} />;
  const landlord = data.role === 'landlord';
  const canEdit = landlord && !data.readOnly;
  const items = data.items.filter((i) => i.roomId === roomId);
  const roomState = data.states.get(`room:${roomId}`);
  const rated = items.filter((i) => isRated(i, data.states.get(i.id))).length;
  const reviewedHere = items.filter((i) => myReview(data, i.id)).length;
  const special = SPECIAL.has(room.templateKey);
  return (
    <>
      <Header
        title={room.name}
        sub={landlord ? `${rated}/${items.length} done` : `${reviewedHere}/${items.length} reviewed`}
        back={`/inventory/${id}`}
        right={
          canEdit ? (
            <Button kind="ghost" onClick={() => setEdit(!edit)} aria-pressed={edit}>
              {edit ? 'Done' : 'Edit'}
            </Button>
          ) : undefined
        }
      />
      <Screen
        bottom={
          data.readOnly ? undefined : (
            <>
              {!special && landlord && (
                <Button
                  kind="primary"
                  className="flex-1 text-lg"
                  onClick={() => {
                    const list = walkItems(data, roomId);
                    const first = Math.max(0, list.findIndex((i) => !isRated(i, data.states.get(i.id))));
                    openCamera({ inventoryId: id, mode: 'walk', itemIds: list.map((i) => i.id), startIndex: first });
                  }}
                >
                  <Icon name="walk" /> Walk-through
                </Button>
              )}
              {!landlord && items.length > 0 && (
                <Button
                  kind="primary"
                  className="flex-1 text-lg"
                  onClick={() => go(`/inventory/${id}/item/${(items.find((i) => !myReview(data, i.id)) || items[0]).id}`)}
                >
                  <Icon name="check" /> Review this room
                </Button>
              )}
              <Button
                kind={special && landlord ? 'primary' : 'secondary'}
                className={special && landlord ? 'flex-1 text-lg' : ''}
                onClick={() => openCamera({ inventoryId: id, mode: 'burst', roomId })}
                aria-label="Take room photos"
                data-testid="room-camera"
              >
                <Icon name="camera" className="w-7 h-7" /> {special && landlord ? 'Room photos' : ''}
              </Button>
            </>
          )
        }
      >
        {edit && canEdit && (
          <Card className="mb-4 space-y-3">
            <Field label="Room name" group>
              <div className="flex gap-2">
                <input className={inputCls} aria-label="Room name" value={name ?? room.name} onChange={(e) => setName(e.target.value)} />
                <Button onClick={() => name && name !== room.name && renameRoom(id, roomId, name)}>Save</Button>
              </div>
            </Field>
            <div className="flex gap-2">
              <input className={inputCls} value={newItem} onChange={(e) => setNewItem(e.target.value)} placeholder="New item name" aria-label="New item name" />
              <Button
                onClick={async () => {
                  if (!newItem.trim()) return;
                  await addItem(id, roomId, newItem, categoryForTemplateKey(room.templateKey));
                  setNewItem('');
                }}
              >
                Add
              </Button>
            </div>
            <Button
              kind="danger"
              onClick={async () => {
                if (window.confirm(`Remove ${room.name} from this inventory? It stays in the history.`)) {
                  await removeRoom(id, roomId);
                  go(`/inventory/${id}`);
                }
              }}
            >
              <Icon name="trash" /> Remove room
            </Button>
          </Card>
        )}
        {roomState && roomState.photos.length > 0 && (
          <div className="flex gap-2 overflow-x-auto mb-3" aria-label="Room photos">
            {roomState.photos.map((p) => (
              <button key={p.id} onClick={() => viewPhoto(p)} className="shrink-0">
                <Thumb photoId={p.id} className="h-20 w-20 rounded-xl" />
              </button>
            ))}
          </div>
        )}
        {!items.length && <Empty>{canEdit ? 'No items in this room. Tap Edit to add some.' : 'No items in this room.'}</Empty>}
        <ul className="space-y-2">
          {items.map((item, idx) => {
            const s = data.states.get(item.id);
            const done = isRated(item, s);
            const issues = s?.issues.length || 0;
            const reviews = [...(s?.reviews.values() || [])];
            return (
              <li key={item.id} className="flex items-stretch gap-2">
                <button
                  className="flex-1 min-w-0 flex items-center gap-3 rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-3 text-left active:bg-slate-50 dark:active:bg-slate-800"
                  onClick={() => go(`/inventory/${id}/item/${item.id}`)}
                  data-testid={`item-${item.name}`}
                >
                  {s?.photos.length ? (
                    <Thumb photoId={s.photos[s.photos.length - 1].id} className="h-14 w-14 rounded-lg shrink-0" />
                  ) : (
                    <div className="h-14 w-14 rounded-lg shrink-0 border-2 border-dashed border-slate-300 dark:border-slate-700 flex items-center justify-center text-slate-400">
                      <Icon name="camera" className="w-5 h-5" />
                    </div>
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="font-semibold leading-tight">{item.name}</p>
                    <p className={done ? 'text-sm text-blue-800 dark:text-blue-300 font-semibold' : 'text-sm text-slate-500'}>
                      {done ? '✓ ' : ''}
                      {ratingSummary(item, s)}
                      {s?.photos.length ? ` · ${plural(s.photos.length, 'photo')}` : ''}
                    </p>
                    <div className="flex flex-wrap gap-1 mt-1">
                      {landlord ? reviews.map((r) => <ReviewIcon key={r.id} e={r} />) : <ReviewIcon e={myReview(data, item.id)} />}
                      {issues > 0 && <span className="text-xs text-red-700 dark:text-red-300 font-semibold">⚠ {plural(issues, 'issue')}</span>}
                    </div>
                  </div>
                </button>
                {edit && canEdit ? (
                  <div className="flex flex-col gap-1">
                    <button className="tap rounded-lg bg-slate-100 dark:bg-slate-800 px-2" aria-label={`Move ${item.name} up`} disabled={idx === 0} onClick={() => moveItem(id, item, -1)}>
                      <Icon name="up" className="w-5 h-5" />
                    </button>
                    <button
                      className="tap rounded-lg bg-slate-100 dark:bg-slate-800 px-2"
                      aria-label={`Move ${item.name} down`}
                      disabled={idx === items.length - 1}
                      onClick={() => moveItem(id, item, 1)}
                    >
                      <Icon name="down" className="w-5 h-5" />
                    </button>
                    <button className="tap rounded-lg bg-red-50 text-red-800 dark:bg-red-950 dark:text-red-200 px-2" aria-label={`Remove ${item.name}`} onClick={() => removeItem(id, item)}>
                      <Icon name="trash" className="w-5 h-5" />
                    </button>
                  </div>
                ) : !data.readOnly ? (
                  <button
                    className="tap rounded-2xl bg-blue-700 text-white px-4 flex items-center"
                    aria-label={`Take photo of ${item.name}`}
                    onClick={() => openCamera({ inventoryId: id, mode: 'burst', roomId, itemId: item.id })}
                  >
                    <Icon name="camera" className="w-7 h-7" />
                  </button>
                ) : null}
              </li>
            );
          })}
        </ul>
      </Screen>
    </>
  );
}

function categoryForTemplateKey(key: string): Item['category'] {
  return key === 'meters' ? 'meter' : key === 'keys' ? 'key' : key === 'safety' ? 'safety' : key === 'documents' ? 'document' : 'general';
}

// ---------- Item ----------

export function ItemScreen({ id, itemId }: { id: string; itemId: string }) {
  const data = useInventory(id);
  const { openCamera, viewPhoto, toast } = useUI();
  const [note, setNote] = useState('');
  const [reply, setReply] = useState('');
  const [details, setDetails] = useState(false);
  const [disputing, setDisputing] = useState(false);
  const [showHidden, setShowHidden] = useState(false);
  const [postSign, setPostSign] = useState(false);
  const [err, setErr] = useState<string>();
  if (!data) return null;
  const item = data.items.find((i) => i.id === itemId) || null;
  if (!item) return <Header title="Item not found" back={`/inventory/${id}`} />;
  const landlord = data.role === 'landlord';
  const room = data.rooms.find((r) => r.id === item.roomId);
  const s: ItemState = data.states.get(itemId) || { rating: {}, notes: [], photos: [], issues: [], disputes: [], replies: [], entries: [], reviews: new Map() };
  const siblings = data.items.filter((i) => i.roomId === item.roomId);
  const idx = siblings.findIndex((i) => i.id === itemId);
  const prev = siblings[idx - 1];
  const next = siblings[idx + 1];
  const mine = myReview(data, itemId);
  const run = async (f: () => Promise<unknown>) => {
    setErr(undefined);
    try {
      await f();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Something went wrong');
    }
  };
  const rate = (r: RatingPayload) => run(() => setRating(id, item, r));
  const hiddenHere = data.hidden.filter((e) => e.itemId === itemId);
  const postSignHere = data.postSign.filter((e) => e.itemId === itemId);
  const hasDisputes = s.disputes.length > 0;
  // A tenant's next unreviewed item, so Agree can move straight on.
  const nextUnreviewed = () => {
    const after = [...data.items.slice(data.items.findIndex((i) => i.id === itemId) + 1), ...data.items];
    return after.find((i) => i.id !== itemId && !myReview(data, i.id));
  };
  return (
    <>
      <Header title={item.name} sub={`${room?.name || ''} · item ${idx + 1} of ${siblings.length}`} back={`/inventory/${id}/room/${item.roomId}`} />
      <Screen
        bottom={
          <>
            <Button aria-label="Previous item" disabled={!prev} onClick={() => prev && go(`/inventory/${id}/item/${prev.id}`, true)}>
              <Icon name="back" />
            </Button>
            {data.readOnly ? (
              <Button kind="primary" className="flex-1 text-lg" onClick={() => setPostSign(true)} disabled={data.property.accessRevoked}>
                <Icon name="edit" /> Post-sign note
              </Button>
            ) : (
              <Button
                kind="primary"
                className="flex-1 text-lg"
                onClick={() => openCamera({ inventoryId: id, mode: 'burst', roomId: item.roomId, itemId })}
                data-testid="item-camera"
              >
                <Icon name="camera" className="w-7 h-7" /> Take photo
              </Button>
            )}
            <Button aria-label="Next item" disabled={!next} onClick={() => next && go(`/inventory/${id}/item/${next.id}`, true)}>
              <Icon name="next" />
            </Button>
          </>
        }
      >
        {data.readOnly && (
          <p className="rounded-xl bg-green-50 dark:bg-green-950 border border-green-600 p-3 text-sm mb-3" data-testid="locked-banner">
            🔒 {data.property.accessRevoked ? 'Your access has ended. This is read-only.' : 'Signed and locked. Read-only.'}
          </p>
        )}
        <div className="flex gap-2 overflow-x-auto pb-1 mb-2" data-testid="item-photos" aria-label="Photos">
          {s.photos.map((p) => (
            <button key={p.id} onClick={() => viewPhoto(p)} className="shrink-0 relative" aria-label={`Photo taken ${formatDateTime(p.takenAt)}`}>
              <Thumb photoId={p.id} className="h-24 w-24 rounded-xl" />
              {p.uploadStatus !== 'uploaded' && <span className="absolute bottom-1 right-1 rounded bg-black/70 text-white text-[10px] px-1">waiting</span>}
              {p.source === 'gallery' && <span className="absolute top-1 left-1 rounded bg-amber-400 text-black text-[10px] px-1 font-semibold">gallery</span>}
              {p.authorId !== data.property.landlordId && data.property.landlordId && (
                <span className="absolute top-1 right-1 rounded bg-blue-700 text-white text-[10px] px-1 font-semibold">tenant</span>
              )}
            </button>
          ))}
          {!s.photos.length && <p className="text-slate-600 dark:text-slate-400 py-6">No photos yet.{data.readOnly ? '' : ' Tap Take photo.'}</p>}
        </div>

        {landlord && !data.readOnly ? (
          <RatingControls item={item} rating={s.rating} onRate={rate} />
        ) : (
          <Card>
            <p className="text-sm text-slate-600 dark:text-slate-400">{landlord ? 'Rating' : "Landlord's rating"}</p>
            <p className="text-xl font-bold" data-testid="rating-readonly">
              {ratingSummary(item, s)}
            </p>
            {s.ratedAt && <p className="text-xs text-slate-600 dark:text-slate-400">Recorded {formatDateTime(s.ratedAt)}</p>}
          </Card>
        )}

        {!landlord && !data.readOnly && (
          <div className="mt-4" data-testid="review-buttons">
            <p className="font-semibold mb-2">Is this right?</p>
            <div className="grid grid-cols-2 gap-2">
              <Chip
                selected={mine?.type === 'agree'}
                tone="green"
                onClick={() =>
                  run(async () => {
                    await agreeItem(id, item);
                    const n = nextUnreviewed();
                    toast('Agreed');
                    if (n) go(`/inventory/${id}/item/${n.id}`, true);
                  })
                }
              >
                Agree
              </Chip>
              <Chip selected={mine?.type === 'dispute'} tone="red" onClick={() => setDisputing(true)}>
                Something's not right
              </Chip>
            </div>
          </div>
        )}
        {err && <p className="text-red-700 dark:text-red-300 mt-2" data-testid="item-error">{err}</p>}

        {landlord && !data.readOnly && (
          <div className="mt-4 flex items-center justify-between">
            <p className="text-sm text-slate-600 dark:text-slate-400">
              {item.description || 'No description'}
              {item.quantity > 1 ? ` · quantity ${item.quantity}` : ''}
            </p>
            <Button kind="ghost" onClick={() => setDetails(true)}>
              Edit details
            </Button>
          </div>
        )}
        {(!landlord || data.readOnly) && item.description && (
          <p className="mt-3 text-sm text-slate-600 dark:text-slate-400">
            {item.description}
            {item.quantity > 1 ? ` · quantity ${item.quantity}` : ''}
          </p>
        )}

        {!data.readOnly && (
          <>
            <SectionTitle>{hasDisputes ? 'Reply or add a note' : 'Notes'}</SectionTitle>
            {hasDisputes ? (
              <div className="flex gap-2">
                <textarea className={inputCls + ' min-h-12'} value={reply} onChange={(e) => setReply(e.target.value)} placeholder="Reply to the thread" aria-label="Reply" />
                <Button
                  onClick={() =>
                    run(async () => {
                      await addReply(id, reply, item.roomId, item.id, s.disputes[s.disputes.length - 1]?.id);
                      setReply('');
                    })
                  }
                  disabled={!reply.trim()}
                  data-testid="send-reply"
                >
                  Reply
                </Button>
              </div>
            ) : null}
            <div className="flex gap-2 mt-2">
              <textarea className={inputCls + ' min-h-12'} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Add a note (dictation works too)" aria-label="Note" />
              <Button
                onClick={() =>
                  run(async () => {
                    await addNote(id, note, item.roomId, item.id);
                    setNote('');
                  })
                }
                disabled={!note.trim()}
              >
                Add
              </Button>
            </div>
          </>
        )}

        {s.issues.length > 0 && (
          <>
            <SectionTitle>Issues</SectionTitle>
            {s.issues.map((e) => (
              <IssueRow key={e.id} e={e} />
            ))}
          </>
        )}

        <SectionTitle
          right={
            hiddenHere.length ? (
              <Button kind="ghost" onClick={() => setShowHidden(!showHidden)}>
                {showHidden ? 'Hide hidden' : `Show hidden (${hiddenHere.length})`}
              </Button>
            ) : undefined
          }
        >
          Thread
        </SectionTitle>
        <ol className="space-y-2" aria-label="Full entry thread" data-testid="thread">
          {[...s.entries].reverse().map((e) => (
            <ThreadEntry key={e.id} e={e} data={data} />
          ))}
          {showHidden &&
            hiddenHere.map((e) => (
              <li key={e.id} className="opacity-60">
                <ThreadEntry e={e} data={data} hidden />
              </li>
            ))}
          {!s.entries.length && <li className="text-sm text-slate-600 dark:text-slate-400">Nothing yet.</li>}
        </ol>
        {postSignHere.length > 0 && (
          <>
            <SectionTitle>Post-sign notes</SectionTitle>
            {postSignHere.map((e) => (
              <ThreadEntry key={e.id} e={e} data={data} />
            ))}
          </>
        )}
      </Screen>
      {details && <ItemDetailsSheet inventoryId={id} item={item} onClose={() => setDetails(false)} />}
      {disputing && <DisputeSheet inventoryId={id} item={item} onClose={() => setDisputing(false)} />}
      {postSign && <PostSignSheet inventoryId={id} roomId={item.roomId} itemId={item.id} onClose={() => setPostSign(false)} />}
    </>
  );
}

/** One entry in a thread, with author, time and (for your own) Hide. */
function ThreadEntry({ e, data, hidden }: { e: Entry; data: InventoryData; hidden?: boolean }) {
  const [busy, setBusy] = useState(false);
  const isLandlordAuthor = data.property.landlordId ? e.authorId === data.property.landlordId : e.authorRole === 'landlord';
  const mine = data.me?.id === e.authorId;
  const canHide = mine && !hidden && !['rating', 'structure-change', 'signature', 'agree'].includes(e.type) && (!data.readOnly || e.postSign) && !data.property.accessRevoked;
  const tone =
    e.type === 'dispute'
      ? 'border-l-4 border-red-700 bg-red-50 dark:bg-red-950'
      : e.type === 'agree'
        ? 'border-l-4 border-green-700 bg-green-50 dark:bg-green-950'
        : e.type === 'reply'
          ? 'border-l-4 border-blue-700 bg-blue-50 dark:bg-blue-950'
          : 'bg-slate-50 dark:bg-slate-900';
  return (
    <div className={classNames('rounded-xl p-3 text-sm', tone)} data-testid={`entry-${e.type}`}>
      <div className="flex gap-2 justify-between">
        <p className="font-semibold">
          {describeEntry(e)}
          {e.authorVerified === false && <span className="ml-1 text-red-700"> (author not verified, ignored)</span>}
          {e.authorVerified !== false && e.type === 'rating' && !isLandlordAuthor && (
            <span className="ml-1 text-red-700"> (ignored: only the landlord sets ratings)</span>
          )}
        </p>
        {canHide && (
          <button
            className="text-xs underline text-slate-600 dark:text-slate-400 shrink-0 min-h-8"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              await hideEntry(e.id).catch(() => undefined);
              setBusy(false);
            }}
            aria-label="Hide this entry (it stays in the history)"
          >
            Hide
          </button>
        )}
      </div>
      <p className="text-slate-600 dark:text-slate-400">
        {e.authorName || e.authorRole} ({isLandlordAuthor ? 'landlord' : 'tenant'}) · {formatDateTime(e.createdAt)}
        {e.postSign ? ' · post-sign' : ''}
        {hidden ? ' · hidden by author' : ''}
        {e.dirty ? ' · waiting to upload' : ''}
      </p>
    </div>
  );
}

function DisputeSheet({ inventoryId, item, onClose }: { inventoryId: string; item: Item; onClose: () => void }) {
  const [reason, setReason] = useState('');
  const [photoIds, setPhotoIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  const takePhoto = async (capture: boolean) => {
    const files = await pickImages({ capture });
    if (!files.length) return;
    setBusy(true);
    try {
      const st = await getSettings();
      for (const f of files) {
        const p = await processPhoto(f, { stamp: st.dateStamp, maxEdge: st.maxEdge, quality: st.jpegQuality, label: 'Tenant · Inventory App' });
        const pid = await addPhoto(inventoryId, item.roomId, item.id, p, capture ? 'camera' : 'gallery');
        setPhotoIds((x) => [...x, pid]);
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Photo failed');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Sheet open onClose={onClose} title="Something's not right">
      <p className="text-sm mb-3 text-slate-600 dark:text-slate-400">Tell your landlord what's different about the {item.name.toLowerCase()}. A photo helps.</p>
      <textarea
        className={inputCls + ' min-h-24 mb-3'}
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder="e.g. There's a burn mark on the left of the worktop"
        aria-label="What's not right"
      />
      <div className="flex gap-2 mb-4 items-center flex-wrap">
        <Button onClick={() => takePhoto(true)} disabled={busy} data-testid="dispute-photo">
          <Icon name="camera" /> Photo
        </Button>
        <Button kind="ghost" onClick={() => takePhoto(false)} disabled={busy}>
          Gallery
        </Button>
        {photoIds.map((pid) => (
          <Thumb key={pid} photoId={pid} className="h-12 w-12 rounded-lg" />
        ))}
        {busy && <span className="text-sm">Saving photo…</span>}
      </div>
      {err && <p className="text-red-700 mb-2">{err}</p>}
      <Button
        kind="primary"
        className="w-full text-lg"
        disabled={!reason.trim() || busy}
        data-testid="save-dispute"
        onClick={async () => {
          try {
            await disputeItem(inventoryId, item, reason, photoIds);
            onClose();
          } catch (e) {
            setErr(e instanceof Error ? e.message : 'Could not save');
          }
        }}
      >
        Send to landlord
      </Button>
    </Sheet>
  );
}

function RatingControls({ item, rating, onRate }: { item: Item; rating: RatingPayload; onRate: (r: RatingPayload) => void }) {
  const [reading, setReading] = useState(rating.reading || '');
  const [unit, setUnit] = useState(rating.unit || (item.name.toLowerCase().includes('water') ? 'm³' : item.name.toLowerCase().includes('gas') ? 'm³' : 'kWh'));
  const [count, setCount] = useState(rating.count ?? 0);
  useEffect(() => setReading(rating.reading || ''), [rating.reading]);
  useEffect(() => setCount(rating.count ?? 0), [rating.count]);
  if (item.category === 'meter')
    return (
      <Card>
        <Field label="Meter reading" hint="Take a photo of the meter too." group>
          <div className="flex gap-2">
            <input className={inputCls} aria-label="Meter reading" inputMode="decimal" value={reading} onChange={(e) => setReading(e.target.value)} placeholder="e.g. 04521.6" data-testid="meter-reading" />
            <select className={inputCls + ' !w-28'} value={unit} onChange={(e) => setUnit(e.target.value)} aria-label="Unit">
              {['kWh', 'm³', 'ft³', 'units'].map((u) => (
                <option key={u}>{u}</option>
              ))}
            </select>
          </div>
        </Field>
        <Button kind="primary" className="w-full" disabled={!reading.trim() || (reading === rating.reading && unit === rating.unit)} onClick={() => onRate({ reading: reading.trim(), unit })}>
          {rating.reading ? 'Update reading' : 'Save reading'}
        </Button>
      </Card>
    );
  if (item.category === 'key')
    return (
      <Card>
        <p className="font-semibold mb-2">How many handed over?</p>
        <div className="flex items-center gap-3">
          <Button aria-label="Fewer" onClick={() => setCount(Math.max(0, count - 1))}>
            −
          </Button>
          <span className="text-3xl font-bold w-12 text-center">{count}</span>
          <Button aria-label="More" onClick={() => setCount(count + 1)}>
            +
          </Button>
          <Button kind="primary" className="flex-1" disabled={rating.count === count} onClick={() => onRate({ count })}>
            Save
          </Button>
        </div>
      </Card>
    );
  if (item.category === 'safety')
    return (
      <div className="grid grid-cols-2 gap-2" role="group" aria-label="Test result">
        <Chip selected={rating.tested === true} onClick={() => onRate({ tested: true })} tone="green">
          Tested: working
        </Chip>
        <Chip selected={rating.tested === false} onClick={() => onRate({ tested: false })} tone="red">
          Not working
        </Chip>
      </div>
    );
  if (item.category === 'document')
    return (
      <div className="grid grid-cols-2 gap-2" role="group" aria-label="Handed over">
        <Chip selected={rating.handedOver === true} onClick={() => onRate({ handedOver: true })} tone="green">
          Handed over
        </Chip>
        <Chip selected={rating.handedOver === false} onClick={() => onRate({ handedOver: false })} tone="amber">
          Not handed over
        </Chip>
      </div>
    );
  return (
    <>
      <p className="font-semibold mb-2" id="cond-label">
        Condition
      </p>
      <div className="grid grid-cols-3 gap-2" role="group" aria-labelledby="cond-label">
        {CONDITIONS.map((c) => (
          <Chip key={c} selected={rating.condition === c} onClick={() => onRate({ condition: c })} tone={c === 'Damaged' || c === 'Missing' ? 'red' : c === 'Poor' ? 'amber' : 'blue'}>
            {c}
          </Chip>
        ))}
      </div>
      <p className="font-semibold mt-4 mb-2" id="clean-label">
        Cleanliness
      </p>
      <div className="grid grid-cols-3 gap-2" role="group" aria-labelledby="clean-label">
        {CLEANLINESS.map((c) => (
          <Chip key={c} selected={rating.cleanliness === c} onClick={() => onRate({ cleanliness: c })}>
            {c === 'Professionally clean' ? 'Pro clean' : c}
          </Chip>
        ))}
      </div>
    </>
  );
}

function ItemDetailsSheet({ inventoryId, item, onClose }: { inventoryId: string; item: Item; onClose: () => void }) {
  const [name, setName] = useState(item.name);
  const [description, setDescription] = useState(item.description);
  const [quantity, setQuantity] = useState(item.quantity);
  return (
    <Sheet open onClose={onClose} title="Item details">
      <Field label="Name">
        <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} />
      </Field>
      <Field label="Description" hint="Make, model, colour">
        <input className={inputCls} value={description} onChange={(e) => setDescription(e.target.value)} />
      </Field>
      <Field label="Quantity">
        <input className={inputCls} type="number" min={1} value={quantity} onChange={(e) => setQuantity(Math.max(1, Number(e.target.value) || 1))} />
      </Field>
      <Button
        kind="primary"
        className="w-full"
        onClick={async () => {
          await updateItem(inventoryId, item, { name, description, quantity });
          onClose();
        }}
      >
        Save
      </Button>
    </Sheet>
  );
}

function IssueRow({ e }: { e: Entry }) {
  const p = e.payload as IssuePayload;
  return (
    <div className="rounded-xl border-l-4 border-red-700 bg-red-50 dark:bg-red-950 p-3 mb-2">
      <p className="font-semibold text-red-900 dark:text-red-100">
        ⚠ {p.issueType} <span className="font-normal text-sm">({p.status}{e.postSign ? ', post-sign' : ''})</span>
      </p>
      {p.note && <p>{p.note}</p>}
      <p className="text-sm text-slate-600 dark:text-slate-400">
        {e.authorName || e.authorRole} · {formatDateTime(e.createdAt)}
        {p.photoIds.length ? ` · ${plural(p.photoIds.length, 'photo')}` : ''}
      </p>
    </div>
  );
}

function describeEntry(e: Entry): string {
  switch (e.type) {
    case 'rating': {
      const r = e.payload as RatingPayload;
      const bits: string[] = [];
      if (r.condition) bits.push(`Condition: ${r.condition}`);
      if (r.cleanliness) bits.push(`Cleanliness: ${r.cleanliness}`);
      if (r.reading) bits.push(`Reading: ${r.reading} ${r.unit || ''}`);
      if (r.count !== undefined) bits.push(`Count: ${r.count}`);
      if (r.tested !== undefined) bits.push(r.tested ? 'Tested: working' : 'Tested: not working');
      if (r.handedOver !== undefined) bits.push(r.handedOver ? 'Handed over' : 'Not handed over');
      return bits.join(' · ');
    }
    case 'note':
      return `${e.postSign ? 'Post-sign note' : 'Note'}: ${(e.payload as NotePayload).text}`;
    case 'photo':
      return `Photo ${(e.payload as PhotoPayload).photo?.source === 'gallery' ? '(from gallery)' : '(taken in app)'}`;
    case 'issue':
      return `Issue reported: ${(e.payload as IssuePayload).issueType}${(e.payload as IssuePayload).note ? ' – ' + (e.payload as IssuePayload).note : ''}`;
    case 'agree':
      return 'Agreed';
    case 'dispute':
      return `Not right: ${(e.payload as ReviewPayload).reason || ''}`;
    case 'reply':
      return `Reply: ${(e.payload as ReplyPayload).text}`;
    case 'signature':
      return `Signed as ${(e.payload as SignaturePayload).typedName}`;
    case 'hide':
      return 'Hid an entry';
    case 'structure-change': {
      const op = e.payload as StructureOp;
      if (op.op === 'update-item') return `Details changed: ${Object.entries(op.changes).map(([k, v]) => `${k} → ${v}`).join(', ')}`;
      if (op.op === 'add-item') return 'Item added';
      if (op.op === 'remove-item') return 'Item removed';
      return 'Structure changed';
    }
    default:
      return e.type;
  }
}

// ---------- Issues and disputes ----------

export function IssuesScreen({ id }: { id: string }) {
  const data = useInventory(id);
  const [tab, setTab] = useState<'disputes' | 'issues'>('disputes');
  const [filter, setFilter] = useState<'open' | 'resolved'>('open');
  if (!data) return null;
  const where = (e: Entry) => {
    const room = data.rooms.find((r) => r.id === e.roomId);
    const item = data.items.find((i) => i.id === e.itemId);
    return { room, item, label: [room?.name, item?.name].filter(Boolean).join(' › ') || 'Whole property' };
  };
  const open = (e: Entry) => {
    const { room, item } = where(e);
    go(item ? `/inventory/${id}/item/${item.id}` : room ? `/inventory/${id}/room/${room.id}` : `/inventory/${id}`);
  };
  const disputes = data.disputes.filter((d) => (filter === 'open' ? d.status === 'open' : d.status !== 'open'));
  const issues = data.issues.filter((e) => {
    const st = (e.payload as IssuePayload).status;
    return filter === 'open' ? st !== 'fixed' : st === 'fixed';
  });
  return (
    <>
      <Header title="Issues and disputes" sub={data.property.address} back={`/inventory/${id}`} />
      <Screen>
        <div className="grid grid-cols-2 gap-2 mb-2">
          <Chip selected={tab === 'disputes'} onClick={() => setTab('disputes')}>
            Disputes ({data.disputes.length})
          </Chip>
          <Chip selected={tab === 'issues'} onClick={() => setTab('issues')}>
            Issues ({data.issues.length})
          </Chip>
        </div>
        <div className="grid grid-cols-2 gap-2 mb-4">
          <Chip selected={filter === 'open'} onClick={() => setFilter('open')}>
            Open
          </Chip>
          <Chip selected={filter === 'resolved'} onClick={() => setFilter('resolved')}>
            {tab === 'disputes' ? 'Answered' : 'Resolved'}
          </Chip>
        </div>
        {tab === 'disputes' ? (
          <>
            {!disputes.length && <Empty>{filter === 'open' ? 'No disputes waiting for an answer.' : 'None yet.'}</Empty>}
            {disputes.map(({ entry, status }) => {
              const s = data.states.get(entry.itemId || '');
              const replies = s?.replies.filter((r) => r.createdAt > entry.createdAt) || [];
              const st = disputeStatus(entry, s, data.entries, data.property);
              return (
                <button key={entry.id} className="block w-full text-left mb-3" onClick={() => open(entry)} data-testid="dispute-row">
                  <p className="text-sm font-semibold text-slate-700 dark:text-slate-300">{where(entry).label}</p>
                  <div className="rounded-xl border-l-4 border-red-700 bg-red-50 dark:bg-red-950 p-3">
                    <p className="font-semibold">{(entry.payload as ReviewPayload).reason}</p>
                    <p className="text-sm text-slate-600 dark:text-slate-400">
                      {entry.authorName} · {formatDateTime(entry.createdAt)} · {status === 'open' ? (data.role === 'landlord' ? 'needs your reply' : 'waiting for landlord') : st}
                    </p>
                    {replies.map((r) => (
                      <p key={r.id} className="text-sm mt-1 pl-3 border-l-2 border-blue-700">
                        {r.authorName}: {(r.payload as ReplyPayload).text}
                      </p>
                    ))}
                  </div>
                </button>
              );
            })}
          </>
        ) : (
          <>
            {!issues.length && <Empty>{filter === 'open' ? 'No open issues.' : 'No resolved issues yet.'}</Empty>}
            {issues.map((e) => (
              <button key={e.id} className="block w-full text-left" onClick={() => open(e)}>
                <p className="text-sm font-semibold text-slate-700 dark:text-slate-300">{where(e).label}</p>
                <IssueRow e={e} />
              </button>
            ))}
          </>
        )}
      </Screen>
    </>
  );
}

// ---------- Export and share ----------

export function ExportScreen({ id }: { id: string }) {
  const data = useInventory(id);
  const exports = useLive(async () => (await db.exports.where('inventoryId').equals(id).toArray()).sort((a, b) => b.createdAt.localeCompare(a.createdAt)), [id], []);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  const { toast } = useUI();
  if (!data) return null;
  const make = async () => {
    setBusy(true);
    setErr(undefined);
    try {
      await createExport(id);
      toast('PDF saved. It will upload to OneDrive.');
    } catch (e) {
      console.error(e);
      setErr(e instanceof Error ? e.message : 'PDF failed');
    } finally {
      setBusy(false);
    }
  };
  const blobFor = async (exportId: string) => (await db.blobs.get(`${exportId}:pdf`))?.blob;
  const open = async (exportId: string) => {
    const b = await blobFor(exportId);
    if (!b) return;
    const url = URL.createObjectURL(b);
    window.open(url, '_blank') || (window.location.href = url);
  };
  const share = async (exportId: string, fileName: string) => {
    const b = await blobFor(exportId);
    if (!b) return;
    const file = new File([b], fileName.split('/').pop() || 'inventory.pdf', { type: 'application/pdf' });
    if (navigator.canShare?.({ files: [file] })) {
      await navigator.share({ files: [file], title: file.name }).catch(() => undefined);
    } else {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(file);
      a.download = file.name;
      a.click();
    }
  };
  return (
    <>
      <Header title="Export and share" sub={data.property.address} back={`/inventory/${id}`} />
      <Screen
        bottom={
          <Button kind="primary" className="flex-1 text-lg" onClick={make} disabled={busy} data-testid="make-pdf">
            <Icon name="file" /> {busy ? 'Making PDF…' : 'Generate PDF'}
          </Button>
        }
      >
        <p className="mb-4 text-slate-700 dark:text-slate-300">
          The PDF has a cover page, every room and item with ratings, notes, photo thumbnails and issues, then meters, keys, safety checks and signatures.
          It's made on this phone and saved to the inventory's exports folder in OneDrive.
        </p>
        {err && <p className="text-red-700 mb-3">{err}</p>}
        {exports && !exports.length && <Empty>No PDFs yet.</Empty>}
        <div className="space-y-3">
          {exports?.map((x) => (
            <Card key={x.id}>
              <p className="font-semibold break-all">{x.fileName.split('/').pop()}</p>
              <p className="text-sm text-slate-600 dark:text-slate-400" data-testid="export-status">
                {formatDateTime(x.createdAt)} · {(x.byteSize / 1024 / 1024).toFixed(1)} MB · {x.uploadStatus === 'uploaded' ? 'saved to OneDrive' : 'waiting to upload'}
              </p>
              <div className="flex gap-2 mt-3">
                <Button onClick={() => open(x.id)}>Open</Button>
                <Button onClick={() => share(x.id, x.fileName)}>
                  <Icon name="share" /> Share
                </Button>
                {x.remoteUrl && (
                  <a className="tap inline-flex items-center rounded-xl px-4 font-semibold text-blue-700 dark:text-blue-300" href={x.remoteUrl} target="_blank" rel="noreferrer">
                    OneDrive
                  </a>
                )}
              </div>
            </Card>
          ))}
        </div>
      </Screen>
    </>
  );
}

