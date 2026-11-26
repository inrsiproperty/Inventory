// TEST-ONLY build. Bundles the real app source with esbuild, swapping in local stand-ins
// for the four npm packages that could not be downloaded here (dexie, @azure/msal-browser,
// browser-image-compression, vite-plugin-pwa). Tailwind CSS is compiled with the real
// tailwindcss package. The production build is `npm run build` (Vite) — see README.
import { build } from 'esbuild';
import { compile } from 'tailwindcss';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const out = path.join(root, 'test-dist');
const NM = '/opt/npm-tools/node_modules';
await fs.rm(out, { recursive: true, force: true });
await fs.mkdir(path.join(out, 'assets'), { recursive: true });

const stubs = {
  dexie: 'test/stubs/dexie.ts',
  '@azure/msal-browser': 'test/stubs/msal.ts',
  'browser-image-compression': 'test/stubs/image-compression.ts',
  'virtual:pwa-register': 'test/stubs/pwa-register.ts',
  signature_pad: 'test/stubs/signature-pad.ts',
};

const aliasPlugin = {
  name: 'alias',
  setup(b) {
    b.onResolve({ filter: /^(dexie|@azure\/msal-browser|browser-image-compression|virtual:pwa-register|signature_pad)$/ }, (a) => ({ path: path.join(root, stubs[a.path]) }));
    b.onResolve({ filter: /\.css$/ }, () => ({ path: 'ignored-css', namespace: 'css-stub' }));
    b.onLoad({ filter: /.*/, namespace: 'css-stub' }, () => ({ contents: '', loader: 'js' }));
  },
};

const res = await build({
  entryPoints: [path.join(root, 'src/main.tsx')],
  bundle: true,
  format: 'esm',
  target: 'es2020',
  jsx: 'automatic',
  outfile: path.join(out, 'assets/app.js'),
  nodePaths: [NM],
  plugins: [aliasPlugin],
  define: {
    'import.meta.env.VITE_MSAL_CLIENT_ID': JSON.stringify(process.env.CLIENT_ID ?? '11111111-2222-3333-4444-555555555555'),
    'import.meta.env.BASE_URL': JSON.stringify('/'),
    'process.env.NODE_ENV': '"production"',
  },
  minify: false,
  sourcemap: false,
  metafile: true,
  logLevel: 'warning',
});

// Tailwind: scan the source for class names, compile with the real tailwindcss package.
const srcFiles = [];
async function walk(d) {
  for (const e of await fs.readdir(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) await walk(p);
    else if (/\.(tsx?|html)$/.test(e.name)) srcFiles.push(p);
  }
}
await walk(path.join(root, 'src'));
const candidates = new Set();
for (const f of srcFiles) for (const m of (await fs.readFile(f, 'utf8')).matchAll(/[A-Za-z0-9_\-:./!\[\]%()#,>+*=&]+/g)) candidates.add(m[0]);
const twDir = path.join(NM, 'tailwindcss');
const compiler = await compile(await fs.readFile(path.join(root, 'src/index.css'), 'utf8'), {
  base: path.join(root, 'src'),
  loadStylesheet: async (id, base) => {
    const file = id === 'tailwindcss' ? path.join(twDir, 'index.css') : path.join(id.startsWith('tailwindcss/') ? twDir : base, id.replace(/^tailwindcss\//, ''));
    return { path: file, base: path.dirname(file), content: await fs.readFile(file, 'utf8') };
  },
});
const css = compiler.build([...candidates]);
await fs.writeFile(path.join(out, 'assets/app.css'), css);

// index.html
let html = await fs.readFile(path.join(root, 'index.html'), 'utf8');
html = html
  .replace('<script type="module" src="/src/main.tsx"></script>', '<script type="module" src="./assets/app.js"></script>')
  .replace('</head>', '  <link rel="stylesheet" href="./assets/app.css" />\n    <link rel="manifest" href="./manifest.webmanifest" />\n  </head>');
await fs.writeFile(path.join(out, 'index.html'), html);
for (const f of await fs.readdir(path.join(root, 'public'))) await fs.copyFile(path.join(root, 'public', f), path.join(out, f));
await fs.writeFile(
  path.join(out, 'manifest.webmanifest'),
  JSON.stringify({ name: 'Inventory App', short_name: 'Inventory', start_url: './', display: 'standalone', icons: [{ src: 'icon-192.png', sizes: '192x192', type: 'image/png' }] }),
);

// Minimal precaching service worker (stands in for the Workbox one vite-plugin-pwa generates).
const files = ['./', './index.html', './assets/app.js', './assets/app.css', './favicon.svg', './icon-192.png', './manifest.webmanifest'];
const ver = createHash('sha1').update(await fs.readFile(path.join(out, 'assets/app.js'))).digest('hex').slice(0, 10);
await fs.writeFile(
  path.join(out, 'sw.js'),
  `const C='app-${ver}';const F=${JSON.stringify(files)};
self.addEventListener('install',e=>{e.waitUntil(caches.open(C).then(c=>c.addAll(F)).then(()=>self.skipWaiting()))});
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(k=>Promise.all(k.filter(x=>x!==C).map(x=>caches.delete(x)))).then(()=>self.clients.claim()))});
self.addEventListener('fetch',e=>{const u=new URL(e.request.url);if(u.origin!==location.origin||e.request.method!=='GET')return;
e.respondWith(caches.match(e.request.mode==='navigate'?'./index.html':e.request).then(r=>r||fetch(e.request)))});`,
);

const kb = (await fs.stat(path.join(out, 'assets/app.js'))).size / 1024;
console.log(`built test-dist: app.js ${kb.toFixed(0)} KB, app.css ${(css.length / 1024).toFixed(0)} KB, ${res.warnings.length} warnings`);
