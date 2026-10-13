import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ThrottlerModule } from '@nestjs/throttler';
import { PhoneModule } from '../common/phone/phone.module';
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
    // Límite de intentos, solo donde hace falta: el login es el único endpoint
    // sin token, y sin tope se pueden probar contraseñas a velocidad de red.
    // Cinco por minuto deja margen a quien se equivoca y corta la fuerza bruta.
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 5 }]),
    ImportModule,
    // Se declara aunque `PhoneModule` sea global: lo global solo aplica donde el
    // módulo ya está en el grafo, y un contexto de prueba parcial no lo incluye.
    PhoneModule,
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
