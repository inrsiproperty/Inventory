import { useEffect, useState } from 'react';

// Hash-based routing: works on GitHub Pages (no server rewrites) and offline.
// Routes look like #/inventory/<id>/room/<roomId>

function read(): string[] {
  const h = window.location.hash;
  if (!h.startsWith('#/')) return []; // includes MSAL's #code=... responses
  return h
    .slice(2)
    .split('?')[0]
    .split('/')
    .filter(Boolean)
    .map(decodeURIComponent);
}

export function useRoute(): string[] {
  const [parts, setParts] = useState(read);
  useEffect(() => {
    const on = () => {
      setParts(read());
      window.scrollTo(0, 0);
    };
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return parts;
}

export function go(path: string, replace = false) {
  const h = '#' + (path.startsWith('/') ? path : '/' + path);
  if (replace) {
    history.replaceState(null, '', h);
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  } else window.location.hash = h;
}
