import { Module } from '@nestjs/common';
import { ParticipantsModule } from '../participants/participants.module';
import { CsvImportService } from './csv-import.service';

@Module({
  // La importación delega en ParticipantsService para vincular matrimonios, así
  // que reutiliza sus reglas (simetría, exclusividad) en vez de duplicarlas.
  imports: [ParticipantsModule],
  providers: [CsvImportService],
  exports: [CsvImportService],
})
export class ImportModule {}
