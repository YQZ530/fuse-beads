import importlib.util
import pathlib
import sys
import cv2
import numpy as np

ROOT = pathlib.Path(r'C:\Users\z5308\Desktop\perler-beads-batch_analy2')
SCRIPT = ROOT / 'scripts' / 'analyze_color_legend.py'
SRC = pathlib.Path(r'C:\Users\z5308\Desktop\batch_pic\Image1\Image1_3.PNG')
OUT = ROOT / 'test_scr' / 'output' / 'template_debug'

spec = importlib.util.spec_from_file_location('acl', SCRIPT)
acl = importlib.util.module_from_spec(spec)
sys.modules['acl'] = acl
spec.loader.exec_module(acl)

def write(path, image):
    path.parent.mkdir(parents=True, exist_ok=True)
    cv2.imencode('.png', image)[1].tofile(str(path))

def bin_text(crop):
    gray = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY) if crop.ndim == 3 else crop
    # Dark gray count text on white background.
    mask = cv2.inRange(gray, 80, 190)
    mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, np.ones((2, 2), np.uint8))
    return mask

def components(mask):
    n, labels, stats, _ = cv2.connectedComponentsWithStats(mask, 8)
    comps = []
    for i in range(1, n):
        x,y,w,h,area = stats[i]
        if area < 5 or h < 6 or w < 2:
            continue
        comps.append((x,y,w,h,area))
    return sorted(comps, key=lambda r: r[0])

img = acl.read_image(SRC)
box = acl.choose_bottom_legend_rect(img)
circles = acl.detect_circles_in_box(img, box)
tokens = acl.read_number_tokens_in_box(img, box)
print('box', box, 'tokens', [(t.text,t.x,t.y,t.width,t.height) for t in tokens])
# Build templates from confident single-digit count crops in the same image.
templates = {}
for t in tokens:
    if len(t.text) != 1:
        continue
    # Avoid D1 token because it is suspected bad at x~858.
    if 830 <= t.x <= 885:
        continue
    crop = img[max(0,t.y-4):t.y+t.height+6, max(0,t.x-4):t.x+t.width+6]
    mask = bin_text(crop)
    comps = components(mask)
    if not comps:
        continue
    x,y,w,h,_ = max(comps, key=lambda c:c[4])
    char = mask[y:y+h, x:x+w]
    char = cv2.resize(char, (24, 32), interpolation=cv2.INTER_NEAREST)
    templates.setdefault(t.text, char)
    write(OUT / f'template_{t.text}.png', char)
print('templates', sorted(templates))

# D1 item crop around count area.
d1_circle = min(circles, key=lambda c: abs(c[0]-866)+abs(c[1]-1544))
x,y,r = d1_circle
count_crop = acl.crop_box(img, x, y + int(r * 1.55), int(r * 1.55), int(r * 0.55))
mask = bin_text(count_crop)
write(OUT / 'D1_count_crop.png', count_crop)
write(OUT / 'D1_count_mask.png', mask)
comps = components(mask)
print('D1 comps', comps)
recognized=[]
for idx,(cx,cy,cw,ch,area) in enumerate(comps,1):
    char = mask[cy:cy+ch, cx:cx+cw]
    char = cv2.resize(char, (24, 32), interpolation=cv2.INTER_NEAREST)
    best=None
    for digit, tmpl in templates.items():
        score = cv2.matchTemplate(char, tmpl, cv2.TM_CCOEFF_NORMED)[0][0]
        if best is None or score > best[0]:
            best=(score,digit)
    recognized.append(best)
    write(OUT / f'D1_char{idx}.png', char)
print('recognized', recognized, 'text', ''.join(d for s,d in recognized if s>0.2))
print(OUT)
