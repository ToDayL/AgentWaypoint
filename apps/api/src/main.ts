import 'reflect-metadata';
import multipart from '@fastify/multipart';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from './app.module';
import { ensureBootstrap } from './bootstrap/local-bootstrap';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';

async function bootstrap(): Promise<void> {
  await ensureBootstrap();

  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({ logger: true }),
  );
  await app.register(multipart, {
    limits: {
      fileSize: 20 * 1024 * 1024,
      files: 1,
    },
  });
  app.useGlobalFilters(new HttpExceptionFilter());

  const logger = new Logger('Bootstrap');
  let shutdownPromise: Promise<void> | null = null;
  const shutdown = (signal: NodeJS.Signals): Promise<void> => {
    if (!shutdownPromise) {
      shutdownPromise = (async () => {
        logger.log(`Received ${signal}; shutting down gracefully.`);
        await app.close();
      })();
    }
    return shutdownPromise;
  };

  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      void shutdown(signal)
        .then(() => process.exit(0))
        .catch((error: unknown) => {
          logger.error(`Failed to shut down after ${signal}`, error instanceof Error ? error.stack : undefined);
          process.exit(1);
        });
    });
  }

  const port = Number(process.env.API_PORT ?? process.env.PORT ?? 4000);
  const listenIp = process.env.LISTEN_IP ?? '0.0.0.0';
  await app.listen(port, listenIp);
}

void bootstrap();
