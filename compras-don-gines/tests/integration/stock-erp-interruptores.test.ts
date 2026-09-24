import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { prisma } from '@/lib/db';
import { limpiarBase, sembrarEscenario, comoUsuario, type Escenario } from './ayudas';
import { cambiarInterruptor, interruptorDeAperturasReales } from '@/lib/services/stock-erp-apertura';
import {
  cambiarInterruptorDeRecepciones,
  interruptorDeRecepcionesReales,
} from '@/lib/services/stock-erp-recepcion';
import { AUDIT_ACTIONS } from '@/lib/services/audit';
import { PERMISSIONS } from '@/lib/auth/permissions';
import {
  esUnaBaseDePruebas,
  esUnaBaseDescartable,
  exigirBaseDescartable,
} from '@/lib/base-de-pruebas';

/**
 * **Los dos interruptores de Stock ERP, y por qué siguen apagados.**
 *
 * Son las dos decisiones que separan un módulo en preparación de un inventario
 * que alguien podría creerse: uno gobierna si una apertura con datos reales se
 * asienta, el otro si una compra real ingresa mercadería al libro. Mientras las
 * ventas no descuenten, los dos tienen que estar apagados, y «apagados» no es
 * una intención: es una propiedad que hay que poder comprobar.
 *
 * Este archivo existe porque la comprobación anterior era MÁS DÉBIL DE LO QUE
 * PARECÍA. Decía «el seed no lo enciende» y lo verificaba leyendo el texto del
 * seed y buscando la palabra `realOpeningEnabled`. Eso no prueba nada sobre lo
 * que el seed HACE: un seed que encendiera el interruptor por SQL crudo, desde
 * un módulo importado o con un nombre de columna armado por concatenación
 * habría pasado esa prueba sin despeinarse. Y del segundo interruptor —el de
 * recepciones, que llegó en la fase 4— esa prueba no decía absolutamente nada.
 *
 * Acá el seed productivo se CORRE, de verdad, contra la base de pruebas, y
 * después se mira el estado. Es la única forma de que la afirmación signifique
 * lo que dice.
 */

const RAIZ = path.resolve(__dirname, '../..');

let escenario: Escenario;
let jefeDeModulo: ReturnType<typeof comoUsuario>;
let sinPermiso: ReturnType<typeof comoUsuario>;

function con(permisos: string[]): ReturnType<typeof comoUsuario> {
  return comoUsuario({
    id: escenario.admin.id,
    email: escenario.admin.email,
    name: escenario.admin.name,
    branchId: null,
    roleId: escenario.admin.roleId,
    roleCode: escenario.admin.roleCode,
    roleName: escenario.admin.roleName,
    permissions: [...escenario.admin.permissions, ...permisos],
    scopeAllBranches: true,
  });
}

beforeEach(async () => {
  await limpiarBase();
  escenario = await sembrarEscenario();
  jefeDeModulo = con([PERMISSIONS.STOCKERP_MODULO_CONFIGURAR]);
  sinPermiso = con([]);
});

afterEach(() => vi.restoreAllMocks());

/** El estado crudo de la fila, leído de la base y no de un servicio. */
async function estadoCrudo() {
  const filas = await prisma.$queryRaw<
    { realOpeningEnabled: boolean; realPurchaseReceiptsEnabled: boolean }[]
  >`SELECT "realOpeningEnabled", "realPurchaseReceiptsEnabled" FROM "stock_module_setting"`;
  return filas;
}

/* ========================================================================== *
 * 1. Nacen apagados
 * ========================================================================== */

