import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsEmail,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';

export class LoginDto {
  @IsEmail({}, { message: 'El correo no es válido' })
  email!: string;

  @IsString()
  @IsNotEmpty({ message: 'La contraseña es obligatoria' })
  password!: string;
}

export class ImportDto {
  @IsString()
  @IsNotEmpty({ message: 'El archivo está vacío' })
  csv!: string;

  @IsOptional()
  @IsBoolean()
  dryRun?: boolean;
}

export class MonthQueryDto {
  @Type(() => Number)
  @IsInt()
  @Min(2020)
  @Max(2100)
  year!: number;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(12)
  month!: number;
}

export class CreateParticipantDto {
  @IsString()
  @IsNotEmpty({ message: 'El nombre es obligatorio' })
  fullName!: string;

  @IsString()
  @IsNotEmpty({ message: 'El teléfono es obligatorio' })
  phone!: string;

  @IsOptional()
  @IsString()
  role?: string;
}

export class CreateWindowDto {
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(6)
  weekday!: number;

  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(1439)
  startMinute!: number;

  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(1440)
  endMinute!: number;
}

export class UpdateSettingsDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) urgentWindowHours?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) supervisorTimeoutMinutes?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) urgentSupervisorTimeoutMinutes?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) coverageCloseHoursBeforeShift?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(23) reminderHourLocal?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) weekdayReminderDaysAhead?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) weekendReminderDaysAhead?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) scheduleHorizonMonths?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) broadcastBatchSize?: number;
  @IsOptional() @IsBoolean() autoResolveUrgent?: boolean;
}
