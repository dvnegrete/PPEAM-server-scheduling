import { Global, Module } from '@nestjs/common';
import { SchedulingModule } from '../scheduling/scheduling.module';
import { WhatsAppModule } from '../whatsapp/whatsapp.module';
import { MembershipsService } from './memberships.service';
import { OrganizationFieldsService } from './organization-fields.service';
import { ParticipantProfileService } from './participant-profile.service';
import { ParticipantsService } from './participants.service';

@Global()
@Module({
  // La edición administrativa alcanza la agenda —cancelar turnos al dar de
  // baja— y la mensajería —descartar los envíos al número viejo—. Se declaran
  // aunque `WhatsAppModule` sea global: lo global solo aplica donde el módulo
  // está en el grafo, y los contextos de prueba parciales no lo incluyen.
  imports: [SchedulingModule, WhatsAppModule],
  providers: [
    ParticipantsService,
    OrganizationFieldsService,
    MembershipsService,
    ParticipantProfileService,
  ],
  exports: [
    ParticipantsService,
    OrganizationFieldsService,
    MembershipsService,
    ParticipantProfileService,
  ],
})
export class ParticipantsModule {}