describe('los dos interruptores nacen apagados', () => {
  it('la fila que crea la migración tiene los dos en false', async () => {
    const filas = await estadoCrudo();
    expect(filas, 'hay exactamente una fila de configuración').toHaveLength(1);
    expect(filas[0].realOpeningEnabled, 'aperturas reales').toBe(false);
    expect(filas[0].realPurchaseReceiptsEnabled, 'recepciones reales').toBe(false);
  });

  it('y los servicios leen lo mismo, sin autor ni motivo', async () => {
    const aperturas = await interruptorDeAperturasReales();
    const recepciones = await interruptorDeRecepcionesReales();
    expect(aperturas.encendido).toBe(false);
    expect(aperturas.cambiadoPor).toBeNull();
    expect(recepciones.encendido).toBe(false);
    expect(recepciones.cambiadoPor).toBeNull();
    expect(recepciones.motivo).toBeNull();
  });

  it('la columna declara false por omisión, así que una fila nueva nace apagada', async () => {
    const columnas = await prisma.$queryRaw<{ column_name: string; column_default: string }[]>`
      SELECT column_name, column_default FROM information_schema.columns
       WHERE table_name = 'stock_module_setting'
         AND column_name IN ('realOpeningEnabled', 'realPurchaseReceiptsEnabled')
       ORDER BY column_name`;
    expect(columnas).toHaveLength(2);
    for (const c of columnas) {
      expect(c.column_default, `${c.column_name} por omisión`).toMatch(/false/);
    }
  });
});

/* ========================================================================== *
 * 2. El seed productivo, CORRIDO de verdad
 * ========================================================================== */

