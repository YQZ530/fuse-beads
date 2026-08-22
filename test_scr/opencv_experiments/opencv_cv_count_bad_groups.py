import importlib.util
import json
import pathlib
import re
import sys
from collections import Counter, defaultdict

import cv2
import numpy as np

ROOT = pathlib.Path(r'C:\Users\z5308\Desktop\perler-beads-batch_analy2')
SCRIPT = ROOT / 'scripts' / 'analyze_color_legend.py'
MANIFEST = ROOT / 'test_scr' / 'groups.manifest.json'
BAD = {'Image1','Image4','Image5','Image6','Image7','Image12','Image16','Image22','Image23'}

spec = importlib.util.spec_from_file_location('acl', SCRIPT)
acl = importlib.util.module_from_spec(spec)
sys.modules['acl'] = acl
spec.loader.exec_module(acl)
palette = acl.load_mard_palette(acl.DEFAULT_MAPPING_PATH, acl.DEFAULT_PALETTE_SETS_PATH, '291')
palette_by_key = {c.key: c for c in palette}
palette_keys = set(palette_by_key)

def count_components_in_box(image, box):
    x0, y0, w, h = box
    legend = image[y0:y0+h, x0:x0+w]
    gray = cv2.cvtColor(legend, cv2.COLOR_BGR2GRAY)
    row_top = int(h * 0.55)
    row_bottom = int(h * 0.90)
    row = gray[row_top:row_bottom, :]
    mask = cv2.inRange(row, 90, 235)
    mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, np.ones((1, 1), np.uint8))
    n, labels, stats, _ = cv2.connectedComponentsWithStats(mask, 8)
    comps = []
    for i in range(1, n):
        x, y, cw, ch, area = stats[i]
        cy = y + row_top
        if 4 <= cw <= 26 and 8 <= ch <= 24 and 8 <= area <= 220:
            comps.append({'x': int(x), 'y': int(cy), 'w': int(cw), 'h': int(ch), 'area': int(area), 'img': mask[y:y+ch, x:x+cw]})
    return comps

def build_digit_templates(tokens, comps, box):
    x0, y0, _w, _h = box
    templates = defaultdict(list)
    for token in tokens:
        local_x = token.x - x0
        local_y = token.y - y0
        inside = [
            c for c in comps
            if c['x'] >= local_x - 3
            and c['x'] + c['w'] <= local_x + token.width + 3
            and abs(c['y'] - local_y) <= 8
        ]
        inside = sorted(inside, key=lambda c: c['x'])
        if len(inside) == len(token.text):
            for ch, comp in zip(token.text, inside):
                templates[ch].append(cv2.resize(comp['img'], (24, 32), interpolation=cv2.INTER_NEAREST))
    return templates

def classify_component(comp, templates):
    if not templates:
        return 0.0, ''
    char = cv2.resize(comp['img'], (24, 32), interpolation=cv2.INTER_NEAREST)
    best = (-1.0, '')
    for digit, tmpls in templates.items():
        score = max(float(cv2.matchTemplate(char, tmpl, cv2.TM_CCOEFF_NORMED)[0][0]) for tmpl in tmpls)
        if score > best[0]:
            best = (score, digit)
    return best

def opencv_count_for_circle(circle, comps, templates, box):
    x0, y0, _w, _h = box
    cx, cy, radius = circle
    lx = cx - x0
    ly = cy - y0
    candidates = []
    for comp in comps:
        ccx = comp['x'] + comp['w'] / 2
        ccy = comp['y'] + comp['h'] / 2
        dx = abs(ccx - lx)
        dy = ccy - ly
        if dx <= max(radius * 1.15, 32) and radius * 0.75 <= dy <= radius * 2.05:
            candidates.append(comp)
    candidates = sorted(candidates, key=lambda c: c['x'])
    if not candidates:
        return '', []
    recognized = [classify_component(comp, templates) for comp in candidates]
    if any(score < 0.35 or not digit for score, digit in recognized):
        return '', recognized
    return ''.join(digit for _score, digit in recognized), recognized

