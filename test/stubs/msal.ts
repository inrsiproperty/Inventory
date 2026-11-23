// TEST-ONLY stand-in for @azure/msal-browser. Simulates the redirect sign-in flow
// (tokens kept in sessionStorage, like the real configuration) against the mock Graph server.

const KEY = 'fake-msal-signed-in';
const ACCOUNT = {
  homeAccountId: 'home-test-landlord',
  localAccountId: 'local-test-landlord',
  username: 'landlord@example.com',
  name: 'Test Landlord',
  environment: 'login.microsoftonline.com',
  tenantId: '9188040d-6c67-4c5b-b112-36a304b66dad',
};

export class InteractionRequiredAuthError extends Error {}
export type AccountInfo = typeof ACCOUNT;

export class PublicClientApplication {
  constructor(public config: unknown) {
    (window as unknown as { __msalConfig: unknown }).__msalConfig = config;
  }
  async initialize() {}
  async handleRedirectPromise() {
    if (location.hash.startsWith('#code=fake')) {
      sessionStorage.setItem(KEY, '1');
      history.replaceState(null, '', location.pathname + location.search);
      return { account: ACCOUNT, accessToken: 'fake-token' };
    }
    return null;
  }
  getActiveAccount() {
    return sessionStorage.getItem(KEY) ? ACCOUNT : null;
  }
  setActiveAccount(_a?: unknown) {}
  getAllAccounts() {
    return sessionStorage.getItem(KEY) ? [ACCOUNT] : [];
  }
  async loginRedirect(_r?: unknown) {
    history.replaceState(null, '', location.pathname + '#code=fake');
    location.reload();
    await new Promise(() => undefined);
  }
  async acquireTokenSilent(_r?: unknown) {
    if (!sessionStorage.getItem(KEY)) throw new InteractionRequiredAuthError('interaction_required');
    return { accessToken: 'fake-token' };
  }
  async logoutRedirect(_r?: unknown) {
    sessionStorage.removeItem(KEY);
    location.reload();
  }
}
