import { describe, it, expect } from 'vitest';
import { toUserMessage, ValidationError, ForbiddenError } from '@/lib/errors';

const GENERICO =
  'Ocurrió un error inesperado. Volvé a intentar; si sigue pasando, avisale al administrador.';

describe('mensajes de error para el usuario', () => {
  it('muestra tal cual lo que la aplicación escribió a propósito', () => {
    expect(toUserMessage(new ValidationError('Falta elegir el proveedor.'))).toBe(
      'Falta elegir el proveedor.',
    );
    expect(toUserMessage(new ForbiddenError())).toContain('permiso');
  });

  it('traduce los errores que sí o sí van a aparecer', () => {
    // El clásico de Safari en iPhone.
    expect(toUserMessage(new Error('The string did not match the expected pattern.'))).toContain(
      'sacar la foto de nuevo',
    );
    expect(toUserMessage(new Error('Failed to fetch'))).toContain('conexión');
    expect(toUserMessage(new Error('Unique constraint failed on the fields'))).toContain(
      'Ya existe un registro',
    );
  });

  it('no deja pasar un error técnico aunque traiga texto en castellano adentro', () => {
    // Este es el caso que se escapó: el volcado de una consulta de Prisma trae
    // embebidos los mensajes de control de la aplicación, con sus acentos, y
    // eso alcanzaba para que el detector de "esto parece inglés" lo dejara
    // pasar entero a la pantalla.
    const prisma = new Error(
      'Invalid `prisma.document.update()` invocation: { data: { checkReport: ' +
        '{ message: "Se leyeron los 9 renglones impresos.", label: "Aritmética de los renglones" } } } ' +
        'Invalid value for argument `grossSubtotal`: invalid digit found in string. Expected decimal String.',
    );
    const mensaje = toUserMessage(prisma);
    expect(mensaje).toBe(GENERICO);
    expect(mensaje).not.toContain('prisma');
    expect(mensaje).not.toContain('Invalid');
  });

  it('no muestra el detalle de un error interno cualquiera', () => {
    expect(toUserMessage(new Error('ENOENT: no such file or directory'))).toBe(GENERICO);
    expect(toUserMessage(new TypeError("Cannot read properties of undefined"))).toBe(GENERICO);
    expect(toUserMessage('algo raro')).toBe(GENERICO);
    expect(toUserMessage(undefined)).toBe(GENERICO);
  });

  it('no menciona claves de API ni servicios de lectura pagos', () => {
    const mensajes = [
      toUserMessage(new Error('401 invalid api key')),
      toUserMessage(new Error('rate limit exceeded')),
      toUserMessage(new Error('authentication_error')),
    ];
    for (const mensaje of mensajes) {
      expect(mensaje.toLowerCase()).not.toMatch(/api|clave|credencial|servicio de lectura/);
    }
  });
});