describe('ningún seed productivo puede encenderlos', () => {
  /**
   * Corre `prisma/seed.ts` de verdad, contra la base de pruebas.
   *
   * No se lee su texto: se lo ejecuta y después se mira el estado. Un seed que
   * encendiera el interruptor por SQL crudo, desde un módulo importado o con el
   * nombre de la columna armado por concatenación pasaría cualquier prueba
   * textual y fallaría ésta, que es la que importa.
   */
  function correrElSeedProductivo(extra: Record<string, string> = {}) {
    /*
     * **La guarda, antes de tocar nada.**
     *
     * Esta función corre el sembrado PRODUCTIVO, que borra y reescribe tablas.
     * Si `DATABASE_URL` estuviera mal —un `.env` heredado, una variable de CI
     * copiada de otro servicio, una terminal donde quedó exportada la de la
     * demo— esto la sembraría sin preguntar.
     *
     * `exigirBaseDescartable` mira el NOMBRE de la base y exige «test» o «e2e».
     * La demo NO alcanza, aunque `esUnaBaseDePruebas` la acepte para otras
     * cosas: la demo está desplegada y hay gente mirándola.
     *
     * Va acá adentro y no sólo en el `setup` global porque ESTA función es la
     * que destruye. Una guarda lejos de lo que protege es una guarda que
     * alguien mueve sin darse cuenta.
     */
    exigirBaseDescartable(process.env.DATABASE_URL);

    execFileSync('npx', ['tsx', 'prisma/seed.ts'], {
      cwd: RAIZ,
      stdio: 'pipe',
      env: {
        ...process.env,
        SEED_ADMIN_PASSWORD: 'PruebasDonGines1',
        SEED_OPERATOR_PASSWORD: 'PruebasDonGines1',
        ...extra,
      },
    });
  }

  it('el sembrado se NIEGA a correr si DATABASE_URL apunta a la demo', () => {
    /*
     * HALLAZGO de una rotura deliberada. La primera versión sólo llamaba a la
     * guarda; quitarla no ponía NADA en rojo, porque contra la base de pruebas
     * la guarda no hace nada de todos modos. Una protección que sólo se ejerce
     * en el caso bueno no está protegida por ninguna prueba.
     *
     * Acá se apunta a propósito a la demo y se comprueba que la función se
     * plante ANTES de ejecutar el seed. Es el caso que importa: la demo es un
     * entorno desplegado, y es al que se llega por una variable mal copiada.
     */
    const original = process.env.DATABASE_URL;
    process.env.DATABASE_URL = 'postgresql://u:p@host:5432/compras_demo';
    try {
      expect(() => correrElSeedProductivo()).toThrow(/DESCARTABLE/);
    } finally {
      process.env.DATABASE_URL = original;
    }
  });

  it('y tampoco si apunta a producción con un usuario llamado «tester»', () => {
    const original = process.env.DATABASE_URL;
    process.env.DATABASE_URL = 'postgresql://tester:p@host:5432/compras_produccion';
    try {
      expect(() => correrElSeedProductivo()).toThrow(/DESCARTABLE/);
    } finally {
      process.env.DATABASE_URL = original;
    }
  });

  it('la guarda se niega contra cualquier base que no sea descartable', () => {
    const prohibidas = [
      ['producción', 'postgresql://u:p@host:5432/compras_produccion?schema=public'],
      ['demo, que está desplegada', 'postgresql://u:p@host:5432/compras_demo'],
      ['usuario que dice test', 'postgresql://tester:p@host:5432/compras_produccion'],
      ['host que dice test', 'postgresql://u:p@test.example.com:5432/compras_produccion'],
      ['contraseña que dice test', 'postgresql://u:testing@host:5432/compras_produccion'],
      ['sin base', 'postgresql://u:p@host:5432/'],
      ['vacía', ''],
    ] as const;

    for (const [porque, url] of prohibidas) {
      expect(() => exigirBaseDescartable(url), porque).toThrow(/DESCARTABLE/);
      expect(esUnaBaseDescartable(url), porque).toBe(false);
    }

    /* Y sí acepta las dos que de verdad se pueden tirar. */
    expect(esUnaBaseDescartable('postgresql://u:p@host:5432/compras_don_gines_test')).toBe(true);
    expect(esUnaBaseDescartable('postgresql://u:p@host:5432/compras_e2e')).toBe(true);
  });

  it('sin DATABASE_URL definida, la guarda también se niega', () => {
    /*
     * Hay que SACAR la variable para probar esto. Pasarle `undefined` a mano no
     * sirve: el parámetro tiene `= process.env.DATABASE_URL` por omisión, así
     * que un `undefined` explícito cae en la base de pruebas y la guarda pasa
     * —con razón—. Escribí esa versión primero y quedó en rojo diciendo
     * exactamente eso.
     */
    const original = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    try {
      expect(() => exigirBaseDescartable()).toThrow(/DATABASE_URL no está definida/);
    } finally {
      process.env.DATABASE_URL = original;
    }
  });

  it('la demo es «de pruebas» pero NO es descartable: son dos preguntas distintas', () => {
    const demo = 'postgresql://u:p@host:5432/compras_demo';
    expect(esUnaBaseDePruebas(demo), 'admite homologación').toBe(true);
    expect(esUnaBaseDescartable(demo), 'no se siembra ni se borra').toBe(false);
  });

  it('la base contra la que corren estas pruebas es descartable', () => {
    expect(esUnaBaseDescartable(process.env.DATABASE_URL)).toBe(true);
  });

  it('el setup de integración usa la guarda por nombre, no un grep de la URL', () => {
    /*
     * HALLAZGO. `setup.ts` decía comprobar «una base cuyo nombre contenga test»
     * y corría `/test/i` sobre la URL entera, así que una URL de producción con
     * un usuario `tester` pasaba. Esta afirmación impide que vuelva.
     */
    const setup = readFileSync(path.join(RAIZ, 'tests/integration/setup.ts'), 'utf8');
    expect(setup).toContain('exigirBaseDescartable');
    expect(setup, 'nada de grepear la URL entera').not.toMatch(
      /\/test\/i\.test\(process\.env\.DATABASE_URL\)/,
    );
  });

  it('correr el seed productivo deja los dos apagados', async () => {
    correrElSeedProductivo();
    const filas = await estadoCrudo();
    expect(filas).toHaveLength(1);
    expect(filas[0].realOpeningEnabled, 'aperturas reales').toBe(false);
    expect(filas[0].realPurchaseReceiptsEnabled, 'recepciones reales').toBe(false);
  });

  it('correrlo dos veces tampoco los enciende', async () => {
    correrElSeedProductivo();
    correrElSeedProductivo();
    const filas = await estadoCrudo();
    expect(filas[0].realOpeningEnabled).toBe(false);
    expect(filas[0].realPurchaseReceiptsEnabled).toBe(false);
  });

  it('ni con variables de entorno que parezcan pedirlo', async () => {
    /*
     * Las variables no existen, y ése es justamente el punto: si alguna vez
     * alguien agregara una, esta prueba se pondría en rojo el día que la
     * agregue, no el día que alguien la copie sin querer a producción.
     */
    correrElSeedProductivo({
      STOCKERP_REAL_OPENINGS: '1',
      STOCKERP_REAL_RECEIPTS: '1',
      REAL_OPENING_ENABLED: 'true',
      REAL_PURCHASE_RECEIPTS_ENABLED: 'true',
      STOCK_ERP_HABILITAR: 'si',
    });
    const filas = await estadoCrudo();
    expect(filas[0].realOpeningEnabled).toBe(false);
    expect(filas[0].realPurchaseReceiptsEnabled).toBe(false);
  });

  it('y el sembrado de pruebas tampoco', async () => {
    await sembrarEscenario().catch(() => null);
    const filas = await estadoCrudo();
    expect(filas[0].realOpeningEnabled).toBe(false);
    expect(filas[0].realPurchaseReceiptsEnabled).toBe(false);
  });
});

