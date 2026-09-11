"""Create a MARD inventory CSV from a palette and purchased quantities."""

import argparse
import csv
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--palette', required=True)
    parser.add_argument('--count', type=int, required=True)
    parser.add_argument('--extra', nargs='*', default=[])
    parser.add_argument('--out', type=Path, required=True)
    args = parser.parse_args()
    if args.count < 0:
        parser.error('--count must be nonnegative')
    with (ROOT / 'src/data/mardPaletteSets.csv').open(encoding='utf-8-sig', newline='') as file:
        palettes = list(csv.DictReader(file))
    palette = next((row for row in palettes if row['brand'] == 'MARD' and row['paletteName'] == args.palette), None)
    if palette is None:
        parser.error('Unknown MARD palette')
    keys = palette['colorCodes'].split()
    extras = {}
    for entry in args.extra:
        try:
            key, quantity = entry.split('=')
            quantity = int(quantity)
        except ValueError:
            parser.error('Extras must have the form COLOR=COUNT')
        if key not in keys or quantity < 0 or key in extras:
            parser.error('Extra color must be in the palette, nonnegative and specified once')
        extras[key] = quantity
    output = args.out if args.out.is_absolute() else ROOT / args.out
    if output.exists():
        parser.error(f'Output already exists: {output}')
    output.parent.mkdir(parents=True, exist_ok=True)
    with output.open('w', encoding='utf-8', newline='') as file:
        writer = csv.DictWriter(file, fieldnames=['colorKey', 'ownedCount', 'note'])
        writer.writeheader()
        for key in keys:
            extra = extras.get(key, 0)
            writer.writerow({'colorKey': key, 'ownedCount': args.count + extra,
                             'note': f'base {args.count} + purchased extra {extra}' if extra else f'base {args.count}'})
    print(f'Created inventory CSV: {len(keys)} colors, {len(keys) * args.count + sum(extras.values())} beads')


if __name__ == '__main__':
    main()
