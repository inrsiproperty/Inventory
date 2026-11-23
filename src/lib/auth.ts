import {
  InteractionRequiredAuthError,
  PublicClientApplication,
  type AccountInfo,
} from '@azure/msal-browser';
import { SCOPES, getClientId, redirectUri } from './config';

// Sign-in with the Microsoft identity platform via MSAL.js.
// "common" authority = personal Microsoft accounts AND work or school accounts.
// Tokens live in sessionStorage (spec: "kept in session storage, not long-term on the device").

let pca: PublicClientApplication | null = null;
let ready: Promise<AccountInfo | null> | null = null;

export function authConfigured() {
  return !!getClientId();
}

export function initAuth(): Promise<AccountInfo | null> {
  if (ready) return ready;
  ready = (async () => {
    const clientId = getClientId();
    if (!clientId) return null;
    pca = new PublicClientApplication({
      auth: {
        clientId,
        authority: 'https://login.microsoftonline.com/common',
        redirectUri: redirectUri(),
        postLogoutRedirectUri: redirectUri(),
        navigateToLoginRequestUrl: false,
      },
      cache: { cacheLocation: 'sessionStorage' },
    });
    await pca.initialize();
    try {
      const res = await pca.handleRedirectPromise();
      if (res?.account) pca.setActiveAccount(res.account);
    } catch (e) {
      console.warn('Sign-in redirect could not be completed', e);
    }
    if (!pca.getActiveAccount()) {
      const all = pca.getAllAccounts();
      if (all.length) pca.setActiveAccount(all[0]);
    }
    return pca.getActiveAccount();
  })();
  return ready;
}

export function activeAccount(): AccountInfo | null {
  return pca?.getActiveAccount() ?? null;
}

export async function signIn(): Promise<void> {
  await initAuth();
  if (!pca) throw new Error('The app has no Microsoft client ID yet.');
  await pca.loginRedirect({ scopes: SCOPES, prompt: 'select_account' });
}

export async function signOut(): Promise<void> {
  await initAuth();
  if (!pca) return;
  const account = pca.getActiveAccount() ?? undefined;
  // Local data stays on the phone; the app just forgets who is signed in.
  const { setKV } = await import('./db');
  await setKV('currentUserId', null);
  await setKV('accountHomeId', null);
  await pca.logoutRedirect({ account });
}

/** Returns an access token, or null if the user needs to sign in again. Never opens a window by itself. */
export async function getToken(): Promise<string | null> {
  await initAuth();
  const account = pca?.getActiveAccount();
  if (!pca || !account) return null;
  try {
    const r = await pca.acquireTokenSilent({ scopes: SCOPES, account });
    return r.accessToken;
  } catch (e) {
    if (e instanceof InteractionRequiredAuthError) return null;
    // Offline: MSAL can't refresh. Treat as "can't get a token right now".
    console.warn('Silent token failed', e);
    return null;
  }
}