/* ========================================================================== *
 * 3. Ninguna variable de entorno, en ningún archivo
 * ========================================================================== */

describe('ninguna variable de entorno los enciende', () => {
  /** Todos los `.ts`/`.tsx` de un directorio, recursivamente. */
  function fuentes(dir: string): string[] {
    const salida: string[] = [];
    for (const nombre of readdirSync(dir)) {
      const completo = path.join(dir, nombre);
      if (statSync(completo).isDirectory()) salida.push(...fuentes(completo));
      else if (/\.tsx?$/.test(nombre)) salida.push(completo);
    }
    return salida;
  }

  it('ningún archivo decide el estado de un interruptor mirando process.env', () => {
    /*
     * Se revisa TODO `src/`, no un archivo elegido a mano. La prueba anterior
     * miraba un solo servicio, y con eso el día que alguien agregara la lectura
     * en otro lado —una acción, una página, un ayudante— no se iba a enterar
     * nadie.
     *
     * La regla es concreta: en ninguna línea que nombre un interruptor puede
     * aparecer `process.env`, y en ninguna línea que lea `process.env` puede
     * aparecer el nombre de un interruptor.
     */
    const culpables: string[] = [];
    for (const archivo of fuentes(path.join(RAIZ, 'src'))) {
      const lineas = readFileSync(archivo, 'utf8').split('\n');
      lineas.forEach((linea, i) => {
        const nombraInterruptor = /realOpeningEnabled|realPurchaseReceiptsEnabled/.test(linea);
        if (nombraInterruptor && /process\.env/.test(linea)) {
          culpables.push(`${path.relative(RAIZ, archivo)}:${i + 1}: ${linea.trim()}`);
        }
      });
    }
    expect(culpables, 'un interruptor decidido por el entorno').toEqual([]);
  });

  it('el único uso de process.env en los servicios de Stock ERP es el nombre de la base', () => {
    /*
     * `DATABASE_URL` se consulta para saber si la base admite homologación, que
     * es una decisión sobre DÓNDE corre esto y no sobre si el módulo está
     * habilitado. Cualquier otra variable en estos archivos es un hallazgo.
     */
    const servicios = [
      'src/lib/services/stock-erp-apertura.ts',
      'src/lib/services/stock-erp-unidades.ts',
      'src/lib/services/stock-erp-recepcion.ts',
    ];
    for (const relativo of servicios) {
      const fuente = readFileSync(path.join(RAIZ, relativo), 'utf8');
      const usadas = [...fuente.matchAll(/process\.env\.([A-Z0-9_]+)/g)].map((m) => m[1]);
      const distintas = [...new Set(usadas)].sort();
      expect(distintas, relativo).toEqual(
        distintas.length === 0 ? [] : ['DATABASE_URL'],
      );
    }
  });
});

