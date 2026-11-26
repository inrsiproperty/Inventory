// Phase 2 end-to-end test: landlord, tenant and a stranger on three phone-sized Chromiums,
// sharing one in-memory OneDrive (test/mock-graph.mjs) with real access checks.
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { MockDrive, USERS } from './mock-graph.mjs';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const dist = path.join(root, 'test-dist');
const outDir = path.join(root, 'test-results-2');
await fs.rm(outDir, { recursive: true, force: true });
await fs.mkdir(outDir, { recursive: true });
const FIX = path.join(root, 'test/fixtures');

const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
const server = http.createServer(async (req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p.endsWith('/')) p += 'index.html';
  try {
    const body = await fs.readFile(path.join(dist, p));
    res.writeHead(200, { 'Content-Type': types[path.extname(p)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end('nf');
  }
});
await new Promise((r) => server.listen(5176, r));
const APP = 'http://localhost:5176/';

const results = [];
const note = (id, pass, detail) => {
  results.push({ id, pass: !!pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${id}: ${detail}`);
};
const log = (...a) => console.log('  ·', ...a);

const drive = new MockDrive();
const browser = await chromium.launch({
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${path.join(FIX, 'camera.y4m')}`],
});

async function newPhone(who) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, permissions: ['camera'] });
  await ctx.addInitScript((w) => localStorage.setItem('fake-user', w), who);
  await ctx.route(/^https:\/\/(graph\.microsoft\.com|download\.mock|upload\.mock)\//, (r) => drive.handle(r));
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('dialog', (d) => d.accept());
  return { ctx, page, errors, who };
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
const goHash = (page, h) => page.evaluate((h) => (location.hash = h), h);
const shot = (page, name) => page.screenshot({ path: path.join(outDir, name + '.png') });

/** Runs a full sync cycle now and waits for it to finish. */
async function syncNow(page) {
  await page.waitForTimeout(400); // let any navigation the app is doing finish first
  const back = await page.evaluate(() => location.hash);
  for (let i = 0; i < 5; i++) {
    await goHash(page, '#/settings');
    if (await page.getByTestId('sync-now').waitFor({ timeout: 3000 }).then(() => true, () => false)) break;
  }
  const before = await page.getByTestId('sync-dot').getAttribute('data-last');
  await page.getByTestId('sync-now').click();
  await page.waitForFunction(
    (b) => {
      const d = document.querySelector('[data-testid=sync-dot]');
      return d && d.getAttribute('data-last') && d.getAttribute('data-last') !== b && d.getAttribute('data-state') === 'idle';
    },
    before,
    { timeout: 120_000, polling: 300 },
  );
  await goHash(page, back || '#/');
  await page.waitForTimeout(300);
}

async function graph(page, token, method, url, body, headers = {}) {
  return page.evaluate(
    async ({ token, method, url, body, headers }) => {
      const r = await fetch(url, { method, headers: { Authorization: 'Bearer ' + token, ...headers }, body });
      return { status: r.status, text: await r.text() };
    },
    { token, method, url, body, headers },
  );
}

async function signIn(phone) {
  await phone.page.getByTestId('sign-in').click();
}

async function drawSignature(page) {
  await page.getByTestId('signature-pad').scrollIntoViewIfNeeded();
  await page.evaluate(() => window.scrollBy(0, 120));
  await page.waitForTimeout(200);
  const box = await page.getByTestId('signature-pad').boundingBox();
  await page.mouse.move(box.x + 30, box.y + box.height * 0.6);
  await page.mouse.down();
  for (let i = 1; i <= 12; i++) await page.mouse.move(box.x + 30 + i * 20, box.y + box.height * (0.6 - 0.25 * Math.sin(i / 2)), { steps: 2 });
  await page.mouse.up();
}

async function sign(phone, invId) {
  const { page } = phone;
  await goHash(page, `#/inventory/${invId}/sign`);
  await page.getByTestId('signature-pad').waitFor();
  await page.getByTestId('reviewed-tick').check();
  await drawSignature(page);
  await page.getByTestId('sign-button').click();
  await page.getByTestId('inventory-status').waitFor();
}

const L = await newPhone('landlord');
const T = await newPhone('tenant');
const S = await newPhone('stranger');
const t0 = Date.now();

try {
  // ---------- Landlord sets up two properties and a check-in ----------
  await L.page.goto(APP);
  await signIn(L);
  await L.page.getByTestId('add-property').waitFor();
  const addProperty = async (address, postcode, beds) => {
    await goHash(L.page, '#/property/new');
    await L.page.fill('input[name=address]', address);
    await L.page.fill('input[name=postcode]', postcode);
    while (Number(await L.page.getByTestId('bedrooms').textContent()) > beds) await L.page.getByRole('button', { name: 'Fewer bedrooms' }).click();
    await L.page.getByTestId('save-property').click();
    await L.page.getByTestId('new-tenancy').waitFor();
  };
  await addProperty('Flat 2, 14 Gillygate, York', 'YO31 7EQ', 1);
  await L.page.getByTestId('new-tenancy').click();
  await L.page.fill('input[name=tenant-name-0]', 'Alex Morgan');
  await L.page.fill('input[name=tenant-email-0]', 'alex.morgan@example.com');
  await L.page.getByTestId('save-tenancy').click();
  await L.page.getByTestId('start-check-in').click();
  await L.page.getByTestId('create-check-in').click();
  await L.page.getByTestId('walk-through').waitFor();
  const invId = (await L.page.evaluate(() => location.hash)).split('/')[2];
  // Walk-through: rate everything, photos on the first few items.
  await L.page.getByTestId('walk-through').click();
  const cam = L.page.getByRole('dialog', { name: 'Camera' });
  await L.page.waitForFunction(() => !document.querySelector('[data-testid=shutter]')?.hasAttribute('disabled'), null, { timeout: 15000 });
  let n = 0;
  for (;;) {
    if (n < 6) await cam.getByTestId('shutter').click();
    await cam.getByRole('button', { name: new RegExp(`^(✓ )?${['Good', 'Fair', 'Good', 'New'][n % 4]}$`) }).click();
    n++;
    const next = cam.getByTestId('next-item');
    const label = await next.textContent();
    await next.click();
    if (/Finish/.test(label)) break;
  }
  await cam.waitFor({ state: 'detached', timeout: 60_000 });
  log(`landlord rated ${n} items`);
  const props1 = await idbAll(L.page, 'properties');
  const p1Local = props1[0];
  // Second property with a different tenant (never shared with Alex).
  await addProperty('9 Bootham Terrace, York', 'YO30 7BW', 2);
  await L.page.getByTestId('new-tenancy').click();
  await L.page.fill('input[name=tenant-name-0]', 'Jo Bloggs');
  await L.page.fill('input[name=tenant-email-0]', 'jo@example.com');
  await L.page.getByTestId('save-tenancy').click();
  await syncNow(L.page);
  const propsL = await idbAll(L.page, 'properties');
  const p2 = propsL.find((p) => p.address.startsWith('9 Bootham'));
  const p1 = propsL.find((p) => p.id === p1Local.id); // now with its OneDrive folder ids

  // ---------- Send to tenant ----------
  await goHash(L.page, `#/property/${p1.id}`);
  await L.page.getByTestId('send-to-tenant').click();
  await L.page.getByTestId('join-link').waitFor();
  const joinLink = (await L.page.getByTestId('join-link').textContent()).trim().replace('http://localhost:5176/', APP);
  await shot(L.page, '01-landlord-sent');
  await L.page.getByRole('button', { name: 'Close' }).first().click();
  const perm = drive.permissions.find((x) => x.email === 'alex.morgan@example.com');
  log('join link', joinLink, 'permission', perm?.id, perm?.roles);
  await syncNow(L.page);

  // ---------- AC1: tenant opens the link, signs in, sees only this property ----------
  await T.page.goto(joinLink);
  await T.page.getByTestId('privacy-notice').waitFor();
  const privacyShown = await T.page.getByTestId('privacy-notice').isVisible();
  await shot(T.page, '02-tenant-welcome');
  await signIn(T);
  await T.page.getByTestId('inventory-status').waitFor({ timeout: 60_000 });
  await T.page.waitForFunction(() => document.querySelectorAll('[role=progressbar]').length > 0);
  await syncNow(T.page);
  await shot(T.page, '03-tenant-overview');
  await goHash(T.page, '#/');
  await T.page.waitForTimeout(500);
  const tenantProps = await idbAll(T.page, 'properties');
  const tenantSees = await T.page.locator('main').textContent();
  const p2Graph = await graph(T.page, 'fake-token-tenant', 'GET', `https://graph.microsoft.com/v1.0/drives/${p2.driveId}/items/${p2.folderId}`);
  const p2Children = await graph(T.page, 'fake-token-tenant', 'GET', `https://graph.microsoft.com/v1.0/drives/${p2.driveId}/items/root-drive-landlord/children`);
  // A stranger with the same link.
  await S.page.goto(joinLink);
  await signIn(S);
  await S.page.getByTestId('join-error').waitFor({ timeout: 30_000 });
  const strangerMsg = await S.page.getByTestId('join-error').textContent();
  await shot(S.page, '04-stranger-refused');
  note(
    'P2-AC1 Tenant opens the invite link, signs in and sees only the one property',
    privacyShown && tenantProps.length === 1 && tenantProps[0].id === p1.id && tenantSees.includes('Gillygate') && !tenantSees.includes('Bootham') && p2Graph.status === 403 && p2Children.status === 403 && /hasn't been shared/.test(strangerMsg),
    `privacy notice shown before sign-in; after sign-in the tenant's phone has ${tenantProps.length} property (${tenantProps[0]?.address}); the landlord's other property is not listed and OneDrive refuses the tenant (HTTP ${p2Graph.status} on its folder, ${p2Children.status} on the landlord's root); a stranger using the same link is refused: "${strangerMsg.trim().slice(0, 90)}…"`,
  );

  // ---------- AC2: landlord and tenant add to the same item at the same time ----------
  const items = await idbAll(L.page, 'items');
  const rooms = await idbAll(L.page, 'rooms');
  const kitchen = rooms.find((r) => r.name === 'Kitchen');
  const oven = items.find((i) => i.roomId === kitchen.id && i.name === 'Oven');
  drive.offline = true; // nobody can sync while both make their changes
  await T.page.goto(APP + `#/inventory/${invId}/item/${oven.id}`);
  await T.page.getByTestId('review-buttons').waitFor();
  await T.page.fill('textarea[aria-label=Note]', 'Tenant: oven door seal is loose');
  await T.page.getByRole('button', { name: 'Add', exact: true }).click();
  await T.page.getByRole('button', { name: /Something's not right/ }).click();
  await T.page.fill('textarea[aria-label="What\'s not right"]', 'There is a burn mark on the left of the oven door');
  const [fc] = await Promise.all([T.page.waitForEvent('filechooser'), T.page.getByTestId('dispute-photo').click()]);
  await fc.setFiles(path.join(FIX, 'portrait.jpg'));
  await T.page.waitForFunction(() => document.querySelectorAll('[role=dialog] img').length > 0, null, { timeout: 30000 });
  await T.page.getByTestId('save-dispute').click();
  await L.page.goto(APP + `#/inventory/${invId}/item/${oven.id}`);
  await L.page.getByRole('button', { name: /^(✓\s*)?Fair$/ }).waitFor();
  await L.page.fill('textarea[aria-label=Note]', 'Landlord: oven serviced in October');
  await L.page.getByRole('button', { name: 'Add', exact: true }).click();
  await L.page.getByRole('button', { name: /^(✓\s*)?Poor$/ }).click();
  await L.page.waitForTimeout(500);
  drive.offline = false;
  await syncNow(T.page);
  await syncNow(L.page);
  await syncNow(T.page);
  const threadOf = async (page) => {
    await page.goto(APP + `#/inventory/${invId}/item/${oven.id}`);
    await page.getByTestId('thread').waitFor();
    return page.getByTestId('thread').textContent();
  };
  const thL = await threadOf(L.page);
  const thT = await threadOf(T.page);
  const want = ['Tenant: oven door seal is loose', 'burn mark', 'Landlord: oven serviced', 'Condition: Poor'];
  const ovenEntryFiles = drive.files().filter((f) => /\/entries\//.test(f.path)).map((f) => JSON.parse(f.item.content.toString())).filter((e) => e.itemId === oven.id);
  const authors = new Set(ovenEntryFiles.map((e) => e.authorRole));
  await shot(L.page, '05-landlord-oven-thread');
  await shot(T.page, '06-tenant-oven-thread');
  note(
    'P2-AC2 Landlord and tenant add to the same item at the same time; both appear, neither overwritten',
    want.every((w) => thL.includes(w)) && want.every((w) => thT.includes(w)) && authors.has('landlord') && authors.has('tenant'),
    `both phones edited the Oven with no connection, then synced: the landlord's and tenant's threads both show all four new entries (tenant note, tenant dispute with photo, landlord note, landlord rating); OneDrive holds ${ovenEntryFiles.length} separate entry files for the Oven from ${[...authors].join(' and ')}`,
  );

  // Tenant disputes another item; the landlord sees a badge and answers.
  const sink = items.find((i) => i.roomId === kitchen.id && i.name === 'Sink and taps');
  await T.page.goto(APP + `#/inventory/${invId}/item/${sink.id}`);
  await T.page.getByTestId('review-buttons').waitFor();
  await T.page.getByRole('button', { name: /Something's not right/ }).click();
  await T.page.fill('textarea[aria-label="What\'s not right"]', 'The cold tap drips constantly');
  await T.page.getByTestId('save-dispute').click();
  await syncNow(T.page);
  await syncNow(L.page);
  await L.page.goto(APP + `#/inventory/${invId}`);
  await L.page.getByTestId('dispute-count').waitFor();
  const badge = await L.page.getByTestId('dispute-count').textContent();
  await L.page.goto(APP + '#/');
  const listBadge = await L.page.getByTestId('dispute-badge').first().textContent().catch(() => '');
  await shot(L.page, '06b-landlord-badge');
  await L.page.goto(APP + `#/inventory/${invId}/issues`);
  await L.page.getByTestId('dispute-row').first().waitFor();
  await shot(L.page, '06c-landlord-disputes-list');
  await L.page.goto(APP + `#/inventory/${invId}/item/${sink.id}`);
  await L.page.fill('textarea[aria-label=Reply]', 'Thanks, a plumber is booked for Friday.');
  await L.page.getByTestId('send-reply').click();
  await L.page.waitForTimeout(400);
  await L.page.goto(APP + `#/inventory/${invId}`);
  await L.page.getByTestId('inventory-status').waitFor();
  await L.page.waitForTimeout(600);
  const badgeAfter = await L.page.getByTestId('dispute-count').count();
  log(`dispute badge ${badge} (list: ${listBadge}) → ${badgeAfter ? 'still shown' : 'cleared'} after reply`);

  // ---------- AC3: tenant can't change ratings, delete anything or see other properties ----------
  await T.page.goto(APP + `#/inventory/${invId}/item/${oven.id}`);
  await T.page.getByTestId('rating-readonly').waitFor();
  const tenantChips = await T.page.getByRole('button', { name: /^(✓\s*)?(New|Good|Fair|Poor|Damaged|Missing)$/ }).count();
  const tenantDeleteButtons = await T.page.getByRole('button', { name: /delete|remove/i }).count();
  await T.page.goto(APP + `#/inventory/${invId}/room/${kitchen.id}`);
  await T.page.getByTestId('item-Oven').waitFor();
  const tenantEdit = await T.page.getByRole('button', { name: 'Edit' }).count();
  await T.page.goto(APP + `#/inventory/${invId}`);
  await T.page.getByTestId('start-review').waitFor();
  const tenantWalk = await T.page.getByTestId('walk-through').count();
  // A tenant going round the app, straight to OneDrive: forge a "landlord" rating, add a tenant rating, delete a landlord entry.
  const L_ID = USERS['fake-token'].id;
  const invFolder = (await idbAll(L.page, 'inventories'))[0].folderName;
  const t1 = (await idbAll(L.page, 'tenancies')).find((t) => t.propertyId === p1.id);
  const entriesRel = `tenancies/${t1.id}/inventories/${invFolder}/entries`;
  const hob = items.find((i) => i.roomId === kitchen.id && i.name === 'Hob');
  const forge = (role, authorId, cond, id) =>
    JSON.stringify({ id, inventoryId: invId, propertyId: p1.id, roomId: kitchen.id, itemId: hob.id, authorId, authorRole: role, authorName: 'Forged', createdAt: new Date().toISOString(), type: 'rating', payload: { condition: cond } });
  const id1 = '11111111-1111-4111-8111-111111111111';
  const id2 = '22222222-2222-4222-8222-222222222222';
  const put = (name, body) =>
    graph(T.page, 'fake-token-tenant', 'PUT', `https://graph.microsoft.com/v1.0/drives/${p1.driveId}/items/${p1.folderId}:/${entriesRel}/${name}:/content`, body, { 'Content-Type': 'application/json' });
  const f1 = await put(`20261126T120000000Z_${L_ID}_${id1}.json`, forge('landlord', L_ID, 'Missing', id1));
  const f2 = await put(`20261126T120001000Z_${USERS['fake-token-tenant'].id}_${id2}.json`, forge('tenant', USERS['fake-token-tenant'].id, 'Damaged', id2));
  const victim = drive.files().find((f) => f.path.includes('/entries/') && JSON.parse(f.item.content.toString()).authorRole === 'landlord' && JSON.parse(f.item.content.toString()).type === 'rating');
  const del = await graph(T.page, 'fake-token-tenant', 'DELETE', `https://graph.microsoft.com/v1.0/drives/${p1.driveId}/items/${victim.item.id}`);
  await syncNow(L.page);
  await syncNow(L.page);
  const hobState = await (async () => {
    await L.page.goto(APP + `#/inventory/${invId}/item/${hob.id}`);
    await L.page.getByTestId('thread').waitFor();
    return { thread: await L.page.getByTestId('thread').textContent(), chips: await L.page.locator('[aria-pressed=true]').allTextContents() };
  })();
  const restored = drive.files().some((f) => f.path === victim.path);
  log('AC3 detail', JSON.stringify({ tenantChips, tenantEdit, tenantWalk, tenantDeleteButtons, f1: f1.status, f2: f2.status, del: del.status, chips: hobState.chips, flagged: /author not verified/.test(hobState.thread), restored }));
  await shot(L.page, '07-landlord-hob-after-forgery');
  note(
    'P2-AC3 Tenant cannot change ratings, delete anything or see other properties',
    tenantChips === 0 && tenantEdit === 0 && tenantWalk === 0 && tenantDeleteButtons === 0 && f1.status < 300 && del.status === 204 && !hobState.chips.join(' ').includes('Missing') && !hobState.chips.join(' ').includes('Damaged') && /author not verified/.test(hobState.thread) && restored && tenantProps.length === 1,
    `tenant screens have no rating chips, Edit, walk-through or delete buttons; going round the app straight to OneDrive, the tenant forged a "landlord" rating (Missing) and wrote their own rating (Damaged): the landlord's app ignored both (Hob still ${hobState.chips.filter((c) => /Good|Fair|New|Poor/.test(c)).join(', ') || 'unchanged'}; forgery flagged "author not verified" because OneDrive shows the tenant created the file); the tenant deleted a landlord entry file (HTTP ${del.status}) and the landlord's app put it back on the next sync (${restored ? 'restored' : 'NOT restored'}); other properties: see P2-AC1`,
  );

  // ---------- Tenant reviews everything, then signatures ----------
  await T.page.goto(APP + `#/inventory/${invId}`);
  await T.page.getByTestId('start-review').click();
  for (let i = 0; i < 200; i++) {
    if (!(await T.page.getByTestId('review-buttons').waitFor({ timeout: 5000 }).then(() => true, () => false))) break;
    const agree = T.page.getByTestId('review-buttons').getByRole('button', { name: /^(✓\s*)?Agree$/ });
    const before = await T.page.evaluate(() => location.hash);
    if ((await agree.getAttribute('aria-pressed')) === 'true') break;
    await agree.click();
    const moved = await T.page.waitForFunction((b) => location.hash !== b, before, { timeout: 4000 }).then(() => true, () => false);
    if (!moved) break; // nothing left to review
    await T.page.getByTestId('review-buttons').waitFor({ timeout: 4000 }).catch(() => undefined);
  }
  await T.page.goto(APP + `#/inventory/${invId}`);
  await T.page.waitForTimeout(500);
  const tenantProgress = await T.page.locator('[role=progressbar]').first().locator('..').textContent();
  log('tenant progress', tenantProgress);
  await sign(T, invId);
  await syncNow(T.page);
  await syncNow(L.page);
  // Landlord adds a note after the tenant signed: the tenant's signature no longer matches.
  await L.page.goto(APP + `#/inventory/${invId}/item/${hob.id}`);
  await L.page.fill('textarea[aria-label=Note]', 'Hob cleaned after tenant review');
  await L.page.getByRole('button', { name: 'Add', exact: true }).click();
  await L.page.goto(APP + `#/inventory/${invId}`);
  await L.page.waitForTimeout(500);
  const signersAfterChange = await L.page.getByTestId('signer').allTextContents();
  await syncNow(L.page);
  await syncNow(T.page);
  await sign(T, invId); // signs again
  await syncNow(T.page);
  await syncNow(L.page);
  await sign(L, invId); // landlord signs last: locks and saves the PDF
  await syncNow(L.page);
  await syncNow(T.page);
  await L.page.goto(APP + `#/inventory/${invId}`);
  await L.page.getByTestId('inventory-status').waitFor();
  const statusL = await L.page.getByTestId('inventory-status').textContent();
  const invL = (await idbAll(L.page, 'inventories'))[0];
  const invJson = JSON.parse(drive.files().find((f) => f.path.endsWith('/inventory.json') && f.path.includes(p1.folderName)).item.content.toString());
  const pdfs = drive.files().filter((f) => f.path.includes(p1.folderName) && f.path.endsWith('.pdf'));
  const sigPngs = drive.files().filter((f) => f.path.includes('/signatures/') && f.path.endsWith('.png'));
  await shot(L.page, '08-landlord-locked');
  // Read-only on both phones.
  await L.page.goto(APP + `#/inventory/${invId}/item/${oven.id}`);
  await L.page.getByTestId('locked-banner').waitFor();
  const lChips = await L.page.getByRole('button', { name: /^(✓\s*)?(New|Good|Fair|Poor|Damaged|Missing)$/ }).count();
  const lCamera = await L.page.getByTestId('item-camera').count();
  await T.page.goto(APP + `#/inventory/${invId}/item/${oven.id}`);
  await T.page.getByTestId('locked-banner').waitFor();
  const tReview = await T.page.getByTestId('review-buttons').count();
  await shot(T.page, '09-tenant-locked-item');
  // Post-sign note from the tenant: kept separate, doesn't change the signed content.
  await T.page.goto(APP + `#/inventory/${invId}`);
  await T.page.getByTestId('post-sign-note').click();
  await T.page.fill('textarea[aria-label="Post-sign note"]', 'Found a small crack in the bathroom tile after moving in');
  await T.page.getByTestId('save-post-sign').click();
  await syncNow(T.page);
  await syncNow(L.page);
  await L.page.goto(APP + `#/inventory/${invId}`);
  await L.page.getByTestId('post-sign-list').waitFor();
  const postSignText = await L.page.getByTestId('post-sign-list').textContent();
  const statusAfterPostSign = await L.page.getByTestId('inventory-status').textContent();
  await shot(L.page, '10-landlord-post-sign');
  await fs.writeFile(path.join(outDir, 'signed.pdf'), pdfs.at(-1).item.content);
  await fs.writeFile(path.join(outDir, 'expect.json'), JSON.stringify({ hash: invL.contentHash, tenant: 'Alex Morgan', landlord: 'Test Landlord' }));
  note(
    'P2-AC4 After all signatures the inventory is read-only and the signed PDF is in OneDrive',
    /signed and locked/i.test(statusL) && invL.status === 'locked' && invJson.status === 'locked' && invJson.contentHash === invL.contentHash && pdfs.length >= 1 && sigPngs.length >= 3 && lChips === 0 && lCamera === 0 && tReview === 0 && /crack in the bathroom tile/.test(postSignText) && /signed and locked/i.test(statusAfterPostSign) && signersAfterChange.some((s) => /needs to sign again/.test(s)),
    `when the landlord added a note after the tenant signed, the tenant's signature showed "needs to sign again" until they re-signed; after both signed: status "${statusL.trim()}", inventory.json in OneDrive is locked with content fingerprint ${invL.contentHash?.slice(0, 12)}…, the signed PDF is in exports (${pdfs.map((f) => path.basename(f.path)).join(', ')}), ${sigPngs.length} signature images saved; no rating chips, camera, Agree or dispute buttons on either phone; the tenant's post-sign note shows separately and the inventory stays signed and locked`,
  );

  // ---------- AC5: removing the tenant stops their access immediately ----------
  await L.page.goto(APP + `#/property/${p1.id}`);
  await L.page.getByTestId('remove-tenant').click();
  await L.page.waitForFunction(() => /Access removed/.test(document.body.textContent || ''), null, { timeout: 30000 });
  const directly = await graph(T.page, 'fake-token-tenant', 'GET', `https://graph.microsoft.com/v1.0/drives/${p1.driveId}/items/${p1.folderId}`);
  const writeTry = await graph(T.page, 'fake-token-tenant', 'PUT', `https://graph.microsoft.com/v1.0/drives/${p1.driveId}/items/${p1.folderId}:/${entriesRel}/x.json:/content`, '{}', { 'Content-Type': 'application/json' });
  await syncNow(T.page);
  await T.page.goto(APP + `#/property/${p1.id}`);
  await T.page.getByTestId('access-ended').waitFor({ timeout: 20000 });
  await shot(T.page, '11-tenant-access-ended');
  await shot(L.page, '12-landlord-removed');
  const permLeft = drive.livePermissions(p1.folderId).length;
  note(
    'P2-AC5 Removing the tenant stops their access immediately',
    directly.status === 403 && writeTry.status === 403 && permLeft === 0,
    `straight after the landlord tapped Remove tenant, OneDrive refused the tenant's very next read (HTTP ${directly.status}) and write (HTTP ${writeTry.status}); the tenant's app now says "Your access to this property has ended" and keeps what was already on the phone; ${permLeft} permissions left on the folder`,
  );
  log(`dispute badge showed ${badge}, cleared after reply: ${badgeAfter === 0}`);
  log('invite permission roles', perm?.roles, 'message has app link:', perm?.message?.includes('#/join/'));
} catch (e) {
  console.error('TEST ERROR', e);
  for (const ph of [L, T, S]) await shot(ph.page, 'zz-error-' + ph.who).catch(() => undefined);
  note('run', false, String(e).slice(0, 500));
} finally {
  for (const ph of [L, T, S]) if (ph.errors.length) console.log(ph.who, 'page errors:', ph.errors.slice(0, 5));
  console.log('graph calls by kind:', drive.stats.byKind, 'denied:', drive.stats.denied.length);
  await fs.writeFile(path.join(outDir, 'results.json'), JSON.stringify({ results, stats: drive.stats, seconds: (Date.now() - t0) / 1000 }, null, 2));
  await browser.close();
  server.close();
}
