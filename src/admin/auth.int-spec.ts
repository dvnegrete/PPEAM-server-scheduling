import { AdminRole, AuthProvider } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { createLocation, createParticipant } from '../../test/helpers/fixtures';
import { createTestContext, resetDatabase, TestContext } from '../../test/helpers/test-context';
import { AdminModule } from './admin.module';
import { AdminAuthService, BCRYPT_COST } from './auth.service';

/** Martes 25 de agosto de 2026, 12:00 hora del centro de México. */
const NOW = new Date('2026-08-25T18:00:00.000Z');

describe('Autenticación del panel (integración)', () => {
  let ctx: TestContext;
  let auth: AdminAuthService;

  beforeAll(async () => {
    ctx = await createTestContext([AdminModule]);
    auth = ctx.module.get(AdminAuthService);
  });

  afterAll(async () => {
    await ctx.close();
  });

  beforeEach(async () => {
    await resetDatabase(ctx.prisma);
    ctx.time.setClock(() => NOW);
  });

  /** Una cuenta con contraseña conocida. */
  async function cuenta(extra: Record<string, unknown> = {}) {
    return ctx.prisma.adminUser.create({
      data: {
        email: 'elena@correo.com',
        passwordHash: await bcrypt.hash('secreta-y-larga', BCRYPT_COST),
        firstName: 'Elena',
        paternalSurname: 'Mora',
        maternalSurname: 'Ruiz',
        ...extra,
      },
    });
  }

  describe('login', () => {
    it('entrega un token con el rol y la versión de la cuenta', async () => {
      await cuenta({ role: AdminRole.SUPERVISOR });

      const { token, name } = await auth.login('elena@correo.com', 'secreta-y-larga');

      expect(name).toBe('Elena Mora Ruiz');
      const payload = await auth.verify(token);
      expect(payload.role).toBe(AdminRole.SUPERVISOR);
      expect(payload.tv).toBe(0);
      expect(payload.email).toBe('elena@correo.com');
    });

    it('acepta el correo escrito con mayúsculas o espacios', async () => {
      await cuenta();
      await expect(auth.login('  Elena@Correo.COM ', 'secreta-y-larga')).resolves.toBeDefined();
    });

    it('rechaza la contraseña equivocada', async () => {
      await cuenta();
      await expect(auth.login('elena@correo.com', 'otra')).rejects.toThrow(/incorrectos/);
    });

    it('da el mismo mensaje para un correo que no existe', async () => {
      // No se filtra qué correos están registrados.
      await expect(auth.login('nadie@correo.com', 'lo-que-sea')).rejects.toThrow(/incorrectos/);
    });

    it('rechaza una cuenta desactivada', async () => {
      await cuenta({ active: false });
      await expect(auth.login('elena@correo.com', 'secreta-y-larga')).rejects.toThrow(
        /incorrectos/,
      );
    });

    it('rechaza una cuenta sin contraseña, como serán las de Google', async () => {
      await cuenta({ passwordHash: null, authProvider: AuthProvider.GOOGLE });
      await expect(auth.login('elena@correo.com', 'secreta-y-larga')).rejects.toThrow(
        /incorrectos/,
      );
    });

    it('sella la hora del último acceso', async () => {
      const elena = await cuenta();
      await auth.login('elena@correo.com', 'secreta-y-larga');

      const despues = await ctx.prisma.adminUser.findUniqueOrThrow({ where: { id: elena.id } });
      expect(despues.lastLoginAt).toEqual(NOW);
    });
  });

  describe('bitácora de acceso', () => {
    it('registra la entrada correcta', async () => {
      await cuenta();
      await auth.login('elena@correo.com', 'secreta-y-larga');

      const registro = await ctx.prisma.auditLog.findFirstOrThrow({
        where: { action: 'admin.login' },
      });
      expect(registro.actorName).toBe('Elena Mora Ruiz');
      expect((registro.metadata as { email: string }).email).toBe('elena@correo.com');
    });

    it('registra el intento fallido con el correo y sin la contraseña', async () => {
      await cuenta();
      await expect(auth.login('elena@correo.com', 'la-equivocada')).rejects.toThrow();

      const registro = await ctx.prisma.auditLog.findFirstOrThrow({
        where: { action: 'admin.login_failed' },
      });
      const meta = registro.metadata as { email: string; motivo: string };
      expect(meta.email).toBe('elena@correo.com');
      expect(meta.motivo).toBe('contraseña');
      // Lo que no debe estar en ningún sitio del registro.
      expect(JSON.stringify(registro)).not.toContain('la-equivocada');
    });

    it('distingue el motivo del fallo en la bitácora, no en la respuesta', async () => {
      // A quien lo intenta se le dice siempre lo mismo; en la bitácora sí consta
      // si fue un correo desconocido o una cuenta desactivada.
      await cuenta({ active: false });
      await expect(auth.login('elena@correo.com', 'secreta-y-larga')).rejects.toThrow();
      await expect(auth.login('otro@correo.com', 'secreta-y-larga')).rejects.toThrow();

      const motivos = (
        await ctx.prisma.auditLog.findMany({
          where: { action: 'admin.login_failed' },
          orderBy: { createdAt: 'asc' },
        })
      ).map((r) => (r.metadata as { motivo: string }).motivo);
      expect(motivos).toEqual(['cuenta inactiva', 'correo desconocido']);
    });
  });

  describe('el perfil efectivo', () => {
    it('toma el nombre del padrón cuando la cuenta está vinculada', async () => {
      // Es lo que hace que la bitácora firme con el nombre del padrón y no con
      // el que quedó inerte en la cuenta.
      const location = await createLocation(ctx.prisma);
      const ana = await createParticipant(ctx.prisma, location.id, 'Ana López Pérez');
      await cuenta({ participantId: ana.id });

      const { name } = await auth.login('elena@correo.com', 'secreta-y-larga');

      expect(name).toBe('Ana López Pérez');
    });

    it('usa el de la cuenta cuando no está vinculada', async () => {
      await cuenta();
      const { name } = await auth.login('elena@correo.com', 'secreta-y-larga');
      expect(name).toBe('Elena Mora Ruiz');
    });
  });

  describe('verificación del token', () => {
    it('rechaza un token manipulado', async () => {
      await cuenta();
      const { token } = await auth.login('elena@correo.com', 'secreta-y-larga');

      await expect(auth.verify(`${token}x`)).rejects.toThrow(/inválida o expirada/);
      await expect(auth.verify('no-es-un-token')).rejects.toThrow(/inválida o expirada/);
    });
  });
});
