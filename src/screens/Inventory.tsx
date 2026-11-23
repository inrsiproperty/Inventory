import { useEffect, useState } from 'react';
import { useUI } from '../components/Overlays';
import { SyncBadge } from '../components/SyncBadge';
import { Button, Card, Chip, Empty, Field, Header, Icon, Progress, Screen, SectionTitle, Sheet, Thumb, inputCls } from '../components/ui';
import { addItem, addNote, addRoom, moveItem, removeItem, removeRoom, renameRoom, setRating, updateItem } from '../lib/actions';
import { db, useLive } from '../lib/db';
import { createExport } from '../lib/pdf';
import { go } from '../lib/router';
import { isRated, ratingSummary, useInventory, type InventoryData, type ItemState } from '../lib/state';
import { CLEANLINESS, CONDITIONS, type Entry, type IssuePayload, type Item, type NotePayload, type PhotoPayload, type RatingPayload, type StructureOp } from '../lib/types';
import { formatDateTime, inventoryTypeLabel, plural } from '../lib/util';

const SPECIAL = new Set(['meters', 'keys', 'safety', 'documents']);

function walkItems(data: InventoryData, roomId?: string) {
  const rooms = data.rooms.filter((r) => !SPECIAL.has(r.templateKey) && (!roomId || r.id === roomId));
  return rooms.flatMap((r) => data.items.filter((i) => i.roomId === r.id && i.category === 'general'));
}

// ---------- Inventory overview ----------

