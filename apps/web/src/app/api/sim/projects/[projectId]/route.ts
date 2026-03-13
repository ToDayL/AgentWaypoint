import { NextRequest } from 'next/server';
import { forwardJson } from '../../_lib';

export const dynamic = 'force-dynamic';

type Params = {
  params: Promise<{ projectId: string }>;
};

export async function DELETE(request: NextRequest, context: Params): Promise<Response> {
  const { projectId } = await context.params;
  return forwardJson(request, { path: `/api/projects/${projectId}`, method: 'DELETE' });
}
