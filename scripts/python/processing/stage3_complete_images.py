"""Complete reviewed images offline. Preview by default; stop the web server before --apply."""

import argparse
import copy
import csv
import hashlib
import io
import json
import os
from pathlib import Path
import re
import sys
from datetime import datetime, timezone
import uuid

PROCESSING = Path('results/processing')
GROUPED = PROCESSING / '1.grouped-images'
LEGENDS = PROCESSING / '2.groupped-bead-count'
DONE = PROCESSING / '3.done-images'
OPERATIONS = PROCESSING / '.completion-operations'
WAREHOUSE = Path('results/app/warehouse')
PROJECTS = Path('results/app/projects')
EXTENSIONS = {'.png', '.jpg', '.jpeg', '.webp', '.gif'}


def json_bytes(value):
    return (json.dumps(value, ensure_ascii=False, indent=2) + '\n').encode('utf-8')


def read_json(file):
    return json.loads(file.read_text(encoding='utf-8-sig'))


def safe(root, relative):
    candidate = root / relative
    if candidate.is_symlink() or not candidate.resolve().is_relative_to(root.resolve()):
        raise ValueError(f'Unsafe path: {relative}')
    return candidate


def digest(file):
    return hashlib.sha256(file.read_bytes()).hexdigest() if file.is_file() else None


def tree_digest(file):
    if file.is_file():
        return digest(file)
    if not file.exists():
        return None
    entries = []
    for child in sorted(file.rglob('*')):
        if child.is_symlink() or not child.resolve().is_relative_to(file.resolve()):
            raise ValueError(f'Unsafe image path: {child}')
        if child.is_file():
            entries.append((child.relative_to(file).as_posix(), digest(child)))
    return hashlib.sha256(json_bytes(entries)).hexdigest()


def parse_image_ids(values):
    result = []
    for token in re.split(r'[,\s]+', ' '.join(values).strip()):
        match = re.fullmatch(r'(?:Image)?([1-9]\d*)', token, re.IGNORECASE)
        if not match:
            raise ValueError(f'Invalid image ID: {token}')
        image_id = f'Image{match[1]}'
        if image_id not in result:
            result.append(image_id)
    return result


def read_csv(file):
    with file.open(encoding='utf-8-sig', newline='') as stream:
        reader = csv.DictReader(stream)
        rows = list(reader)
        if not reader.fieldnames or any(None in row or None in row.values() for row in rows):
            raise ValueError(f'Invalid CSV: {file}')
        return reader.fieldnames, rows


def csv_bytes(columns, rows):
    stream = io.StringIO(newline='')
    writer = csv.DictWriter(stream, fieldnames=columns, lineterminator='\n')
    writer.writeheader()
    writer.writerows(rows)
    return stream.getvalue().encode('utf-8')


def positive_counts(row):
    counts = row.get('colorCounts')
    if not isinstance(counts, dict) or not counts:
        raise ValueError(f'Missing counts: {row.get("id")}')
    for key, count in counts.items():
        if not re.fullmatch(r'[A-Z]+[1-9]\d*', key) or type(count) is not int or count <= 0:
            raise ValueError(f'Invalid count: {key}={count}')
    if sum(counts.values()) != row.get('totalBeads') or len(counts) != row.get('totalColorKeys'):
        raise ValueError(f'Legend total mismatch: {row.get("id")}')
    if row.get('needsReviewCount', 0) or row.get('matchesExpected') is False:
        raise ValueError(f'Unresolved legend: {row.get("id")}')
    return counts


