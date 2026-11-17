import { Global, Module } from '@nestjs/common';
import { DatabaseWakeMiddleware } from './database-wake.middleware';
import { PrismaService } from './prisma.service';

@Global()
@Module({
  providers: [PrismaService, DatabaseWakeMiddleware],
  exports: [PrismaService, DatabaseWakeMiddleware],
})
export class PrismaModule {}
