-- Stock ERP, fase 4: la recepción de una compra.
--
-- SIN BANDEJA NUEVA
--
-- No se crea ninguna cola de pendientes. Las recepciones pendientes se
-- calculan: comprobantes VALIDADO, con al menos un renglón de mercadería, sin
-- una fila en `stock_receipt`. Guardar además la lista de pendientes sería
-- guardar una copia que se desincroniza sola; lo que la base tiene que
-- recordar es la DECISIÓN, y eso es exactamente `stock_receipt`.
--
-- UNA FILA POR COMPROBANTE
--
-- `documentId` es único. Esta fase recibe el comprobante completo como una
-- sola operación: no hay recepciones parciales. Si algún día el negocio
-- necesita recibir un mismo comprobante en dos momentos, cambiar esta
-- restricción es una decisión comercial y no un detalle técnico.

CREATE TYPE "StockReceiptResolution" AS ENUM (
  -- Generó movimientos de mercadería en el libro.
  'APLICADA',
  -- La mercadería ya estaba comprendida en el conteo inicial de la sucursal:
  -- llegó en la fecha del corte o antes. No genera movimientos, y registrarlo
  -- es lo que impide que alguien la reciba después "por las dudas" y duplique.
  'INCLUIDA_EN_APERTURA',
  -- El comprobante no tiene mercadería con impacto: sólo gastos, por ejemplo.
  'EXCLUIDA'
);

CREATE TABLE "stock_receipt" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,

    -- Cuándo llegó FÍSICAMENTE la mercadería. Con zona horaria, y nunca
    -- copiada de la fecha fiscal del comprobante: son dos cosas distintas y
    -- confundirlas es lo que hace que una factura de agosto recibida en
    -- septiembre entre en el mes equivocado.
    "receivedAt" TIMESTAMPTZ(3) NOT NULL,

    "resolution" "StockReceiptResolution" NOT NULL,
    "operationId" TEXT,

    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reason" TEXT,
    -- Si alguien forzó la decisión por fuera del camino normal. Se guarda para
    -- poder preguntarlo después, no para habilitar nada.
    "manualOverride" BOOLEAN NOT NULL DEFAULT false,

    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "stock_receipt_pkey" PRIMARY KEY ("id")
);

-- Una decisión por comprobante, garantizada por la base y no por el servicio.
CREATE UNIQUE INDEX "stock_receipt_documentId_key" ON "stock_receipt"("documentId");
CREATE INDEX "stock_receipt_branchId_receivedAt_idx" ON "stock_receipt"("branchId", "receivedAt");
CREATE INDEX "stock_receipt_resolution_idx" ON "stock_receipt"("resolution");
-- Una operación escribe una sola recepción: si alguna vez dos filas apuntaran a
-- la misma, el `result` guardado dejaría de decir qué pasó en cuál.
CREATE UNIQUE INDEX "stock_receipt_operationId_key" ON "stock_receipt"("operationId");

