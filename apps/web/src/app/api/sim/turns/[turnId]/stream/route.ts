import { NextRequest } from 'next/server';
import { getApiBaseUrl, readUserEmail, unauthorizedResponse } from '../../../_lib';

export const dynamic = 'force-dynamic';

type Params = {
  params: Promise<{ turnId: string }>;
};

export async function GET(request: NextRequest, context: Params): Promise<Response> {
  const email = readUserEmail(request);
  if (!email) {
    return unauthorizedResponse();
  }

  const { turnId } = await context.params;
  const since = request.nextUrl.searchParams.get('since');
  const query = since ? `?since=${encodeURIComponent(since)}` : '';

  let upstream: Response;
  try {
    upstream = await fetch(`${getApiBaseUrl()}/api/turns/${turnId}/stream${query}`, {
      method: 'GET',
      headers: {
        accept: 'text/event-stream',
        'x-user-email': email,
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
