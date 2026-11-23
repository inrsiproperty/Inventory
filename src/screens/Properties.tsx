import { useState } from 'react';
import { SyncBadge } from '../components/SyncBadge';
import { Button, Card, Chip, Empty, Field, Header, Icon, Screen, SectionTitle, Sheet, Thumb, inputCls } from '../components/ui';
import { createProperty, createTenancy, startInventory, updateProperty, updateTenancy, type PropertyInput } from '../lib/actions';
import { db, readSettings, useLive } from '../lib/db';
import { go } from '../lib/router';
import { defaultRoomChoices, type RoomChoice } from '../lib/templates';
import type { Furnishing, PropertyType, TenantRef } from '../lib/types';
import { formatDate, inventoryTypeLabel, plural } from '../lib/util';

// ---------- Properties list ----------

export function PropertiesScreen() {
  const data = useLive(async () => {
    const props = (await db.properties.toArray()).sort((a, b) => a.address.localeCompare(b.address));
    const tens = await db.tenancies.toArray();
    const invs = await db.inventories.toArray();
    return props.map((p) => {
      const t = tens.filter((x) => x.propertyId === p.id).sort((a, b) => b.startDate.localeCompare(a.startDate))[0];
      const inv = t ? invs.filter((i) => i.tenancyId === t.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] : undefined;
      return { p, t, inv };
    });
  }, []);
  return (
    <>
      <Header
        title="Properties"
        right={
          <button className="tap rounded-full p-2" aria-label="Settings" onClick={() => go('/settings')}>
            <Icon name="gear" />
          </button>
        }
      />
      <Screen
        bottom={
          <Button kind="primary" className="flex-1 text-lg" onClick={() => go('/property/new')} data-testid="add-property">
            <Icon name="plus" /> Add property
          </Button>
        }
      >
        <SyncBadge />
        <div className="mt-4 space-y-3">
          {data && !data.length && <Empty>No properties yet. Tap Add property to start your first check-in.</Empty>}
          {data?.map(({ p, t, inv }) => (
            <Card key={p.id} onClick={() => go(`/property/${p.id}`)} className="flex gap-3 items-center">
              {p.coverPhotoId ? (
                <Thumb photoId={p.coverPhotoId} className="h-20 w-20 rounded-xl shrink-0" alt="" />
              ) : (
                <div className="h-20 w-20 rounded-xl shrink-0 bg-blue-50 dark:bg-blue-950 text-blue-700 dark:text-blue-300 flex items-center justify-center">
                  <Icon name="home" className="w-9 h-9" />
                </div>
              )}
              <div className="min-w-0 flex-1">
                <p className="font-semibold text-lg leading-tight">{p.address}</p>
                <p className="text-slate-600 dark:text-slate-400">{p.postcode}</p>
                <p className="text-sm mt-1">
                  {t ? `${t.tenants.map((x) => x.name).join(', ') || 'Tenancy'} · from ${formatDate(t.startDate)}` : 'No tenancy yet'}
                </p>
                {inv && (
                  <p className="text-sm font-semibold text-blue-800 dark:text-blue-300">
                    {inventoryTypeLabel(inv.type)}: {inv.status === 'draft' ? 'in progress' : inv.status}
                  </p>
                )}
              </div>
            </Card>
          ))}
        </div>
      </Screen>
    </>
  );
}

// ---------- Add / edit property ----------

