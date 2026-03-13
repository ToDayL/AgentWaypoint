import { NextRequest } from 'next/server';
import { getApiBaseUrl } from '../../../_lib';

export const dynamic = 'force-dynamic';

type Params = {
  params: Promise<{ turnId: string }>;
};

export async function GET(request: NextRequest, context: Params): Promise<Response> {
  const { turnId } = await context.params;
  const since = request.nextUrl.searchParams.get('since');
  const query = since ? `?since=${encodeURIComponent(since)}` : '';
  const cookieHeader = request.headers.get('cookie');
  const devEmailHeader = request.headers.get('x-user-email');

  let upstream: Response;
  try {
    upstream = await fetch(`${getApiBaseUrl()}/api/turns/${turnId}/stream${query}`, {
      method: 'GET',
      headers: {
        accept: 'text/event-stream',
        ...(cookieHeader ? { cookie: cookieHeader } : {}),
        ...(devEmailHeader ? { 'x-user-email': devEmailHeader } : {}),
        ...(request.headers.get('last-event-id')
          ? { 'last-event-id': request.headers.get('last-event-id') as string }
          : {}),
      },
      cache: 'no-store',
    });
  } catch {
    return Response.json(
      {
        error: {
          code: 'UPSTREAM_UNAVAILABLE',
          message: 'API upstream unavailable',
        },
      },
      { status: 502 },
    );
  }

  if (!upstream.ok || !upstream.body) {
    return new Response(await upstream.text(), {
      status: upstream.status,
      headers: {
        'content-type': upstream.headers.get('content-type') ?? 'application/json',
      },
    });
  }

  return new Response(upstream.body, {
    status: upstream.status,
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    },
  });
}
