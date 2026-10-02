import { Module } from '@nestjs/common';
import { DispatchController } from './dispatch.controller';
import { DispatchService } from './dispatch.service';
import { SettlementModule } from '../settlement/settlement.module';

@Module({
  imports: [SettlementModule],
  controllers: [DispatchController],
  providers: [DispatchService],
})
export class DispatchModule {}