export function PropertyFormScreen({ id }: { id?: string }) {
  const existing = useLive(() => (id ? db.properties.get(id) : undefined), [id]);
  const [f, setF] = useState<PropertyInput | null>(id ? null : { address: '', postcode: '', type: 'flat', bedrooms: 2, furnishing: 'unfurnished' });
  if (id && existing && !f) setF({ address: existing.address, postcode: existing.postcode, type: existing.type, bedrooms: existing.bedrooms, furnishing: existing.furnishing });
  if (!f) return null;
  const set = (p: Partial<PropertyInput>) => setF({ ...f, ...p });
  const save = async () => {
    if (!f.address.trim()) return;
    if (id) {
      await updateProperty(id, f);
      go(`/property/${id}`);
    } else {
      const nid = await createProperty({ ...f, address: f.address.trim(), postcode: f.postcode.trim().toUpperCase() });
      go(`/property/${nid}`, true);
    }
  };
  return (
    <>
      <Header title={id ? 'Edit property' : 'Add property'} back={id ? `/property/${id}` : '/'} />
      <Screen
        bottom={
          <Button kind="primary" className="flex-1 text-lg" onClick={save} disabled={!f.address.trim()} data-testid="save-property">
            Save property
          </Button>
        }
      >
        <Field label="Address">
          <input className={inputCls} value={f.address} onChange={(e) => set({ address: e.target.value })} placeholder="Flat 2, 14 Gillygate, York" autoComplete="street-address" name="address" />
        </Field>
        <Field label="Postcode">
          <input className={inputCls} value={f.postcode} onChange={(e) => set({ postcode: e.target.value })} placeholder="YO31 7EQ" autoComplete="postal-code" name="postcode" />
        </Field>
        <Field label="Type" group>
          <div className="grid grid-cols-2 gap-2">
            {(['flat', 'house'] as PropertyType[]).map((t) => (
              <Chip key={t} selected={f.type === t} onClick={() => set({ type: t })}>
                {t === 'flat' ? 'Flat' : 'House'}
              </Chip>
            ))}
          </div>
        </Field>
        <Field label="Bedrooms" group>
          <div className="flex items-center gap-3">
            <Button aria-label="Fewer bedrooms" onClick={() => set({ bedrooms: Math.max(0, f.bedrooms - 1) })}>
              −
            </Button>
            <span className="text-2xl font-bold w-10 text-center" data-testid="bedrooms">
              {f.bedrooms}
            </span>
            <Button aria-label="More bedrooms" onClick={() => set({ bedrooms: Math.min(12, f.bedrooms + 1) })}>
              +
            </Button>
          </div>
        </Field>
        <Field label="Furnishing" group>
          <div className="grid grid-cols-3 gap-2">
            {(
              [
                ['furnished', 'Furnished'],
                ['part', 'Part'],
                ['unfurnished', 'Unfurnished'],
              ] as [Furnishing, string][]
            ).map(([v, l]) => (
              <Chip key={v} selected={f.furnishing === v} onClick={() => set({ furnishing: v })}>
                {l}
              </Chip>
            ))}
          </div>
        </Field>
        <p className="text-sm text-slate-600 dark:text-slate-400">You can pick a cover photo later from any inventory photo.</p>
      </Screen>
    </>
  );
}

// ---------- Property ----------

