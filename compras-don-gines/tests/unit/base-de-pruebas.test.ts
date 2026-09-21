import { describe, it, expect } from 'vitest';
import {
  esUnaBaseDePruebas,
  exigirBaseDePruebas,
  nombreDeLaBase,
} from '@/lib/base-de-pruebas';

/**
 * **La guarda que decide si algo puede borrar tablas.**
 *
 * El sembrado empieza con un TRUNCATE y la vista previa hospedada lo corre en
 * cada arranque, así que la pregunta «¿esta base es de pruebas?» la contesta
 * una función, no una persona mirando la consola. Lo que se prueba acá es que
 * la contesta bien en los casos donde equivocarse cuesta caro.
 */

describe('qué se acepta como base de pruebas', () => {
  it('acepta los nombres que las pruebas y la demostración usan de verdad', () => {
    for (const nombre of [
      'compras_don_gines_e2e',
      'compras_don_gines_test',
      'compras_demo',
      'compras_e2e',
      'test_compras',
      'e2e',
    ]) {
      expect(esUnaBaseDePruebas(`postgresql://u:p@localhost:5432/${nombre}`), nombre).toBe(true);
    }
  });

  it('rechaza una base de producción aunque la URL tenga la palabra alrededor', () => {
    /*
     * El caso que hace falta que falle. Una URL de Supabase lleva el proyecto
     * en el host y el usuario, y ahí puede aparecer cualquier cosa; lo único
     * que dice contra qué base se escribe es el nombre después de la barra.
     */
    const produccion = [
      'postgresql://postgres:clave@db.proyecto.supabase.co:5432/postgres',
      'postgresql://test_user:p@localhost:5432/compras_don_gines',
      'postgresql://u:p@demo-host.example.com:5432/produccion',
      'postgresql://u:p@localhost:5432/compras?schema=test',
      'postgresql://u:p@localhost:5432/contest',
      'postgresql://u:p@localhost:5432/atestado',
    ];
    for (const url of produccion) {
      expect(esUnaBaseDePruebas(url), url).toBe(false);
    }
  });

  it('rechaza lo que no es una URL, y la ausencia de variable', () => {
    expect(esUnaBaseDePruebas(undefined)).toBe(false);
    expect(esUnaBaseDePruebas('')).toBe(false);
    expect(esUnaBaseDePruebas('esto no es una url')).toBe(false);
    expect(nombreDeLaBase('postgresql://u:p@localhost:5432/')).toBeNull();
  });

  it('cortar la ejecución nombra la base que vio, y no la contraseña', () => {
    let mensaje = '';
    try {
      exigirBaseDePruebas('postgresql://postgres:la-contrasena-secreta@host:5432/produccion');
    } catch (error) {
      mensaje = (error as Error).message;
    }

    expect(mensaje).toContain('produccion');
    // Decir cuál base miró ayuda; filtrar la credencial en un log, no.
    expect(mensaje).not.toContain('la-contrasena-secreta');
    expect(mensaje).not.toContain('postgres:');
  });

  it('no corta cuando la base sí es de pruebas', () => {
    expect(() =>
      exigirBaseDePruebas('postgresql://u:p@localhost:5432/compras_demo'),
    ).not.toThrow();
  });
});
