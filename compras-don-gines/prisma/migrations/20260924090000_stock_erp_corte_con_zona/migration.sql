-- Corrección previa a la fase 4: el corte, con zona horaria en los dos lugares.
--
-- `stock_count_session.cutoffAt` ya era TIMESTAMPTZ. `product_stock_activation.cutoffAt`
-- había quedado como TIMESTAMP sin zona: es una columna de la fase 1, anterior a
-- que el corte tuviera dueño. La fase 4 compara la fecha de recepción contra el
-- corte para decidir si una mercadería entra o ya estaba contada, y esa
-- comparación no puede apoyarse en dos representaciones distintas del tiempo.
--
--
-- POR QUÉ LA CONVERSIÓN ES «AT TIME ZONE 'UTC'» Y NO 'America/Argentina/Buenos_Aires'
--
-- La instrucción decía preservar el instante interpretado en hora argentina.
-- Interpretar el valor guardado COMO hora argentina lo correría tres horas y
-- rompería todos los cortes. Lo medí antes de escribir esto, sobre la base de
-- pruebas, y queda acá porque es el tipo de cosa que alguien va a querer
-- revisar:
--
--   instante escrito por Prisma ......... 2026-09-23T23:30:00.000Z
--   valor crudo en la columna sin zona .. 2026-09-23 23:30:00
--   AT TIME ZONE 'UTC' .................. 2026-09-23T23:30:00.000Z   ← igual
--   AT TIME ZONE 'Buenos_Aires' ......... 2026-09-24T02:30:00.000Z   ← +3 h
--
-- Prisma escribe un `DateTime` en una columna sin zona como la hora UTC de ese
-- instante. Así que el texto guardado ES hora UTC, y leerlo como UTC devuelve
-- exactamente el instante original. Eso es lo que preserva el momento, y por lo
-- tanto lo que se lee bien en Buenos Aires: 23:30 UTC siguen siendo las 20:30
-- del 23 de septiembre en el local.
--
-- La otra lectura —tomar «23:30» como hora argentina— inventaría un instante
-- tres horas más tarde. Habría convertido un corte de las 20:30 en uno de las
-- 23:30, y una mercadería recibida a las 22:00 habría pasado de «entra» a «ya
-- estaba contada». Con datos reales eso es un inventario mal armado.
--
-- Hoy no hay datos reales —ninguna apertura confirmada fuera de bases de
-- prueba— así que la conversión es inofensiva en la práctica. Se hace bien
-- igual: la migración va a correr algún día sobre una base que sí los tenga.

ALTER TABLE "product_stock_activation"
  ALTER COLUMN "cutoffAt" TYPE TIMESTAMPTZ(3)
  USING "cutoffAt" AT TIME ZONE 'UTC';

-- ---------------------------------------------------------------------------
-- El interruptor de recepciones reales
--
-- La fase 4 hace ingresar mercadería al libro, pero las VENTAS todavía no la
-- descuentan. Un saldo que sólo sube no es un inventario: es una cuenta que
-- crece sola. Por eso las recepciones con datos reales tienen su propio
-- interruptor, aparte del de las aperturas, y nace apagado.
--
-- Son dos interruptores y no uno a propósito: se puede querer inaugurar
-- sucursales —contar lo que hay— mucho antes de empezar a mover el saldo con
-- compras. Un solo interruptor obligaría a habilitar las dos cosas juntas.
-- ---------------------------------------------------------------------------
ALTER TABLE "stock_module_setting"
  ADD COLUMN "realPurchaseReceiptsEnabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "receiptsChangedById" TEXT,
  ADD COLUMN "receiptsChangedAt" TIMESTAMP(3),
  ADD COLUMN "receiptsReason" TEXT;

ALTER TABLE "stock_module_setting"
  ADD CONSTRAINT "stock_module_setting_recepciones_con_motivo" CHECK (
    "realPurchaseReceiptsEnabled" = false
    OR ("receiptsChangedById" IS NOT NULL AND "receiptsChangedAt" IS NOT NULL
        AND "receiptsReason" IS NOT NULL)
  ),
  ADD CONSTRAINT "stock_module_setting_receiptsChangedById_fkey"
  FOREIGN KEY ("receiptsChangedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