def locate_images(root, image_id, group):
    candidates = [p for p in safe(root, GROUPED).iterdir()
                  if p.name.lower() == image_id.lower()
                  or (p.is_file() and p.stem.lower() == image_id.lower() and p.suffix.lower() in EXTENSIONS)]
    if len(candidates) != 1:
        raise ValueError(f'Missing or ambiguous images: {image_id}')
    source = candidates[0]
    safe(root / GROUPED, source.relative_to(root / GROUPED))
    tree_digest(source)
    files = sorted(p for p in source.rglob('*') if p.is_file()) if source.is_dir() else [source]
    images = [p for p in files if p.suffix.lower() in EXTENSIONS]
    if not images:
        raise ValueError(f'No screenshots: {image_id}')
    if group:
        expected = [str(i['filename']).replace('\\', '/').split('/')[-1].lower() for i in group['items']]
        actual = [p.name.lower() for p in images]
        if sorted(expected) != sorted(actual) or group['count'] != len(images):
            raise ValueError(f'Manifest/files mismatch: {image_id}')
    destination = safe(root, DONE / source.name)
    if destination.exists() or any(p.name.lower() == source.name.lower() for p in destination.parent.glob('*')):
        raise ValueError(f'Archive destination exists: {destination}')
    old_paths = [p.relative_to(root).as_posix() for p in images]
    new_paths = [(DONE / source.name / p.relative_to(source)).as_posix() if source.is_dir()
                 else (DONE / source.name).as_posix() for p in images]
    return source, destination, old_paths, new_paths


def fallback_hex(key):
    value = 0
    for char in key:
        value = (value * 31 + ord(char)) & 0xFFFFFFFF
    return f'#{value & 0xFFFFFF:06X}'


def recalculate_project(root, project, inventory, now):
    # Match the web store's active-pattern, color-key and hex-based stock rules.
    stock = {r['colorKey'].upper(): r for r in inventory
             if r['warehouseId'] == project['warehouseId'] and r['colorKey']}
    stock_hex = {r['hex'].upper(): int(r['ownedCount']) for r in stock.values()}
    demand = {}
    for pattern in project['patterns']:
        if pattern.get('status', 'draft') not in ('draft', 'in_progress'):
            continue
        if pattern.get('colorCounts'):
            colors = [(stock.get(key.upper(), {}).get('hex', fallback_hex(key)).upper(), key, count)
                      for key, count in pattern['colorCounts'].items()]
        else:
            if not pattern.get('path'):
                raise ValueError(f'Cannot recalculate pattern without counts/path: {pattern["id"]}')
            grid = read_json(safe(root, pattern['path']))
            colors = [(entry.get('color', key).upper(), entry.get('colorKey', entry.get('key', '')), entry['count'])
                      for key, entry in grid['colorCounts'].items()]
        for hex_value, key, count in colors:
            if type(count) is not int or count < 0:
                raise ValueError(f'Invalid project count: {key}')
            if count:
                demand[(hex_value, key)] = demand.get((hex_value, key), 0) + count
    items = []
    for (hex_value, key), needed in demand.items():
        owned = stock_hex.get(hex_value, 0)
        items.append(dict(hex=hex_value, colorKey=key, needed=needed, owned=owned,
                          missing=max(0, needed-owned), remainingAfterProject=owned-needed))
    def color_order(item):
        match = re.fullmatch(r'([A-Z]+)(\d+)', item['colorKey'])
        return (match[1], int(match[2])) if match else (item['colorKey'], 0)
    project['items'] = sorted(items, key=color_order)
    project['missingItems'] = [i for i in project['items'] if i['missing'] > 0]
    project['summary'] = dict(totalNeeded=sum(i['needed'] for i in items),
                              totalOwned=sum(min(i['needed'], i['owned']) for i in items),
                              totalMissing=sum(i['missing'] for i in items), colorsNeeded=len(items),
                              missingColorCount=len(project['missingItems']))
    statuses = [p.get('status', 'draft') for p in project['patterns']]
    project['status'] = ('in_progress' if 'in_progress' in statuses else
                         'completed' if statuses and all(s == 'completed' for s in statuses) else 'draft')
    project['updatedAt'] = now


