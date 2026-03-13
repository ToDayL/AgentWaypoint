import { NextRequest } from 'next/server';

export function getApiBaseUrl(): string {
  return process.env.API_BASE_URL ?? process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:4000';
}

export async function forwardJson(
  request: NextRequest,
  input: { path: string; method: 'GET' | 'POST' },
): Promise<Response> {
  const rawBody = input.method === 'POST' ? await request.text() : '';
  const hasJsonBody = rawBody.trim().length > 0;
  const cookieHeader = request.headers.get('cookie');
  const devEmailHeader = request.headers.get('x-user-email');

  try {
    const upstream = await fetch(`${getApiBaseUrl()}${input.path}`, {
      method: input.method,
      headers: {
        ...(cookieHeader ? { cookie: cookieHeader } : {}),
        ...(devEmailHeader ? { 'x-user-email': devEmailHeader } : {}),
        ...(hasJsonBody ? { 'content-type': 'application/json' } : {}),
      },
      ...(hasJsonBody ? { body: rawBody } : {}),
      cache: 'no-store',
    });

    const responseHeaders: Record<string, string> = {
      'content-type': upstream.headers.get('content-type') ?? 'application/json',
    };
    const upstreamSetCookie = upstream.headers.get('set-cookie');
    if (upstreamSetCookie) {
      responseHeaders['set-cookie'] = upstreamSetCookie;
    }

    return new Response(await upstream.text(), {
      status: upstream.status,
      headers: responseHeaders,
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
}
