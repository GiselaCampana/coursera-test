import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

/**
 * **La cadena de migraciones, auditada como propiedad y no como informe.**
 *
 * La fase 8 auditó a mano qué hace cada migración desde la producción actual
 * hasta acá, y la conclusión importante fue una: la cadena es **aditiva**, así
 * que si las migraciones se aplican y después el build nuevo falla, el código
 * productivo sigue funcionando.
 *
 * Una conclusión así escrita sólo en un informe se pudre con el primer commit.
 * Acá está como afirmación, y una rotura deliberada la comprobó: una migración
 * nueva que hacía `UPDATE "documents"` no ponía NADA en rojo antes de que este
 * archivo existiera.
 *
 * Las tablas de Compras se nombran de a una. Podría usarse «todo lo que no
 * empiece con stock_», pero entonces agregar una tabla nueva al módulo la
 * dejaría sin cubrir por el solo hecho de llamarse distinto.
 */

const RAIZ = path.resolve(__dirname, '../..');
const MIGRACIONES = path.join(RAIZ, 'prisma/migrations');

/** Las tablas de Compras: las que existían antes de que Stock ERP empezara. */
const TABLAS_DE_COMPRAS = [
  'documents',
  'document_items',
  'document_files',
  'document_tax_lines',
  'suppliers',
  'supplier_aliases',
  'supplier_payment_terms',
  'supplier_tax_rules',
  'supplier_expense_codes',
  'products',
  'product_aliases',
  'product_families',
  'payment_schedules',
  'payment_events',
  'cost_history',
  'sale_price_history',
  'pricing_rules',
  'users',
  'roles',
  'branches',
  'sessions',
  'audit_logs',
  'ocr_attempts',
  'stock_outbox',
];

/**
 * La primera migración de Stock ERP. Todo lo anterior es historia de Compras y
 * SÍ hizo correcciones de datos —el IVA de Errecalde, entre otras—, con razón y
 * en su momento. Lo que esta fase exige es de acá en adelante.
 */
const PRIMERA_DE_STOCK_ERP = '20260921120000_stock_erp_fase_1';

const ESPERADAS_DE_STOCK_ERP = [
  '20260921120000_stock_erp_fase_1',
  '20260923100000_stock_erp_fase_2_unidades',
  '20260923150000_stock_erp_fase_3_estados',
  '20260923160000_stock_erp_fase_3_apertura',
  '20260924090000_stock_erp_corte_con_zona',
  '20260924100000_stock_erp_fase_4_recepcion',
  '20260926100000_stock_erp_fase_6_estados',
  '20260926100500_stock_erp_fase_6_traslados',
  '20260927100000_stock_erp_fase_7_correcciones',
];

function migraciones(): string[] {
  return readdirSync(MIGRACIONES)
    .filter((d) => statSync(path.join(MIGRACIONES, d)).isDirectory())
    .sort();
}

function deStockErpEnAdelante(): string[] {
  return migraciones().filter((m) => m >= PRIMERA_DE_STOCK_ERP);
}

function sql(m: string): string {
  return readFileSync(path.join(MIGRACIONES, m, 'migration.sql'), 'utf8');
}

/** Las sentencias, sin comentarios: una regla que cuenta comentarios no sirve. */
function sentencias(texto: string): string[] {
  return texto
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '' && !l.startsWith('--'));
}

