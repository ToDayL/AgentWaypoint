import { PrismaClient } from '@prisma/client';
import { hashPassword } from '../modules/auth/auth.service';

type CliInput = {
  email: string;
  password: string;
  displayName: string | null;
};

async function main(): Promise<void> {
  const input = parseArgs(process.argv.slice(2));
  const prisma = new PrismaClient();

  try {
    const existingAdmin = await prisma.user.findFirst({
      where: {
        role: 'admin',
      },
      select: {
        id: true,
        email: true,
      },
    });
    if (existingAdmin) {
      // eslint-disable-next-line no-console
      console.log(
        JSON.stringify(
          {
            action: 'skipped',
            reason: 'admin_exists',
            user: existingAdmin,
          },
          null,
          2,
        ),
      );
      return;
    }

    const passwordHash = await hashPassword(input.password);
    const existing = await prisma.user.findUnique({
      where: { email: input.email },
      select: { id: true },
    });

    const user = await prisma.user.upsert({
      where: { email: input.email },
      update: {
        displayName: input.displayName,
        isActive: true,
        role: 'admin',
        authPolicy: 'password_or_webauthn',
        passwordHash,
      },
      create: {
        email: input.email,
        displayName: input.displayName,
        isActive: true,
        role: 'admin',
        authPolicy: 'password_or_webauthn',
        passwordHash,
      },
      select: {
        id: true,
        email: true,
        role: true,
        isActive: true,
      },
    });

    // eslint-disable-next-line no-console
    console.log(
      JSON.stringify(
        {
          action: existing ? 'updated' : 'created',
          user,
        },
        null,
        2,
      ),
    );
  } finally {
    await prisma.$disconnect();
  }
}

function parseArgs(args: string[]): CliInput {
  const values: Record<string, string> = {};

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] ?? '';
    if (arg === '--') {
      continue;
    }
    if (!arg.startsWith('--')) {
      throw new Error(`Unexpected argument: ${arg}`);
    }
    const key = arg.slice(2);
    const value = args[i + 1];
    if (!value || value.startsWith('--')) {
      throw new Error(`Missing value for --${key}`);
    }
    values[key] = value;
    i += 1;
  }

  const email = (values.email ?? '').trim().toLowerCase();
  const password = values.password ?? '';
  const displayNameRaw = (values['display-name'] ?? '').trim();

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error('A valid --email is required');
  }
  if (password.length < 8) {
    throw new Error('--password must be at least 8 characters');
  }

  return {
    email,
    password,
    displayName: displayNameRaw.length > 0 ? displayNameRaw : null,
  };
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'Failed to bootstrap admin';
  // eslint-disable-next-line no-console
  console.error(`[auth:bootstrap-admin] ${message}`);
  process.exitCode = 1;
});
