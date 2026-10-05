import { displayName, formalName, fullName, greetingName } from './person-name';

describe('Composición del nombre', () => {
  const ana = {
    firstName: 'Ana María',
    paternalSurname: 'López',
    maternalSurname: 'Pérez',
    displayName: null,
  };

  const unSoloApellido = {
    firstName: 'John',
    paternalSurname: 'Smith',
    maternalSurname: null,
    displayName: null,
  };

  describe('formalName, para padrones y reportes', () => {
    it('pone los apellidos primero, para poder recorrer la lista con la vista', () => {
      expect(formalName(ana)).toBe('López Pérez, Ana María');
    });

    it('omite el apellido materno cuando no lo hay', () => {
      expect(formalName(unSoloApellido)).toBe('Smith, John');
    });

    it('trata una cadena en blanco como ausencia de apellido materno', () => {
      expect(formalName({ ...ana, maternalSurname: '   ' })).toBe('López, Ana María');
    });

    it('ignora el nombre a mostrar: un padrón se ordena por apellido', () => {
      expect(formalName({ ...ana, displayName: 'Anita' })).toBe('López Pérez, Ana María');
    });
  });

  describe('displayName, para el tablero y los mensajes', () => {
    it('usa nombre y primer apellido', () => {
      expect(displayName(ana)).toBe('Ana María López');
    });

    it('respeta el nombre que la persona eligió', () => {
      expect(displayName({ ...ana, displayName: 'Anita L.' })).toBe('Anita L.');
    });

    it('ignora un nombre elegido vacío', () => {
      expect(displayName({ ...ana, displayName: '  ' })).toBe('Ana María López');
    });
  });

  describe('fullName, para identificar sin ambigüedad', () => {
    it('va en el orden del habla', () => {
      expect(fullName(ana)).toBe('Ana María López Pérez');
    });

    it('funciona con un solo apellido', () => {
      expect(fullName(unSoloApellido)).toBe('John Smith');
    });
  });

  describe('greetingName, para saludar', () => {
    it('toma solo el primer nombre, no el nombre compuesto completo', () => {
      expect(greetingName(ana)).toBe('Ana');
    });

    it('respeta el nombre elegido, recortado a su primera palabra', () => {
      expect(greetingName({ ...ana, displayName: 'Anita L.' })).toBe('Anita');
    });

    it('no se confunde con un apellido al frente', () => {
      // El caso que fallaba antes: partir «López Pérez, Ana» por el primer
      // espacio saludaba «Hola, López».
      expect(greetingName(ana)).not.toBe('López');
    });

    it('tolera espacios de más', () => {
      expect(greetingName({ ...ana, firstName: '  Ana   María  ' })).toBe('Ana');
    });
  });
});