export function InventoryScreen({ id }: { id: string }) {
  const data = useInventory(id);
  const { openCamera } = useUI();
  const [addingRoom, setAddingRoom] = useState(false);
  if (data === undefined) return null;
  if (!data) return <Header title="Inventory not found" back="/" />;
  const startWalk = () => {
    const list = walkItems(data);
    const first = Math.max(0, list.findIndex((i) => !isRated(i, data.states.get(i.id))));
    openCamera({ inventoryId: id, mode: 'walk', itemIds: list.map((i) => i.id), startIndex: first });
  };
  const roomTile = (r: InventoryData['rooms'][number]) => {
    const items = data.items.filter((i) => i.roomId === r.id);
    const rated = items.filter((i) => isRated(i, data.states.get(i.id))).length;
    const issues = data.issues.filter((e) => e.roomId === r.id).length;
    const photos = data.photos.filter((p) => p.roomId === r.id).length;
    return (
      <Card key={r.id} onClick={() => go(`/inventory/${id}/room/${r.id}`)} className="!p-3">
        <p className="font-semibold leading-tight">{r.name}</p>
        <p className="text-sm text-slate-600 dark:text-slate-400 mt-1">
          {rated}/{items.length} done
        </p>
        <div className="h-1.5 rounded-full bg-slate-200 dark:bg-slate-800 mt-2 overflow-hidden">
          <div className="h-full bg-blue-700" style={{ width: `${items.length ? (rated / items.length) * 100 : 0}%` }} />
        </div>
        <p className="text-xs mt-2 text-slate-600 dark:text-slate-400">
          {plural(photos, 'photo')}
          {issues ? <span className="text-red-700 dark:text-red-300 font-semibold"> · {plural(issues, 'issue')}</span> : null}
        </p>
      </Card>
    );
  };
  return (
    <>
      <Header title={`${inventoryTypeLabel(data.inventory.type)} inventory`} sub={data.property.address} back={`/property/${data.property.id}`} />
      <Screen
        bottom={
          <>
            <Button kind="primary" className="flex-1 text-lg" onClick={startWalk} data-testid="walk-through">
              <Icon name="walk" /> Walk-through
            </Button>
            <Button onClick={() => go(`/inventory/${id}/issues`)} aria-label="Issues list">
              <Icon name="list" /> {data.issues.length}
            </Button>
            <Button onClick={() => go(`/inventory/${id}/export`)} aria-label="Export PDF" data-testid="export">
              <Icon name="file" /> PDF
            </Button>
          </>
        }
      >
        <SyncBadge />
        <div className="mt-4">
          <Progress value={data.ratedCount} total={data.itemCount} label="Items recorded" />
          <p className="text-sm text-slate-600 dark:text-slate-400 mt-2">
            Status: {data.inventory.status === 'draft' ? 'draft (not yet sent to tenant)' : data.inventory.status} · {plural(data.photos.length, 'photo')} ·{' '}
            {plural(data.issues.length, 'issue')}
          </p>
        </div>
        <SectionTitle right={<Button kind="ghost" onClick={() => setAddingRoom(true)}>+ Room</Button>}>Rooms</SectionTitle>
        <div className="grid grid-cols-2 gap-3">{data.rooms.filter((r) => !SPECIAL.has(r.templateKey)).map(roomTile)}</div>
        <SectionTitle>Meters, keys and safety</SectionTitle>
        <div className="grid grid-cols-2 gap-3">{data.rooms.filter((r) => SPECIAL.has(r.templateKey)).map(roomTile)}</div>
      </Screen>
      {addingRoom && <AddRoomSheet inventoryId={id} onClose={() => setAddingRoom(false)} />}
    </>
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
  const items = data.items.filter((i) => i.roomId === roomId);
  const roomState = data.states.get(`room:${roomId}`);
  const rated = items.filter((i) => isRated(i, data.states.get(i.id))).length;
  const special = SPECIAL.has(room.templateKey);
  return (
    <>
      <Header
        title={room.name}
        sub={`${rated}/${items.length} done`}
        back={`/inventory/${id}`}
        right={
          <Button kind="ghost" onClick={() => setEdit(!edit)} aria-pressed={edit}>
            {edit ? 'Done' : 'Edit'}
          </Button>
        }
      />
      <Screen
        bottom={
          <>
            {!special && (
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
            <Button
              kind={special ? 'primary' : 'secondary'}
              className={special ? 'flex-1 text-lg' : ''}
              onClick={() => openCamera({ inventoryId: id, mode: 'burst', roomId })}
              aria-label="Take room photos"
              data-testid="room-camera"
            >
              <Icon name="camera" className="w-7 h-7" /> {special ? 'Room photos' : ''}
            </Button>
          </>
        }
      >
        {edit && (
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
        {!items.length && <Empty>No items in this room. Tap Edit to add some.</Empty>}
        <ul className="space-y-2">
          {items.map((item, idx) => {
            const s = data.states.get(item.id);
            const done = isRated(item, s);
            const issues = s?.issues.length || 0;
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
                    {issues > 0 && <p className="text-sm text-red-700 dark:text-red-300 font-semibold">⚠ {plural(issues, 'issue')}</p>}
                  </div>
                </button>
                {edit ? (
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
                ) : (
                  <button
                    className="tap rounded-2xl bg-blue-700 text-white px-4 flex items-center"
                    aria-label={`Take photo of ${item.name}`}
                    onClick={() => openCamera({ inventoryId: id, mode: 'burst', roomId, itemId: item.id })}
                  >
                    <Icon name="camera" className="w-7 h-7" />
                  </button>
                )}
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
  const { openCamera, viewPhoto } = useUI();
  const [note, setNote] = useState('');
  const [details, setDetails] = useState(false);
  if (!data) return null;
  const item = data.items.find((i) => i.id === itemId) || null;
  if (!item) return <Header title="Item not found" back={`/inventory/${id}`} />;
  const room = data.rooms.find((r) => r.id === item.roomId);
  const s: ItemState = data.states.get(itemId) || { rating: {}, notes: [], photos: [], issues: [], entries: [] };
  const siblings = data.items.filter((i) => i.roomId === item.roomId);
  const idx = siblings.findIndex((i) => i.id === itemId);
  const prev = siblings[idx - 1];
  const next = siblings[idx + 1];
  const rate = (r: RatingPayload) => setRating(id, item, r);
  return (
    <>
      <Header title={item.name} sub={`${room?.name || ''} · item ${idx + 1} of ${siblings.length}`} back={`/inventory/${id}/room/${item.roomId}`} />
      <Screen
        bottom={
          <>
            <Button aria-label="Previous item" disabled={!prev} onClick={() => prev && go(`/inventory/${id}/item/${prev.id}`, true)}>
              <Icon name="back" />
            </Button>
            <Button
              kind="primary"
              className="flex-1 text-lg"
              onClick={() => openCamera({ inventoryId: id, mode: 'burst', roomId: item.roomId, itemId })}
              data-testid="item-camera"
            >
              <Icon name="camera" className="w-7 h-7" /> Take photo
            </Button>
            <Button aria-label="Next item" disabled={!next} onClick={() => next && go(`/inventory/${id}/item/${next.id}`, true)}>
              <Icon name="next" />
            </Button>
          </>
        }
      >
        <div className="flex gap-2 overflow-x-auto pb-1 mb-2" data-testid="item-photos" aria-label="Photos">
          {s.photos.map((p) => (
            <button key={p.id} onClick={() => viewPhoto(p)} className="shrink-0 relative" aria-label={`Photo taken ${formatDateTime(p.takenAt)}`}>
              <Thumb photoId={p.id} className="h-24 w-24 rounded-xl" />
              {p.uploadStatus !== 'uploaded' && <span className="absolute bottom-1 right-1 rounded bg-black/70 text-white text-[10px] px-1">waiting</span>}
              {p.source === 'gallery' && <span className="absolute top-1 left-1 rounded bg-amber-400 text-black text-[10px] px-1 font-semibold">gallery</span>}
            </button>
          ))}
          {!s.photos.length && <p className="text-slate-600 dark:text-slate-400 py-6">No photos yet. Tap Take photo.</p>}
        </div>

        <RatingControls item={item} rating={s.rating} onRate={rate} />

        <div className="mt-4 flex items-center justify-between">
          <p className="text-sm text-slate-600 dark:text-slate-400">
            {item.description || 'No description'}
            {item.quantity > 1 ? ` · quantity ${item.quantity}` : ''}
          </p>
          <Button kind="ghost" onClick={() => setDetails(true)}>
            Edit details
          </Button>
        </div>

        <SectionTitle>Notes</SectionTitle>
        <div className="flex gap-2">
          <textarea className={inputCls + ' min-h-12'} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Add a note (dictation works too)" aria-label="Note" />
          <Button
            onClick={async () => {
              await addNote(id, note, item.roomId, item.id);
              setNote('');
            }}
            disabled={!note.trim()}
          >
            Add
          </Button>
        </div>

        {s.issues.length > 0 && (
          <>
            <SectionTitle>Issues</SectionTitle>
            {s.issues.map((e) => (
              <IssueRow key={e.id} e={e} />
            ))}
          </>
        )}

        <SectionTitle>History</SectionTitle>
        <ol className="space-y-2" aria-label="Full entry history">
          {[...s.entries].reverse().map((e) => (
            <li key={e.id} className="rounded-xl bg-slate-50 dark:bg-slate-900 p-3 text-sm">
              <p className="font-semibold">{describeEntry(e)}</p>
              <p className="text-slate-600 dark:text-slate-400">
                {e.authorName || e.authorRole} · {formatDateTime(e.createdAt)}
                {e.dirty ? ' · waiting to upload' : ''}
              </p>
            </li>
          ))}
        </ol>
      </Screen>
      {details && <ItemDetailsSheet inventoryId={id} item={item} onClose={() => setDetails(false)} />}
    </>
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
        ⚠ {p.issueType} <span className="font-normal text-sm">({p.status})</span>
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
      return `Note: ${(e.payload as NotePayload).text}`;
    case 'photo':
      return `Photo ${(e.payload as PhotoPayload).photo?.source === 'gallery' ? '(from gallery)' : '(taken in app)'}`;
    case 'issue':
      return `Issue reported: ${(e.payload as IssuePayload).issueType}`;
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

// ---------- Issues list ----------

export function IssuesScreen({ id }: { id: string }) {
  const data = useInventory(id);
  const [filter, setFilter] = useState<'open' | 'resolved'>('open');
  if (!data) return null;
  const list = data.issues.filter((e) => {
    const st = (e.payload as IssuePayload).status;
    return filter === 'open' ? st !== 'fixed' : st === 'fixed';
  });
  return (
    <>
      <Header title="Issues" sub={data.property.address} back={`/inventory/${id}`} />
      <Screen>
        <div className="grid grid-cols-2 gap-2 mb-4">
          <Chip selected={filter === 'open'} onClick={() => setFilter('open')}>
            Open
          </Chip>
          <Chip selected={filter === 'resolved'} onClick={() => setFilter('resolved')}>
            Resolved
          </Chip>
        </div>
        {!list.length && <Empty>{filter === 'open' ? 'No open issues.' : 'No resolved issues yet.'}</Empty>}
        {list.map((e) => {
          const room = data.rooms.find((r) => r.id === e.roomId);
          const item = data.items.find((i) => i.id === e.itemId);
          return (
            <button key={e.id} className="block w-full text-left" onClick={() => go(item ? `/inventory/${id}/item/${item.id}` : room ? `/inventory/${id}/room/${room.id}` : `/inventory/${id}`)}>
              <p className="text-sm font-semibold text-slate-700 dark:text-slate-300">{[room?.name, item?.name].filter(Boolean).join(' › ') || 'Whole property'}</p>
              <IssueRow e={e} />
            </button>
          );
        })}
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

