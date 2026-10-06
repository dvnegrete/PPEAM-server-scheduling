import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  ActorType,
  AssignmentStatus,
  MaritalStatus,
  Participant,
  ParticipantRole,
  ParticipantStatus,
  Prisma,
} from '@prisma/client';
import { AUDIT_ACTIONS, AuditService } from '../audit/audit.service';
import { formalName, fullName } from '../common/names/person-name';
import { InvalidPhoneNumberError, PhoneService } from '../common/phone/phone.service';
import { SettingsService } from '../common/settings/settings.service';
import { TimeService } from '../common/time/time.service';
import { PrismaService } from '../prisma/prisma.service';
import { AssignmentsService } from '../scheduling/assignments.service';
import { OutboxService } from '../whatsapp/outbox.service';
import { MembershipsService } from './memberships.service';
import { ParticipantsService } from './participants.service';

/** Estados de asignación que ocupan un lugar en el turno. */
const OCCUPYING_STATUSES = [AssignmentStatus.ASSIGNED, AssignmentStatus.CONFIRMED];

export interface UpdateProfileParams {
  participantId: string;
  /** El punto desde el que se edita: el rol y las alertas son de la membresía. */
  locationId: string;

  firstName?: string;
  paternalSurname?: string;
  /** `null` lo borra; `undefined` lo deja como estaba. */
  maternalSurname?: string | null;
  displayName?: string | null;
  phone?: string;

  role?: ParticipantRole;
  coverageAlerts?: boolean;
  status?: ParticipantStatus;

  congregation?: string | null;
  circuit?: string | null;
  city?: string | null;

  maritalStatus?: MaritalStatus;
  spouseParticipantId?: string | null;
  spouseName?: string | null;

  actorId?: string | null;
  actorName?: string | null;
}

export interface UpdateProfileResult {
  participant: Participant;
  /** Turnos futuros cancelados por una pausa o baja. */
  cancelledShifts: number;
  /** Avisos que no impiden guardar pero el administrador debe conocer. */
  warnings: string[];
}

/**
 * Edición administrativa completa de un participante.
 *
 * Vive aparte de `ParticipantsService` porque no es una operación de dominio
 * sino una de administración: alcanza la agenda —cancelar turnos al dar de
 * baja— y la mensajería —descartar envíos al número viejo—, y meter esas
 * dependencias en el servicio de participantes lo convertiría en el centro por
 * el que pasa todo.
 *
 * **Toda la validación ocurre antes del primer `update`.** No puede ser una sola
 * transacción porque `updateMarital` abre la suya y Prisma no anida
 * transacciones interactivas; el orden compensa eso dejando al final lo que
 * encadena efectos, de modo que un dato mal escrito falle sin haber tocado nada.
 */
@Injectable()
export class ParticipantProfileService {
  private readonly logger = new Logger(ParticipantProfileService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly phone: PhoneService,
    private readonly time: TimeService,
    private readonly audit: AuditService,
    private readonly settings: SettingsService,
    private readonly participants: ParticipantsService,
    private readonly memberships: MembershipsService,
    private readonly assignments: AssignmentsService,
    private readonly outbox: OutboxService,
  ) {}

