import { execSync } from 'node:child_process';

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  'postgresql://ppeam:ppeam@localhost:5433/ppeam_schedules_test?schema=public';

/**
 * Prepara una base de datos separada para las pruebas de integración.
 * Se usa una base propia para no tocar nunca los datos de desarrollo.
 */
export default function globalSetup(): void {
  process.env.DATABASE_URL = TEST_DATABASE_URL;

  // psql no entiende el parámetro `schema` de Prisma, así que se recorta.
  const adminUrl = TEST_DATABASE_URL.replace(/\/[^/?]+(\?.*)?$/, '/postgres');
  try {
    execSync(
      `psql "${adminUrl}" -tc "SELECT 1 FROM pg_database WHERE datname='ppeam_schedules_test'" | grep -q 1 || psql "${adminUrl}" -c "CREATE DATABASE ppeam_schedules_test"`,
      { stdio: 'pipe', shell: '/bin/bash' },
    );
  } catch (error) {
    throw new Error(
      `No se pudo preparar la base de pruebas. ¿Está levantado docker compose? Detalle: ${String(error)}`,
    );
  }

  execSync('npx prisma migrate deploy', {
    stdio: 'pipe',
    env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL },
  });
}