ALTER TABLE "stock_receipt"
  ADD CONSTRAINT "stock_receipt_documentId_fkey"
    FOREIGN KEY ("documentId") REFERENCES "documents"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "stock_receipt_branchId_fkey"
    FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "stock_receipt_operationId_fkey"
    FOREIGN KEY ("operationId") REFERENCES "stock_operation"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "stock_receipt_decidedById_fkey"
    FOREIGN KEY ("decidedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Una recepción APLICADA tiene que tener su operación: es la que prueba que el
-- libro se escribió. Las otras dos resoluciones no escriben libro y por eso no
-- la exigen.
ALTER TABLE "stock_receipt"
  ADD CONSTRAINT "recepcion_aplicada_con_operacion" CHECK (
    "resolution" <> 'APLICADA' OR "operationId" IS NOT NULL
  );

-- ---------------------------------------------------------------------------
-- El vínculo con el renglón del comprobante
--
-- `stock_ledger.documentItemId` ya existía como texto suelto, sin clave
-- foránea. Ahora que hay recepciones de verdad pasa a apuntar al renglón: es
-- lo que permite contestar «este movimiento de stock, ¿de qué renglón de qué
-- factura salió?» sin adivinar.
--
-- ON DELETE SET NULL y no CASCADE: el libro es inmutable. Si alguna vez se
-- borrara un renglón, el movimiento tiene que quedar —con su vínculo en nulo—
-- y no desaparecer con él.
-- ---------------------------------------------------------------------------
ALTER TABLE "stock_ledger"
  ADD CONSTRAINT "stock_ledger_documentItemId_fkey"
  FOREIGN KEY ("documentItemId") REFERENCES "document_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "stock_ledger_documentItemId_idx" ON "stock_ledger"("documentItemId");

-- ---------------------------------------------------------------------------
-- La defensa del interruptor de recepciones, EN LA BASE
--
-- Mismo criterio que la apertura: el servicio se puede saltear con una
-- consulta, y una recepción escrita de costado es indistinguible de una buena
-- una semana después.
--
--   * una recepción de datos REALES exige el interruptor encendido;
--   * una recepción FICTICIA sólo se acepta contra una base cuyo nombre diga
--     test, e2e o demo.
--
-- Una recepción es ficticia si lo es la apertura de su sucursal: no tiene
-- sentido recibir mercadería inventada sobre un inventario real, ni al revés.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION stock_recepcion_permitida() RETURNS trigger AS $$
DECLARE
  ficticia boolean;
  habilitado boolean;
BEGIN
  -- Sólo se juzga la que escribe libro. Registrar que algo ya estaba en la
  -- apertura, o que no tiene mercadería, no mueve una sola existencia.
  IF NEW."resolution" <> 'APLICADA' THEN
    RETURN NEW;
  END IF;

  SELECT s."ficticia" INTO ficticia
    FROM "stock_count_session" s
   WHERE s."branchId" = NEW."branchId" AND s."status" = 'CONFIRMADA'
   LIMIT 1;

  IF ficticia IS NULL THEN
    RAISE EXCEPTION
      'La sucursal no tiene una apertura confirmada de Stock ERP. Sin apertura '
      'no hay saldo sobre el cual recibir: sus artículos no están en cero, '
      'están sin contar.';
  END IF;

  IF ficticia THEN
    IF current_database() !~ '(^|[_-])(e2e|test|demo)([_-]|$)' THEN
      RAISE EXCEPTION
        'Una recepción sobre una apertura ficticia sólo se aplica contra una '
        'base de pruebas: el nombre tiene que contener "e2e", "test" o "demo". '
        'Base vista: %', current_database();
    END IF;
  ELSE
    SELECT "realPurchaseReceiptsEnabled" INTO habilitado FROM "stock_module_setting" LIMIT 1;
    IF habilitado IS NOT TRUE THEN
      RAISE EXCEPTION
        'El interruptor de recepciones reales de Stock ERP está apagado. Los '
        'saldos todavía no incluyen ventas, así que recibir mercadería real '
        'haría crecer un inventario que nada descuenta.';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- AFTER y no BEFORE, y no es un detalle de estilo.
--
-- Un disparador BEFORE corre ANTES de que PostgreSQL evalúe las CHECK y las
-- claves foráneas de la fila, así que se comería sus mensajes: intentar una
-- recepción APLICADA sin operación contestaría «falta el interruptor» en vez de
-- «una recepción aplicada tiene que tener su operación». El rechazo es el mismo
-- —la transacción se cae igual— pero el que lo lee tarda el doble en entender
-- qué hizo mal.
CREATE TRIGGER "stock_recepcion_permitida"
  AFTER INSERT OR UPDATE ON "stock_receipt"
  FOR EACH ROW EXECUTE FUNCTION stock_recepcion_permitida();

-- ---------------------------------------------------------------------------
-- Ningún ingreso de compra con fecha efectiva anterior o igual al corte
--
-- Es la regla que impide duplicar existencias, y va en la base porque es la
-- que más caro sale equivocar: la mercadería recibida antes del corte YA ESTÁ
-- contada en la apertura. Sumarla otra vez la contaría dos veces, y el error
-- no se ve hasta el siguiente recuento.
--
-- `stockerp.excepcion.historica` sirve para documentar y auditar una decisión
-- sin movimiento, NUNCA para saltear esto. Por eso el disparador no tiene
-- ninguna puerta de escape: no hay bandera que lo desactive.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION stock_ingreso_posterior_al_corte() RETURNS trigger AS $$
DECLARE corte timestamptz;
BEGIN
  IF NEW."type" <> 'PURCHASE_IN' THEN
    RETURN NEW;
  END IF;

  SELECT s."cutoffAt" INTO corte
    FROM "stock_count_session" s
   WHERE s."branchId" = NEW."branchId" AND s."status" = 'CONFIRMADA'
   LIMIT 1;

  IF corte IS NULL THEN
    RAISE EXCEPTION
      'No se puede ingresar mercadería en una sucursal sin apertura confirmada.';
  END IF;

  IF NEW."effectiveAt" <= corte THEN
    RAISE EXCEPTION
      'Un ingreso de compra no puede tener fecha efectiva anterior o igual al '
      'corte de la apertura (% <= %). Esa mercadería ya está contada en el '
      'conteo inicial: sumarla la duplicaría.',
      NEW."effectiveAt", corte;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- AFTER, por el mismo motivo, y acá el HALLAZGO fue concreto: con BEFORE, este
-- disparador tapó siete pruebas de la fase 1. Todas insertaban un PURCHASE_IN a
-- mano para comprobar una CHECK de la base —cantidad negativa, cantidad cero,
-- dirección equivocada, reversión incoherente— y todas empezaron a contestar
-- «no se puede ingresar mercadería en una sucursal sin apertura confirmada».
-- Ninguna garantía se había perdido; lo que se había perdido era la capacidad
-- de nombrar cuál se violó, que es la mitad del valor de tenerlas en la base.
CREATE TRIGGER "stock_ingreso_posterior_al_corte"
  AFTER INSERT ON "stock_ledger"
  FOR EACH ROW EXECUTE FUNCTION stock_ingreso_posterior_al_corte();

-- ---------------------------------------------------------------------------
-- La fecha de recepción no se mueve
--
-- Una vez decidida, `receivedAt` es historia: entra en la huella de
-- idempotencia y, cuando la recepción generó movimientos, en la fecha efectiva
-- de cada asiento. Cambiarla después dejaría el libro diciendo una fecha y la
-- recepción otra, sin que ninguna fila del libro cambie.
--
-- Tampoco se cambia la resolución ni el comprobante: una recepción registrada
-- es una decisión tomada, y corregirla es registrar otra cosa, no reescribir
-- ésta.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION stock_recepcion_inmutable() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Una recepción decidida no se borra.';
  END IF;
  IF OLD."receivedAt" IS DISTINCT FROM NEW."receivedAt" THEN
    RAISE EXCEPTION
      'La fecha de recepción no se cambia después de decidida (% -> %).',
      OLD."receivedAt", NEW."receivedAt";
  END IF;
  IF OLD."documentId" IS DISTINCT FROM NEW."documentId"
     OR OLD."branchId" IS DISTINCT FROM NEW."branchId"
     OR OLD."resolution" IS DISTINCT FROM NEW."resolution"
     OR OLD."operationId" IS DISTINCT FROM NEW."operationId" THEN
    RAISE EXCEPTION 'Una recepción registrada no se reescribe.';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "stock_recepcion_inmutable"
  BEFORE UPDATE OR DELETE ON "stock_receipt"
  FOR EACH ROW EXECUTE FUNCTION stock_recepcion_inmutable();

-- ---------------------------------------------------------------------------
-- Reiniciar las bases de prueba: ahora hay una tabla más
--
-- `stock_receipt` referencia `stock_operation`, así que el TRUNCATE sin CASCADE
-- de la función de reinicio **falla** desde que esta tabla existe: Postgres se
-- niega a truncar una tabla referenciada si no se trunca también la que
-- referencia. Se agrega a la lista explícita, que sigue sin CASCADE a
-- propósito: un CASCADE alcanzaría tablas comerciales que no son de Stock ERP.
--
-- La guarda por nombre de base no cambia: sigue siendo lo primero que corre.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION stock_erp_reset_para_pruebas() RETURNS void AS $$
BEGIN
  IF current_database() !~ '(^|[_-])(e2e|test|demo)([_-]|$)' THEN
    RAISE EXCEPTION
      'Esto borra el libro de stock y sólo corre contra una base de pruebas: '
      'el nombre tiene que contener "e2e", "test" o "demo". Base vista: %',
      current_database();
  END IF;

  ALTER TABLE "stock_ledger" DISABLE TRIGGER "stock_ledger_sin_truncate";
  ALTER TABLE "stock_ledger" DISABLE TRIGGER "stock_ledger_sin_delete";
  ALTER TABLE "stock_operation" DISABLE TRIGGER "stock_operation_inmutable";
  ALTER TABLE "stock_receipt" DISABLE TRIGGER "stock_recepcion_inmutable";

  TRUNCATE TABLE
    "stock_receipt",
    "stock_balance",
    "stock_ledger",
    "stock_transfer_line",
    "stock_transfer",
    "stock_operation",
    "product_stock_activation",
    "stock_count_session",
    "product_stock_config_history",
    "product_stock_config",
    "product_purchase_presentation";

  ALTER TABLE "stock_ledger" ENABLE TRIGGER "stock_ledger_sin_truncate";
  ALTER TABLE "stock_ledger" ENABLE TRIGGER "stock_ledger_sin_delete";
  ALTER TABLE "stock_operation" ENABLE TRIGGER "stock_operation_inmutable";
  ALTER TABLE "stock_receipt" ENABLE TRIGGER "stock_recepcion_inmutable";
END;
$$ LANGUAGE plpgsql;
