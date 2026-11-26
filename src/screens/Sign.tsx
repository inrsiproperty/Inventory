import { useEffect, useRef, useState } from 'react';
import SignaturePad from 'signature_pad';
import { useUI } from '../components/Overlays';
import { Button, Card, Header, Icon, Screen, SectionTitle, inputCls } from '../components/ui';
import { lockInventory, signInventory } from '../lib/actions';
import { useInventory } from '../lib/state';
import type { SignaturePayload } from '../lib/types';
import { formatDate, formatDateTime, nowIso, plural } from '../lib/util';
import { go } from '../lib/router';

// Review and sign: summary counts, confirmation tick, signature pad, typed name.

export function SignScreen({ id }: { id: string }) {
  const data = useInventory(id);
  const { toast } = useUI();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const padRef = useRef<SignaturePad | null>(null);
  const [name, setName] = useState<string | null>(null);
  const [ticked, setTicked] = useState(false);
  const [drawn, setDrawn] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();

  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    const ratio = Math.max(window.devicePixelRatio || 1, 1);
    c.width = c.offsetWidth * ratio;
    c.height = c.offsetHeight * ratio;
    c.getContext('2d')!.scale(ratio, ratio);
    const pad = new SignaturePad(c, { penColor: '#0b1220', backgroundColor: 'rgb(255,255,255)', minWidth: 1, maxWidth: 3 });
    pad.addEventListener('endStroke', () => setDrawn(!pad.isEmpty()));
    padRef.current = pad;
    return () => pad.off();
  }, [data ? 'ready' : 'loading']);

  if (!data) return null;
  if (name === null && data.me) setName(data.me.name);
  const me = data.signers.find((s) => (data.role === 'landlord' ? s.role === 'landlord' : s.email.toLowerCase() === data.me?.email.toLowerCase()));
  const landlord = data.role === 'landlord';
  const unreviewed = data.itemCount - data.reviewedByMe;
  const deadlinePassed = !!data.inventory.reviewDeadline && data.inventory.reviewDeadline <= nowIso();
  const landlordSigned = data.signers.find((s) => s.role === 'landlord')?.valid;

  const sign = async () => {
    const pad = padRef.current;
    if (!pad || pad.isEmpty()) return setErr('Please sign in the box with your finger.');
    setBusy(true);
    setErr(undefined);
    try {
      const blob: Blob = await new Promise((res, rej) => canvasRef.current!.toBlob((b) => (b ? res(b) : rej(new Error('Could not read the signature'))), 'image/png'));
      await signInventory(id, name || '', blob, ticked);
      toast('Signed');
      go(`/inventory/${id}`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not sign');
      setBusy(false);
    }
  };

  return (
    <>
      <Header title="Review and sign" sub={data.property.address} back={`/inventory/${id}`} />
      <Screen
        bottom={
          data.locked || me?.valid ? undefined : (
            <Button kind="primary" className="flex-1 text-lg" onClick={sign} disabled={busy || !ticked || !drawn || !name?.trim()} data-testid="sign-button">
              <Icon name="check" /> {busy ? 'Signing…' : 'Sign inventory'}
            </Button>
          )
        }
      >
        <Card>
          <p className="font-semibold mb-2">Summary</p>
          <ul className="text-sm space-y-1">
            <li>
              {plural(data.rooms.filter((r) => !['meters', 'keys', 'safety', 'documents'].includes(r.templateKey)).length, 'room')}, {plural(data.itemCount, 'item')} (
              {data.ratedCount} recorded)
            </li>
            <li>
              {plural(data.photos.length, 'photo')} · {plural(data.issues.length, 'issue')}
            </li>
            <li>
              {plural(data.disputes.length, 'dispute')} ({data.openDisputes} waiting for the landlord)
            </li>
            {!landlord && (
              <li>
                You've reviewed {data.reviewedByMe} of {data.itemCount} items
              </li>
            )}
          </ul>
        </Card>

        <SectionTitle>Signatures</SectionTitle>
        <ul className="space-y-1 mb-2">
          {data.signers.map((s) => (
            <li key={s.key} className="flex gap-2 text-sm">
              <span aria-hidden="true">{s.valid ? '✅' : s.stale ? '⚠️' : '⬜'}</span>
              <span className="flex-1">
                {s.name} ({s.role})
              </span>
              <span>
                {s.valid
                  ? `signed ${formatDateTime((s.signature!.payload as SignaturePayload).signedAt)}`
                  : s.stale
                    ? 'changed since signing: sign again'
                    : 'not signed yet'}
              </span>
            </li>
          ))}
        </ul>

        {data.locked ? (
          <Card className="!border-green-600">
            <p className="font-semibold">🔒 Signed and locked.</p>
            <p className="text-sm">Anything found from now on goes in a post-sign note.</p>
          </Card>
        ) : me?.valid ? (
          <Card>
            <p className="font-semibold" data-testid="already-signed">
              You've signed this version.
            </p>
            <p className="text-sm">
              {landlord ? 'It locks automatically once your tenant has signed too.' : 'Once your landlord signs too, it locks and the PDF is saved.'} If
              anything changes before then, you'll be asked to sign again.
            </p>
          </Card>
        ) : (
          <>
            {!landlord && unreviewed > 0 && (
              <p className="rounded-xl bg-amber-50 dark:bg-amber-950 border border-amber-400 p-3 text-sm mb-3">
                You haven't reviewed {plural(unreviewed, 'item')} yet. You can still sign, but it's worth checking them first.
              </p>
            )}
            {data.openDisputes > 0 && (
              <p className="rounded-xl bg-amber-50 dark:bg-amber-950 border border-amber-400 p-3 text-sm mb-3">
                {plural(data.openDisputes, 'dispute')} {data.openDisputes === 1 ? "hasn't" : "haven't"} been answered. They'll be shown in the signed PDF.
              </p>
            )}
            <label className="flex gap-3 items-start rounded-xl border-2 border-slate-300 dark:border-slate-600 p-3 mb-3">
              <input type="checkbox" className="h-6 w-6 mt-0.5 accent-blue-700" checked={ticked} onChange={(e) => setTicked(e.target.checked)} data-testid="reviewed-tick" />
              <span>I have reviewed this inventory, including the photos, ratings, notes and any disputes.</span>
            </label>
            <label className="block mb-3">
              <span className="block text-sm font-semibold mb-1">Your full name</span>
              <input className={inputCls} value={name || ''} onChange={(e) => setName(e.target.value)} autoComplete="name" data-testid="typed-name" />
            </label>
            <div className="mb-1 flex justify-between items-end">
              <span className="text-sm font-semibold">Sign with your finger</span>
              <Button
                kind="ghost"
                onClick={() => {
                  padRef.current?.clear();
                  setDrawn(false);
                }}
              >
                Clear
              </Button>
            </div>
            <canvas
              ref={canvasRef}
              className="w-full h-44 rounded-xl border-2 border-slate-400 bg-white touch-none"
              aria-label="Signature box: draw your signature here"
              data-testid="signature-pad"
            />
            <p className="text-xs text-slate-600 dark:text-slate-400 mt-2">
              This is a simple electronic signature: your drawn mark, typed name, the time and your signed-in Microsoft account ({data.me?.email}). It
              signs the inventory exactly as it is now.
            </p>
            {err && <p className="text-red-700 dark:text-red-300 mt-2">{err}</p>}
          </>
        )}

        {landlord && !data.locked && landlordSigned && data.inventory.reviewDeadline && (
          <Card className="mt-4">
            <p className="font-semibold">Tenant hasn't signed?</p>
            <p className="text-sm mb-2">
              The 7-day review window {deadlinePassed ? 'ended' : 'ends'} on {formatDate(data.inventory.reviewDeadline)}. After that you can lock it as "issued,
              not signed by tenant". This is recorded on the PDF.
            </p>
            <Button
              disabled={!deadlinePassed}
              onClick={async () => {
                try {
                  await lockInventory(id, 'issued-not-signed-by-tenant');
                  go(`/inventory/${id}`);
                } catch (e) {
                  setErr(e instanceof Error ? e.message : 'Could not lock');
                }
              }}
            >
              Lock as issued, not signed by tenant
            </Button>
          </Card>
        )}
      </Screen>
    </>
  );
}
