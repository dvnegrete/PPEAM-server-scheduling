import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { AnnounceConfirmationsDto, ConfirmationsQueryDto } from './admin.dto';

/**
 * Los DTO de las confirmaciones, que son los que reciben datos del panel sin
 * pasar por ninguna otra validación. `days` llega como texto en la query, así
 * que lo que se comprueba es la conversión **y** el rango: antes de tener tope,
 * un `?days=abc` entraba como NaN.
 */
describe('DTO de confirmaciones', () => {
  function validar<T extends object>(cls: new () => T, valor: object): string[] {
    const dto = plainToInstance(cls, valor, { enableImplicitConversion: false });
    return validateSync(dto as object).flatMap((error) => Object.values(error.constraints ?? {}));
  }

  describe('ConfirmationsQueryDto', () => {
    it('acepta que no venga, y convierte el texto de la query a número', () => {
      expect(validar(ConfirmationsQueryDto, {})).toEqual([]);
      const dto = plainToInstance(ConfirmationsQueryDto, { days: '30' });
      expect(dto.days).toBe(30);
      expect(validateSync(dto)).toEqual([]);
    });

    it('rechaza lo que no es un número y lo que se sale del rango', () => {
      expect(validar(ConfirmationsQueryDto, { days: 'abc' }).length).toBeGreaterThan(0);
      expect(validar(ConfirmationsQueryDto, { days: '0' }).length).toBeGreaterThan(0);
      expect(validar(ConfirmationsQueryDto, { days: '61' }).length).toBeGreaterThan(0);
      expect(validar(ConfirmationsQueryDto, { days: '1.5' }).length).toBeGreaterThan(0);
    });
  });

  describe('AnnounceConfirmationsDto', () => {
    it('exige al menos una clave', () => {
      expect(validar(AnnounceConfirmationsDto, { keys: [] })).toContain(
        'Hay que indicar al menos una confirmación',
      );
      expect(validar(AnnounceConfirmationsDto, {}).length).toBeGreaterThan(0);
    });

    it('acepta una lista de claves y rechaza lo que no son cadenas', () => {
      expect(validar(AnnounceConfirmationsDto, { keys: ['turno:persona'] })).toEqual([]);
      expect(validar(AnnounceConfirmationsDto, { keys: [42] }).length).toBeGreaterThan(0);
    });
  });
});