def page_detail_with_cv_counts(path):
    image = acl.read_image(path)
    box = acl.choose_bottom_legend_rect(image)
    if box is None:
        return []
    circles = acl.detect_circles_in_box(image, box)
    tokens = acl.read_number_tokens_in_box(image, box)
    selected_tokens, expected_total, _transparent = acl.select_legend_count_tokens(tokens)
    comps = count_components_in_box(image, box)
    templates = build_digit_templates(tokens, comps, box)
    rows = []
    for token in selected_tokens:
        circle = acl.find_circle_above_token(circles, token)
        if circle is None:
            continue
        x, y, r = circle
        sampled = acl.sample_circle_rgb(image, x, y, r)
        if sampled is None:
            continue
        matched, distance = acl.match_palette(sampled, palette)
        mosaic = acl.looks_like_mosaic_stat_circle(image, x, y, r)
        ocr_key = ''
        if mosaic or distance > 4.0:
            ocr_key, inside_text = acl.read_circle_key(image, x, y, r, palette_keys)
            if ocr_key not in palette_keys and mosaic:
                continue
        key = ocr_key if ocr_key in palette_by_key else matched.key
        cv_text, scores = opencv_count_for_circle(circle, comps, templates, box)
        count_text = cv_text or token.text
        rows.append({'key': key, 'count': int(count_text), 'token': token.text, 'cv': cv_text, 'source': path.name})
    return rows

def page_modal(path):
    image = acl.read_image(path)
    analysis = acl.analyze_color_modal(image, palette)
    return [{'key': c.matched_key, 'count': c.count or 0, 'token': c.count_text, 'cv': '', 'source': path.name} for c in analysis.circles]

def merge_rows(pages):
    by_key = {}
    obs = defaultdict(list)
    for rows in pages:
        for row in rows:
            obs[row['key']].append(row)
            if row['key'] not in by_key or row['count'] > by_key[row['key']]['count']:
                by_key[row['key']] = row
    return by_key, obs

def group_expected(group):
    keys = []
    for item in group.get('items', []):
        pk = item.get('pairKey')
        if pk and re.match(r'^\d+_\d+$', pk):
            keys.append(pk)
    return Counter(keys).most_common(1)[0][0] if keys else None

manifest = json.loads(MANIFEST.read_text(encoding='utf-8'))
print('Image1_3 page detail CV total check:')
rows = page_detail_with_cv_counts(pathlib.Path(r'C:\Users\z5308\Desktop\batch_pic\Image1\Image1_3.PNG'))
print('keys', len(rows), 'sum', sum(r['count'] for r in rows))
print([(r['key'], r['count'], r['token'], r['cv']) for r in rows])
print('\nBad group experiment:')
for group in manifest.get('groups', []):
    name = group.get('groupName') or group.get('folderName') or group.get('id')
    if name not in BAD:
        continue
    items = [item for item in group.get('items', []) if isinstance(item, dict)]
    detail = [item for item in items if item.get('pageType') == 'detail_page']
    modal = [item for item in items if item.get('pageType') == 'color_modal']
    selected = detail if detail else modal
    pages = []
    for item in selected:
        path = pathlib.Path(str(item.get('source')))
        rows = page_detail_with_cv_counts(path) if item.get('pageType') == 'detail_page' else page_modal(path)
        pages.append(rows)
    merged, obs = merge_rows(pages)
    got_keys = len(merged)
    got_beads = sum(row['count'] for row in merged.values())
    pk = group_expected(group) or '0_0'
    exp_keys, exp_beads = map(int, pk.split('_'))
    print(name, 'expected', pk, 'got', f'{got_keys}_{got_beads}', 'diff', got_keys-exp_keys, got_beads-exp_beads)
    if name == 'Image1':
        print(' Image1 changed rows where cv differs from token:')
        for rows in pages:
            for r in rows:
                if r['cv'] and r['cv'] != r['token']:
                    print(' ', r)
