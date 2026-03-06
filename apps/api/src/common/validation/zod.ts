import { BadRequestException } from '@nestjs/common';
import { z } from 'zod';

export function parseWithZod<T>(schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input);

  if (!parsed.success) {
    throw new BadRequestException({
      message: 'Validation failed',
      details: parsed.error.flatten(),
    });
  }

  return parsed.data;
}
