import { InvalidPhoneNumberError, PhoneService } from './phone.service';

describe('PhoneService', () => {
  const service = new PhoneService();

  describe('normalize', () => {
    it('normaliza un número nacional mexicano', () => {
      expect(service.normalize('5512345678')).toBe('+525512345678');
      expect(service.normalize('55 1234 5678')).toBe('+525512345678');
      expect(service.normalize('(55) 1234-5678')).toBe('+525512345678');
    });

    it('quita el "1" que WhatsApp agrega a los móviles mexicanos', () => {
      expect(service.normalize('+5215512345678')).toBe('+525512345678');
      expect(service.normalize('5215512345678')).toBe('+525512345678');
      expect(service.normalize('+52 1 55 1234 5678')).toBe('+525512345678');
    });

    it('conserva números de otros países', () => {
      expect(service.normalize('+13055551234')).toBe('+13055551234');
    });

    it('rechaza lo que no es un teléfono', () => {
      expect(() => service.normalize('123')).toThrow(InvalidPhoneNumberError);
      expect(() => service.normalize('sin número')).toThrow(InvalidPhoneNumberError);
      expect(service.tryNormalize('123')).toBeNull();
    });
  });

  describe('lookupVariants', () => {
    it('incluye la forma con el "1" mexicano para poder buscar por cualquiera', () => {
      const variants = service.lookupVariants('+525512345678');
      expect(variants).toEqual(
        expect.arrayContaining([
          '+525512345678',
          '525512345678',
          '+5215512345678',
          '5215512345678',
        ]),
      );
    });

    it('no inventa variantes para otros países', () => {
      expect(service.lookupVariants('+13055551234')).toEqual(['+13055551234', '13055551234']);
    });
  });

  it('formatea para mostrar', () => {
    expect(service.format('+525512345678')).toBe('+52 55 1234 5678');
  });
});
