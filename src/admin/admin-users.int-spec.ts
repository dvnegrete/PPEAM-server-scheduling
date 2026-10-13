import { AdminRole, ParticipantRole } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { createLocation, createParticipant } from '../../test/helpers/fixtures';
import { createTestContext, resetDatabase, TestContext } from '../../test/helpers/test-context';
import { AdminModule } from './admin.module';
import { AdminUsersService } from './admin-users.service';
import { AdminAuthService, BCRYPT_COST } from './auth.service';

describe('Cuentas del panel (integración)', () => {
  let ctx: TestContext;
  let cuentas: AdminUsersService;
  let auth: AdminAuthService;
  let locationId: string;

  beforeAll(async () => {
    ctx = await createTestContext([AdminModule]);
    cuentas = ctx.module.get(AdminUsersService);
    auth = ctx.module.get(AdminAuthService);
  });

  afterAll(async () => {
    await ctx.close();
  });

  beforeEach(async () => {
    await resetDatabase(ctx.prisma);
    const location = await createLocation(ctx.prisma);
    locationId = location.id;
  });

  const actor = { id: 'admin-0', name: 'Quien administra' };

  /** El administrador que ya existe en cualquier instalación. */
  async function administradorExistente() {
    return ctx.prisma.adminUser.create({
      data: {
        email: 'jefe@correo.com',
        passwordHash: await bcrypt.hash('la-del-jefe', BCRYPT_COST),
        firstName: 'Jefa',
        paternalSurname: 'Principal',
        role: AdminRole.ADMIN,
      },
    });
  }

  describe('alta', () => {
    it('crea una cuenta que debe cambiar su contraseña al entrar', async () => {
      const cuenta = await cuentas.create(
        {
          email: 'Elena@Correo.com',
          password: 'secreta-y-larga',
          role: AdminRole.SUPERVISOR,
          firstName: 'Elena',
          paternalSurname: 'Mora',
        },
        actor,
      );

      expect(cuenta.email).toBe('elena@correo.com'); // normalizado
      expect(cuenta.role).toBe(AdminRole.SUPERVISOR);
      expect(cuenta.mustChangePassword).toBe(true);
      expect(cuenta.perfil.fullName).toBe('Elena Mora');
      expect(cuenta.perfil.fromPadron).toBe(false);
    });

    it('rechaza una contraseña corta', async () => {
      await expect(
        cuentas.create(
          {
            email: 'elena@correo.com',
            password: 'corta',
            role: AdminRole.ADMIN,
            firstName: 'Elena',
            paternalSurname: 'Mora',
          },
          actor,
        ),
      ).rejects.toThrow(/al menos 8/);
    });

    it('rechaza un correo repetido', async () => {
      await administradorExistente();
      await expect(
        cuentas.create(
          {
            email: 'jefe@correo.com',
            password: 'secreta-y-larga',
            role: AdminRole.ADMIN,
            firstName: 'Otra',
            paternalSurname: 'Persona',
          },
          actor,
        ),
      ).rejects.toThrow(/Ya hay una cuenta/);
    });

    it('exige nombre si no se vincula con el padrón', async () => {
      await expect(
        cuentas.create(
          { email: 'elena@correo.com', password: 'secreta-y-larga', role: AdminRole.ADMIN },
          actor,
        ),
      ).rejects.toThrow(/nombre y el apellido, o vincular/);
    });

    it('nunca devuelve ni registra la contraseña', async () => {
      const cuenta = await cuentas.create(
        {
          email: 'elena@correo.com',
          password: 'secreta-y-larga',
          role: AdminRole.ADMIN,
          firstName: 'Elena',
          paternalSurname: 'Mora',
        },
        actor,
      );

      expect(JSON.stringify(cuenta)).not.toContain('secreta-y-larga');
      const bitacora = await ctx.prisma.auditLog.findMany();
      expect(JSON.stringify(bitacora)).not.toContain('secreta-y-larga');
    });
  });

  describe('el vínculo con el padrón', () => {
    it('toma del padrón el nombre, el teléfono y la congregación', async () => {
      const ana = await createParticipant(ctx.prisma, locationId, 'Ana López Pérez');
      await ctx.prisma.participant.update({
        where: { id: ana.id },
        data: { congregation: 'Centro' },
      });

      const cuenta = await cuentas.create(
        {
          email: 'ana@correo.com',
          password: 'secreta-y-larga',
          role: AdminRole.SUPERVISOR,
          participantId: ana.id,
          // Estos quedan inertes: manda el padrón.
          firstName: 'Nombre',
          paternalSurname: 'Inerte',
          phone: '55 0000 0000',
        },
        actor,
      );

      expect(cuenta.perfil.fullName).toBe('Ana López Pérez');
      expect(cuenta.perfil.phone).toBe(ana.phoneE164);
      expect(cuenta.perfil.congregation).toBe('Centro');
      expect(cuenta.perfil.fromPadron).toBe(true);
    });

    it('es 1:1: un participante no puede tener dos cuentas', async () => {
      const ana = await createParticipant(ctx.prisma, locationId, 'Ana López');
      await cuentas.create(
        {
          email: 'ana@correo.com',
          password: 'secreta-y-larga',
          role: AdminRole.SUPERVISOR,
          participantId: ana.id,
        },
        actor,
      );

      await expect(
        cuentas.create(
          {
            email: 'otra@correo.com',
            password: 'secreta-y-larga',
            role: AdminRole.SUPERVISOR,
            participantId: ana.id,
          },
          actor,
        ),
      ).rejects.toThrow(/ya tiene cuenta \(ana@correo.com\)/);
    });

    it('al desvincular, los datos vuelven a ser los de la cuenta', async () => {
      const ana = await createParticipant(ctx.prisma, locationId, 'Ana López');
      const cuenta = await cuentas.create(
        {
          email: 'ana@correo.com',
          password: 'secreta-y-larga',
          role: AdminRole.SUPERVISOR,
          participantId: ana.id,
          firstName: 'Elena',
          paternalSurname: 'Mora',
        },
        actor,
      );
      expect(cuenta.perfil.fullName).toBe('Ana López');

      const suelta = await cuentas.update(cuenta.id, { participantId: null }, actor);
      expect(suelta.perfil.fullName).toBe('Elena Mora');
      expect(suelta.perfil.fromPadron).toBe(false);
    });
  });

  describe('un solo interruptor para el rol', () => {
    it('marcar la cuenta como encargado da también el rol en el padrón', async () => {
      const ana = await createParticipant(ctx.prisma, locationId, 'Ana López');

      await cuentas.create(
        {
          email: 'ana@correo.com',
          password: 'secreta-y-larga',
          role: AdminRole.SUPERVISOR,
          participantId: ana.id,
        },
        actor,
      );

      const membresia = await ctx.prisma.locationMembership.findFirstOrThrow({
        where: { participantId: ana.id, locationId },
      });
      expect(membresia.role).toBe(ParticipantRole.SUPERVISOR);
    });

    it('el cambio de rol de la cuenta arrastra el del padrón', async () => {
      const ana = await createParticipant(ctx.prisma, locationId, 'Ana López');
      const cuenta = await cuentas.create(
        {
          email: 'ana@correo.com',
          password: 'secreta-y-larga',
          role: AdminRole.SUPERVISOR,
          participantId: ana.id,
        },
        actor,
      );

      await cuentas.update(cuenta.id, { role: AdminRole.ADMIN }, actor);

      const membresia = await ctx.prisma.locationMembership.findFirstOrThrow({
        where: { participantId: ana.id, locationId },
      });
      expect(membresia.role).toBe(ParticipantRole.ADMIN);
    });

    it('una cuenta sin vincular no toca ninguna membresía', async () => {
      await cuentas.create(
        {
          email: 'elena@correo.com',
          password: 'secreta-y-larga',
          role: AdminRole.SUPERVISOR,
          firstName: 'Elena',
          paternalSurname: 'Mora',
        },
        actor,
      );

      expect(
        await ctx.prisma.locationMembership.count({ where: { role: ParticipantRole.SUPERVISOR } }),
      ).toBe(0);
    });
  });

  describe('no quedarse sin administradores', () => {
    it('no se puede desactivar al único administrador', async () => {
      const jefa = await administradorExistente();

      await expect(cuentas.update(jefa.id, { active: false }, actor)).rejects.toThrow(
        /único administrador/,
      );
    });

    it('no se puede degradar al único administrador', async () => {
      const jefa = await administradorExistente();

      await expect(cuentas.update(jefa.id, { role: AdminRole.SUPERVISOR }, actor)).rejects.toThrow(
        /único administrador/,
      );
    });

    it('el mensaje cambia cuando eres tú quien se cierra la puerta', async () => {
      const jefa = await administradorExistente();

      await expect(
        cuentas.update(jefa.id, { active: false }, { id: jefa.id, name: 'Jefa' }),
      ).rejects.toThrow(/No puedes quitarte el acceso/);
    });

    it('con otro administrador activo, sí se puede', async () => {
      const jefa = await administradorExistente();
      await cuentas.create(
        {
          email: 'segunda@correo.com',
          password: 'secreta-y-larga',
          role: AdminRole.ADMIN,
          firstName: 'Segunda',
          paternalSurname: 'Admin',
        },
        actor,
      );

      const degradada = await cuentas.update(jefa.id, { role: AdminRole.SUPERVISOR }, actor);
      expect(degradada.role).toBe(AdminRole.SUPERVISOR);
    });

    it('un administrador inactivo no cuenta como respaldo', async () => {
      const jefa = await administradorExistente();
      await ctx.prisma.adminUser.create({
        data: {
          email: 'dormida@correo.com',
          passwordHash: 'x',
          firstName: 'Dormida',
          paternalSurname: 'Admin',
          role: AdminRole.ADMIN,
          active: false,
        },
      });

      await expect(cuentas.update(jefa.id, { active: false }, actor)).rejects.toThrow(
        /único administrador/,
      );
    });
  });

  describe('contraseñas', () => {
    it('cambiar la propia exige la actual y cierra las demás sesiones', async () => {
      const jefa = await administradorExistente();
      const { token } = await auth.login('jefe@correo.com', 'la-del-jefe');
      const antes = await auth.verify(token);

      await cuentas.changeOwnPassword(jefa.id, 'la-del-jefe', 'la-nueva-y-larga');

      const despues = await ctx.prisma.adminUser.findUniqueOrThrow({ where: { id: jefa.id } });
      // La versión subió, así que el token anterior ya no vale.
      expect(despues.tokenVersion).toBe(antes.tv + 1);
      expect(despues.mustChangePassword).toBe(false);
      await expect(auth.login('jefe@correo.com', 'la-nueva-y-larga')).resolves.toBeDefined();
      await expect(auth.login('jefe@correo.com', 'la-del-jefe')).rejects.toThrow();
    });

    it('rechaza el cambio si la actual no es correcta', async () => {
      const jefa = await administradorExistente();

      await expect(
        cuentas.changeOwnPassword(jefa.id, 'la-equivocada', 'la-nueva-y-larga'),
      ).rejects.toThrow(/actual no es correcta/);
    });

    it('rechaza repetir la misma contraseña', async () => {
      const jefa = await administradorExistente();

      await expect(
        cuentas.changeOwnPassword(jefa.id, 'la-del-jefe', 'la-del-jefe'),
      ).rejects.toThrow(/distinta de la actual/);
    });

    it('restablecer la de otro vuelve a obligar el cambio y corta su sesión', async () => {
      const cuenta = await cuentas.create(
        {
          email: 'elena@correo.com',
          password: 'secreta-y-larga',
          role: AdminRole.SUPERVISOR,
          firstName: 'Elena',
          paternalSurname: 'Mora',
        },
        actor,
      );
      await cuentas.changeOwnPassword(cuenta.id, 'secreta-y-larga', 'la-suya-y-larga');
      const versionPrevia = (
        await ctx.prisma.adminUser.findUniqueOrThrow({ where: { id: cuenta.id } })
      ).tokenVersion;

      await cuentas.resetPassword(cuenta.id, 'la-que-puso-el-jefe', actor);

      const despues = await ctx.prisma.adminUser.findUniqueOrThrow({ where: { id: cuenta.id } });
      expect(despues.mustChangePassword).toBe(true);
      expect(despues.tokenVersion).toBe(versionPrevia + 1);
      await expect(auth.login('elena@correo.com', 'la-que-puso-el-jefe')).resolves.toBeDefined();
    });
  });
});