def build_completion_plan(root, ids, warehouse_id, note='完成拼图'):
    root = Path(root).resolve()
    for name in ('.csv.lock', '.csv-pending'):
        if (root / WAREHOUSE / name).exists():
            raise ValueError(f'Warehouse has an active/interrupted writer: {name}')
    snapshots = {}
    def watch(relative):
        file = safe(root, relative)
        snapshots[str(relative)] = digest(file)
        return file
    main_path = LEGENDS / 'analyze_color_legend.main.json'
    debug_path = LEGENDS / 'analyze_color_legend.debug.json'
    manifest_path = GROUPED / 'groups.manifest.json'
    main = read_json(watch(main_path))
    debug = read_json(watch(debug_path))
    manifest = read_json(watch(manifest_path))
    done_path = DONE / 'done-count.json'
    done_file = watch(done_path)
    done = read_json(done_file) if done_file.exists() else dict(schemaVersion=1, images={})
    inv_columns, inventory = read_csv(watch(WAREHOUSE / 'inventory.csv'))
    tx_columns, transactions = read_csv(watch(WAREHOUSE / 'transactions.csv'))
    stock = {}
    for row in inventory:
        if row['schemaVersion'] != '1' or not re.fullmatch(r'\d+', row['ownedCount']):
            raise ValueError('Invalid inventory row')
        key = (row['warehouseId'], row['colorKey'])
        if key in stock:
            raise ValueError(f'Duplicate inventory color: {key}')
        stock[key] = row
    if not any(r['warehouseId'] == warehouse_id for r in inventory):
        raise ValueError(f'Unknown warehouse: {warehouse_id}')
    for tx in transactions:
        if int(tx['before']) + int(tx['delta']) != int(tx['after']) or int(tx['after']) < 0:
            raise ValueError('Invalid transaction balance')
    def index(rows, key):
        result = {}
        for row in rows:
            if row[key] in result:
                raise ValueError(f'Ambiguous ID: {row[key]}')
            result[row[key]] = row
        return result
    main_index = index(main['images'], 'id')
    debug_index = index(debug['images'], 'id')
    groups = index(manifest['groups'], 'groupName')
    now = datetime.now(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')
    selected, skipped, moves = [], [], []
    for image_id in ids:
        existing = done['images'].get(image_id)
        related = [t for t in transactions if t['patternId'] == image_id]
        if existing:
            valid = (existing['warehouseId'] == warehouse_id and image_id not in main_index
                     and image_id not in debug_index and image_id not in groups
                     and len(related) == len(existing['colorCounts'])
                     and all(t['transactionId'] == existing['transactionId'] and t['warehouseId'] == warehouse_id
                             and -int(t['delta']) == existing['colorCounts'].get(t['colorKey']) for t in related)
                     and len({t['colorKey'] for t in related}) == len(related)
                     and all(safe(root, p).is_file() for p in existing['imagePaths']))
            if not valid:
                raise ValueError(f'Inconsistent completion: {image_id}')
            skipped.append(image_id)
            continue
        if related:
            raise ValueError(f'Existing transaction without archive: {image_id}')
        if image_id not in main_index or image_id not in debug_index:
            raise ValueError(f'Unknown/incomplete image: {image_id}')
        row = main_index[image_id]
        counts = positive_counts(row)
        source, destination, old_paths, new_paths = locate_images(root, image_id, groups.get(image_id))
        transaction_id = str(uuid.uuid4())
        for key, count in counts.items():
            item = stock.get((warehouse_id, key))
            if item is None or int(item['ownedCount']) < count:
                raise ValueError(f'Insufficient stock: {image_id} {key}, need {count}, owned {item["ownedCount"] if item else 0}')
            before = int(item['ownedCount'])
            transactions.append(dict(schemaVersion='1', transactionId=transaction_id, warehouseId=warehouse_id,
                type='manual_adjustment', createdAt=now, note=note, projectId='', patternId=image_id,
                imagePath=new_paths[0], colorKey=key, hex=item['hex'], delta=str(-count),
                before=str(before), after=str(before-count)))
            item['ownedCount'] = str(before-count)
            item['itemUpdatedAt'] = now
        done['images'][image_id] = dict(id=image_id, completedAt=now, warehouseId=warehouse_id,
            transactionId=transaction_id, reason=note, colorCounts=copy.deepcopy(counts), totalBeads=sum(counts.values()),
            imagePaths=new_paths, originalPaths=old_paths, main=copy.deepcopy(row),
            debug=copy.deepcopy(debug_index[image_id]), manifest=copy.deepcopy(groups.get(image_id)), projectReferences=[])
        moves.append(dict(source=source.relative_to(root).as_posix(), destination=destination.relative_to(root).as_posix(),
                          digest=tree_digest(source)))
        selected.append(image_id)
    writes = {}
    project_count = 0
    for file in sorted((root / PROJECTS).glob('*/project.json')):
        project = read_json(watch(file.relative_to(root)))
        if any(p['id'] in skipped for p in project.get('patterns', [])):
            raise ValueError(f'Completed image still in project: {project["id"]}')
        matches = [p for p in project.get('patterns', []) if p['id'] in selected]
        for pattern in matches:
            if pattern.get('inventoryDeductedAt'):
                raise ValueError(f'Project already deducted stock: {pattern["id"]}')
            record = done['images'][pattern['id']]
            record['projectReferences'].append(dict(projectId=project['id'], projectName=project['name'],
                projectPath=file.relative_to(root).as_posix(), pattern=copy.deepcopy(pattern)))
        if matches or (selected and project.get('warehouseId') == warehouse_id):
            project['patterns'] = [p for p in project['patterns'] if p['id'] not in selected]
            recalculate_project(root, project, inventory, now)
            writes[file.relative_to(root).as_posix()] = json_bytes(project)
            project_count += 1
    assignments_path = PROJECTS / 'pattern-assignments.json'
    assignments_file = watch(assignments_path)
    if assignments_file.exists():
        assignments = read_json(assignments_file)
        if any(i in assignments for i in skipped):
            raise ValueError('Completed image still assigned to a project')
        if any(i in assignments for i in selected):
            assignments = {k:v for k,v in assignments.items() if k not in selected}
            writes[assignments_path.as_posix()] = json_bytes(assignments)
    if selected:
        for row in inventory:
            if row['warehouseId'] == warehouse_id:
                row['warehouseUpdatedAt'] = now
        manifest['groups'] = [g for g in manifest['groups'] if g['groupName'] not in selected]
        manifest['groupCount'] = len(manifest['groups'])
        manifest['imageCount'] = sum(g['count'] for g in manifest['groups'])
        for data in (main, debug):
            data['images'] = [r for r in data['images'] if r['id'] not in selected]
            data['imageCount'] = len(data['images'])
            data['conflictImages'] = [r for r in data.get('conflictImages', [])
                                      if (r if isinstance(r, str) else r.get('id', r.get('groupName'))) not in selected]
            data['conflictCount'] = len(data['conflictImages'])
            if 'groupCount' in data:
                data['groupCount'] = len(data['images'])
                data['errorGroupCount'] = sum(bool(r.get('error')) for r in data['images'])
                data['analyzedGroupCount'] = data['groupCount'] - data['errorGroupCount']
            if 'sourceManifest' in data:
                data['sourceManifest'].update(groupCount=manifest['groupCount'], imageCount=manifest['imageCount'])
        aggregate = {}
        for record in done['images'].values():
            for key, count in record['colorCounts'].items():
                aggregate[key] = aggregate.get(key, 0) + count
        done.update(doneCount=len(done['images']), totalBeads=sum(aggregate.values()), colorCounts=aggregate)
        for relative, data in ((main_path, main), (debug_path, debug), (manifest_path, manifest), (done_path, done)):
            writes[relative.as_posix()] = json_bytes(data)
        writes[(WAREHOUSE / 'inventory.csv').as_posix()] = csv_bytes(inv_columns, inventory)
        writes[(WAREHOUSE / 'transactions.csv').as_posix()] = csv_bytes(tx_columns, transactions)
    return dict(root=root, snapshots=snapshots, writes=writes, moves=moves, selected=selected, skipped=skipped,
                totalBeads=sum(done['images'][i]['totalBeads'] for i in selected), projects=project_count,
                detailCount=sum(len(done['images'][i]['colorCounts']) for i in selected),
                remaining=sum(int(r['ownedCount']) for r in inventory if r['warehouseId'] == warehouse_id))


def atomic_write(file, data):
    file.parent.mkdir(parents=True, exist_ok=True)
    temp = file.with_name(file.name + '.completion-tmp')
    with temp.open('wb') as stream:
        stream.write(data)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temp, file)


