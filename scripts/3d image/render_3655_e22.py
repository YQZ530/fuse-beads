"""Render the existing, verified bead layout with an E22 paper background."""
import json
from pathlib import Path

palette_path = Path('src/app/colorSystemMapping.json')
palette = json.loads(palette_path.read_text(encoding='utf-8-sig'))
matches = [hex_color for hex_color, names in palette.items() if names.get('MARD') == 'E22']
assert len(matches) == 1, matches
background = matches[0]

source = Path('scripts/render_3655.py').read_text(encoding='utf-8')
source = source.replace("Image.new('RGB',(W,H),'white')", f"Image.new('RGB',(W,H),'{background}')")
source = source.replace('fill="white"/>', f'fill="{background}"/>')
source = source.replace('#929292', '#77616C')
source = source.replace('色号依原图', '色号依原图  |  背景 E22（不放豆）')
source = source.replace('空白格不放豆；', 'E22 背景格不放豆；')
source = source.replace('unoccupied cells are left white.', 'unoccupied cells show the E22 background and have no bead code.')
source = source.replace('great-wave-52x{ROWS}', 'great-wave-52x{ROWS}-e22')
source = source.replace("out/'preview.png'", "out/'preview-e22.png'")
source = source.replace("out/'verification.json'", "out/'verification-e22.json'")
exec(compile(source, 'scripts/render_3655.py [E22 background]', 'exec'))

report_path = Path('results/3655/verification-e22.json')
report = json.loads(report_path.read_text(encoding='utf-8'))
report['background'] = {'code': 'E22', 'hex': background, 'palette_source': str(palette_path), 'beads': False}
original = json.loads(Path('results/3655/verification.json').read_text(encoding='utf-8'))
assert all(report[key] == original[key] for key in ('columns', 'rows', 'parts', 'beads', 'counts'))
assert Path('results/3655/great-wave-52x80-e22.csv').read_bytes() == Path('results/3655/great-wave-52x80.csv').read_bytes()
report['checks'].append('bead grid identical to the original CSV; E22 is background only')
report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
print(f'Background: MARD E22 {background}. Original bead cells and empty holes unchanged.')
