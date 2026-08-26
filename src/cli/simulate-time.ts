/**
 * Simulador de tiempo.
 *
 * Los recordatorios de fin de semana salen con siete días de anticipación y las
 * solicitudes vencen en minutos: esperar en tiempo real para verificarlos no es
 * viable. Este comando fija el reloj del sistema en un instante dado y ejecuta
 * los procesos programados como si fuera ese momento.
 *
 * Uso:
 *   npm run simulate -- --at "2026-08-26T09:00" --run recordatorios,solicitudes
 *   npm run simulate -- --at "2026-09-01T03:00" --run calendario
 *   npm run simulate -- --run todo            (usa la hora actual)
 */
import { NestFactory } from '@nestjs/core';
import { DateTime } from 'luxon';
import { AppModule } from '../app.module';
import { TimeService } from '../common/time/time.service';
import { AppConfigService } from '../config/app-config.service';
import { RemindersService } from '../messaging/reminders.service';
import { ScheduleMaintenanceService } from '../scheduling/schedule-maintenance.service';
import { SupervisorTasksScheduler } from '../supervisors/supervisor-tasks.scheduler';
import { OutboxWorker } from '../whatsapp/outbox.worker';

type Job = 'recordatorios' | 'solicitudes' | 'calendario' | 'mensajes';

const ALL_JOBS: Job[] = ['calendario', 'recordatorios', 'solicitudes', 'mensajes'];

function parseArgs(argv: string[]): { at?: string; run: Job[] } {
  const args = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index].startsWith('--')) {
      args.set(argv[index].slice(2), argv[index + 1] ?? '');
    }
  }

  const runRaw = args.get('run') ?? 'todo';
  const run =
    runRaw === 'todo' ? ALL_JOBS : (runRaw.split(',').map((item) => item.trim()) as Job[]);

  return { at: args.get('at'), run };
}

async function main(): Promise<void> {
  const { at, run } = parseArgs(process.argv.slice(2));

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['log', 'warn', 'error'],
  });

  const config = app.get(AppConfigService);
  const time = app.get(TimeService);

  if (at) {
    const target = DateTime.fromISO(at, { zone: config.defaultTimezone });
    if (!target.isValid) {
      console.error(`Fecha inválida: "${at}". Usa formato 2026-08-26T09:00`);
      await app.close();
      process.exit(1);
    }
    const fixed = target.toJSDate();
    time.setClock(() => fixed);
    console.log(
      `Reloj fijado en ${target.setLocale('es-MX').toFormat("cccc d 'de' LLLL yyyy, HH:mm")} ` +
        `(${config.defaultTimezone})`,
    );
  } else {
    console.log('Usando la hora real del sistema');
  }

  for (const job of run) {
    switch (job) {
      case 'calendario': {
        console.log('\n▸ Extendiendo el calendario…');
        await app.get(ScheduleMaintenanceService).run();
        break;
      }
      case 'recordatorios': {
        console.log('\n▸ Enviando recordatorios…');
        const enviados = await app.get(RemindersService).dispatchDue();
        console.log(`  ${enviados} recordatorio(s) encolado(s)`);
        break;
      }
      case 'solicitudes': {
        console.log('\n▸ Revisando solicitudes vencidas…');
        const atendidas = await app.get(SupervisorTasksScheduler).processDueTasks();
        console.log(`  ${atendidas} solicitud(es) procesada(s)`);
        break;
      }
      case 'mensajes': {
        console.log('\n▸ Entregando la cola de mensajes…');
        const enviados = await app.get(OutboxWorker).processBatch();
        console.log(`  ${enviados} mensaje(s) entregado(s)`);
        break;
      }
      default:
        console.warn(`Trabajo desconocido: "${String(job)}". Usa: ${ALL_JOBS.join(', ')} o "todo"`);
    }
  }

  time.resetClock();
  await app.close();
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
