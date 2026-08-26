import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AppConfigService } from '../config/app-config.service';
import { ImportModule } from '../import/import.module';
import { ReportsModule } from '../reports/reports.module';
import { SchedulingModule } from '../scheduling/scheduling.module';
import { SupervisorsModule } from '../supervisors/supervisors.module';
import { AdminAuthGuard } from './admin-auth.guard';
import { AdminController } from './admin.controller';
import { AdminAuthService } from './auth.service';

@Module({
  imports: [
    ImportModule,
    ReportsModule,
    SchedulingModule,
    SupervisorsModule,
    JwtModule.registerAsync({
      inject: [AppConfigService],
      useFactory: (config: AppConfigService) => ({
        secret: config.jwt.secret,
        // El tipo de `expiresIn` en la librería es una unión de literales muy
        // estrecha; el valor viene validado desde la configuración.
        signOptions: { expiresIn: config.jwt.expiresIn as `${number}h` },
      }),
    }),
  ],
  controllers: [AdminController],
  providers: [AdminAuthService, AdminAuthGuard],
  exports: [AdminAuthService],
})
export class AdminModule {}
