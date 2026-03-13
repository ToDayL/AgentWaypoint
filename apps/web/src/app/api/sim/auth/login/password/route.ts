import { NextRequest } from 'next/server';
import { forwardJson } from '../../../_lib';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest): Promise<Response> {
  return forwardJson(request, { path: '/api/auth/login/password', method: 'POST' });
}
