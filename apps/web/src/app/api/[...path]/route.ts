import { NextRequest } from 'next/server';
import { getApiBaseUrl } from '../_lib';

export const dynamic = 'force-dynamic';

type Params = {
  params: Promise<{ path: string[] }>;
};

const ALLOWED_METHODS = new Set(['GET', 'POST', 'PATCH', 'DELETE']);

export async function GET(request: NextRequest, context: Params): Promise<Response> {
  return proxyRequest(request, context);
}

export async function POST(request: NextRequest, context: Params): Promise<Response> {
  return proxyRequest(request, context);
}

export async function PATCH(request: NextRequest, context: Params): Promise<Response> {
  return proxyRequest(request, context);
}

export async function DELETE(request: NextRequest, context: Params): Promise<Response> {
  return proxyRequest(request, context);
}

async function proxyRequest(request: NextRequest, context: Params): Promise<Response> {
  const method = request.method.toUpperCase();
  if (!ALLOWED_METHODS.has(method)) {
    return Response.json(
      {
        error: {
          code: 'METHOD_NOT_ALLOWED',
          message: `Unsupported method: ${method}`,
        },
      },
      { status: 405 },
    );
  }

  const { path } = await context.params;
  if (!Array.isArray(path) || path.length === 0) {
    return Response.json(
      {
        error: {
          code: 'NOT_FOUND',
          message: 'Route not found',
        },
      },
      { status: 404 },
    );
  }

  const contentTypeHeader = request.headers.get('content-type') ?? '';
  const isJsonRequest = contentTypeHeader.toLowerCase().includes('application/json');
  const contentLengthHeader = request.headers.get('content-length');
  let rawJsonBody = '';
  let upstreamBody: BodyInit | undefined;
  if (method !== 'GET' && method !== 'DELETE') {
    if (isJsonRequest) {
      rawJsonBody = await request.text();
      if (rawJsonBody.trim().length > 0) {
        upstreamBody = rawJsonBody;
      }
    } else if (request.body) {
      upstreamBody = request.body;
    }
  }

  const cookieHeader = request.headers.get('cookie');
  const devEmailHeader = request.headers.get('x-user-email');
  const acceptHeader = request.headers.get('accept');
  const lastEventIdHeader = request.headers.get('last-event-id');
  const upstreamPath = `/api/${path.map((segment) => encodeURIComponent(segment)).join('/')}${request.nextUrl.search}`;

  try {
    const upstream = await fetch(`${getApiBaseUrl()}${upstreamPath}`, {
      method,
      headers: {
        ...(cookieHeader ? { cookie: cookieHeader } : {}),
        ...(devEmailHeader ? { 'x-user-email': devEmailHeader } : {}),
        ...(acceptHeader ? { accept: acceptHeader } : {}),
        ...(lastEventIdHeader ? { 'last-event-id': lastEventIdHeader } : {}),
        ...(upstreamBody && isJsonRequest ? { 'content-type': 'application/json' } : {}),
        ...(upstreamBody && !isJsonRequest && contentTypeHeader ? { 'content-type': contentTypeHeader } : {}),
        ...(upstreamBody && !isJsonRequest && contentLengthHeader ? { 'content-length': contentLengthHeader } : {}),
      },
      ...(upstreamBody ? { body: upstreamBody } : {}),
      ...(upstreamBody === request.body ? { duplex: 'half' } : {}),
      cache: 'no-store',
    } as RequestInit & { duplex?: 'half' });

    const upstreamContentType = upstream.headers.get('content-type') ?? '';
    const noBodyStatus = upstream.status === 204 || upstream.status === 205 || upstream.status === 304;
    const isEventStream =
      upstreamContentType.includes('text/event-stream') || (acceptHeader ?? '').includes('text/event-stream');

    if (isEventStream && upstream.body) {
      return new Response(upstream.body, {
        status: upstream.status,
        headers: {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        },
      });
    }

    const responseHeaders: Record<string, string> = {};
    if (upstreamContentType && !noBodyStatus) {
      responseHeaders['content-type'] = upstreamContentType;
    } else if (!noBodyStatus) {
      responseHeaders['content-type'] = 'application/json';
    }

    const upstreamSetCookie = upstream.headers.get('set-cookie');
    if (upstreamSetCookie) {
      responseHeaders['set-cookie'] = upstreamSetCookie;
    }

    if (noBodyStatus) {
      return new Response(null, {
        status: upstream.status,
        headers: responseHeaders,
      });
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
