// TEST-ONLY stand-in for @azure/msal-browser. Simulates the redirect sign-in flow
// (tokens kept in sessionStorage, like the real configuration) against the mock Graph server.
// The test picks who signs in with localStorage["fake-user"] = landlord | tenant | stranger.

const KEY = 'fake-msal-signed-in';
function who() {
  return (localStorage.getItem('fake-user') || 'landlord') as 'landlord' | 'tenant' | 'stranger';
}
const ACCOUNTS = {
  landlord: { homeAccountId: 'home-landlord', localAccountId: 'local-landlord', username: 'landlord@example.com', name: 'Test Landlord' },
  tenant: { homeAccountId: 'home-tenant', localAccountId: 'local-tenant', username: 'alex.morgan@example.com', name: 'Alex Morgan' },
  stranger: { homeAccountId: 'home-stranger', localAccountId: 'local-stranger', username: 'sam.stranger@example.com', name: 'Sam Stranger' },
};
const TOKENS = { landlord: 'fake-token', tenant: 'fake-token-tenant', stranger: 'fake-token-stranger' };
function account() {
  return { ...ACCOUNTS[who()], environment: 'login.microsoftonline.com', tenantId: '9188040d-6c67-4c5b-b112-36a304b66dad' };
}

export class InteractionRequiredAuthError extends Error {}
export type AccountInfo = ReturnType<typeof account>;

export class PublicClientApplication {
  constructor(public config: unknown) {
    (window as unknown as { __msalConfig: unknown }).__msalConfig = config;
  }
  async initialize() {}
  async handleRedirectPromise() {
    if (location.hash.startsWith('#code=fake')) {
      sessionStorage.setItem(KEY, '1');
      history.replaceState(null, '', location.pathname + location.search);
      return { account: account(), accessToken: TOKENS[who()] };
    }
    return null;
  }
  getActiveAccount() {
    return sessionStorage.getItem(KEY) ? account() : null;
  }
  setActiveAccount(_a?: unknown) {}
  getAllAccounts() {
    return sessionStorage.getItem(KEY) ? [account()] : [];
  }
  async loginRedirect(_r?: unknown) {
    // Like the real redirect, the page's hash route is lost on the way back.
    history.replaceState(null, '', location.pathname + '#code=fake');
    location.reload();
    await new Promise(() => undefined);
  }
  async acquireTokenSilent(_r?: unknown) {
    if (!sessionStorage.getItem(KEY)) throw new InteractionRequiredAuthError('interaction_required');
    return { accessToken: TOKENS[who()] };
  }
  async logoutRedirect(_r?: unknown) {
    sessionStorage.removeItem(KEY);
    location.reload();
  }
}
