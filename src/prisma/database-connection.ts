import { Prisma } from '@prisma/client';

/**
 * Códigos con que Prisma dice «no llegué a la base»: no se pudo alcanzar el
 * servidor (P1001), se agotó el tiempo de conexión (P1002) o la conexión se
 * cerró (P1017). No hablan de la consulta, sino del camino hasta la base.
 */
const CONNECTION_ERROR_CODES = new Set(['P1001', 'P1002', 'P1017']);

/**
 * Si el fallo es de conexión y no de la consulta.
 *
 * Importa distinguirlo porque la base se duerme cuando pasa un rato sin uso:
 * la primera consulta después la despierta, pero ella misma falla. Eso no es
 * un error de la aplicación ni de quien la usa; solo hay que esperar.
 */
export function isDatabaseConnectionError(error: unknown): boolean {
  if (error instanceof Prisma.PrismaClientInitializationError) return true;
  return (
    error instanceof Prisma.PrismaClientKnownRequestError && CONNECTION_ERROR_CODES.has(error.code)
  );
}
