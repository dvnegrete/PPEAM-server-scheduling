import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsEmail,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { CANCEL_REASON_CODES } from '../scheduling/assignments.service';

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
  firstName!: string;

  @IsString()
  @IsNotEmpty({ message: 'El apellido paterno es obligatorio' })
  paternalSurname!: string;

  /** Opcional: hay quien usa un solo apellido. */
  @IsOptional()
  @IsString()
  maternalSurname?: string;

  /** Cómo prefiere que se le llame. */
  @IsOptional()
  @IsString()
  displayName?: string;

  @IsString()
  @IsNotEmpty({ message: 'El teléfono es obligatorio' })
  phone!: string;

  @IsOptional()
  @IsString()
  role?: string;

  @IsOptional()
  @IsString()
  congregation?: string;

  @IsOptional()
  @IsString()
  circuit?: string;

  @IsOptional()
  @IsString()
  city?: string;
}

/**
 * Edición de un participante desde el Padrón.
 *
 * Es un PATCH: lo que no venga no se toca. Por eso todo es opcional y los
 * campos que se pueden borrar se tipan como `string | null` —mandar `null`
 * vacía el dato—, mientras el nombre y el apellido paterno solo aceptan un
 * valor con contenido, porque el modelo los exige.
 */
export class UpdateParticipantDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty({ message: 'El nombre no puede quedar vacío' })
  firstName?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty({ message: 'El apellido paterno no puede quedar vacío' })
  paternalSurname?: string;

  /** `null` o cadena vacía lo borran: hay quien usa un solo apellido. */
  @IsOptional()
  @IsString()
  maternalSurname?: string | null;

  /** `null` o cadena vacía lo borran: se vuelve a saludar por el nombre de pila. */
  @IsOptional()
  @IsString()
  displayName?: string | null;

  /** El formato lo valida PhoneService, igual que en el alta. */
  @IsOptional()
  @IsString()
  @IsNotEmpty({ message: 'El teléfono no puede quedar vacío' })
  phone?: string;

  /** Del vínculo con el punto, no de la persona. */
  @IsOptional()
  @IsIn(['participante', 'encargado', 'admin'], {
    message: 'Rol no válido: usa participante, encargado o admin',
  })
  role?: string;

  @IsOptional()
  @IsBoolean()
  coverageAlerts?: boolean;

  @IsOptional()
  @IsIn(['ACTIVE', 'PAUSED', 'INACTIVE'], {
    message: 'Estado no válido: usa ACTIVE, PAUSED o INACTIVE',
  })
  status?: 'ACTIVE' | 'PAUSED' | 'INACTIVE';

  @IsOptional()
  @IsString()
  congregation?: string | null;

  @IsOptional()
  @IsString()
  circuit?: string | null;

  @IsOptional()
  @IsString()
  city?: string | null;

  @IsOptional()
  @IsIn(['SIN_REGISTRAR', 'SOLTERO', 'CASADO', 'VIUDO', 'SEPARADO', 'DIVORCIADO'], {
    message: 'Estado civil no válido',
  })
  maritalStatus?: 'SIN_REGISTRAR' | 'SOLTERO' | 'CASADO' | 'VIUDO' | 'SEPARADO' | 'DIVORCIADO';

  /** Cónyuge que también es participante. Excluyente con `spouseName`. */
  @IsOptional()
  @IsString()
  spouseParticipantId?: string | null;

  /** Nombre del cónyuge que no participa. Excluyente con `spouseParticipantId`. */
  @IsOptional()
  @IsString()
  spouseName?: string | null;
}

/** Congregación, circuito y ciudad de una persona. */
export class UpdateOrganizationDto {
  @IsOptional()
  @IsString()
  congregation?: string | null;

  @IsOptional()
  @IsString()
  circuit?: string | null;

  @IsOptional()
  @IsString()
  city?: string | null;
}

export class RangeQueryDto {
  @IsString()
  @IsNotEmpty({ message: 'Falta la fecha inicial' })
  from!: string;

  @IsString()
  @IsNotEmpty({ message: 'Falta la fecha final' })
  to!: string;
}

export class PollDraftQueryDto extends RangeQueryDto {
  @IsOptional()
  @IsIn(['cupo', 'minimo'], { message: 'El nivel debe ser cupo o minimo' })
  level?: 'cupo' | 'minimo';
}

export class CancelAssignmentDto {
  @IsIn([...CANCEL_REASON_CODES], {
    message: `El motivo debe ser uno de: ${CANCEL_REASON_CODES.join(', ')}`,
  })
  reasonCode!: string;

  @IsOptional()
  @IsString()
  reason?: string;

  /**
   * Cancelar también a su cónyuge en ese mismo turno.
   *
   * Se manda una bandera y no el `assignmentId` del cónyuge: el servidor
   * resuelve el vínculo, así que no hay forma de dar de baja a un tercero con
   * una petición preparada a mano.
   */
  @IsOptional()
  @IsBoolean()
  cancelSpouse?: boolean;
}

/** Datos mínimos de quien cubre sin estar en el padrón de este punto. */
export class ExternalCoverDto {
  @IsString()
  @IsNotEmpty({ message: 'Falta el nombre' })
  firstName!: string;

  @IsString()
  @IsNotEmpty({ message: 'Falta el apellido' })
  paternalSurname!: string;