/* ========================================================================== *
 * 4. La base se niega sin autor, fecha y motivo
 * ========================================================================== */

describe('la base no deja encenderlos sin decir quién y por qué', () => {
  it('rechaza encender las aperturas reales por SQL suelto', async () => {
    await expect(
      prisma.$executeRawUnsafe(`UPDATE "stock_module_setting" SET "realOpeningEnabled" = true`),
    ).rejects.toThrow(/encendido_con_motivo/);
    expect((await estadoCrudo())[0].realOpeningEnabled).toBe(false);
  });

  it('rechaza encender las recepciones reales por SQL suelto', async () => {
    await expect(
      prisma.$executeRawUnsafe(
        `UPDATE "stock_module_setting" SET "realPurchaseReceiptsEnabled" = true`,
      ),
    ).rejects.toThrow(/recepciones_con_motivo/);
    expect((await estadoCrudo())[0].realPurchaseReceiptsEnabled).toBe(false);
  });

  it('rechaza encenderlas con autor pero sin motivo', async () => {
    await expect(
      prisma.$executeRawUnsafe(
        `UPDATE "stock_module_setting"
            SET "realPurchaseReceiptsEnabled" = true,
                "receiptsChangedById" = $1,
                "receiptsChangedAt" = now()`,
        escenario.admin.id,
      ),
    ).rejects.toThrow(/recepciones_con_motivo/);
  });

  it('no se puede crear una segunda fila de configuración para esquivar la primera', async () => {
    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO "stock_module_setting" ("id","unica","realOpeningEnabled","createdAt","updatedAt")
         VALUES ('otra', true, false, now(), now())`,
      ),
    ).rejects.toThrow();
    expect(await estadoCrudo()).toHaveLength(1);
  });
});

/* ========================================================================== *
 * 5. Encenderlos exige permiso sensible y queda auditado
 * ========================================================================== */

describe('encenderlos exige permiso y deja constancia', () => {
  it('sin el permiso sensible, las aperturas reales no se encienden', async () => {
    await expect(
      cambiarInterruptor(sinPermiso, { encender: true, motivo: 'porque sí' }),
    ).rejects.toThrow(/stockerp\.modulo\.configurar/);
    expect((await estadoCrudo())[0].realOpeningEnabled).toBe(false);
  });

  it('sin el permiso sensible, las recepciones reales tampoco', async () => {
    await expect(
      cambiarInterruptorDeRecepciones(sinPermiso, { encender: true, motivo: 'porque sí' }),
    ).rejects.toThrow(/stockerp\.modulo\.configurar/);
    expect((await estadoCrudo())[0].realPurchaseReceiptsEnabled).toBe(false);
  });

  it('el intento rechazado queda auditado, con quién y qué le faltaba', async () => {
    await cambiarInterruptorDeRecepciones(sinPermiso, { encender: true, motivo: 'x' }).catch(
      () => null,
    );
    const rechazo = await prisma.auditLog.findFirst({
      where: { action: AUDIT_ACTIONS.STOCKERP_INTENTO_RECHAZADO },
      orderBy: { createdAt: 'desc' },
    });
    expect(rechazo).not.toBeNull();
    expect((rechazo!.after as Record<string, unknown>).permisoQueFaltaba).toBe(
      PERMISSIONS.STOCKERP_MODULO_CONFIGURAR,
    );
  });

  it('con permiso pero sin motivo, tampoco', async () => {
    await expect(
      cambiarInterruptor(jefeDeModulo, { encender: true, motivo: '   ' }),
    ).rejects.toThrow(/por qué/i);
    await expect(
      cambiarInterruptorDeRecepciones(jefeDeModulo, { encender: true, motivo: '' }),
    ).rejects.toThrow(/por qué/i);
    const filas = await estadoCrudo();
    expect(filas[0].realOpeningEnabled).toBe(false);
    expect(filas[0].realPurchaseReceiptsEnabled).toBe(false);
  });

  it('son DOS decisiones: encender una no enciende la otra', async () => {
    await cambiarInterruptor(jefeDeModulo, {
      encender: true,
      motivo: 'Prueba: se inauguran sucursales con datos reales.',
    });
    const filas = await estadoCrudo();
    expect(filas[0].realOpeningEnabled, 'la que se encendió').toBe(true);
    expect(filas[0].realPurchaseReceiptsEnabled, 'la otra sigue apagada').toBe(false);

    /* Se lo devuelve a apagado: ninguna base queda encendida por una prueba. */
    await cambiarInterruptor(jefeDeModulo, { encender: false, motivo: 'Fin de la prueba.' });
    expect((await estadoCrudo())[0].realOpeningEnabled).toBe(false);
  });

  it('encenderlo y apagarlo queda auditado con el valor anterior leído de la base', async () => {
    await cambiarInterruptorDeRecepciones(jefeDeModulo, {
      encender: true,
      motivo: 'Homologación del módulo, con el jefe de compras presente.',
    });
    const asiento = await prisma.auditLog.findFirstOrThrow({
      where: { action: AUDIT_ACTIONS.STOCKERP_RECEPCIONES_INTERRUPTOR },
      orderBy: { createdAt: 'desc' },
    });
    expect(asiento.userId).toBe(jefeDeModulo.id);
    expect((asiento.before as Record<string, unknown>).realPurchaseReceiptsEnabled).toBe(false);
    expect((asiento.after as Record<string, unknown>).realPurchaseReceiptsEnabled).toBe(true);
    expect((asiento.after as Record<string, unknown>).motivo).toMatch(/Homologación/);

    await cambiarInterruptorDeRecepciones(jefeDeModulo, {
      encender: false,
      motivo: 'Fin de la homologación.',
    });
    expect((await estadoCrudo())[0].realPurchaseReceiptsEnabled).toBe(false);
  });
});

/* ========================================================================== *
 * 6. El navegador no decide
 * ========================================================================== */

describe('la decisión es del servidor, no de la pantalla', () => {
  it('el permiso se comprueba en el servicio, que es lo que corre venga de donde venga', async () => {
    /*
     * No hay pantalla en el medio: se llama al servicio directamente, que es
     * exactamente lo que haría quien arme el pedido mirando la red. Esconder el
     * control es comodidad; esto es la defensa.
     */
    await expect(
      cambiarInterruptorDeRecepciones(sinPermiso, {
        encender: true,
        motivo: 'Mando el pedido sin pasar por la pantalla.',
      }),
    ).rejects.toThrow(/stockerp\.modulo\.configurar/);
  });

  it('y aunque el servicio se saltee, la base sigue negándose', async () => {
    /* Las dos defensas son independientes, y por eso se prueban por separado. */
    await expect(
      prisma.stockModuleSetting.updateMany({ data: { realPurchaseReceiptsEnabled: true } }),
    ).rejects.toThrow();
    expect((await estadoCrudo())[0].realPurchaseReceiptsEnabled).toBe(false);
  });

  it('al terminar este archivo, los dos interruptores siguen apagados', async () => {
    const filas = await estadoCrudo();
    expect(filas[0].realOpeningEnabled).toBe(false);
    expect(filas[0].realPurchaseReceiptsEnabled).toBe(false);
  });
});
