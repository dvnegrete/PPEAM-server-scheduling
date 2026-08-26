import { Module } from '@nestjs/common';
import { CsvImportService } from './csv-import.service';

@Module({
  providers: [CsvImportService],
  exports: [CsvImportService],
})
export class ImportModule {}