  /** El formato lo valida PhoneService, igual que en el alta del padrón. */
  @IsString()
  @IsNotEmpty({ message: 'Falta el teléfono' })
  phone!: string;

  /** Nota de esa vez: «la trajo Dora». */
  @IsOptional()
  @IsString()
  note?: string;
}

// -------------------------------------------------------------------------
// Cuentas del panel
// -------------------------------------------------------------------------

const ROLES_DE_CUENTA = ['ADMIN', 'SUPERVISOR'] as const;
const MINIMO = 8;

export class CreateAdminUserDto {
  @IsEmail({}, { message: 'El correo no es válido' })
  email!: string;

  @IsString()
  @MinLength(MINIMO, { message: `La contraseña debe tener al menos ${MINIMO} caracteres` })
  password!: string;

  @IsIn([...ROLES_DE_CUENTA], { message: 'Rol no válido: usa ADMIN o SUPERVISOR' })
  role!: (typeof ROLES_DE_CUENTA)[number];

  /** A quién del padrón corresponde. Opcional: puede no estar. */
  @IsOptional()
  @IsString()
  participantId?: string | null;

  /** Datos propios, obligatorios **solo** si la cuenta no se vincula. */
  @IsOptional()
  @IsString()
  firstName?: string;

  @IsOptional()
  @IsString()
  paternalSurname?: string;

  @IsOptional()
  @IsString()
  maternalSurname?: string | null;

  @IsOptional()
  @IsString()
  phone?: string | null;

  @IsOptional()
  @IsString()
  congregation?: string | null;

  @IsOptional()
  @IsString()
  circuit?: string | null;

  @IsOptional()
  @IsString()
  city?: string | null;
}

export class UpdateAdminUserDto {
  @IsOptional()
  @IsEmail({}, { message: 'El correo no es válido' })
  email?: string;

  @IsOptional()
  @IsIn([...ROLES_DE_CUENTA], { message: 'Rol no válido: usa ADMIN o SUPERVISOR' })
  role?: (typeof ROLES_DE_CUENTA)[number];

  @IsOptional()
  @IsBoolean()
  active?: boolean;

  /** `null` desvincula del padrón; un id vincula. */
  @IsOptional()
  @IsString()
  participantId?: string | null;

  @IsOptional()
  @IsString()
  firstName?: string;

  @IsOptional()
  @IsString()
  paternalSurname?: string;

  @IsOptional()
  @IsString()
  maternalSurname?: string | null;

  @IsOptional()
  @IsString()
  phone?: string | null;

  @IsOptional()
  @IsString()
  congregation?: string | null;

  @IsOptional()
  @IsString()
  circuit?: string | null;

  @IsOptional()
  @IsString()
  city?: string | null;
}

/** Un administrador restablece la contraseña de otra cuenta. */
export class ResetPasswordDto {
  @IsString()
  @MinLength(MINIMO, { message: `La contraseña debe tener al menos ${MINIMO} caracteres` })
  password!: string;
}

/** Cada quien cambia la suya, demostrando que sabe la actual. */
export class ChangeOwnPasswordDto {
  @IsString()
  @IsNotEmpty({ message: 'Falta la contraseña actual' })
  current!: string;

  @IsString()
  @MinLength(MINIMO, { message: `La contraseña nueva debe tener al menos ${MINIMO} caracteres` })
  password!: string;
}

/** Alguien del padrón, para los turnos fijos. Un invitado no puede ser titular. */
export class AssignParticipantDto {
  @IsString()
  @IsNotEmpty({ message: 'Falta el participante' })
  participantId!: string;
}

/**
 * Quién cubre un turno concreto, de una de dos formas excluyentes: alguien del
 * padrón por su `participantId`, o alguien de fuera con sus datos mínimos.
 *
 * Es un DTO aparte de `AssignParticipantDto` porque los dos endpoints tienen
 * contratos distintos: a un turno fijo solo se sienta gente del padrón, y
 * aflojar ese `participantId` para reutilizar la clase dejaría ese alta sin
 * validar.
 */
export class CoverShiftDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty({ message: 'Falta el participante' })
  participantId?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => ExternalCoverDto)
  external?: ExternalCoverDto;

  /** Nota de esa vez, también para alguien del padrón. */
  @IsOptional()
  @IsString()
  note?: string;
}

export class UpdateMaritalDto {
  @IsIn(['SIN_REGISTRAR', 'SOLTERO', 'CASADO', 'VIUDO', 'SEPARADO', 'DIVORCIADO'], {
    message: 'Estado civil no válido',
  })
  maritalStatus!: 'SIN_REGISTRAR' | 'SOLTERO' | 'CASADO' | 'VIUDO' | 'SEPARADO' | 'DIVORCIADO';

  /** Cónyuge que también es participante. Excluyente con `spouseName`. */
  @IsOptional()
  @IsString()
  spouseParticipantId?: string | null;

  /** Nombre del cónyuge que no participa. Excluyente con `spouseParticipantId`. */
  @IsOptional()
  @IsString()
  spouseName?: string | null;
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

  @IsOptional()
  @IsIn(['test', 'live'], { message: 'El modo debe ser test o live' })
  messagingMode?: 'test' | 'live';

  /** Teléfonos dados de alta en la cuenta de prueba de Meta. */
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  allowedRecipients?: string[];

  @IsOptional() @IsBoolean() broadcastCoverageToParticipants?: boolean;
}
