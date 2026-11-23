import { useEffect, useState } from 'react';
import { SyncBadge } from '../components/SyncBadge';
import { Button, Card, Chip, Field, Header, Screen, SectionTitle, inputCls } from '../components/ui';
import { signIn, signOut } from '../lib/auth';
import { clientIdIsBakedIn, getClientId, redirectUri } from '../lib/config';
import { currentUser, db, readSettings, useLive } from '../lib/db';
import { localChange } from '../lib/events';
import { resyncFromOneDrive, syncNow, useSyncStatus } from '../lib/sync';
import { DEFAULT_TEMPLATES } from '../lib/templates';
import type { RoomTemplate } from '../lib/types';
import { formatDateTime, nowIso } from '../lib/util';

export function SettingsScreen() {
  const user = useLive(() => currentUser(), []);
  const settings = useLive(() => readSettings(), []);
  const status = useSyncStatus();
  const queue = useLive(async () => {
    const photos = await db.photos.where('uploadStatus').equals('pending').toArray();
    const entries = await db.entries.where('dirty').equals(1).count();
    const errors = [
      ...photos.filter((p) => p.sync?.lastError).map((p) => p.sync!.lastError!),
      ...(await db.entries.where('dirty').equals(1).toArray()).filter((e) => e.sync?.lastError).map((e) => e.sync!.lastError!),
    ];
    return { photos: photos.length, entries, errors: [...new Set(errors)].slice(0, 5) };
  }, []);
  const [storage, setStorage] = useState<string>();
  useEffect(() => {
    navigator.storage?.estimate?.().then((e) => setStorage(`${((e.usage || 0) / 1024 / 1024).toFixed(0)} MB used on this phone`));
  }, [queue?.photos]);
  if (!settings) return null;
  const save = async (p: Partial<typeof settings>) => {
    await db.settings.put({ ...settings, ...p, updatedAt: nowIso(), dirty: 1 });
    localChange();
  };
  return (
    <>
      <Header title="Settings" back="/" />
      <Screen>
        <SectionTitle>Account</SectionTitle>
        <Card>
          <p className="font-semibold">{user?.name}</p>
          <p className="text-slate-600 dark:text-slate-400 break-all">{user?.email}</p>
          <p className="text-sm mt-1">Role: landlord</p>
          <div className="flex gap-2 mt-3">
            {status.state === 'needs-sign-in' && (
              <Button kind="primary" onClick={() => signIn()}>
                Sign in again
              </Button>
            )}
            <Button kind="danger" onClick={() => window.confirm('Sign out? Anything not yet uploaded stays safely on this phone.') && signOut()}>
              Sign out
            </Button>
          </div>
        </Card>

        <SectionTitle>Sync</SectionTitle>
        <SyncBadge />
        <Card className="mt-2">
          <p>
            {queue?.photos ?? 0} photos and {queue?.entries ?? 0} entries waiting to upload.
          </p>
          {status.lastSyncAt && <p className="text-sm text-slate-600 dark:text-slate-400">Last synced {formatDateTime(status.lastSyncAt)}</p>}
          {status.lastError && <p className="text-sm text-red-700 dark:text-red-300">Last problem: {status.lastError}</p>}
          {queue?.errors.map((e) => (
            <p key={e} className="text-sm text-amber-800 dark:text-amber-200">
              Retrying: {e}
            </p>
          ))}
          <p className="text-sm text-slate-600 dark:text-slate-400 mt-2">
            On iPhone, uploads only run while the app is open. Keep it open until this says "All saved to OneDrive".
          </p>
          {storage && <p className="text-sm text-slate-600 dark:text-slate-400">{storage}</p>}
          <div className="flex flex-wrap gap-2 mt-3">
            <Button kind="primary" onClick={() => syncNow()} data-testid="sync-now">
              Sync now
            </Button>
            <Button onClick={() => resyncFromOneDrive()}>Re-read everything from OneDrive</Button>
          </div>
        </Card>

        <SectionTitle>Photos</SectionTitle>
        <Card>
          <p className="font-semibold mb-2">Date and time stamp on photos</p>
          <div className="grid grid-cols-2 gap-2 mb-4">
            <Chip selected={settings.dateStamp} onClick={() => save({ dateStamp: true })}>
              On
            </Chip>
            <Chip selected={!settings.dateStamp} onClick={() => save({ dateStamp: false })}>
              Off
            </Chip>
          </div>
          <p className="font-semibold mb-2">Photo size (longest edge)</p>
          <div className="grid grid-cols-3 gap-2">
            {[1600, 2048, 2560].map((n) => (
              <Chip key={n} selected={settings.maxEdge === n} onClick={() => save({ maxEdge: n })}>
                {n}px
              </Chip>
            ))}
          </div>
          <p className="text-sm text-slate-600 dark:text-slate-400 mt-2">2560px is about 0.5 to 1.5 MB per photo; every photo is kept under 2 MB.</p>
        </Card>

        <SectionTitle>Room templates</SectionTitle>
        <TemplatesEditor templates={settings.templates} onSave={(templates) => save({ templates })} />

        <SectionTitle>App</SectionTitle>
        <Card>
          <p className="text-sm break-all">Microsoft client ID: {getClientId() || 'not set'} {clientIdIsBakedIn() ? '' : '(set on this phone)'}</p>
          <p className="text-sm break-all">Redirect URI: {redirectUri()}</p>
          <p className="text-sm">Version 0.1.0 · phase 1 (landlord check-in)</p>
        </Card>
      </Screen>
    </>
  );
}

function TemplatesEditor({ templates, onSave }: { templates: RoomTemplate[]; onSave: (t: RoomTemplate[]) => void }) {
  const [open, setOpen] = useState<string | null>(null);
  const [text, setText] = useState('');
  return (
    <Card>
      <p className="text-sm text-slate-600 dark:text-slate-400 mb-3">
        Items suggested for each room when you start a check-in. One item per line. End an item with * if it only applies to furnished or part-furnished
        properties.
      </p>
      <div className="space-y-2">
        {templates.map((t) => (
          <div key={t.key}>
            <Button
              className="w-full justify-between"
              onClick={() => {
                setOpen(open === t.key ? null : t.key);
                setText(t.items.join('\n'));
              }}
            >
              <span>{t.name}</span>
              <span className="text-sm font-normal">{t.items.length} items</span>
            </Button>
            {open === t.key && (
              <div className="mt-2">
                <Field label={`${t.name} items`}>
                  <textarea className={inputCls + ' min-h-60 font-mono text-sm'} value={text} onChange={(e) => setText(e.target.value)} />
                </Field>
                <div className="flex gap-2">
                  <Button
                    kind="primary"
                    onClick={() => {
                      const items = text
                        .split('\n')
                        .map((x) => x.trim())
                        .filter(Boolean);
                      onSave(templates.map((x) => (x.key === t.key ? { ...x, items } : x)));
                      setOpen(null);
                    }}
                  >
                    Save
                  </Button>
                  <Button
                    onClick={() => {
                      const d = DEFAULT_TEMPLATES.find((x) => x.key === t.key);
                      if (d) setText(d.items.join('\n'));
                    }}
                  >
                    Reset to standard
                  </Button>
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
    </Card>
  );
}
