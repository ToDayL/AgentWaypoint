import { NextRequest } from 'next/server';
import { forwardJson } from '../../../_lib';

export const dynamic = 'force-dynamic';

type Params = {
  params: Promise<{ projectId: string }>;
};

export async function GET(request: NextRequest, context: Params): Promise<Response> {
  const { projectId } = await context.params;
  return forwardJson(request, { path: `/api/projects/${projectId}/sessions`, method: 'GET' });
}

export async function POST(request: NextRequest, context: Params): Promise<Response> {
  const { projectId } = await context.params;
  return forwardJson(request, { path: `/api/projects/${projectId}/sessions`, method: 'POST' });
}
