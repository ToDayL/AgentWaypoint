import { NextRequest } from 'next/server';
import { forwardJson } from '../../../_lib';

export const dynamic = 'force-dynamic';

export async function PATCH(request: NextRequest, context: { params: Promise<{ userId: string }> }): Promise<Response> {
  const params = await context.params;
  return forwardJson(request, { path: `/api/settings/users/${params.userId}`, method: 'PATCH' });
}
