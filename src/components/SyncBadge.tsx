import { signIn } from '../lib/auth';
import { go } from '../lib/router';
import { useSyncStatus } from '../lib/sync';
import { classNames, plural } from '../lib/util';
import { Icon } from './ui';

/** Always shows what is saved and what is still waiting to upload. */
export function SyncBadge({ compact }: { compact?: boolean }) {
  const s = useSyncStatus();
  const waiting = s.pendingPhotos + s.pendingChanges;
  let text: string;
  let icon = 'cloud';
  let tone = 'bg-green-50 text-green-900 border-green-300 dark:bg-green-950 dark:text-green-100 dark:border-green-800';
  const parts: string[] = [];
  if (s.pendingPhotos) parts.push(`${plural(s.pendingPhotos, 'photo')}`);
  if (s.pendingChanges) parts.push(`${plural(s.pendingChanges, 'change')}`);
  const what = parts.join(' and ');

  if (!s.counted) {
    text = 'Checking what is saved…';
    icon = 'sync';
    tone = 'bg-slate-100 text-slate-800 border-slate-300 dark:bg-slate-800 dark:text-slate-100 dark:border-slate-600';
  } else if (s.state === 'not-configured') {
    text = 'Saved on this phone (OneDrive not set up)';
    icon = 'cloudOff';
    tone = 'bg-slate-100 text-slate-800 border-slate-300 dark:bg-slate-800 dark:text-slate-100 dark:border-slate-600';
  } else if (s.state === 'needs-sign-in') {
    text = waiting ? `${what} saved on phone · Sign in to sync` : 'Sign in to sync';
    icon = 'cloudOff';
    tone = 'bg-amber-50 text-amber-950 border-amber-400 dark:bg-amber-950 dark:text-amber-100 dark:border-amber-700';
  } else if (s.state === 'offline') {
    text = waiting ? `Offline · ${what} saved on phone` : 'Offline · everything is saved on this phone';
    icon = 'cloudOff';
    tone = 'bg-slate-100 text-slate-800 border-slate-300 dark:bg-slate-800 dark:text-slate-100 dark:border-slate-600';
  } else if (waiting) {
    text = s.detail && s.state === 'syncing' ? `${s.detail} · ${what} waiting` : `${what} waiting to upload`;
    icon = 'upload';
    tone = 'bg-blue-50 text-blue-950 border-blue-300 dark:bg-blue-950 dark:text-blue-100 dark:border-blue-800';
    if (s.state === 'error') text += ' · will retry';
  } else if (s.state === 'syncing') {
    text = 'Checking OneDrive…';
    icon = 'sync';
  } else if (s.state === 'error') {
    text = 'Sync problem · will retry';
    icon = 'alert';
    tone = 'bg-amber-50 text-amber-950 border-amber-400 dark:bg-amber-950 dark:text-amber-100 dark:border-amber-700';
  } else {
    text = 'All saved to OneDrive';
    icon = 'check';
  }

  const onClick = () => {
    if (s.state === 'needs-sign-in') void signIn();
    else go('/settings');
  };

  return (
    <button
      onClick={onClick}
      data-testid="sync-badge"
      data-state={s.counted ? s.state : 'checking'}
      data-waiting={waiting}
      className={classNames('tap w-full flex items-center gap-2 rounded-xl border px-3 text-left text-sm font-semibold', tone, compact && 'min-h-10')}
      aria-live="polite"
    >
      <Icon name={icon} className={classNames('w-5 h-5 shrink-0', s.state === 'syncing' && 'animate-pulse')} />
      <span className="flex-1">{text}</span>
    </button>
  );
}

/** Small always-visible indicator for the header of every screen. */
export function SyncDot() {
  const s = useSyncStatus();
  const waiting = s.pendingPhotos + s.pendingChanges;
  const ok = s.counted && !waiting && s.state === 'idle';
  const label = ok ? 'All saved to OneDrive' : waiting ? `${waiting} waiting to upload` : s.state === 'offline' ? 'Offline' : 'Sync status';
  return (
    <button
      onClick={() => (s.state === 'needs-sign-in' ? void signIn() : go('/settings'))}
      className="tap relative rounded-full p-2 text-slate-700 dark:text-slate-200"
      aria-label={label}
      title={label}
      data-testid="sync-dot"
      data-last={s.lastSyncAt || ''}
      data-state={s.counted ? s.state : 'checking'}
      data-waiting={waiting}
    >
      <Icon name={ok ? 'cloud' : s.state === 'offline' || s.state === 'needs-sign-in' ? 'cloudOff' : 'upload'} />
      {ok && <Icon name="check" className="absolute bottom-1.5 right-1.5 w-3.5 h-3.5 text-green-700 dark:text-green-400" />}
      {waiting > 0 && (
        <span className="absolute -top-0.5 -right-0.5 min-w-5 h-5 rounded-full bg-blue-700 text-white text-[11px] font-bold flex items-center justify-center px-1">
          {waiting > 999 ? '999+' : waiting}
        </span>
      )}
    </button>
  );
}
