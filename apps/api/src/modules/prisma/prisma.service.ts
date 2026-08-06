import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  async onModuleInit(): Promise<void> {
    await this.$connect();
    // DELETE journal mode creates and removes a rollback journal for every
    // write. Turn streams persist frequently, so use WAL to avoid that delete
    // path and allow readers to proceed while events are written.
    await this.$queryRawUnsafe('PRAGMA journal_mode = WAL');
    await this.$queryRawUnsafe('PRAGMA busy_timeout = 5000');
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
