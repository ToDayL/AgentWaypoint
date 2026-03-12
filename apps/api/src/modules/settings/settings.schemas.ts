import { z } from 'zod';

export const UpdateAppSettingsBodySchema = z.object({
  turnSteerEnabled: z.boolean(),
});

export type UpdateAppSettingsBody = z.infer<typeof UpdateAppSettingsBodySchema>;
