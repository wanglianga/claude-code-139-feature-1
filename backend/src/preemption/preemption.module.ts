import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { PreemptionController } from './preemption.controller';

@Module({
  imports: [DatabaseModule],
  controllers: [PreemptionController],
})
export class PreemptionModule {}
