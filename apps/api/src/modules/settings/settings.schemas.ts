import { z } from 'zod';

export const UpdateAppSettingsBodySchema = z
  .object({
    turnSteerEnabled: z.boolean().optional(),
    defaultWorkspaceRoot: z.string().trim().min(1).max(1024).optional().nullable(),
  })
  .refine((input) => Object.keys(input).length > 0, {
    message: 'At least one field is required',
  });

export type UpdateAppSettingsBody = z.infer<typeof UpdateAppSettingsBodySchema>;

const CcSwitchProviderIdSchema = z.string().trim().min(1).max(120);

export const UpdateCcSwitchProvidersBodySchema = z
  .object({
    codexProviderId: CcSwitchProviderIdSchema.optional(),
    claudeProviderId: CcSwitchProviderIdSchema.optional(),
    expectedCurrent: z
      .object({
        codex: CcSwitchProviderIdSchema.optional(),
        claude: CcSwitchProviderIdSchema.optional(),
      })
      .optional(),
  })
  .refine((input) => !!input.codexProviderId || !!input.claudeProviderId, {
    message: 'At least one provider is required',
  });

export type UpdateCcSwitchProvidersBody = z.infer<typeof UpdateCcSwitchProvidersBodySchema>;

export const AdminCreateUserBodySchema = z.object({
  email: z.string().trim().email().max(320),
  displayName: z.string().trim().max(120).optional().nullable(),
  password: z.string().min(8).max(512),
  role: z.enum(['admin', 'user']).default('user'),
  isActive: z.boolean().default(true),
  defaultWorkspaceRoot: z.string().trim().min(1).max(1024).optional().nullable(),
});

export type AdminCreateUserBody = z.infer<typeof AdminCreateUserBodySchema>;

export const AdminUpdateUserBodySchema = z
  .object({
    displayName: z.string().trim().max(120).optional().nullable(),
    password: z.string().min(8).max(512).optional(),
    role: z.enum(['admin', 'user']).optional(),
    isActive: z.boolean().optional(),
    defaultWorkspaceRoot: z.string().trim().min(1).max(1024).optional().nullable(),
  })
  .refine((input) => Object.keys(input).length > 0, {
    message: 'At least one field is required',
  });

export type AdminUpdateUserBody = z.infer<typeof AdminUpdateUserBodySchema>;
