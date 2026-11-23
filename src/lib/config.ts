// App-wide configuration.
//
// The Microsoft Entra "Application (client) ID" is normally baked in at build time
// from the VITE_MSAL_CLIENT_ID variable (set as a GitHub repository variable called
// MSAL_CLIENT_ID). If it is missing, the welcome screen lets the owner paste it in,
// and it is kept on this device only.

const CLIENT_ID_KEY = 'inventory.clientId';

export function getClientId(): string {
  const baked = (import.meta.env.VITE_MSAL_CLIENT_ID as string | undefined) || '';
  if (baked.trim()) return baked.trim();
  try {
    return localStorage.getItem(CLIENT_ID_KEY) || '';
  } catch {
    return '';
  }
}

export function clientIdIsBakedIn(): boolean {
  return !!((import.meta.env.VITE_MSAL_CLIENT_ID as string | undefined) || '').trim();
}

export function setLocalClientId(id: string) {
  try {
    localStorage.setItem(CLIENT_ID_KEY, id.trim());
  } catch {
    /* ignore */
  }
}

/** The address Microsoft sends people back to after sign-in. Must match the Entra redirect URI exactly. */
export function redirectUri(): string {
  return window.location.origin + import.meta.env.BASE_URL;
}

// Scopes from the spec. offline_access is also added by MSAL automatically.
export const SCOPES = ['User.Read', 'Files.ReadWrite.All', 'offline_access'];

export const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';

/** Top-level OneDrive folder that holds everything the app writes. */
export const ROOT_FOLDER = 'Property Inventories';

export const APP_NAME = 'Inventory App';