def recover_operation(root, folder):
    journal = read_json(folder / 'journal.json')
    if journal['state'] != 'pending':
        return
    # Validate the entire recovery set before overwriting anything.
    for entry in journal['files']:
        current = digest(safe(root, entry['path']))
        if current not in (entry['before'], entry['after']):
            raise ValueError(f'External change blocks recovery: {entry["path"]}')
        if entry['before'] is not None and digest(safe(folder, entry['backup'])) != entry['before']:
            raise ValueError('Recovery backup is missing or damaged')
    for move in journal['moves']:
        source = safe(root / GROUPED, Path(move['source']).relative_to(GROUPED))
        dest = safe(root / DONE, Path(move['destination']).relative_to(DONE))
        states = (tree_digest(source), tree_digest(dest))
        if states not in ((move['digest'], None), (None, move['digest'])):
            raise ValueError(f'Image state blocks recovery: {move["source"]}')
    for move in reversed(journal['moves']):
        source, dest = safe(root, move['source']), safe(root, move['destination'])
        if dest.exists():
            source.parent.mkdir(parents=True, exist_ok=True)
            os.replace(dest, source)
    for entry in journal['files']:
        file = safe(root, entry['path'])
        if entry['before'] is None:
            file.unlink(missing_ok=True)
        else:
            atomic_write(file, safe(folder, entry['backup']).read_bytes())
    journal['state'] = 'rolled_back'
    atomic_write(folder / 'journal.json', json_bytes(journal))