describe('la cadena de migraciones de Stock ERP es aditiva', () => {
  it('el conjunto de migraciones del módulo es exactamente el esperado', () => {
    /*
     * Si aparece una migración nueva del módulo, esta lista tiene que crecer a
     * mano. Es deliberado: agregar una migración a esta cadena es una decisión
     * que merece que alguien la escriba dos veces.
     */
    expect(deStockErpEnAdelante()).toEqual(ESPERADAS_DE_STOCK_ERP);
  });

  it('ninguna toca los datos de Compras', () => {
    const patron = new RegExp(
      `^(INSERT\\s+INTO|UPDATE|DELETE\\s+FROM|TRUNCATE(\\s+TABLE)?)\\s+"?(${TABLAS_DE_COMPRAS.join('|')})"?\\b`,
      'i',
    );
    for (const m of deStockErpEnAdelante()) {
      for (const linea of sentencias(sql(m))) {
        expect(patron.test(linea), `${m} escribe datos de Compras: ${linea}`).toBe(false);
      }
    }
  });

  it('ninguna borra, renombra ni vuelve obligatoria una columna', () => {
    /*
     * Éstas son las tres formas de romper el código que ya está corriendo:
     * quitarle una columna, cambiarle el nombre o exigirle un valor que no
     * manda. `DROP NOT NULL` sí está permitido —afloja, no aprieta— y la fase 6
     * lo usó para que un traslado pudiera ser borrador.
     */
    for (const m of deStockErpEnAdelante()) {
      for (const linea of sentencias(sql(m))) {
        expect(/DROP\s+COLUMN/i.test(linea), `${m} borra una columna: ${linea}`).toBe(false);
        expect(/RENAME/i.test(linea), `${m} renombra algo: ${linea}`).toBe(false);
        expect(/SET\s+NOT\s+NULL/i.test(linea), `${m} vuelve obligatoria una columna: ${linea}`).toBe(
          false,
        );
        expect(/DROP\s+TABLE/i.test(linea), `${m} borra una tabla: ${linea}`).toBe(false);
      }
    }
  });

  it('lo único que agrega a una tabla de Compras es opcional', () => {
    /*
     * La cadena agrega UNA columna a una tabla de Compras: `products.catalogUnit`.
     * Tiene que ser opcional: una columna obligatoria sin valor por omisión hace
     * fallar cualquier inserción del código viejo.
     */
    const agregadas: string[] = [];
    for (const m of deStockErpEnAdelante()) {
      const texto = sql(m);
      const re = new RegExp(
        `ALTER TABLE "(${TABLAS_DE_COMPRAS.join('|')})"\\s+ADD COLUMN "([^"]+)"([^;]*);`,
        'gi',
      );
      for (const coincidencia of texto.matchAll(re)) {
        const [, tabla, columna, resto] = coincidencia;
        agregadas.push(`${tabla}.${columna}`);
        const obligatoriaSinDefecto =
          /NOT\s+NULL/i.test(resto ?? '') && !/DEFAULT/i.test(resto ?? '');
        expect(
          obligatoriaSinDefecto,
          `${m} agrega ${tabla}.${columna} obligatoria y sin valor por omisión`,
        ).toBe(false);
      }
    }
    expect(agregadas, 'la única columna que la cadena le agrega a Compras').toEqual([
      'products.catalogUnit',
    ]);
  });

  it('ningún disparador de la cadena vigila una tabla de Compras', () => {
    /*
     * **Ésta es la afirmación que sostiene la compatibilidad hacia atrás.** Un
     * disparador sobre `documents` podría rechazar un alta que el código
     * productivo hace hoy, y entonces aplicar las migraciones sin desplegar el
     * código nuevo dejaría Compras roto.
     */
    for (const m of deStockErpEnAdelante()) {
      const texto = sql(m);
      for (const coincidencia of texto.matchAll(
        /CREATE\s+TRIGGER\s+"?[a-z_]+"?[\s\S]{0,120}?\bON\s+"([a-z_]+)"/gi,
      )) {
        const tabla = coincidencia[1]!;
        expect(
          TABLAS_DE_COMPRAS.includes(tabla),
          `${m} pone un disparador sobre la tabla de Compras «${tabla}»`,
        ).toBe(false);
      }
    }
  });

  it('ninguna enciende un interruptor real', () => {
    const columnas = [
      'realOpeningEnabled',
      'realPurchaseReceiptsEnabled',
      'realTransfersEnabled',
      'realCorrectionsEnabled',
    ];
    for (const m of migraciones()) {
      for (const linea of sentencias(sql(m))) {
        for (const c of columnas) {
          if (!linea.includes(c)) continue;
          expect(
            /=\s*true|SET\s+DEFAULT\s+true/i.test(linea),
            `${m} enciende ${c}: ${linea}`,
          ).toBe(false);
        }
      }
    }
  });

  it('ninguna crea aperturas, movimientos, saldos ni salidas', () => {
    /*
     * Las tablas del módulo tampoco se siembran desde una migración: un saldo
     * que aparece sin que nadie lo haya contado es un inventario inventado, y
     * `stock_outbox` con una fila sería un mensaje a Control de Stock que nadie
     * pidió.
     */
    const prohibidas = [
      'stock_ledger',
      'stock_balance',
      'stock_operation',
      'stock_count_session',
      'stock_count_line',
      'stock_waste',
      'stock_transfer',
      'stock_transfer_line',
      'product_stock_activation',
      'stock_outbox',
    ];
    const patron = new RegExp(
      `^(INSERT\\s+INTO|UPDATE)\\s+"?(${prohibidas.join('|')})"?\\b`,
      'i',
    );
    for (const m of deStockErpEnAdelante()) {
      for (const linea of sentencias(sql(m))) {
        expect(patron.test(linea), `${m} escribe en ${linea.slice(0, 60)}…`).toBe(false);
      }
    }
  });
});
