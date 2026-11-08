import { captainFirst } from './captain-first';

interface Persona {
  id: string;
  spouseId: string | null;
}

const p = (id: string, spouseId: string | null = null): Persona => ({ id, spouseId });
const ordenar = (gente: Persona[], capitan: string | null) =>
  captainFirst(
    gente,
    capitan,
    (persona) => persona.id,
    (persona) => persona.spouseId,
  ).map((persona) => persona.id);

describe('captainFirst', () => {
  it('pone al capitán al frente y deja al resto en su orden', () => {
    expect(ordenar([p('ana'), p('beto'), p('carla')], 'carla')).toEqual(['carla', 'ana', 'beto']);
  });

  it('su cónyuge va en segundo lugar si está en el turno', () => {
    const gente = [p('ana'), p('beto'), p('carla', 'dora'), p('dora', 'carla')];
    expect(ordenar(gente, 'carla')).toEqual(['carla', 'dora', 'ana', 'beto']);
  });

  it('si el cónyuge no está en el turno, sigue el orden normal', () => {
    expect(ordenar([p('ana'), p('beto', 'zoe'), p('carla')], 'beto')).toEqual([
      'beto',
      'ana',
      'carla',
    ]);
  });

  it('sin capitán, o si el capitán no está (canceló), no cambia nada', () => {
    const gente = [p('ana'), p('beto')];
    expect(ordenar(gente, null)).toEqual(['ana', 'beto']);
    expect(ordenar(gente, 'carla')).toEqual(['ana', 'beto']);
  });
});
