import copy
import importlib.util
from pathlib import Path
import tempfile
import unittest

REPO = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('complete_images', REPO / 'scripts/python/complete_images.py')
c = importlib.util.module_from_spec(spec)
spec.loader.exec_module(c)


class SimulatedPowerLoss(BaseException):
    pass


class CompletionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        for directory in (c.GROUPED, c.LEGENDS, c.WAREHOUSE, c.PROJECTS):
            (self.root / directory).mkdir(parents=True)
        self.inv_columns, _ = c.read_csv(REPO / c.WAREHOUSE / 'inventory.csv')
        self.tx_columns, _ = c.read_csv(REPO / c.WAREHOUSE / 'transactions.csv')
        rows = []
        for warehouse in ('warehouse-1', 'warehouse-221'):
            for key in ('F5', 'H2'):
                row = {k:'' for k in self.inv_columns}
                row.update(schemaVersion='1', warehouseId=warehouse, warehouseName=warehouse, brand='MARD',
                           paletteName='96', warehouseCreatedAt='before', warehouseUpdatedAt='before',
                           colorKey=key, hex='#FFFFFF' if key == 'H2' else '#FF0000', ownedCount='541')
                rows.append(row)
        self.write(c.WAREHOUSE / 'inventory.csv', c.csv_bytes(self.inv_columns, rows))
        self.write(c.WAREHOUSE / 'transactions.csv', c.csv_bytes(self.tx_columns, []))
        self.rows = [dict(id='Image3', totalBeads=7, totalColorKeys=2, colorCounts={'F5':4, 'H2':3},
                         needsReviewCount=0, matchesExpected=True),
                     dict(id='Image35', totalBeads=2, totalColorKeys=1, colorCounts={'H2':2}, needsReviewCount=0)]
        self.save(c.LEGENDS / 'analyze_color_legend.main.json', dict(images=self.rows, imageCount=2, conflictImages=[], conflictCount=0))
        self.save(c.LEGENDS / 'analyze_color_legend.debug.json', dict(images=self.rows, imageCount=2,
                  groupCount=2, analyzedGroupCount=2, errorGroupCount=0, conflictImages=[], conflictCount=0))
        self.save(c.GROUPED / 'groups.manifest.json', dict(groups=[dict(groupName='Image3', count=1,
                  items=[dict(filename='Image3.PNG', source='C:/old/Image3.PNG')])], groupCount=1, imageCount=1))
        self.write(c.GROUPED / 'Image3.PNG', b'first-image')
        self.write(c.GROUPED / 'Image35' / 'Image35_1.PNG', b'page-1')
        self.write(c.GROUPED / 'Image35' / 'Image35_2.PNG', b'page-2')
        self.project = dict(id='project-1', name='project', warehouseId='warehouse-1',
            patterns=[dict(id=r['id'], status='draft', colorCounts=r['colorCounts']) for r in self.rows])
        self.save(c.PROJECTS / 'one/project.json', self.project)
        self.save(c.PROJECTS / 'pattern-assignments.json', {'Image3':{'projectId':'project-1'}, 'Image35':{'projectId':'project-1'}})

    def write(self, relative, data):
        file = self.root / relative
        file.parent.mkdir(parents=True, exist_ok=True)
        file.write_bytes(data)

    def save(self, relative, value):
        self.write(relative, c.json_bytes(value))

    def files(self):
        return {p.relative_to(self.root).as_posix():p.read_bytes() for p in self.root.rglob('*')
                if p.is_file() and '.completion-operations' not in p.parts}

    def plan(self, ids=('Image3',)):
        return c.build_completion_plan(self.root, ids, 'warehouse-1')

    def test_parse(self):
        self.assertEqual(c.parse_image_ids(['3,6', '8', 'Image3']), ['Image3','Image6','Image8'])
        for bad in ('Image03', '../Image3', '3x', ''):
            with self.assertRaises(ValueError):
                c.parse_image_ids([bad])

    def test_preview_does_not_write(self):
        before = self.files()
        plan = self.plan()
        self.assertEqual(plan['totalBeads'], 7)
        self.assertEqual(before, self.files())

    def test_complete_preserves_other_data_and_is_idempotent(self):
        original_stock = c.read_csv(self.root / c.WAREHOUSE / 'inventory.csv')[1]
        c.commit_completion(self.plan())
        done = c.read_json(self.root / c.DONE / 'done-count.json')
        self.assertEqual(done['totalBeads'], 7)
        self.assertEqual(done['images']['Image3']['projectReferences'][0]['pattern'], self.project['patterns'][0])
        self.assertEqual(c.read_json(self.root / c.LEGENDS / 'analyze_color_legend.main.json')['images'], [self.rows[1]])
        project = c.read_json(self.root / c.PROJECTS / 'one/project.json')
        self.assertEqual(project['patterns'], [self.project['patterns'][1]])
        self.assertEqual(project['items'][0]['owned'], 538)
        new_stock = c.read_csv(self.root / c.WAREHOUSE / 'inventory.csv')[1]
        self.assertEqual([r for r in original_stock if r['warehouseId']=='warehouse-221'],
                         [r for r in new_stock if r['warehouseId']=='warehouse-221'])
        before = self.files()
        self.assertEqual(self.plan()['skipped'], ['Image3'])
        c.commit_completion(self.plan())
        self.assertEqual(before, self.files())

    def test_multipage_without_manifest_and_empty_project(self):
        c.commit_completion(self.plan(('Image3', 'Image35')))
        done = c.read_json(self.root / c.DONE / 'done-count.json')
        self.assertEqual(len(done['images']['Image35']['imagePaths']), 2)
        self.assertEqual(done['doneCount'], 2)
        self.assertFalse((self.root / c.GROUPED / 'Image35').exists())
        self.assertEqual(c.read_json(self.root / c.PROJECTS / 'one/project.json')['patterns'], [])

    def test_caught_failure_rolls_back(self):
        for step in ('move','file'):
            before = self.files()
            def fail(current):
                if current == step:
                    raise RuntimeError('injected failure')
            with self.assertRaises(RuntimeError):
                c.commit_completion(self.plan(), fail)
            self.assertEqual(before, self.files())

    def test_power_loss_recovers_on_next_run(self):
        before = self.files()
        def crash(step):
            if step == 'file':
                raise SimulatedPowerLoss()
        with self.assertRaises(SimulatedPowerLoss):
            c.commit_completion(self.plan(), crash)
        c.recover_pending(self.root)
        c.recover_pending(self.root)
        self.assertEqual(before, self.files())

    def test_recovery_refuses_external_changes(self):
        def crash(step):
            raise SimulatedPowerLoss()
        with self.assertRaises(SimulatedPowerLoss):
            c.commit_completion(self.plan(), crash)
        self.write(c.DONE / 'Image3.PNG', b'changed externally')
        with self.assertRaisesRegex(ValueError, 'blocks recovery'):
            c.recover_pending(self.root)
        self.assertEqual((self.root / c.DONE / 'Image3.PNG').read_bytes(), b'changed externally')

    def test_changed_after_preview(self):
        plan = self.plan()
        self.write(c.GROUPED / 'Image3.PNG', b'updated')
        with self.assertRaisesRegex(ValueError, 'changed after preview'):
            c.commit_completion(plan)

    def test_unknown_and_ambiguous(self):
        with self.assertRaises(ValueError):
            self.plan(('Image300',))
        self.write(c.GROUPED / 'Image3/another.PNG', b'ambiguous')
        with self.assertRaisesRegex(ValueError, 'ambiguous'):
            self.plan()

    def test_shortage_and_missing_color(self):
        for counts in ({'F5':542}, {'F99':1}):
            row = dict(id='Image3',totalBeads=sum(counts.values()),totalColorKeys=1,colorCounts=counts)
            self.save(c.LEGENDS / 'analyze_color_legend.main.json', dict(images=[row],conflictImages=[]))
            with self.assertRaisesRegex(ValueError, 'Insufficient stock'):
                self.plan()

    def test_destination_conflict(self):
        self.write(c.DONE / 'Image3.PNG', b'existing')
        with self.assertRaisesRegex(ValueError, 'destination exists'):
            self.plan()

    def test_manifest_missing_page(self):
        self.save(c.GROUPED / 'groups.manifest.json', dict(groups=[dict(groupName='Image3',count=2,
            items=[dict(filename='Image3.PNG'),dict(filename='missing.PNG')])]))
        with self.assertRaisesRegex(ValueError, 'Manifest/files mismatch'):
            self.plan()

    def test_partial_completion_stops(self):
        c.commit_completion(self.plan())
        self.write(c.WAREHOUSE / 'transactions.csv', c.csv_bytes(self.tx_columns, []))
        with self.assertRaisesRegex(ValueError, 'Inconsistent completion'):
            self.plan()

    def test_path_restrictions(self):
        with self.assertRaisesRegex(ValueError, 'Unsafe path'):
            c.safe(self.root, '../outside')

    def test_existing_history_is_preserved(self):
        tx = {key:'' for key in self.tx_columns}
        tx.update(schemaVersion='1',transactionId='old',warehouseId='warehouse-221',type='manual_adjustment',
                  colorKey='H2',hex='#FFFFFF',delta='1',before='540',after='541')
        self.write(c.WAREHOUSE / 'transactions.csv', c.csv_bytes(self.tx_columns, [tx]))
        c.commit_completion(self.plan())
        self.assertEqual(c.read_csv(self.root / c.WAREHOUSE / 'transactions.csv')[1][0],tx)


if __name__ == '__main__':
    unittest.main()
