import { useState } from 'react';
import { Button, Icon, inputCls } from '../components/ui';
import { authConfigured, signIn } from '../lib/auth';
import { redirectUri, setLocalClientId } from '../lib/config';

export function Welcome({ error }: { error?: string }) {
  const [configured, setConfigured] = useState(authConfigured());
  const [clientId, setClientId] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(error);
  const go = async () => {
    setBusy(true);
    setErr(undefined);
    try {
      await signIn();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Sign-in failed');
      setBusy(false);
    }
  };
  return (
    <main className="min-h-dvh flex flex-col justify-between px-6 pt-[max(3rem,env(safe-area-inset-top))] pb-[max(2rem,env(safe-area-inset-bottom))] max-w-md mx-auto">
      <div>
        <img src={import.meta.env.BASE_URL + 'icon-192.png'} alt="" className="w-20 h-20 rounded-3xl mb-6" />
        <h1 className="text-4xl font-bold mb-3">Inventory App</h1>
        <p className="text-lg text-slate-700 dark:text-slate-300">
          Photo-evidenced property inventories, made on your phone and saved in your own OneDrive.
        </p>
      </div>
      <div>
        {configured ? (
          <>
            <Button kind="primary" className="w-full text-lg h-14" onClick={go} disabled={busy} data-testid="sign-in">
              <Icon name="home" /> Sign in with Microsoft
            </Button>
            <p className="text-sm text-slate-600 dark:text-slate-400 mt-3">
              You'll be asked once to let the app use your OneDrive. It only writes inside a folder called "Property Inventories". You need a
              connection for this first sign-in; after that the app works offline.
            </p>
          </>
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (!/^[0-9a-f-]{36}$/i.test(clientId.trim())) return setErr('That doesn\'t look like an Application (client) ID.');
              setLocalClientId(clientId);
              setConfigured(true);
              window.location.reload();
            }}
          >
            <p className="font-semibold mb-2">One-off setup</p>
            <p className="text-sm text-slate-600 dark:text-slate-400 mb-3">
              Paste the Application (client) ID from your Microsoft Entra app registration. Its redirect URI must be <code className="break-all">{redirectUri()}</code>
            </p>
            <input className={inputCls + ' mb-3'} value={clientId} onChange={(e) => setClientId(e.target.value)} placeholder="00000000-0000-0000-0000-000000000000" aria-label="Application (client) ID" />
            <Button kind="primary" className="w-full h-14" type="submit">
              Save
            </Button>
          </form>
        )}
        {err && <p className="text-red-700 dark:text-red-300 mt-3">{err}</p>}
      </div>
    </main>
  );
}
