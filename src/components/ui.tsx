import { useEffect, useState, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { db, useLive } from '../lib/db';
import { go } from '../lib/router';
import { classNames } from '../lib/util';
import { SyncDot } from './SyncBadge';

// ---------- Icons (inline SVG, labelled by their buttons) ----------

const paths: Record<string, string> = {
  camera:
    'M4 8.5A2.5 2.5 0 0 1 6.5 6h1.6l1.2-1.8A1.5 1.5 0 0 1 10.5 3.5h3a1.5 1.5 0 0 1 1.2.7L15.9 6h1.6A2.5 2.5 0 0 1 20 8.5v8a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 4 16.5zM12 16a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z',
  back: 'M15 5l-7 7 7 7',
  next: 'M9 5l7 7-7 7',
  plus: 'M12 5v14M5 12h14',
  alert: 'M12 3l9.5 17h-19zM12 10v4M12 17.5v.5',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  cloud: 'M7 18a4.5 4.5 0 0 1-.5-9 6 6 0 0 1 11.6 1.5A3.75 3.75 0 0 1 17.5 18z',
  cloudOff: 'M7 18a4.5 4.5 0 0 1-.5-9 6 6 0 0 1 11.6 1.5A3.75 3.75 0 0 1 17.5 18zM3 3l18 18',
  upload: 'M12 16V5M7.5 9.5 12 5l4.5 4.5M5 19h14',
  gear: 'M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM19.4 13.5l1.6 1.2-2 3.4-1.9-.7a7 7 0 0 1-1.7 1l-.3 2h-4l-.3-2a7 7 0 0 1-1.7-1l-1.9.7-2-3.4 1.6-1.2a7 7 0 0 1 0-3L3 9.3l2-3.4 1.9.7a7 7 0 0 1 1.7-1l.3-2h4l.3 2a7 7 0 0 1 1.7 1l1.9-.7 2 3.4-1.6 1.2a7 7 0 0 1 0 3z',
  image: 'M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v11a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 4 17.5zM4 16l4.5-4.5 4 4 2.5-2.5L20 17.5M15 9.5h.01',
  walk: 'M13 4.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zM10 22l2-7 3 3v4M8 12l2-4 4 1 2 4 3 1M10 8 7 9l-1 4',
  file: 'M7 3h7l5 5v13H7zM14 3v5h5M10 13h6M10 17h6',
  edit: 'M4 20h4L19 9l-4-4L4 16zM14 6l4 4',
  trash: 'M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13',
  up: 'M12 19V5M6 11l6-6 6 6',
  down: 'M12 5v14M6 13l6 6 6-6',
  x: 'M6 6l12 12M18 6 6 18',
  share: 'M12 15V4M7.5 8.5 12 4l4.5 4.5M5 13v6h14v-6',
  home: 'M3 11l9-7 9 7v9h-6v-6H9v6H3z',
  list: 'M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01',
  sync: 'M4 12a8 8 0 0 1 14-5.3M20 12a8 8 0 0 1-14 5.3M18 3v4h-4M6 21v-4h4',
};

export function Icon({ name, className = 'w-6 h-6 shrink-0' }: { name: keyof typeof paths | string; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d={paths[name] || ''} />
    </svg>
  );
}

// ---------- Layout ----------

export function Header({ title, back, sub, right }: { title: string; back?: string; sub?: string; right?: ReactNode }) {
  return (
    <header className="sticky top-0 z-20 bg-white/95 dark:bg-slate-950/95 backdrop-blur border-b border-slate-200 dark:border-slate-800 pt-[env(safe-area-inset-top)]">
      <div className="flex items-center gap-1 px-2 min-h-14">
        {back !== undefined ? (
          <button className="tap rounded-full p-2 text-slate-700 dark:text-slate-200" aria-label="Back" onClick={() => go(back)}>
            <Icon name="back" />
          </button>
        ) : (
          <div className="w-2" />
        )}
        <div className="flex-1 min-w-0 py-2">
          <h1 className="text-lg font-semibold leading-tight truncate">{title}</h1>
          {sub && <p className="text-sm text-slate-600 dark:text-slate-400 truncate">{sub}</p>}
        </div>
        {right}
        <SyncDot />
      </div>
    </header>
  );
}

export function Screen({ children, bottom }: { children: ReactNode; bottom?: ReactNode }) {
  return (
    <>
      <main className={classNames('mx-auto max-w-2xl px-4 pt-4', bottom ? 'pb-44' : 'pb-28')}>{children}</main>
      {bottom && (
        <div className="fixed inset-x-0 bottom-0 z-20 border-t border-slate-200 dark:border-slate-800 bg-white/95 dark:bg-slate-950/95 backdrop-blur pb-[max(0.75rem,env(safe-area-inset-bottom))]">
          <div className="mx-auto max-w-2xl px-4 pt-3 flex gap-3">{bottom}</div>
        </div>
      )}
    </>
  );
}

type BtnKind = 'primary' | 'secondary' | 'ghost' | 'danger';
export function Button({
  kind = 'secondary',
  className,
  children,
  ...rest
}: { kind?: BtnKind } & ButtonHTMLAttributes<HTMLButtonElement>) {
  const k = {
    primary: 'bg-blue-700 text-white active:bg-blue-800 disabled:bg-slate-400',
    secondary: 'bg-slate-100 text-slate-900 dark:bg-slate-800 dark:text-slate-100 active:bg-slate-200 dark:active:bg-slate-700',
    ghost: 'text-blue-700 dark:text-blue-300 active:bg-slate-100 dark:active:bg-slate-800',
    danger: 'bg-red-50 text-red-800 dark:bg-red-950 dark:text-red-200',
  }[kind];
  return (
    <button
      className={classNames('tap inline-flex items-center justify-center gap-2 rounded-xl px-4 font-semibold whitespace-nowrap disabled:opacity-60', k, className)}
      {...rest}
    >
      {children}
    </button>
  );
}

export function Chip({
  selected,
  onClick,
  children,
  tone = 'blue',
  label,
}: {
  selected?: boolean;
  onClick?: () => void;
  children: ReactNode;
  tone?: 'blue' | 'red' | 'amber' | 'green';
  label?: string;
}) {
  const on = {
    blue: 'bg-blue-700 text-white border-blue-700',
    red: 'bg-red-700 text-white border-red-700',
    amber: 'bg-amber-500 text-black border-amber-500',
    green: 'bg-green-700 text-white border-green-700',
  }[tone];
  return (
    <button
      type="button"
      aria-pressed={!!selected}
      aria-label={label}
      onClick={onClick}
      className={classNames(
        'tap relative rounded-xl border-2 px-2 py-1 text-base font-semibold flex items-center justify-center text-center leading-tight break-words',
        selected ? on : 'border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100',
      )}
    >
      {selected && <Icon name="check" className="absolute top-1 left-1 w-4 h-4" />}
      <span>{children}</span>
    </button>
  );
}

export function Card({ children, className, onClick }: { children: ReactNode; className?: string; onClick?: () => void }) {
  const Tag = onClick ? 'button' : 'div';
  return (
    <Tag
      onClick={onClick}
      className={classNames(
        'block w-full text-left rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4',
        onClick && 'active:bg-slate-50 dark:active:bg-slate-800',
        className,
      )}
    >
      {children}
    </Tag>
  );
}

export function Field({ label, hint, children, group }: { label: string; hint?: string; children: ReactNode; group?: boolean }) {
  const inner = (
    <>
      <span className="block text-sm font-semibold mb-1 text-slate-700 dark:text-slate-300">{label}</span>
      {children}
      {hint && <span className="block text-sm text-slate-500 mt-1">{hint}</span>}
    </>
  );
  // A <label> wrapping several buttons would rename them all, so groups use role="group".
  return group ? (
    <div className="block mb-4" role="group" aria-label={label}>
      {inner}
    </div>
  ) : (
    <label className="block mb-4">{inner}</label>
  );
}

export const inputCls =
  'w-full rounded-xl border-2 border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900 px-3 py-3 text-base focus:border-blue-600 outline-none';

export function SectionTitle({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <div className="flex items-center justify-between mt-6 mb-2">
      <h2 className="text-sm font-bold uppercase tracking-wide text-slate-600 dark:text-slate-400">{children}</h2>
      {right}
    </div>
  );
}

export function Progress({ value, total, label }: { value: number; total: number; label: string }) {
  const pct = total ? Math.round((value / total) * 100) : 0;
  return (
    <div>
      <div className="flex justify-between text-sm mb-1">
        <span>{label}</span>
        <span className="font-semibold">
          {value}/{total}
        </span>
      </div>
      <div className="h-2.5 rounded-full bg-slate-200 dark:bg-slate-800 overflow-hidden" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label={label}>
        <div className="h-full bg-blue-700" style={{ width: pct + '%' }} />
      </div>
    </div>
  );
}

export function Sheet({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: string; children: ReactNode }) {
  useEffect(() => {
    if (!open) return;
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center" role="dialog" aria-modal="true" aria-label={title}>
      <button className="absolute inset-0 bg-black/50" aria-label="Close" onClick={onClose} />
      <div className="relative w-full max-w-2xl max-h-[92vh] overflow-y-auto rounded-t-3xl bg-white dark:bg-slate-900 px-4 pt-3 pb-[max(1rem,env(safe-area-inset-bottom))]">
        <div className="mx-auto mb-2 h-1.5 w-12 rounded-full bg-slate-300 dark:bg-slate-700" />
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-xl font-bold">{title}</h2>
          <button className="tap rounded-full p-2" aria-label="Close" onClick={onClose}>
            <Icon name="x" />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

/** Shows a photo's thumbnail from the phone's local store. */
export function Thumb({ photoId, className, alt }: { photoId: string; className?: string; alt?: string }) {
  const rec = useLive(() => db.blobs.get(`${photoId}:thumb`), [photoId]);
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    if (!rec?.blob) return;
    const u = URL.createObjectURL(rec.blob);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [rec]);
  if (!url)
    return (
      <div className={classNames('bg-slate-200 dark:bg-slate-800 flex items-center justify-center text-slate-500', className)} aria-label={alt || 'Photo in OneDrive'}>
        <Icon name="image" className="w-6 h-6" />
      </div>
    );
  return <img src={url} alt={alt || 'Photo'} className={classNames('object-cover', className)} />;
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="rounded-2xl border-2 border-dashed border-slate-300 dark:border-slate-700 p-6 text-center text-slate-600 dark:text-slate-400">{children}</div>;
}

/** Opens the phone's camera (capture) or gallery via a hidden file input. Must be called from a tap. */
export function pickImages(opts: { capture: boolean; multiple?: boolean }): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    if (opts.capture) input.setAttribute('capture', 'environment');
    if (opts.multiple) input.multiple = true;
    input.style.display = 'none';
    input.dataset.testid = opts.capture ? 'capture-input' : 'gallery-input';
    document.body.appendChild(input);
    let done = false;
    const finish = (files: File[]) => {
      if (done) return;
      done = true;
      input.remove();
      resolve(files);
    };
    input.addEventListener('change', () => finish(Array.from(input.files || [])));
    input.addEventListener('cancel', () => finish([]));
    input.click();
  });
}
