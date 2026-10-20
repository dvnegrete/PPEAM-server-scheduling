import {
  ACCIONES_SENSIBLES,
  AUDIT_CATEGORIES,
  AUDIT_CATEGORY_IDS,
  categoriaDe,
  etiquetaDe,
} from './audit-catalog';
import { AUDIT_ACTIONS } from './audit.service';

describe('Catálogo de la bitácora', () => {
  const acciones = Object.values(AUDIT_ACTIONS);

  // Esta es la prueba que importa: si alguien añade una acción a AUDIT_ACTIONS y
  // no la cataloga, la bitácora la mostraría con su clave técnica. Aquí falla.
  it('tiene etiqueta y categoría para todas las acciones registradas', () => {
    const sinEtiqueta = acciones.filter((accion) => etiquetaDe(accion) === accion);
    const sinCategoria = acciones.filter((accion) => categoriaDe(accion) === null);

    expect(sinEtiqueta).toEqual([]);
    expect(sinCategoria).toEqual([]);
  });

  it('no repite una acción en dos categorías', () => {
    const todas = AUDIT_CATEGORY_IDS.flatMap((id) => [...AUDIT_CATEGORIES[id].actions]);
    expect(todas).toHaveLength(new Set(todas).size);
    expect(todas).toHaveLength(acciones.length);
  });

  it('devuelve la clave tal cual cuando la acción no está catalogada', () => {
    // `AuditEntry.action` acepta texto libre, así que esto puede pasar.
    expect(etiquetaDe('algo.que.nadie.declaro')).toBe('algo.que.nadie.declaro');
    expect(categoriaDe('algo.que.nadie.declaro')).toBeNull();
  });

  it('considera sensible todo lo de accesos y cuentas, y nada más', () => {
    expect([...ACCIONES_SENSIBLES].sort()).toEqual(
      [
        AUDIT_ACTIONS.ADMIN_LOGIN,
        AUDIT_ACTIONS.ADMIN_LOGIN_FAILED,
        AUDIT_ACTIONS.ADMIN_USER_CREATED,
        AUDIT_ACTIONS.ADMIN_USER_UPDATED,
        AUDIT_ACTIONS.ADMIN_PASSWORD_RESET,
        AUDIT_ACTIONS.ADMIN_PASSWORD_CHANGED,
      ].sort(),
    );
  });

  it('cada categoría tiene etiqueta y al menos una acción', () => {
    for (const id of AUDIT_CATEGORY_IDS) {
      expect(AUDIT_CATEGORIES[id].label).toBeTruthy();
      expect(AUDIT_CATEGORIES[id].actions.length).toBeGreaterThan(0);
    }
  });
});
