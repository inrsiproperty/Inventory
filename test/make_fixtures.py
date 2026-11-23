"""Creates the test photos and the fake camera feed used by test/e2e.mjs (needs numpy + Pillow).
big-noisy.jpg is a deliberately hard 12-megapixel, ~11 MB photo with EXIF camera time."""
import os
import numpy as np
from PIL import Image

here = os.path.join(os.path.dirname(__file__), 'fixtures')
os.makedirs(here, exist_ok=True)
rng = np.random.default_rng(1)


def scene(w, h):
    y, x = np.mgrid[0:h, 0:w]
    r = 128 + 100 * np.sin(x / 97.0) + 20 * np.cos(y / 31.0)
    g = 128 + 90 * np.cos(y / 113.0) + 25 * np.sin((x + y) / 41.0)
    b = 128 + 80 * np.sin((x - y) / 151.0)
    img = np.stack([r, g, b], -1) + rng.normal(0, 38, (h, w, 3))
    return Image.fromarray(np.clip(img, 0, 255).astype('uint8'))


im = scene(4032, 3024)
ex = im.getexif()
ex[0x0110] = 'Test Phone'
ex.get_ifd(0x8769)[0x9003] = '2026:11:20 10:15:30'
im.save(os.path.join(here, 'big-noisy.jpg'), quality=95, exif=ex.tobytes())
scene(3024, 4032).save(os.path.join(here, 'portrait.jpg'), quality=92)

w, h = 1920, 1080
with open(os.path.join(here, 'camera.y4m'), 'wb') as f:
    f.write(f'YUV4MPEG2 W{w} H{h} F10:1 Ip A1:1 C420jpeg\n'.encode())
    for _ in range(4):
        rgb = np.asarray(scene(w, h)).astype(np.float32)
        Y = 0.299 * rgb[..., 0] + 0.587 * rgb[..., 1] + 0.114 * rgb[..., 2]
        U = (-0.169 * rgb[..., 0] - 0.331 * rgb[..., 1] + 0.5 * rgb[..., 2] + 128).reshape(h // 2, 2, w // 2, 2).mean((1, 3))
        V = (0.5 * rgb[..., 0] - 0.419 * rgb[..., 1] - 0.081 * rgb[..., 2] + 128).reshape(h // 2, 2, w // 2, 2).mean((1, 3))
        f.write(b'FRAME\n')
        for plane in (Y, U, V):
            f.write(np.clip(plane, 0, 255).astype('uint8').tobytes())
print('fixtures written to', here)
