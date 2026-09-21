import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { esUnaBaseDePruebas } from '@/lib/base-de-pruebas';

/**
 * **La demo no puede apuntar a producción, ni hablar con nadie.**
 *
 * La configuración de la demo es un archivo, y un archivo se edita sin que
 * nadie corra nada. Estas afirmaciones existen para que agregarle una
 * credencial de escritura, una base de producción o Supabase rompa una prueba
 * en vez de descubrirse cuando la demo escriba en algún lado.
 *
 * Se lee el YAML como texto a propósito, sin parser: lo que hay que comprobar
 * es la **ausencia** de ciertos nombres, y una ausencia se comprueba mejor
 * sobre el archivo entero que sobre un árbol donde una clave anidada distinta
 * pasaría de largo.
 */

const RAIZ = join(__dirname, '..', '..');
const DEMO = readFileSync(join(RAIZ, 'deploy', 'vista-previa.render.yaml'), 'utf8');
const PRODUCCION = readFileSync(join(RAIZ, '..', 'render.yaml'), 'utf8');

describe('la demo usa su propia base y nada más', () => {
  it('declara compras-demo-db y toma de ahí su DATABASE_URL', () => {
    expect(DEMO).toContain('name: compras-demo-db');
    expect(DEMO).toContain('databaseName: compras_demo');
    expect(DEMO).toMatch(/fromDatabase:\s*\n\s*name: compras-demo-db/);
  });

  it('el nombre de su base pasa la guarda del sembrador', () => {
    /*
     * El sembrado borra tablas antes de escribir, y sólo corre si el nombre de
     * la base contiene «e2e», «test» o «demo». Se comprueba con la MISMA
     * función que usa el sembrador, no con una copia de la expresión.
     */
    expect(esUnaBaseDePruebas('postgresql://u:p@host:5432/compras_demo')).toBe(true);
    expect(esUnaBaseDePruebas('postgresql://u:p@host:5432/compras_don_gines')).toBe(false);
  });

  it('no nombra ningún recurso de producción', () => {
    /*
     * Producción es el otro archivo, y su servicio se llama
     * `compras-don-gines`. Si ese nombre apareciera acá, el Blueprint de la
     * demo pasaría a administrar producción.
     */
    expect(PRODUCCION).toContain('name: compras-don-gines');
    expect(DEMO).not.toContain('name: compras-don-gines');
    expect(DEMO).toContain('name: compras-vista-previa-demo');
  });

  it('no crea entornos de vista previa por rama', () => {
    expect(DEMO).toMatch(/generation:\s*"off"/);
  });
});

describe('la demo no habla con ningún servicio real', () => {
  for (const variable of [
    'STOCK_INTEGRATION_WRITE_URL',
    'STOCK_INTEGRATION_KEY',
    'STOCK_CATALOG_URL',
    'SUPABASE_URL',
    'SUPABASE_SECRET_KEY',
    'SUPABASE_PUBLISHABLE_KEY',
    'SUPABASE_BUCKET',
  ]) {
    it(`no menciona ${variable}`, () => {
      expect(DEMO).not.toContain(variable);
    });
  }

  it('el almacenamiento es local y la autenticación también', () => {
    expect(DEMO).toMatch(/key: STORAGE_DRIVER\s*\n\s*value: local/);
    expect(DEMO).toMatch(/key: AUTH_PROVIDER\s*\n\s*value: local/);
    expect(DEMO).not.toContain('value: supabase');
  });

  it('el secreto de firma lo genera Render y no está escrito acá', () => {
    expect(DEMO).toMatch(/key: STORAGE_SIGNING_SECRET\s*\n\s*generateValue: true/);
  });
});

describe('producción, por su lado, tampoco tiene la escritura configurada', () => {
  it('render.yaml no declara STOCK_INTEGRATION_WRITE_URL', () => {
    /*
     * La integración de escritura quedó retirada en el código, así que la
     * variable no cambia nada. Igual se comprueba que no esté declarada: una
     * variable declarada invita a cargarla, y cargarla invitaría a alguien a
     * preguntarse por qué no anda.
     */
    expect(PRODUCCION).not.toContain('STOCK_INTEGRATION_WRITE_URL');
  });
});
