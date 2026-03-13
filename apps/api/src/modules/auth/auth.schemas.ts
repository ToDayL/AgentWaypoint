import { z } from 'zod';

export const PasswordLoginBodySchema = z.object({
  email: z.string().trim().email().max(320),
  password: z.string().min(8).max(512),
});

export type PasswordLoginBody = z.infer<typeof PasswordLoginBodySchema>;
