import { Module } from '@nestjs/common';
import { QueueSignalService } from './queue-signal.service';

@Module({
  providers: [QueueSignalService],
  exports: [QueueSignalService],
})
export class QueueSignalModule {}
