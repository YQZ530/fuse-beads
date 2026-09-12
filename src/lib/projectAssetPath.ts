import { realpathSync } from 'fs';
import path from 'path';

const IMAGE_ROOTS = [
  'results/processing/1.grouped-images',
  'results/processing/3.done-images',
  'results/app/1.source-images',
  'results/app/projects',
];

export function resolveProjectImagePath(root: string, input: string): string {
  if (!input || path.isAbsolute(input) || /^[A-Za-z]:/.test(input)) return '';
  const resolved = path.resolve(root, input.replace(/\\/g, '/'));
  if (!['.png', '.jpg', '.jpeg', '.webp', '.gif'].includes(path.extname(resolved).toLowerCase())) return '';
  for (const relative of IMAGE_ROOTS) {
    const allowed = path.resolve(root, relative);
    const child = path.relative(allowed, resolved);
    if (!child || child.startsWith('..') || path.isAbsolute(child)) continue;
    try {
      const actual = realpathSync(resolved);
      // Reject symlinks/junctions which escape the allowed image tree.
      const actualChild = path.relative(allowed, actual);
      if (actualChild && !actualChild.startsWith('..') && !path.isAbsolute(actualChild)) return actual;
    } catch { return ''; }
  }
  return '';
}
