import { NextRequest } from 'next/server';
import { forwardJson } from '../../_lib';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest): Promise<Response> {
  const query = new URLSearchParams();
  const prefix = request.nextUrl.searchParams.get('prefix') ?? '';
  query.set('prefix', prefix);
  const limit = request.nextUrl.searchParams.get('limit');
  if (limit) {
    query.set('limit', limit);
  }
  return forwardJson(request, { path: `/api/fs/suggestions?${query.toString()}`, method: 'GET' });
}