  async updateProfile(params: UpdateProfileParams): Promise<UpdateProfileResult> {
    const actor = { id: params.actorId ?? null, name: params.actorName ?? null };
    const warnings: string[] = [];

    // ---------------------------------------------------------------------
    // Validación, antes de escribir nada
    // ---------------------------------------------------------------------

    const anterior = await this.prisma.participant.findUnique({
      where: { id: params.participantId },
    });
    if (!anterior) throw new NotFoundException('Ese participante ya no existe');

    await this.memberships.membershipIn(params.participantId, params.locationId).then((m) => {
      if (!m) throw new NotFoundException('Esa persona no pertenece a ese punto de exhibición');
    });

    const firstName = params.firstName?.trim();
    const paternalSurname = params.paternalSurname?.trim();
    if (params.firstName !== undefined && !firstName) {
      throw new BadRequestException('El nombre no puede quedar vacío');
    }
    if (params.paternalSurname !== undefined && !paternalSurname) {
      throw new BadRequestException('El apellido paterno no puede quedar vacío');
    }

    const telefonoNuevo = await this.resolvePhone(params, anterior, warnings);

    // ---------------------------------------------------------------------
    // 1. Identidad y teléfono
    // ---------------------------------------------------------------------

    const datos: Prisma.ParticipantUpdateInput = {};
    if (firstName) datos.firstName = firstName;
    if (paternalSurname) datos.paternalSurname = paternalSurname;
    if (params.maternalSurname !== undefined) {
      datos.maternalSurname = params.maternalSurname?.trim() || null;
    }
    if (params.displayName !== undefined) {
      datos.displayName = params.displayName?.trim() || null;
    }
    if (telefonoNuevo) {
      datos.phoneE164 = telefonoNuevo;
      datos.phoneChangedAt = this.time.now();
    }

    if (Object.keys(datos).length > 0) {
      await this.writeIdentity(params.participantId, datos, anterior, telefonoNuevo, actor);
    }

    // El número viejo se queda con lo que no alcanzó a salir, y eso se descarta
    // después de escribir: si la escritura falla, no se tira nada.
    if (telefonoNuevo) {
      const descartados = await this.outbox.cancelPendingFor(
        params.participantId,
        `cambio de teléfono (${anterior.phoneE164} → ${telefonoNuevo})`,
      );
      if (descartados > 0) {
        warnings.push(
          `Se descartaron ${descartados} mensaje(s) que estaban por salir al número anterior; ` +
            'los recordatorios se volverán a generar con el número nuevo.',
        );
      }
    }

    // ---------------------------------------------------------------------
    // 2. Membresía: el rol y los avisos son del vínculo con el punto
    // ---------------------------------------------------------------------

    await this.writeMembership(params, actor);

    // ---------------------------------------------------------------------
    // 3. Organización y 4. estado civil: los servicios que ya existen
    // ---------------------------------------------------------------------

    if (
      params.congregation !== undefined ||
      params.circuit !== undefined ||
      params.city !== undefined
    ) {
      await this.participants.updateOrganization(
        params.participantId,
        { congregation: params.congregation, circuit: params.circuit, city: params.city },
        actor,
      );
    }

    if (params.maritalStatus !== undefined) {
      await this.participants.updateMarital({
        participantId: params.participantId,
        maritalStatus: params.maritalStatus,
        spouseParticipantId: params.spouseParticipantId,
        spouseName: params.spouseName,
        actorId: actor.id,
        actorName: actor.name,
      });
    }

    // ---------------------------------------------------------------------
    // 5. Estado, al final: es lo que encadena efectos
    // ---------------------------------------------------------------------

    const cancelledShifts = await this.applyStatus(params, anterior, actor);

    const participant = await this.prisma.participant.findUniqueOrThrow({
      where: { id: params.participantId },
    });
    return { participant, cancelledShifts, warnings };
  }

  /**
   * Normaliza el teléfono nuevo y comprueba que no sea de nadie más.
   * Devuelve `null` si no se está cambiando.
   */
  private async resolvePhone(
    params: UpdateProfileParams,
    anterior: Participant,
    warnings: string[],
  ): Promise<string | null> {
    if (params.phone === undefined) return null;
    if (!params.phone.trim()) throw new BadRequestException('El teléfono no puede quedar vacío');

    let normalizado: string;
    try {
      normalizado = this.phone.normalize(params.phone);
    } catch (error) {
      // `PhoneService` lanza un error de dominio, no una excepción HTTP: sin
      // traducirlo, un número mal escrito saldría como un 500.
      if (error instanceof InvalidPhoneNumberError) {
        throw new BadRequestException(`El teléfono "${params.phone}" no es válido`);
      }
      throw error;
    }

    if (this.phone.lookupVariants(anterior.phoneE164).includes(normalizado)) return null;

    const ocupado = await this.prisma.participant.findFirst({
      where: {
        phoneE164: { in: this.phone.lookupVariants(normalizado) },
        id: { not: params.participantId },
      },
    });
    if (ocupado) {
      throw new ConflictException(
        `Ese teléfono ya es de ${formalName(ocupado)}. Revisa si se trata de un registro duplicado`,
      );
    }

    // En modo de prueba solo se entrega a la lista blanca de Meta, y lo que no
    // coincide se omite **en silencio**: sin este aviso, el administrador
    // creería que la persona recibe avisos cuando no le llega ninguno.
    const location = await this.prisma.location.findUnique({ where: { id: params.locationId } });
    if (location) {
      const ajustes = this.settings.resolve(location);
      const permitido = this.phone
        .lookupVariants(normalizado)
        .some((variante) => ajustes.allowedRecipients.includes(variante));
      if (ajustes.messagingMode === 'test' && !permitido) {
        warnings.push(
          'Este punto está en modo de prueba y el número nuevo no está en la lista de ' +
            'destinatarios permitidos: no recibirá ningún mensaje hasta que lo agregues en Ajustes.',
        );
      }
    }

    return normalizado;
  }

