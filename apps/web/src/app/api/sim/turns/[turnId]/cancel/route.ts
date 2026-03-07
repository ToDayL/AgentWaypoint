import { NextRequest } from 'next/server';
import { forwardJson } from '../../../_lib';

export const dynamic = 'force-dynamic';

type Params = {
  params: Promise<{ turnId: string }>;
};

export async function POST(request: NextRequest, context: Params): Promise<Response> {
  const { turnId } = await context.params;
  return forwardJson(request, { path: `/api/turns/${turnId}/cancel`, method: 'POST' });
}
