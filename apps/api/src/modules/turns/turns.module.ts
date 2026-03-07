import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AuthGuard } from '../auth/auth.guard';
import { RunnerModule } from '../runner/runner.module';
import { TurnsController } from './turns.controller';
import { TurnsService } from './turns.service';

@Module({
  imports: [AuthModule, RunnerModule],
  controllers: [TurnsController],
  providers: [TurnsService, AuthGuard],
  exports: [TurnsService],
})
export class TurnsModule {}
