import { readdir, readFile } from 'fs/promises';
import path from 'path';
import WarehouseClient from './WarehouseClient';
import { readInventory, readMardColors, readMardPaletteOptions } from '@/lib/warehouseStore';

interface ProjectFile {
  id?: string;
  name?: string;
  warehouseId?: string;
  items?: ProjectRequirementItem[];
}

interface ProjectRequirementItem {
  hex?: string;
  colorKey?: string;
  needed?: number;
}

const ROOT_DIR = process.cwd();
const PROJECTS_DIR = path.join(ROOT_DIR, 'results', 'projects');

export default async function WarehousePage() {
  const [inventory, paletteOptions, allMardColors, projectDemands] = await Promise.all([
    readInventory(),
    readMardPaletteOptions(),
    readMardColors('291'),
    readProjectDemands(),
  ]);

  return (
    <WarehouseClient
      initialInventory={inventory}
      paletteOptions={paletteOptions}
      allMardColors={allMardColors}
      projectDemands={projectDemands}
    />
  );
}

async function readProjectDemands() {
  try {
    const entries = await readdir(PROJECTS_DIR, { withFileTypes: true });
    const projects = await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .map(async (entry) => {
          const projectPath = path.join(PROJECTS_DIR, entry.name, 'project.json');
          try {
            const text = await readFile(projectPath, 'utf8');
            const project = JSON.parse(text.replace(/^\uFEFF/, '')) as ProjectFile;
            if (!project.warehouseId) return null;
            return {
              projectId: project.id || entry.name,
              name: project.name || entry.name,
              warehouseId: project.warehouseId,
              items: (project.items ?? []).map((item) => ({
                hex: String(item.hex || ''),
                colorKey: String(item.colorKey || ''),
                needed: Number(item.needed || 0),
              })),
            };
          } catch {
            return null;
          }
        })
    );
    return projects.filter((project): project is NonNullable<typeof project> => project !== null);
  } catch {
    return [];
  }
}