def recover_pending(root):
    for journal in sorted((root / OPERATIONS).glob('*/journal.json')):
        recover_operation(root, journal.parent)


def commit_completion(plan, checkpoint=None):
    root = plan['root']
    if not plan['selected']:
        return None
    for relative, expected in plan['snapshots'].items():
        if digest(safe(root, relative)) != expected:
            raise ValueError(f'Data changed after preview: {relative}')
    for move in plan['moves']:
        if tree_digest(safe(root, move['source'])) != move['digest'] or safe(root, move['destination']).exists():
            raise ValueError('Image changed after preview')
    folder = safe(root, OPERATIONS / str(uuid.uuid4()))
    folder.mkdir(parents=True)
    journal = dict(operationId=folder.name, state='pending', files=[], moves=plan['moves'])
    for number, (relative, data) in enumerate(plan['writes'].items()):
        file = safe(root, relative)
        backup, staged = f'{number}.before', f'{number}.after'
        if file.exists():
            atomic_write(folder / backup, file.read_bytes())
        atomic_write(folder / staged, data)
        journal['files'].append(dict(path=relative, backup=backup, staged=staged, before=digest(file),
                                    after=hashlib.sha256(data).hexdigest()))
    atomic_write(folder / 'journal.json', json_bytes(journal))
    try:
        for move in journal['moves']:
            source = safe(root / GROUPED, Path(move['source']).relative_to(GROUPED))
            dest = safe(root / DONE, Path(move['destination']).relative_to(DONE))
            dest.parent.mkdir(parents=True, exist_ok=True)
            os.replace(source, dest)
            if checkpoint:
                checkpoint('move')
        for entry in journal['files']:
            atomic_write(safe(root, entry['path']), (folder / entry['staged']).read_bytes())
            if checkpoint:
                checkpoint('file')
        for entry in journal['files']:
            if digest(safe(root, entry['path'])) != entry['after']:
                raise ValueError('Post-commit checksum mismatch')
        for move in journal['moves']:
            if tree_digest(safe(root, move['destination'])) != move['digest']:
                raise ValueError('Post-commit image checksum mismatch')
        journal['state'] = 'committed'
        atomic_write(folder / 'journal.json', json_bytes(journal))
    except Exception:
        recover_operation(root, folder)
        raise
    return folder


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--images', nargs='+')
    parser.add_argument('--warehouse', default='warehouse-1')
    parser.add_argument('--note', default='完成拼图')
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[3]
    try:
        recover_pending(root)
        ids = parse_image_ids(args.images or [input('Image IDs: ')])
        plan = build_completion_plan(root, ids, args.warehouse, args.note)
        print(json.dumps({k: plan[k] for k in ('selected', 'skipped', 'totalBeads', 'detailCount', 'remaining', 'projects')},
                         ensure_ascii=False, indent=2))
        if args.apply:
            folder = commit_completion(plan)
            print(f'Completed. Recovery backup: {folder}' if folder else 'Already completed; no changes.')
        else:
            print('Preview only. Stop the web server before running with --apply.')
    except (ValueError, OSError, KeyError, EOFError) as error:
        print(f'Completion stopped: {error}', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
