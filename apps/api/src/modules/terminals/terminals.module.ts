import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { TerminalProcessFactory } from './terminal-process';
import { TerminalNetwork } from './terminal-network';
import { TerminalsService } from './terminals.service';
import { TerminalsGateway } from './terminals.gateway';
import { TerminalsController } from './terminals.controller';

@Module({
  imports: [AuthModule],
  providers: [TerminalProcessFactory, TerminalNetwork, TerminalsService, TerminalsGateway],
  controllers: [TerminalsController],
  exports: [TerminalsService, TerminalsGateway],
})
export class TerminalsModule {}
