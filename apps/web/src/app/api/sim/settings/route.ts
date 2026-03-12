import { NextRequest } from 'next/server';
import { forwardJson } from '../_lib';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest): Promise<Response> {
  return forwardJson(request, { path: '/api/settings', method: 'GET' });
}

export async function POST(request: NextRequest): Promise<Response> {
  return forwardJson(request, { path: '/api/settings', method: 'POST' });
}
