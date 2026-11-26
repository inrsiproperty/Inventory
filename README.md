# Inventory App: phase 1 (landlord check-in)

> **Live app:** https://inrsiproperty.github.io/Inventory/ · repository `inrsiproperty/Inventory` · Entra app "Inventory App" in Default Directory, client ID `d2439f50-4c9e-4165-be02-46d81a73875a` (built into `src/lib/config.ts`). Setup below is already done; it's kept for reference.

Inventory App is a phone-first web app (PWA) for photo-evidenced property inventories. Everything is saved on the phone first, then synced to the landlord's own OneDrive. There's no app server.

Phase 1 covers sign-in, properties, tenancies, rooms and items from UK templates, walk-through photo capture, condition ratings, Report issue, meters, keys, safety checks and documents, offline save with OneDrive sync, and PDF export.

Stack (as specified): React + TypeScript + Vite PWA (vite-plugin-pwa), MSAL.js, Microsoft Graph, Dexie/IndexedDB, pdf-lib, browser-image-compression and Tailwind CSS.

---

## Set it up (about 20 minutes, one time)

You'll need:

- the Microsoft account whose OneDrive will hold the data (your Microsoft 365 Personal account)
- a free GitHub account.

Your app address will be `https://YOUR-GITHUB-NAME.github.io/inventory-app/`. Work this out first, because both Microsoft and GitHub need it. It ends with a `/`.

### Step 1: Get a Microsoft Entra directory (only if you don't have one)

Since June 2024, Microsoft requires every new app registration to live inside a directory (tenant), even for personal accounts. If you open the Entra admin centre and it says you have no directory, or that you are in "Microsoft Services", create one for free:

1. Go to https://azure.microsoft.com/free and sign up with your Microsoft account. Microsoft may ask for a card to confirm your identity. Registering an app is free.
2. Sign-up creates a "Default Directory" for you.

The Microsoft 365 Developer Program is another free way to get a directory.

### Step 2: Register the app in Microsoft Entra

1. Go to https://entra.microsoft.com and sign in.
2. Open **App registrations**. Search for it in the top bar, or go to **Entra ID → App registrations**. Click **New registration**.
3. **Name:** `Inventory App`
4. **Supported account types:** choose **Accounts in any organizational directory (Any Microsoft Entra ID tenant – Multitenant) and personal Microsoft accounts (e.g. Skype, Xbox)**.
5. **Redirect URI:**
   - Platform: **Single-page application (SPA)**. Don't choose "Web".
   - Address: `https://YOUR-GITHUB-NAME.github.io/inventory-app/`, with the trailing `/`.
6. Click **Register**.
7. On the **Overview** page, copy the **Application (client) ID** (it looks like `1b2c3d4e-…`) and keep it for Step 4.
8. Open **API permissions → Add a permission → Microsoft Graph → Delegated permissions**. Tick **Files.ReadWrite.All** and **offline_access**. **User.Read** is already there. Click **Add permissions**. Personal accounts don't need admin consent; you'll approve access yourself the first time you sign in.
9. Optional, for trying it on a computer: open **Authentication** and, under Single-page application, add `http://localhost:5173/`.

Leave **Certificates & secrets** alone. A phone app must never have a client secret.

### Step 3: Put the code on GitHub

1. Sign in at https://github.com and click **New repository**.
2. Name it exactly `inventory-app`, set it to **Public** (free GitHub Pages needs a public repository), and don't add a README. Click **Create repository**.
3. Unzip `inventory-app.zip` on your computer.
4. On the new repository page, click **uploading an existing file**. Drag in **everything inside** the unzipped `inventory-app` folder, then click **Commit changes**.
   - The `.github` folder is hidden by default. On a Mac, press **Cmd + Shift + .** in Finder to show it. On Windows, choose **View → Show → Hidden items**. It must be uploaded, because it holds the publishing workflow.
   - If it didn't upload: click **Add file → Create new file**, type `.github/workflows/deploy.yml` as the name, paste in the contents of that file from the zip, and commit.

### Step 4: Turn on GitHub Pages and give it your client ID

1. In the repository, go to **Settings → Pages**. Under **Build and deployment → Source**, choose **GitHub Actions**.
2. Go to **Settings → Secrets and variables → Actions → Variables** tab and click **New repository variable**.
   - Name: `MSAL_CLIENT_ID`
   - Value: the Application (client) ID from Step 2.
3. Go to the **Actions** tab, click **Deploy to GitHub Pages**, then **Run workflow**. After about two minutes you get a green tick and your link: `https://YOUR-GITHUB-NAME.github.io/inventory-app/`.

Every later upload of changed files to the repository republishes the site automatically.

### Step 5: Put it on your phone

- **iPhone:** open the link in **Safari**, tap **Share → Add to Home Screen**, then open it from the home-screen icon.
- **Android:** open the link in **Chrome**, tap **⋮ → Install app** (or **Add to Home screen**).

Then tap **Sign in with Microsoft** and approve OneDrive access once. Your OneDrive now has a **Property Inventories** folder, and each property gets its own subfolder when you add it.

