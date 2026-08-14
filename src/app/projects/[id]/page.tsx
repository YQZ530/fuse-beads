import { notFound } from 'next/navigation';
import { readProjectDetailById } from '../../api/projects/_projectStore';
import ProjectDetailClient from './ProjectDetailClient';

export const dynamic = 'force-dynamic';

export default async function ProjectDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const project = await readProjectDetailById(id);
  if (!project) {
    notFound();
  }

  return <ProjectDetailClient initialProject={project} />;
}