export function PropertyScreen({ id }: { id: string }) {
  const data = useLive(async () => {
    const p = await db.properties.get(id);
    const tenancies = (await db.tenancies.where('propertyId').equals(id).toArray()).sort((a, b) => b.startDate.localeCompare(a.startDate));
    const invs = await db.inventories.where('propertyId').equals(id).toArray();
    return { p, tenancies, invs };
  }, [id]);
  const [startFor, setStartFor] = useState<string | null>(null);
  if (!data) return null;
  const { p, tenancies, invs } = data;
  if (!p) return <Header title="Property not found" back="/" />;
  return (
    <>
      <Header
        title={p.address}
        sub={p.postcode}
        back="/"
        right={
          <button className="tap rounded-full p-2" aria-label="Edit property" onClick={() => go(`/property/${id}/edit`)}>
            <Icon name="edit" />
          </button>
        }
      />
      <Screen
        bottom={
          <Button kind="primary" className="flex-1 text-lg" onClick={() => go(`/property/${id}/tenancy/new`)} data-testid="new-tenancy">
            <Icon name="plus" /> New tenancy
          </Button>
        }
      >
        {p.coverPhotoId && <Thumb photoId={p.coverPhotoId} className="w-full h-44 rounded-2xl mb-3" alt="Cover photo" />}
        <Card>
          <p>
            {p.type === 'flat' ? 'Flat' : 'House'} · {plural(p.bedrooms, 'bedroom')} · {p.furnishing === 'part' ? 'part furnished' : p.furnishing}
          </p>
          <p className="text-sm text-slate-600 dark:text-slate-400 mt-1">OneDrive folder: Property Inventories/{p.folderName}</p>
        </Card>
        <SectionTitle>Tenancies</SectionTitle>
        {!tenancies.length && <Empty>Add a tenancy (tenant names, emails and start date) to start the check-in.</Empty>}
        <div className="space-y-3">
          {tenancies.map((t) => {
            const ti = invs.filter((i) => i.tenancyId === t.id).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
            const checkIn = ti.find((i) => i.type === 'check-in');
            return (
              <Card key={t.id}>
                <div className="flex justify-between gap-2">
                  <div>
                    <p className="font-semibold">{t.tenants.map((x) => x.name).join(', ') || 'Tenants not named'}</p>
                    <p className="text-sm text-slate-600 dark:text-slate-400">
                      {formatDate(t.startDate)} {t.endDate ? `to ${formatDate(t.endDate)}` : 'onwards'}
                      {t.depositRef ? ` · deposit ref ${t.depositRef}` : ''}
                    </p>
                  </div>
                  <button className="tap rounded-full p-2 shrink-0" aria-label="Edit tenancy" onClick={() => go(`/tenancy/${t.id}/edit`)}>
                    <Icon name="edit" className="w-5 h-5" />
                  </button>
                </div>
                <div className="mt-3 space-y-2">
                  {ti.map((inv) => (
                    <Button key={inv.id} className="w-full justify-between" onClick={() => go(`/inventory/${inv.id}`)}>
                      <span>{inventoryTypeLabel(inv.type)}</span>
                      <span className="text-sm font-normal">{inv.status === 'draft' ? 'In progress' : inv.status} ›</span>
                    </Button>
                  ))}
                  {!checkIn && (
                    <Button kind="primary" className="w-full" onClick={() => setStartFor(t.id)} data-testid="start-check-in">
                      Start check-in
                    </Button>
                  )}
                  <Button kind="ghost" className="w-full" disabled title="Arrives in phase 2">
                    Send to tenant (coming in phase 2)
                  </Button>
                </div>
              </Card>
            );
          })}
        </div>
      </Screen>
      {startFor && <StartCheckInSheet tenancyId={startFor} bedrooms={p.bedrooms} onClose={() => setStartFor(null)} />}
    </>
  );
}

function StartCheckInSheet({ tenancyId, bedrooms, onClose }: { tenancyId: string; bedrooms: number; onClose: () => void }) {
  const settings = useLive(() => readSettings(), []);
  const [choices, setChoices] = useState<RoomChoice[] | null>(null);
  const [extra, setExtra] = useState('');
  const [busy, setBusy] = useState(false);
  if (settings && !choices) setChoices(defaultRoomChoices(settings.templates, bedrooms));
  if (!choices) return null;
  const start = async () => {
    setBusy(true);
    const id = await startInventory(tenancyId, choices);
    onClose();
    go(`/inventory/${id}`);
  };
  return (
    <Sheet open onClose={onClose} title="Start check-in">
      <p className="mb-3 text-slate-700 dark:text-slate-300">Untick rooms the property doesn't have. Meters, keys, safety checks and documents are always included.</p>
      <div className="space-y-2 mb-3">
        {choices.map((c, i) => (
          <label key={i} className="flex items-center gap-3 rounded-xl border border-slate-200 dark:border-slate-700 px-3 min-h-12">
            <input
              type="checkbox"
              className="h-6 w-6 accent-blue-700"
              checked={c.include}
              onChange={(e) => setChoices(choices.map((x, j) => (j === i ? { ...x, include: e.target.checked } : x)))}
            />
            <input
              className="flex-1 bg-transparent py-3 text-base outline-none"
              value={c.name}
              aria-label="Room name"
              onChange={(e) => setChoices(choices.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))}
            />
          </label>
        ))}
      </div>
      <div className="flex gap-2 mb-4">
        <input className={inputCls} value={extra} onChange={(e) => setExtra(e.target.value)} placeholder="Add a room, e.g. Bathroom 2" />
        <Button
          onClick={() => {
            if (!extra.trim()) return;
            const key = /bath|shower|wc|en.?suite/i.test(extra) ? 'bathroom' : /bed/i.test(extra) ? 'bedroom' : 'custom';
            setChoices([...choices, { key, name: extra.trim(), include: true }]);
            setExtra('');
          }}
        >
          Add
        </Button>
      </div>
      <Button kind="primary" className="w-full text-lg" onClick={start} disabled={busy} data-testid="create-check-in">
        Create check-in
      </Button>
    </Sheet>
  );
}

