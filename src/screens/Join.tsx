import { useEffect, useState } from 'react';
import { Button, Header, Screen } from '../components/ui';
import { joinProperty } from '../lib/actions';
import { signOut } from '../lib/auth';
import { currentUser, db, useLive } from '../lib/db';
import { go } from '../lib/router';
import { syncNow } from '../lib/sync';

const KEY = 'inventory.pendingJoin';

export function savePendingJoin(driveId: string, folderId: string) {
  try {
    localStorage.setItem(KEY, JSON.stringify({ driveId, folderId }));
  } catch {
    /* ignore */
  }
}

export function pendingJoin(): { driveId: string; folderId: string } | null {
  try {
    const v = localStorage.getItem(KEY);
    return v ? JSON.parse(v) : null;
  } catch {
    return null;
  }
}

function clearPendingJoin() {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}

/** Tenant opened an invite link: find the shared property folder and load it. */
export function JoinScreen() {
  const user = useLive(() => currentUser(), []);
  const [err, setErr] = useState<string>();
  const [busy, setBusy] = useState(true);
  const [attempt, setAttempt] = useState(0);
  const [stage, setStage] = useState('Finding the property your landlord shared…');
  useEffect(() => {
    const j = pendingJoin();
    if (!j) {
      go('/', true);
      return;
    }
    if (!navigator.onLine) {
      setErr("You need a connection to open the invitation the first time. Once it's loaded, the inventory works offline.");
      setBusy(false);
      return;
    }
    setBusy(true);
    setErr(undefined);
    joinProperty(j.driveId, j.folderId)
      .then(async (propertyId) => {
        clearPendingJoin();
        setStage('Loading the inventory from OneDrive…');
        await syncNow().catch(() => undefined);
        // Open the inventory straight away if it's already here; otherwise the property page fills in as it syncs.
        const inv = (await db.inventories.where('propertyId').equals(propertyId).toArray()).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
        go(inv ? `/inventory/${inv.id}` : `/property/${propertyId}`, true);
      })
      .catch((e) => {
        setErr(e instanceof Error ? e.message : 'Could not open the invitation.');
        setBusy(false);
      });
  }, [attempt]);
  return (
    <>
      <Header title="Opening your invitation" />
      <Screen>
        {busy && (
          <p className="text-lg" data-testid="joining">
            {stage}
          </p>
        )}
        {err && (
          <div className="space-y-3" data-testid="join-error">
            <p className="text-red-800 dark:text-red-200 text-lg">{err}</p>
            {user && <p className="text-sm">Signed in as {user.email}.</p>}
            <div className="flex flex-wrap gap-2">
              <Button kind="primary" onClick={() => setAttempt((n) => n + 1)}>
                Try again
              </Button>
              <Button onClick={() => signOut()}>Sign in with a different account</Button>
              <Button
                kind="ghost"
                onClick={() => {
                  clearPendingJoin();
                  go('/', true);
                }}
              >
                Cancel
              </Button>
            </div>
          </div>
        )}
      </Screen>
    </>
  );
}
