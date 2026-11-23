import { useEffect, useState, type ReactNode } from 'react';
import { ReportIssueFab, UIProvider } from './components/Overlays';
import { initAuth } from './lib/auth';
import { currentUser, db, getKV, getSettings, setKV, useLive } from './lib/db';
import { getMe } from './lib/graph';
import { useRoute } from './lib/router';
import { countPending, startSyncEngine } from './lib/sync';
import { InventoryScreen, IssuesScreen, ItemScreen, ExportScreen, RoomScreen } from './screens/Inventory';
import { PropertiesScreen, PropertyFormScreen, PropertyScreen, TenancyFormScreen } from './screens/Properties';
import { SettingsScreen } from './screens/Settings';
import { Welcome } from './screens/Welcome';

/** Signs in (if a Microsoft redirect just came back) and records who the landlord is. Works offline once set up. */
function useSession() {
  const [state, setState] = useState<{ ready: boolean; signedIn: boolean; error?: string }>({ ready: false, signedIn: false });
  useEffect(() => {
    (async () => {
      await getSettings();
      let error: string | undefined;
      try {
        const account = await initAuth();
        const known = await currentUser();
        if (account && navigator.onLine && (!known || (await getKV<string>('accountHomeId')) !== account.homeAccountId)) {
          const me = await getMe();
          await db.participants.put({
            id: me.id,
            name: me.displayName || account.name || account.username,
            email: me.mail || me.userPrincipalName || account.username,
            role: 'landlord',
            msAccountId: me.id,
          });
          await setKV('currentUserId', me.id);
          await setKV('accountHomeId', account.homeAccountId);
        }
      } catch (e) {
        console.error(e);
        error = e instanceof Error ? e.message : 'Sign-in failed';
      }
      const user = await currentUser();
      setState({ ready: true, signedIn: !!user, error });
      if (user) startSyncEngine();
    })();
  }, []);
  return state;
}

function Routes() {
  const r = useRoute();
  const [a, b, c, d] = r;
  // Context for the Report issue button: wherever you are.
  let issueCtx: { inventoryId?: string; roomId?: string; itemId?: string } = {};
  let screen: ReactNode;
  if (a === 'property' && b === 'new') screen = <PropertyFormScreen />;
  else if (a === 'property' && b && c === 'edit') screen = <PropertyFormScreen id={b} />;
  else if (a === 'property' && b && c === 'tenancy' && d === 'new') screen = <TenancyFormScreen propertyId={b} />;
  else if (a === 'property' && b) screen = <PropertyScreen id={b} />;
  else if (a === 'tenancy' && b && c === 'edit') screen = <TenancyFormScreen id={b} />;
  else if (a === 'inventory' && b) {
    issueCtx = { inventoryId: b };
    if (c === 'room' && d) {
      issueCtx.roomId = d;
      screen = <RoomScreen id={b} roomId={d} />;
    } else if (c === 'item' && d) {
      issueCtx.itemId = d;
      screen = <ItemScreen key={d} id={b} itemId={d} />;
    } else if (c === 'issues') screen = <IssuesScreen id={b} />;
    else if (c === 'export') screen = <ExportScreen id={b} />;
    else screen = <InventoryScreen id={b} />;
  } else if (a === 'settings') screen = <SettingsScreen />;
  else screen = <PropertiesScreen />;
  return (
    <>
      {screen}
      <ReportIssueFab ctx={issueCtx} />
    </>
  );
}

export default function App() {
  const s = useSession();
  // Warn before leaving while uploads are waiting (iPhone can't upload in the background).
  const waiting = useLive(async () => {
    const c = await countPending();
    return c.pendingPhotos + c.pendingChanges;
  }, []);
  useEffect(() => {
    const h = (e: BeforeUnloadEvent) => {
      if (waiting) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [waiting]);

  if (!s.ready) return <div className="min-h-dvh flex items-center justify-center text-slate-500">Loading…</div>;
  if (!s.signedIn) return <Welcome error={s.error} />;
  return (
    <UIProvider>
      <Routes />
    </UIProvider>
  );
}