  /** Escribe nombre y teléfono, con la bitácora en la misma transacción. */
  private async writeIdentity(
    participantId: string,
    datos: Prisma.ParticipantUpdateInput,
    anterior: Participant,
    telefonoNuevo: string | null,
    actor: { id: string | null; name: string | null },
  ): Promise<void> {
    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.participant.update({ where: { id: participantId }, data: datos });

        await this.audit.record(
          {
            actorType: actor.id ? ActorType.ADMIN : ActorType.SYSTEM,
            actorId: actor.id,
            actorName: actor.name,
            action: telefonoNuevo
              ? AUDIT_ACTIONS.PARTICIPANT_PHONE_CHANGED
              : AUDIT_ACTIONS.PARTICIPANT_UPDATED,
            entity: 'Participant',
            entityId: participantId,
            before: {
              firstName: anterior.firstName,
              paternalSurname: anterior.paternalSurname,
              maternalSurname: anterior.maternalSurname,
              displayName: anterior.displayName,
              phoneE164: anterior.phoneE164,
            },
            after: {
              firstName: datos.firstName ?? anterior.firstName,
              paternalSurname: datos.paternalSurname ?? anterior.paternalSurname,
              maternalSurname:
                datos.maternalSurname !== undefined
                  ? datos.maternalSurname
                  : anterior.maternalSurname,
              displayName:
                datos.displayName !== undefined ? datos.displayName : anterior.displayName,
              phoneE164: telefonoNuevo ?? anterior.phoneE164,
            },
            metadata: { participantName: fullName(anterior) },
          },
          tx,
        );
      });
    } catch (error) {
      // Red de seguridad por si otro administrador tomó ese número entre la
      // comprobación y la escritura: el índice único lo rechaza con P2002.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException('Ese teléfono acaba de quedar ocupado por otro registro');
      }
      throw error;
    }

    if (telefonoNuevo) {
      this.logger.log(
        `${fullName(anterior)} cambió de número: ${anterior.phoneE164} → ${telefonoNuevo}`,
      );
    }
  }

  /** Rol y preferencia de avisos, que son de la membresía y no de la persona. */
  private async writeMembership(
    params: UpdateProfileParams,
    actor: { id: string | null; name: string | null },
  ): Promise<void> {
    if (params.role === undefined && params.coverageAlerts === undefined) return;

    const antes = await this.memberships.membershipIn(params.participantId, params.locationId);

    if (params.role !== undefined) {
      await this.memberships.setRole(params.participantId, params.locationId, params.role);
    }
    if (params.coverageAlerts !== undefined) {
      await this.memberships.setCoverageAlerts(
        params.participantId,
        params.locationId,
        params.coverageAlerts,
      );
    }

    // `MembershipsService` no audita: la bitácora la escribe quien lo llama.
    await this.audit.record({
      actorType: actor.id ? ActorType.ADMIN : ActorType.SYSTEM,
      actorId: actor.id,
      actorName: actor.name,
      action: AUDIT_ACTIONS.PARTICIPANT_UPDATED,
      entity: 'LocationMembership',
      entityId: antes?.id ?? params.participantId,
      before: { role: antes?.role ?? null, coverageAlerts: antes?.coverageAlerts ?? null },
      after: {
        role: params.role ?? antes?.role ?? null,
        coverageAlerts: params.coverageAlerts ?? antes?.coverageAlerts ?? null,
      },
      metadata: { locationId: params.locationId },
    });
  }

  /**
   * Cambia el estado y, al pausar o dar de baja, libera sus turnos futuros.
   *
   * Se cancela **sin convocar**: una baja administrativa con quince turnos
   * abriría quince convocatorias de golpe. Los huecos quedan visibles en el
   * tablero y el administrador decide cuándo y cómo convocar.
   */
  private async applyStatus(
    params: UpdateProfileParams,
    anterior: Participant,
    actor: { id: string | null; name: string | null },
  ): Promise<number> {
    if (params.status === undefined || params.status === anterior.status) return 0;

    await this.prisma.participant.update({
      where: { id: params.participantId },
      data: { status: params.status },
    });

    await this.audit.record({
      actorType: actor.id ? ActorType.ADMIN : ActorType.SYSTEM,
      actorId: actor.id,
      actorName: actor.name,
      action: AUDIT_ACTIONS.PARTICIPANT_STATUS_CHANGED,
      entity: 'Participant',
      entityId: params.participantId,
      before: { status: anterior.status },
      after: { status: params.status },
      metadata: { participantName: fullName(anterior) },
    });

    if (params.status === ParticipantStatus.ACTIVE) return 0;

    const futuras = await this.prisma.assignment.findMany({
      where: {
        participantId: params.participantId,
        status: { in: OCCUPYING_STATUSES },
        shift: { startsAt: { gt: this.time.now() } },
      },
      select: { id: true },
    });

    for (const asignacion of futuras) {
      await this.assignments.cancel({
        assignmentId: asignacion.id,
        actorId: actor.id,
        actorName: actor.name,
        actorType: ActorType.ADMIN,
        reasonCode: params.status === ParticipantStatus.PAUSED ? 'pausa' : 'baja',
        notify: false,
      });
    }

    this.logger.log(
      `${fullName(anterior)} pasa a ${params.status}; ` +
        `se liberaron ${futuras.length} turno(s) futuro(s) sin convocar`,
    );
    return futuras.length;
  }
}
