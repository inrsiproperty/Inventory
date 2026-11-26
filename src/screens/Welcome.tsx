import { useState } from 'react';
import { Button, Icon, inputCls } from '../components/ui';
import { authConfigured, signIn } from '../lib/auth';
import { redirectUri, setLocalClientId } from '../lib/config';

export function Welcome({ error, invited }: { error?: string; invited?: boolean }) {
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
        {invited ? (
          <>
            <p className="text-lg text-slate-700 dark:text-slate-300 mb-4">
              Your landlord has shared a property inventory with you. Go through it room by room, tell them if anything's not right, add your own photos,
              then sign.
            </p>
            <PrivacyNotice />
          </>
        ) : (
          <p className="text-lg text-slate-700 dark:text-slate-300">
            Photo-evidenced property inventories, made on your phone and saved in your own OneDrive.
          </p>
        )}
      </div>
      <div>
        {configured ? (
          <>
            <Button kind="primary" className="w-full text-lg h-14" onClick={go} disabled={busy} data-testid="sign-in">
              <Icon name="home" /> Sign in with Microsoft
            </Button>
            {invited ? (
              <p className="text-sm text-slate-600 dark:text-slate-400 mt-3">
                Sign in with the email address your landlord invited. No Microsoft account? Make a free one at <strong>signup.live.com</strong> with that
                email, then come back to this link.
              </p>
            ) : (
              <p className="text-sm text-slate-600 dark:text-slate-400 mt-3">
                You'll be asked once to let the app use your OneDrive. It only writes inside a folder called "Property Inventories". You need a
                connection for this first sign-in; after that the app works offline.
              </p>
            )}
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

/** Shown to tenants before they first sign in (UK GDPR). */
export function PrivacyNotice() {
  return (
    <details open className="rounded-2xl border border-slate-300 dark:border-slate-700 p-4 text-sm text-slate-700 dark:text-slate-300" data-testid="privacy-notice">
      <summary className="font-semibold text-base cursor-pointer">Privacy notice</summary>
      <div className="mt-2 space-y-2">
        <p>
          Your landlord is the data controller. This inventory is stored in your landlord's own OneDrive, in a folder shared only with the tenants of this
          property. Inventory App has no server of its own and doesn't receive your data.
        </p>
        <p>
          What's kept: your name, email address and Microsoft account ID, your signature, and the photos and comments you add. Every entry records who
          made it and when, and nothing can be deleted, so the record can be used as evidence about the property's condition and your deposit.
        </p>
        <p>
          Your landlord decides how long it's kept after the tenancy ends. Please avoid photographing people or personal belongings. You can ask your
          landlord for a copy of your data or about how it's used.
        </p>
      </div>
    </details>
  );
}
