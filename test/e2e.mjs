// End-to-end test of phase 1 against the acceptance criteria, on a phone-sized
// Chromium with a fake rear camera and an in-memory OneDrive (test/mock-graph.mjs).
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { MockDrive } from './mock-graph.mjs';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const dist = path.join(root, 'test-dist');
const outDir = path.join(root, 'test-results');
await fs.rm(outDir, { recursive: true, force: true });
await fs.mkdir(outDir, { recursive: true });
const FIX = path.join(root, 'test/fixtures');

// ---------- static server for the built app ----------
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
const server = http.createServer(async (req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p.endsWith('/')) p += 'index.html';
  try {
    const body = await fs.readFile(path.join(dist, p));
    res.writeHead(200, { 'Content-Type': types[path.extname(p)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(body);
  } catch {
    console.log('  · 404', p);
    res.writeHead(404);
    res.end('nf');
  }
});
await new Promise((r) => server.listen(5174, r));
const APP = 'http://localhost:5174/';

const results = [];
const note = (id, pass, detail) => {
  results.push({ id, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${id}: ${detail}`);
};
const log = (...a) => console.log('  ·', ...a);

const drive = new MockDrive();
const browser = await chromium.launch({
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${path.join(FIX, 'camera.y4m')}`],
});

async function newPhone() {
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    permissions: ['camera'],
    userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0 Mobile Safari/537.36',
  });
  await ctx.route(/^https:\/\/(graph\.microsoft\.com|download\.mock|upload\.mock)\//, (r) => drive.handle(r));
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('dialog', (d) => d.accept());
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  return { ctx, page, errors };
}

async function idbAll(page, store) {
  return page.evaluate(
    (store) =>
      new Promise((res, rej) => {
        const r = indexedDB.open('inventory-app');
        r.onsuccess = () => {
          const q = r.result.transaction(store).objectStore(store).getAll();
          q.onsuccess = () => {
            const out = q.result.map((x) => {
              const o = { ...x };
              delete o.blob;
              return o;
            });
            r.result.close();
            res(out);
          };
          q.onerror = () => rej(q.error);
        };
        r.onerror = () => rej(r.error);
      }),
    store,
  );
}
async function idbKeys(page, store) {
  return page.evaluate(
    (store) =>
      new Promise((res) => {
        const r = indexedDB.open('inventory-app');
        r.onsuccess = () => {
          const q = r.result.transaction(store).objectStore(store).getAllKeys();
          q.onsuccess = () => {
            r.result.close();
            res(q.result);
          };
        };
      }),
    store,
  );
}

async function waitSynced(page, timeout = 240_000) {
  await page.waitForFunction(
    () => {
      const b = document.querySelector('[data-testid=sync-dot]');
      return b && b.getAttribute('data-waiting') === '0' && b.getAttribute('data-state') === 'idle';
    },
    null,
    { timeout, polling: 500 },
  );
}
const goHash = (page, h) => page.evaluate((h) => (location.hash = h), h);
const shot = (page, name) => page.screenshot({ path: path.join(outDir, name + '.png') });

let taps = 0;
const tap = async (loc) => {
  taps++;
  await loc.click();
};

const t0 = Date.now();
const { ctx, page, errors } = await newPhone();

try {
  // ---------- AC1: sign in, property folder appears in OneDrive ----------
  await page.goto(APP);
  await shot(page, '01-welcome');
  await page.getByTestId('sign-in').click();
  await page.getByTestId('add-property').waitFor();
  await page.waitForFunction(async () => (await navigator.serviceWorker.getRegistration())?.active?.state === 'activated', null, { timeout: 15000 }).catch(async (e) => {
    console.log(await page.evaluate(async () => { const r = await navigator.serviceWorker.getRegistration(); return { url: location.href, r: !!r, active: r?.active?.state, inst: r?.installing?.state, wait: r?.waiting?.state }; }));
    throw e;
  });
  await page.getByTestId('add-property').click();
  await page.fill('input[name=address]', 'Flat 2, 14 Gillygate, York');
  await page.fill('input[name=postcode]', 'yo31 7eq');
  await page.getByRole('button', { name: 'Flat', exact: true }).click();
  await page.getByRole('button', { name: 'Furnished', exact: true }).click();
  await shot(page, '02-add-property');
  await page.getByTestId('save-property').click();
  await page.getByTestId('new-tenancy').waitFor();
  await page.getByTestId('new-tenancy').click();
  await page.fill('input[name=tenant-name-0]', 'Alex Morgan');
  await page.fill('input[name=tenant-email-0]', 'alex.morgan@example.com');
  await page.getByTestId('save-tenancy').click();
  await page.getByTestId('start-check-in').waitFor();
  await waitSynced(page, 30_000).catch(() => undefined);
  const props = await idbAll(page, 'properties');
  const folder = `Property Inventories/${props[0].folderName}`;
  const propJson = drive.files().find((f) => f.path === `${folder}/property.json`);
  const tenJson = drive.files().find((f) => f.path.startsWith(folder + '/tenancies/') && f.path.endsWith('tenancy.json'));
  note('AC1 Sign in and property folder in OneDrive', !!propJson && !!tenJson, propJson ? `created "${folder}/" with property.json and tenancies/…/tenancy.json` : 'property folder missing');
  await shot(page, '03-property');

  // ---------- AC2: whole 2-bed check-in in airplane mode ----------
  drive.offline = true;
  await ctx.setOffline(true);
  log('airplane mode ON');
  await page.getByTestId('start-check-in').click();
  await shot(page, '04-start-check-in');
  await page.getByTestId('create-check-in').click();
  await page.getByTestId('walk-through').waitFor();
  const invId = (await page.evaluate(() => location.hash)).split('/')[2];
  await shot(page, '05-overview-empty');

  // Walk-through: photo + condition chip + Next for every item in every room.
  await page.getByTestId('walk-through').click();
  const cam = page.getByRole('dialog', { name: 'Camera' });
  await cam.getByTestId('shutter').waitFor();
  await page.waitForFunction(() => !document.querySelector('[data-testid=shutter]')?.hasAttribute('disabled'), null, { timeout: 15000 });
  const conds = ['Good', 'Good', 'Fair', 'New', 'Good', 'Poor', 'Good', 'Damaged'];
  let walked = 0;
  for (;;) {
    await cam.getByTestId('shutter').click();
    await cam.getByRole('button', { name: new RegExp(`^(✓ )?${conds[walked % conds.length]}$`) }).click();
    walked++;
    if (walked === 3) await shot(page, '06-walk-through');
    const next = cam.getByTestId('next-item');
    const label = await next.textContent();
    await next.click();
    if (/Finish/.test(label)) break;
    if (walked > 400) throw new Error('walk-through did not end');
  }
  await cam.waitFor({ state: 'detached', timeout: 120_000 });
  log(`walk-through: ${walked} items photographed and rated`);

  // Two big gallery photos on the living room sofa (worst case for size): labelled "from gallery".
  const items = await idbAll(page, 'items');
  const rooms = await idbAll(page, 'rooms');
  const byName = (room, item) => {
    const r = rooms.find((x) => x.name === room);
    return items.find((i) => i.roomId === r.id && i.name === item);
  };
  const sofa = byName('Living room', 'Sofa');
  await goHash(page, `#/inventory/${invId}/item/${sofa.id}`);
  await page.getByTestId('item-camera').click();
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), cam.getByRole('button', { name: 'Add from gallery' }).click()]);
  await chooser.setFiles([path.join(FIX, 'big-noisy.jpg'), path.join(FIX, 'portrait.jpg')]);
  await cam.getByTestId('camera-done').click();
  await cam.waitFor({ state: 'detached', timeout: 60_000 });

  // ---------- AC3: photo from an item screen in two taps ----------
  const hob = byName('Kitchen', 'Hob');
  await goHash(page, `#/inventory/${invId}/item/${hob.id}`);
  await page.getByTestId('item-photos').waitFor();
  const before = await page.locator('[data-testid=item-photos] img').count();
  taps = 0;
  await tap(page.getByTestId('item-camera'));
  await page.waitForFunction(() => !document.querySelector('[data-testid=shutter]')?.hasAttribute('disabled'), null, { timeout: 15000 });
  await tap(cam.getByTestId('shutter'));
  const twoTaps = taps;
  await page.waitForFunction((n) => document.querySelectorAll('[data-testid=camera-strip] img').length > n, before, { timeout: 15000 });
  await shot(page, '07-camera-after-two-taps');
  await cam.getByTestId('camera-done').click();
  await cam.waitFor({ state: 'detached' });
  const after = await page.locator('[data-testid=item-photos] img').count();
  note('AC3 Photo from item screen in two taps', twoTaps === 2 && after === before + 1, `${twoTaps} taps (camera button, shutter); Hob photos ${before} → ${after}, shown on the item and in the camera strip`);
  await shot(page, '08-item');

  // ---------- AC4: Report issue in three taps ----------
  const oven = byName('Kitchen', 'Oven');
  await goHash(page, `#/inventory/${invId}/item/${oven.id}`);
  await page.getByTestId('report-issue').waitFor();
  taps = 0;
  await tap(page.getByTestId('report-issue'));
  await shot(page, '09-report-issue');
  await tap(page.getByRole('dialog', { name: 'Report an issue' }).getByRole('button', { name: /^(✓\s*)?Broken$/ }));
  await tap(page.getByTestId('issue-save'));
  const issueTaps = taps;
  await page.getByRole('dialog', { name: 'Report an issue' }).waitFor({ state: 'detached' });
  await page.waitForTimeout(300);
  const issues = (await idbAll(page, 'entries')).filter((e) => e.type === 'issue');
  const ovenIssue = issues.find((e) => e.itemId === oven.id && e.payload.issueType === 'Broken');
  // From a screen with no inventory open (properties list) it is still three taps.
  await goHash(page, '#/');
  await page.getByTestId('add-property').waitFor();
  taps = 0;
  await tap(page.getByTestId('report-issue'));
  await tap(page.getByRole('dialog', { name: 'Report an issue' }).getByRole('button', { name: /^(✓\s*)?Damp or mould$/ }));
  await tap(page.getByTestId('issue-save'));
  const issueTaps2 = taps;
  await page.getByRole('dialog', { name: 'Report an issue' }).waitFor({ state: 'detached' });
  // One issue with a photo and a dictated-style note, from the bathroom.
  const extractor = byName('Bathroom', 'Extractor fan');
  await goHash(page, `#/inventory/${invId}/item/${extractor.id}`);
  await page.getByTestId('report-issue').click();
  const [ch2] = await Promise.all([page.waitForEvent('filechooser'), page.getByTestId('issue-photo').click()]);
  await ch2.setFiles(path.join(FIX, 'portrait.jpg'));
  await page.waitForFunction(() => document.querySelectorAll('[role=dialog] img').length > 0, null, { timeout: 30000 });
  await page.getByRole('dialog', { name: 'Report an issue' }).getByRole('button', { name: /^(✓\s*)?Not working$/ }).click();
  await page.fill('textarea', 'Fan makes a rattling noise and does not clear steam');
  await page.getByTestId('issue-save').click();
  await page.getByRole('dialog', { name: 'Report an issue' }).waitFor({ state: 'detached' });
  const issuesAll = (await idbAll(page, 'entries')).filter((e) => e.type === 'issue');
  note(
    'AC4 Report issue in three taps or fewer',
    issueTaps === 3 && issueTaps2 === 3 && !!ovenIssue && issuesAll.length === 3,
    `${issueTaps} taps on the Oven (Report issue, Broken, Save) and ${issueTaps2} taps from the properties list; issue filed to Kitchen › Oven automatically; ${issuesAll.length} issues saved`,
  );

  // Meters, keys, safety checks, documents.
  const meter = byName('Meter readings', 'Electricity meter');
  await goHash(page, `#/inventory/${invId}/item/${meter.id}`);
  await page.getByTestId('meter-reading').fill('045213.6');
  await page.getByRole('button', { name: 'Save reading' }).click();
  await page.getByTestId('item-camera').click();
  await page.waitForFunction(() => !document.querySelector('[data-testid=shutter]')?.hasAttribute('disabled'), null, { timeout: 15000 });
  await cam.getByTestId('shutter').click();
  await cam.getByTestId('camera-done').click();
  await cam.waitFor({ state: 'detached' });
  for (const [m, v] of [
    ['Gas meter', '01873.2'],
    ['Water meter', '00412'],
  ]) {
    await goHash(page, `#/inventory/${invId}/item/${byName('Meter readings', m).id}`);
    await page.getByTestId('meter-reading').fill(v);
    await page.getByRole('button', { name: 'Save reading' }).click();
  }
  for (const k of ['Front door keys', 'Building fobs']) {
    await goHash(page, `#/inventory/${invId}/item/${byName('Keys and fobs', k).id}`);
    await page.getByRole('button', { name: 'More' }).click();
    await page.getByRole('button', { name: 'More' }).click();
    await page.getByRole('button', { name: 'Save', exact: true }).click();
  }
  for (const s of ['Smoke alarm (hallway)', 'Carbon monoxide alarm']) {
    await goHash(page, `#/inventory/${invId}/item/${byName('Safety checks', s).id}`);
    await page.getByRole('button', { name: /Tested: working/ }).click();
  }
  await goHash(page, `#/inventory/${invId}/item/${byName('Manuals and documents', 'Gas Safety Certificate').id}`);
  await page.getByRole('button', { name: /^(✓\s*)?Handed over$/ }).click();
  await page.fill('textarea[aria-label=Note]', 'Certificate dated 3 Oct 2026, copy emailed to tenant');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await page.waitForTimeout(300);
  await shot(page, '10-document-item');

  // Reload the app with no signal: it must open from the phone and still have everything.
  await page.reload();
  await page.getByTestId('sync-dot').waitFor({ timeout: 20000 });
  await goHash(page, `#/inventory/${invId}`);
  await page.getByTestId('walk-through').waitFor({ timeout: 20000 });
  await page.waitForFunction(() => document.querySelector('[data-testid=sync-badge]')?.getAttribute('data-state') !== 'checking');
  const offlineBadge = await page.getByTestId('sync-badge').textContent();
  await shot(page, '11-overview-offline');
  log('after offline reload:', offlineBadge);

  // PDF while offline.
  await goHash(page, `#/inventory/${invId}/export`);
  await page.getByTestId('make-pdf').click();
  await page.getByTestId('export-status').first().waitFor({ timeout: 120_000 });
  await shot(page, '12-export');

  const localPhotos = await idbAll(page, 'photos');
  const localEntries = await idbAll(page, 'entries');
  const blobKeysOffline = await idbKeys(page, 'blobs');
  log(`offline totals: ${localPhotos.length} photos, ${localEntries.length} entries, ${blobKeysOffline.length} blobs; Graph requests while offline: ${drive.stats.requests}`);
  const reqsBeforeOnline = drive.stats.requests;

  // ---------- back online: sync, with injected OneDrive errors to exercise retry/back-off ----------
  drive.fail.photo503 = 2;
  drive.fail.photo500 = 3;
  drive.offline = false;
  await ctx.setOffline(false);
  log('airplane mode OFF');
  await goHash(page, `#/inventory/${invId}`);
  const tSync = Date.now();
  await waitSynced(page);
  log(`synced in ${((Date.now() - tSync) / 1000).toFixed(1)}s, ${drive.stats.failuresInjected} injected failures retried`);
  await shot(page, '13-overview-synced');

  const remote = drive.files();
  const remotePhotos = remote.filter((f) => f.path.endsWith('.jpg'));
  const remoteEntries = remote.filter((f) => /\/entries\/.+\.json$/.test(f.path));
  const shaRemote = new Set(remotePhotos.map((f) => createHash('sha256').update(f.item.content).digest('hex')));
  const missingPhotos = localPhotos.filter((p) => !shaRemote.has(p.sha256));
  const pdfRemote = remote.filter((f) => f.path.endsWith('.pdf'));
  const invJson = remote.find((f) => f.path.endsWith('/inventory.json'));
  const photosAfter = await idbAll(page, 'photos');
  const blobKeysAfter = await idbKeys(page, 'blobs');
  const allUploaded = photosAfter.every((p) => p.uploadStatus === 'uploaded');
  const fullsLeft = blobKeysAfter.filter((k) => String(k).endsWith(':full')).length;
  const general = items.filter((i) => i.category === 'general');
  note(
    'AC2 2-bed check-in offline, then full sync with nothing lost',
    /Offline/.test(offlineBadge) &&
      missingPhotos.length === 0 &&
      remotePhotos.length === localPhotos.length &&
      remoteEntries.length === localEntries.length &&
      !!invJson &&
      pdfRemote.length === 1 &&
      allUploaded,
    `offline: ${rooms.filter((r) => !['meters', 'keys', 'safety', 'documents'].includes(r.templateKey)).length} rooms, ${walked}/${general.length} items photographed and rated, ${localPhotos.length} photos, ${localEntries.length} entries, 1 PDF, app reloaded with no signal and showed "${offlineBadge}". ` +
      `Online: ${remotePhotos.length}/${localPhotos.length} photos in OneDrive with matching SHA-256, ${remoteEntries.length}/${localEntries.length} entry files, inventory.json, PDF; ` +
      `${drive.stats.failuresInjected} injected OneDrive errors retried; ${fullsLeft} full-size copies left on phone after confirmation`,
  );

  // ---------- AC5: photos under 2 MB with a date stamp ----------
  const sizes = remotePhotos.map((f) => f.size);
  const maxMB = Math.max(...sizes) / 1024 / 1024;
  const avgMB = sizes.reduce((a, b) => a + b, 0) / sizes.length / 1024 / 1024;
  const allStamped = localEntries.filter((e) => e.type === 'photo').every((e) => e.payload.photo.stamped);
  const gallery = localPhotos.filter((p) => p.source === 'gallery');
  for (const f of remotePhotos) await fs.writeFile(path.join(outDir, 'photo-' + path.basename(f.path)), f.item.content);
  await fs.writeFile(
    path.join(outDir, 'photos.json'),
    JSON.stringify(
      remotePhotos.map((f) => ({ path: f.path, size: f.size })),
      null,
      1,
    ),
  );
  note(
    'AC5 Every OneDrive photo under 2 MB and date-stamped (metadata)',
    maxMB < 2 && allStamped,
    `${remotePhotos.length} photos, largest ${maxMB.toFixed(2)} MB, average ${avgMB.toFixed(2)} MB; includes ${gallery.length} gallery photos from a 10.9 MB 12-megapixel original; all entries record stamped=true (pixel check below)`,
  );

  // ---------- AC6: PDF ----------
  await fs.writeFile(path.join(outDir, 'report.pdf'), pdfRemote[0].item.content);
  await fs.writeFile(
    path.join(outDir, 'expected.json'),
    JSON.stringify({
      rooms: rooms.filter((r) => !r.removed).map((r) => r.name),
      items: items.filter((i) => !i.removed).map((i) => i.name),
      photos: localPhotos.length,
      pdfPath: pdfRemote[0].path,
    }),
  );

  // ---------- Extra: eTag conflict on inventory.json ----------
  drive.touch(invJson.path);
  const bedroom = rooms.find((r) => r.name === 'Bedroom 2');
  await goHash(page, `#/inventory/${invId}/room/${bedroom.id}`);
  await page.getByRole('button', { name: 'Edit' }).click();
  await page.fill('input[aria-label="New item name"]', 'Desk and chair');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await page.getByRole('button', { name: 'Done' }).click();
  await page.waitForTimeout(2500);
  await waitSynced(page, 60_000);
  const invAfter = JSON.parse(drive.files().find((f) => f.path === invJson.path).item.content.toString());
  note('Extra: inventory.json eTag conflict (If-Match)', invAfter.items.some((i) => i.name === 'Desk and chair'), 'another device changed inventory.json; the app got 412, pulled, and rewrote on top of the new eTag');
  await shot(page, '14-room-edit');

  // ---------- Extra: second phone restores everything from OneDrive ----------
  const phone2 = await newPhone();
  await phone2.page.goto(APP);
  await phone2.page.getByTestId('sign-in').click();
  await phone2.page.getByTestId('add-property').waitFor();
  await phone2.page.waitForFunction(() => !!document.querySelector('[data-testid=sync-dot]')?.getAttribute('data-last'), null, { timeout: 180_000 });
  await waitSynced(phone2.page, 120_000);
  // A second cycle fetches more thumbnails.
  await phone2.page.getByTestId('sync-dot').click();
  await phone2.page.getByTestId('sync-now').click();
  await waitSynced(phone2.page, 120_000);
  await phone2.page.waitForTimeout(1500);
  const p2props = await idbAll(phone2.page, 'properties');
  const p2entries = await idbAll(phone2.page, 'entries');
  const p2photos = await idbAll(phone2.page, 'photos');
  const p2thumbs = p2photos.filter((x) => x.hasThumb).length;
  await goHash(phone2.page, `#/inventory/${invId}`);
  await phone2.page.getByTestId('walk-through').waitFor();
  const prog1 = await page.evaluate(() => document.querySelector('[role=progressbar]')?.parentElement?.textContent);
  await goHash(page, `#/inventory/${invId}`);
  const progA = await page.locator('[role=progressbar]').locator('..').textContent();
  const progB = await phone2.page.locator('[role=progressbar]').locator('..').textContent();
  await shot(phone2.page, '15-second-phone');
  note(
    'Extra: restore on a second phone (delta sync)',
    p2props.length === 1 && p2entries.length === (await idbAll(page, 'entries')).length && p2photos.length === photosAfter.length && progA === progB,
    `second phone pulled ${p2props.length} property, ${p2entries.length} entries, ${p2photos.length} photo records (${p2thumbs} thumbnails fetched so far); progress "${progB}" matches "${progA}"`,
  );
  void prog1;
  if (phone2.errors.length) log('phone 2 console errors:', phone2.errors.slice(0, 5));

  // Visual check of the main screens in dark mode.
  await page.emulateMedia({ colorScheme: 'dark' });
  await goHash(page, `#/inventory/${invId}/room/${rooms.find((r) => r.name === 'Kitchen').id}`);
  await page.waitForTimeout(500);
  await shot(page, '16-room-dark');
  await goHash(page, `#/inventory/${invId}/item/${oven.id}`);
  await page.waitForTimeout(500);
  await shot(page, '17-item-dark');
} catch (e) {
  console.error('TEST ERROR', e);
  await shot(page, 'zz-error').catch(() => undefined);
  note('run', false, String(e).slice(0, 400));
} finally {
  console.log('page errors:', errors.slice(0, 10));
  console.log('graph calls by kind:', drive.stats.byKind);
  await fs.writeFile(path.join(outDir, 'results.json'), JSON.stringify({ results, errors, stats: drive.stats, seconds: (Date.now() - t0) / 1000 }, null, 2));
  await browser.close();
  server.close();
}
