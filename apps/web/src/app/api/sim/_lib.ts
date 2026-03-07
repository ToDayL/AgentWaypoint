import { NextRequest } from 'next/server';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function getApiBaseUrl(): string {
  return process.env.API_BASE_URL ?? process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:4000';
}

export function readUserEmail(request: NextRequest): string | null {
  const headerEmail = request.headers.get('x-user-email');
  const queryEmail = request.nextUrl.searchParams.get('email');
  const email = (headerEmail ?? queryEmail ?? '').trim().toLowerCase();
  if (!EMAIL_PATTERN.test(email)) {
    return null;
  }
  return email;
}

export function unauthorizedResponse(): Response {
  return Response.json(
    {
      error: {
        code: 'UNAUTHORIZED',
        message: 'Missing or invalid user email',
      },
    },
    { status: 401 },
  );
}

export async function forwardJson(
  request: NextRequest,
  input: { path: string; method: 'GET' | 'POST' },
): Promise<Response> {
  const email = readUserEmail(request);
  if (!email) {
    return unauthorizedResponse();
  }

  const body = input.method === 'POST' ? await request.text() : undefined;
  try {
    const upstream = await fetch(`${getApiBaseUrl()}${input.path}`, {
      method: input.method,
      headers: {
        'content-type': 'application/json',
        'x-user-email': email,
      },
      body,
      cache: 'no-store',
    });

    return new Response(await upstream.text(), {
      status: upstream.status,
      headers: {
        'content-type': upstream.headers.get('content-type') ?? 'application/json',
      },
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
