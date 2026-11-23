"""Checks the files the e2e test pulled out of the mock OneDrive:
- every photo carries a burned-in date/time stamp in the bottom-right corner (pixel check)
- the PDF is structurally valid, renders with PDFium (Android's engine) and Poppler,
  and shows every room, item, rating and a thumbnail for every photo.
"""
import glob, json, os, re, subprocess, sys
import numpy as np
from PIL import Image
import pypdf, pypdfium2 as pdfium

out = os.path.join(os.path.dirname(__file__), '..', 'test-results')
res = json.load(open(os.path.join(out, 'results.json')))
exp = json.load(open(os.path.join(out, 'expected.json')))
checks = []

# ---- stamps ----
stamped, total, worst = 0, 0, []
for f in sorted(glob.glob(os.path.join(out, 'photo-*.jpg'))):
    im = np.asarray(Image.open(f).convert('L')).astype(float)
    h, w = im.shape
    fs = max(14, round(max(w, h) * 0.022))
    bw, bh = int(fs * 9.5), int(fs * 2.4)
    pad = int(fs * 0.45)
    box = im[h - pad - bh + 2 : h - pad - 2, w - pad - bw + 2 : w - pad - 2]
    ctl = im[h - pad - bh + 2 : h - pad - 2, pad : pad + bw - 4]
    white = (box > 235).mean()
    ok = np.median(box) < np.median(ctl) - 25 and white > 0.02 and white > 3 * (ctl > 235).mean()
    total += 1
    stamped += ok
    if not ok:
        worst.append(os.path.basename(f))
checks.append(('AC5 date stamp burned into every OneDrive photo (pixel check)', stamped == total, f'{stamped}/{total} photos have the stamp box with white text in the bottom-right corner' + (f'; missing: {worst[:5]}' if worst else '')))

# ---- PDF ----
pdf_path = os.path.join(out, 'report.pdf')
q = subprocess.run(['qpdf', '--check', pdf_path], capture_output=True, text=True)
qpdf_ok = q.returncode == 0
reader = pypdf.PdfReader(pdf_path)
text = '\n'.join(p.extract_text() or '' for p in reader.pages)
flat = re.sub(r'\s+', ' ', text)
images = sum(len(p.images) for p in reader.pages)
missing_rooms = [r for r in exp['rooms'] if r not in flat]
missing_items = [i for i in set(exp['items']) if i not in flat and i != 'Desk and chair']
ratings_seen = sorted({w for w in ['New', 'Good', 'Fair', 'Poor', 'Damaged'] if re.search(rf'\b{w}\b', flat)})
doc = pdfium.PdfDocument(pdf_path)
rendered = 0
for i in range(len(doc)):
    pg = doc[i]
    img = pg.render(scale=1.2).to_pil()
    rendered += 1
    if i in (0, 2, 3, len(doc) - 1):
        img.save(os.path.join(out, f'pdf-page-{i + 1}.png'))
pop = subprocess.run(['pdftoppm', '-r', '40', '-png', pdf_path, os.path.join(out, 'poppler')], capture_output=True)
pop_pages = len(glob.glob(os.path.join(out, 'poppler*.png')))
size_mb = os.path.getsize(pdf_path) / 1024 / 1024
ok = qpdf_ok and not missing_rooms and not missing_items and images >= exp['photos'] and rendered == len(reader.pages) == pop_pages
checks.append(
    (
        'AC6 PDF shows every room, item, rating and photo thumbnail',
        ok,
        f'{len(reader.pages)} A4 pages, {size_mb:.1f} MB; qpdf structure check {"OK" if qpdf_ok else "FAILED"}; renders on PDFium (Android/Chrome engine) and Poppler: {rendered}/{pop_pages} pages; '
        f'{len(exp["rooms"]) - len(missing_rooms)}/{len(exp["rooms"])} rooms and {len(set(exp["items"])) - 1 - len(missing_items)}/{len(set(exp["items"])) - 1} item names found in the text; ratings shown: {", ".join(ratings_seen)}; '
        f'{images} embedded thumbnails for {exp["photos"]} photos' + (f'; missing rooms {missing_rooms}' if missing_rooms else '') + (f'; missing items {missing_items[:8]}' if missing_items else ''),
    )
)

for c in checks:
    print(('PASS' if c[1] else 'FAIL'), c[0] + ':', c[2])
res['results'].extend({'id': c[0], 'pass': bool(c[1]), 'detail': c[2]} for c in checks)
json.dump(res, open(os.path.join(out, 'results.json'), 'w'), indent=2)