// ---------- Tenancy form ----------

export function TenancyFormScreen({ propertyId, id }: { propertyId?: string; id?: string }) {
  const existing = useLive(() => (id ? db.tenancies.get(id) : undefined), [id]);
  const [tenants, setTenants] = useState<TenantRef[] | null>(id ? null : [{ name: '', email: '' }]);
  const [startDate, setStart] = useState(new Date().toISOString().slice(0, 10));
  const [endDate, setEnd] = useState('');
  const [depositRef, setDep] = useState('');
  if (id && existing && !tenants) {
    setTenants(existing.tenants.length ? existing.tenants : [{ name: '', email: '' }]);
    setStart(existing.startDate);
    setEnd(existing.endDate || '');
    setDep(existing.depositRef || '');
  }
  if (!tenants) return null;
  const pid = propertyId || existing?.propertyId;
  const save = async () => {
    const clean = tenants.map((t) => ({ ...t, name: t.name.trim(), email: t.email.trim().toLowerCase() })).filter((t) => t.name || t.email);
    const input = { tenants: clean, startDate, endDate: endDate || undefined, depositRef: depositRef.trim() || undefined };
    if (id) await updateTenancy(id, input);
    else await createTenancy(pid!, input);
    go(`/property/${pid}`, !id);
  };
  return (
    <>
      <Header title={id ? 'Edit tenancy' : 'New tenancy'} back={`/property/${pid}`} />
      <Screen
        bottom={
          <Button kind="primary" className="flex-1 text-lg" onClick={save} disabled={!startDate} data-testid="save-tenancy">
            Save tenancy
          </Button>
        }
      >
        {tenants.map((t, i) => (
          <Card key={i} className="mb-3">
            <Field label={tenants.length > 1 ? `Tenant ${i + 1} name` : 'Tenant name'}>
              <input className={inputCls} value={t.name} name={`tenant-name-${i}`} onChange={(e) => setTenants(tenants.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} />
            </Field>
            <Field label="Email" hint="Used in phase 2 to share the property folder with them.">
              <input
                className={inputCls}
                type="email"
                inputMode="email"
                name={`tenant-email-${i}`}
                value={t.email}
                onChange={(e) => setTenants(tenants.map((x, j) => (j === i ? { ...x, email: e.target.value } : x)))}
              />
            </Field>
            {tenants.length > 1 && (
              <Button kind="danger" onClick={() => setTenants(tenants.filter((_, j) => j !== i))}>
                Remove tenant
              </Button>
            )}
          </Card>
        ))}
        <Button kind="ghost" className="mb-4" onClick={() => setTenants([...tenants, { name: '', email: '' }])}>
          <Icon name="plus" /> Add another tenant (joint tenancy)
        </Button>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Start date">
            <input className={inputCls} type="date" value={startDate} onChange={(e) => setStart(e.target.value)} name="start-date" />
          </Field>
          <Field label="End date (optional)">
            <input className={inputCls} type="date" value={endDate} onChange={(e) => setEnd(e.target.value)} />
          </Field>
        </div>
        <Field label="Deposit scheme reference (optional)">
          <input className={inputCls} value={depositRef} onChange={(e) => setDep(e.target.value)} />
        </Field>
      </Screen>
    </>
  );
}
