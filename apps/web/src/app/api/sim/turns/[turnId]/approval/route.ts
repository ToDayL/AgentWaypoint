import { NextRequest } from 'next/server';
import { forwardJson } from '../../../_lib';

type Params = {
  params: Promise<{ turnId: string }>;
};

export async function POST(request: NextRequest, { params }: Params) {
  const { turnId } = await params;
  return forwardJson(request, { path: `/api/turns/${turnId}/approval`, method: 'POST' });
}
