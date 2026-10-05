import { z } from 'zod';

/**
 * Parámetros operativos de cada punto de exhibición. Viven en `Location.settings`
 * (JSON) para que un administrador pueda ajustarlos desde el panel sin migración
 * ni redespliegue.
 */
export const locationSettingsSchema = z.object({
  /** Un turno que ocurre dentro de estas horas convierte la vacante en urgente. */
  urgentWindowHours: z.number().positive().default(24),

  /** Plazo que tiene un encargado para atender una solicitud normal. */
  supervisorTimeoutMinutes: z.number().positive().default(60),

  /** Plazo más corto cuando la solicitud es urgente; al vencer, el sistema resuelve solo. */
  urgentSupervisorTimeoutMinutes: z.number().positive().default(30),

  /** La vacante deja de aceptar ofrecimientos estas horas antes de que inicie el turno. */
  coverageCloseHoursBeforeShift: z.number().min(0).default(1),

  /** Hora local a la que sale el recordatorio (L-V el día previo; sáb/dom una semana antes). */
  reminderHourLocal: z.number().int().min(0).max(23).default(9),

  /** Días de anticipación del recordatorio para turnos de lunes a viernes. */
  weekdayReminderDaysAhead: z.number().int().positive().default(1),

  /** Días de anticipación del recordatorio para turnos de sábado y domingo. */
  weekendReminderDaysAhead: z.number().int().positive().default(7),

  /** Meses de calendario materializados por adelantado. */
  scheduleHorizonMonths: z.number().int().positive().default(2),

  /** Vigencia de un flujo conversacional a medias antes de reiniciarse. */
  sessionTtlMinutes: z.number().int().positive().default(30),

  /** Un hilo de preguntas sin actividad se cierra tras estas horas. */
  threadIdleCloseHours: z.number().positive().default(24),

  /** Cuántos avisos de vacante se encolan por tanda (control de costo y ritmo). */
  broadcastBatchSize: z.number().int().positive().default(50),

  /** Si es true, al vencer el plazo de una vacante urgente el sistema aprueba solo. */
  autoResolveUrgent: z.boolean().default(true),

  /**
   * Modo de entrega de mensajes.
   *
   * `test` es para operar con una cuenta de prueba de Meta, que solo permite
   * escribir a un puñado de números dados de alta: cualquier envío a otro número
   * sería rechazado y llenaría el outbox de fallos. En ese modo solo se entrega a
   * `allowedRecipients`; el resto se omite y queda en el log.
   */
  messagingMode: z.enum(['test', 'live']).default('test'),

  /** Teléfonos en E.164 dados de alta en la cuenta de prueba. Solo aplica en modo `test`. */
  allowedRecipients: z.array(z.string()).default([]),

  /**
   * Si es false, abrir una vacante no difunde nada a los participantes.
   * Mientras la convocatoria se haga con una encuesta manual en el grupo, esto
   * evita mensajes que nadie espera y que además no podrían entregarse.
   */
  broadcastCoverageToParticipants: z.boolean().default(false),
});

export type LocationSettings = z.infer<typeof locationSettingsSchema>;

export const DEFAULT_LOCATION_SETTINGS: LocationSettings = locationSettingsSchema.parse({});
