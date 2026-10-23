import { BadRequestException, NotFoundException } from '@nestjs/common';
import { createLocation } from '../../../test/helpers/fixtures';
import {
  createFullTestContext,
  resetDatabase,
  TestContext,
} from '../../../test/helpers/test-context';
import { SettingsService } from './settings.service';

describe('Identidad del punto de exhibición (integración)', () => {
  let ctx: TestContext;
  let settings: SettingsService;

  beforeAll(async () => {
    ctx = await createFullTestContext();
    settings = ctx.module.get(SettingsService);
  });

  afterAll(async () => {
    await ctx.close();
  });

  beforeEach(async () => {
    await resetDatabase(ctx.prisma);
  });

  it('guarda el nombre y la dirección sin espacios de sobra', async () => {
    const location = await createLocation(ctx.prisma);

    const actualizado = await settings.updateIdentity(location.id, {
      name: '  Pto. 3 Chipitlan  ',
      address: ' Secundaria #4 ',
    });

    expect(actualizado.name).toBe('Pto. 3 Chipitlan');
    expect(actualizado.address).toBe('Secundaria #4');
  });

  it('cambia solo el campo recibido', async () => {
    const location = await createLocation(ctx.prisma, {
      name: 'Pto. 3 Chipitlan',
      address: 'Secundaria #4',
    });

    const actualizado = await settings.updateIdentity(location.id, { address: 'Primaria #7' });

    expect(actualizado.name).toBe('Pto. 3 Chipitlan');
    expect(actualizado.address).toBe('Primaria #7');
  });

  it('deja la dirección en ausente cuando se envía en blanco', async () => {
    const location = await createLocation(ctx.prisma, { address: 'Secundaria #4' });

    // Una cadena vacía guardada tal cual produciría «Nombre, » en el mensaje.
    expect((await settings.updateIdentity(location.id, { address: '   ' })).address).toBeNull();
    expect((await settings.updateIdentity(location.id, { address: null })).address).toBeNull();
  });

  it('no deja al punto sin nombre', async () => {
    const location = await createLocation(ctx.prisma, { name: 'Pto. 3 Chipitlan' });

    await expect(settings.updateIdentity(location.id, { name: '   ' })).rejects.toThrow(
      BadRequestException,
    );
    expect((await ctx.prisma.location.findUniqueOrThrow({ where: { id: location.id } })).name).toBe(
      'Pto. 3 Chipitlan',
    );
  });

  it('no conserva los ajustes operativos por error al tocar la identidad', async () => {
    const location = await createLocation(ctx.prisma, { settings: { reminderHourLocal: 7 } });

    await settings.updateIdentity(location.id, { name: 'Otro nombre' });

    expect((await settings.forLocation(location.id)).reminderHourLocal).toBe(7);
  });

  it('avisa cuando el punto no existe', async () => {
    await expect(settings.updateIdentity('no-existe', { name: 'Algo' })).rejects.toThrow(
      NotFoundException,
    );
  });
});
