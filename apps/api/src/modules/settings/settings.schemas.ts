import { z } from 'zod';

export const UpdateAppSettingsBodySchema = z.object({
  turnSteerEnabled: z.boolean(),
});

export type UpdateAppSettingsBody = z.infer<typeof UpdateAppSettingsBodySchema>;

export const AdminCreateUserBodySchema = z.object({
  email: z.string().trim().email().max(320),
  displayName: z.string().trim().max(120).optional().nullable(),
  password: z.string().min(8).max(512),
  role: z.enum(['admin', 'user']).default('user'),
  isActive: z.boolean().default(true),
});

export type AdminCreateUserBody = z.infer<typeof AdminCreateUserBodySchema>;

export const AdminUpdateUserBodySchema = z
  .object({
    displayName: z.string().trim().max(120).optional().nullable(),
    password: z.string().min(8).max(512).optional(),
    role: z.enum(['admin', 'user']).optional(),
    isActive: z.boolean().optional(),
  })
  .refine((input) => Object.keys(input).length > 0, {
    message: 'At least one field is required',
  });

export type AdminUpdateUserBody = z.infer<typeof AdminUpdateUserBodySchema>;
