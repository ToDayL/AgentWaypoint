import { NextRequest } from 'next/server';
import { forwardJson } from '../../_lib';

export const dynamic = 'force-dynamic';

type Params = {
  params: Promise<{ sessionId: string }>;
};

export async function DELETE(request: NextRequest, context: Params): Promise<Response> {
  const { sessionId } = await context.params;
  return forwardJson(request, { path: `/api/sessions/${sessionId}`, method: 'DELETE' });
}
