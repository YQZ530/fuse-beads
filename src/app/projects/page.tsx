import { readProjectList, readProjectWarehouseOptions } from '../api/projects/_projectStore';
import ProjectsClient from './ProjectsClient';

export const dynamic = 'force-dynamic';

export default async function ProjectsPage() {
  const [projects, warehouses] = await Promise.all([
    readProjectList(),
    readProjectWarehouseOptions(),
  ]);

  return (
    <ProjectsClient
      initialProjects={projects}
      warehouses={warehouses}
    />
  );
}