> **Azure Static Web Apps instead of GitHub Pages?** It works too. Create a Static Web App linked to the same repository, with app location `/` and output location `dist`. Use its `https://….azurestaticapps.net/` address as the Entra redirect URI, and set `VITE_MSAL_CLIENT_ID` as a build environment variable.

---

## Using it

1. **Add property**: enter the address, postcode, flat or house, bedrooms and furnishing.
2. **New tenancy**: enter tenant names and emails, the start date, and optionally the end date and deposit scheme reference.
3. **Start check-in**: untick any rooms the property doesn't have. Meters, keys, safety checks and documents are always added.
4. **Walk-through**: the camera opens, and for each item you snap one or more photos, tap a condition, then **Next item**.
5. Use the item screens for cleanliness, notes, descriptions, meter readings, key counts, safety tests and documents.
6. **Report issue** is the red button on every screen: optional photo, then the issue type, then **Save**.
7. **PDF**: generate the report, which saves to the inventory's `exports` folder in OneDrive. You can open or share it from the phone.

Everything works with no signal. The cloud icon at the top of each screen shows what's waiting to upload. On iPhone, keep the app open until it shows **All saved to OneDrive**, because iPhone web apps can't upload in the background.

---

## How it stores data

```
OneDrive/Property Inventories/
  _app/settings.json                                   templates, photo settings
  {address-slug}_{propertyId}/                         one folder per property
    property.json
    tenancies/{tenancyId}/tenancy.json
    tenancies/{tenancyId}/inventories/{type}_{date}_{inventoryId}/
      inventory.json                                   rooms and items (landlord only, written with If-Match)
      entries/{timestamp}_{authorId}_{entryId}.json    one small file per change, written once, never edited
      photos/{room}/{item}/{timestamp}_{photoId}.jpg   ≤2560 px, under 2 MB, date-stamped
      exports/Inventory_{address}_{type}_{date}_v{n}.pdf
```

- Every change (a rating, note, photo, issue or room/item edit) is an **entry**. The current state is rebuilt by replaying the entries, so nothing is overwritten.
- Each photo's SHA-256 fingerprint and three timestamps are kept: camera time (EXIF, for gallery photos), app time, and OneDrive's created time.
- Photos are uploaded with `conflictBehavior=fail`, so a retried upload can never replace a file. Files over 4 MB (in practice only PDFs) use a resumable upload session.
- New changes are pulled with Graph **delta** on each property folder, so a second phone restores everything.
- Uploads retry with back-off. The full-size photo is removed from the phone only after OneDrive confirms it, and a thumbnail stays.

## Code layout

```
src/lib/       config, types (data model), db (Dexie), auth (MSAL), graph (OneDrive), sync,
               actions (all changes), state (replay), photos (resize + stamp), exif, pdf, paths, templates
src/screens/   Welcome, Properties (+ property, tenancy, start check-in), Inventory (overview, room,
               item, issues, export), Settings (sync queue, photo options, template editor)
src/components ui kit, Camera (in-app camera, burst and walk-through), Overlays (Report issue,
               photo viewer), SyncBadge
test/          end-to-end test harness (see below)
```

## Develop on a computer

```bash
npm install
echo "VITE_MSAL_CLIENT_ID=your-client-id" > .env.local
npm run dev          # http://localhost:5173/  (add this redirect URI in Entra, Step 2.9)
npm run build        # production build in dist/
npm run typecheck
```

## Tests

`test/e2e.mjs` drives the app in a phone-sized Chromium (Playwright) with a fake rear camera and an in-memory OneDrive (`test/mock-graph.mjs`) that behaves like Microsoft Graph. It checks the phase 1 acceptance criteria, plus an eTag conflict and a second-phone restore. `test/check_outputs.py` checks the burned-in date stamp on every photo, and checks that the PDF is valid and renders with PDFium and Poppler.

The harness was built where npm packages couldn't be downloaded. So `test/build.mjs` bundles the real source with esbuild, and swaps in small stand-ins (`test/stubs/`) for Dexie, MSAL, browser-image-compression and the PWA plugin. To run it:

```bash
python3 test/make_fixtures.py
node test/build.mjs && node test/e2e.mjs && python3 test/check_outputs.py
```

(`test/build.mjs` expects esbuild, tailwindcss, react, react-dom, pdf-lib and playwright in `test/node_modules`.)

## Known limits in phase 1

- **Sign-in each time the app is reopened.** Per the spec, tokens are kept in session storage. Closing the app forgets them, so you tap "Sign in to sync" (one tap, no password if Microsoft remembers you). Your data is always on the phone, and the app opens and works offline without signing in. Switching MSAL's `cacheLocation` to `localStorage` in `src/lib/auth.ts` would remove this prompt, but tokens would then stay on the device longer.
- **A new phone restores entries one file at a time.** Restoring about 250 entries takes a few hundred small requests. Graph `$batch` could speed this up later.
- Tenant invite, review, disputes, signatures and locking are phase 2. Check-out, comparison, mid-term inspections and fixed-issue status are phase 3. The "Send to tenant" button is shown but disabled.
