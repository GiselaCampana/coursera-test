-- Stock ERP, fase 7: mermas, recuentos correctivos y reversiones acotadas.
--
-- TRES CONCEPTOS DISTINTOS, Y NINGUNA ENTRADA MANUAL GENÉRICA
--
--   * Una MERMA es una pérdida con causa conocida: sale mercadería y se dice por
--     qué. Cantidad positiva, categoría obligatoria, motivo escrito.
--   * Un RECUENTO CORRECTIVO es contar lo que hay. La persona escribe la
--     cantidad FÍSICA, nunca una diferencia; el servidor calcula el delta contra
--     el saldo que tiene bloqueado y asienta sólo esa diferencia.
--   * Una REVERSIÓN agrega asientos inversos. No borra ni edita el libro.
--
-- No existe «sumar o restar a mano»: cada corrección tiene una forma, un motivo
-- y una explicación de por qué el número cambió.
--
-- LO QUE NO SE CREA
--
-- No hay tipos de movimiento nuevos: `WASTE_OUT`, `INTERNAL_USE_OUT`,
-- `ADJUSTMENT_IN` y `ADJUSTMENT_OUT` ya estaban declarados desde la fase 1 y
-- nadie los usaba. Tampoco hay clases de operación nuevas: `AJUSTE` y
-- `REVERSION` ya existían. La maquinaria de reversión —`reversesId` único, el
-- disparador de coherencia, la dirección invertida por CHECK— también.

-- ---------------------------------------------------------------------------
-- 1. Las categorías de merma, y el discriminador de las sesiones
-- ---------------------------------------------------------------------------

CREATE TYPE "StockWasteCategory" AS ENUM (
  'VENCIMIENTO',
  'ROTURA',
  -- Deterioro o corte de la cadena de frío: la heladera que se apagó.
  'DETERIORO_O_FRIO',
  -- Lo que se pierde al elaborar o al recortar una horma. No es un error.
  'ELABORACION_O_RECORTE',
  'CONSUMO_INTERNO',
  -- Falta y no se sabe por qué. Se registra como lo que es.
  'FALTANTE',
  'ERROR_OPERATIVO',
  -- Exige detalle escrito: una categoría que explica todo no explica nada.
  'OTRO'
);

/*
 * El discriminador de la sesión, EXPLÍCITO.
 *
 * `StockCountSession` ya servía para las dos cosas y se distinguían por el
 * estado: la apertura usa BORRADOR y CONFIRMADA, y ABIERTA y CERRADA estaban
 * reservadas para los recuentos con un comentario desde la fase 1. Depender de
 * esa lectura implícita es pedir que alguien la interprete mal una vez.
 */
CREATE TYPE "StockCountSessionKind" AS ENUM ('APERTURA', 'RECUENTO');

CREATE TYPE "StockCountLineResolution" AS ENUM (
  -- Se contó y coincidía. No genera movimiento: un asiento de cero sería ruido
  -- que después alguien tiene que explicar.
  'SIN_DIFERENCIA',
  -- Se contó, había diferencia y se asentó el ajuste.
  'AJUSTADA'
);

ALTER TABLE "stock_count_session"
  ADD COLUMN "kind" "StockCountSessionKind" NOT NULL DEFAULT 'APERTURA';

-- Una apertura usa BORRADOR/CONFIRMADA y un recuento ABIERTA/CERRADA. Ahora que
-- el tipo es explícito, la base puede exigir que no se mezclen.
ALTER TABLE "stock_count_session"
  ADD CONSTRAINT "sesion_estado_segun_tipo" CHECK (
    ("kind" = 'APERTURA' AND "status" IN ('BORRADOR', 'CONFIRMADA'))
    OR ("kind" = 'RECUENTO' AND "status" IN ('ABIERTA', 'CERRADA'))
  );

CREATE INDEX "stock_count_session_kind_status_idx" ON "stock_count_session"("kind", "status");

-- ---------------------------------------------------------------------------
-- 2. La merma
-- ---------------------------------------------------------------------------

CREATE TABLE "stock_waste" (
    "id" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,

    "quantity" DECIMAL NOT NULL,
    "unit" "StockUnit" NOT NULL,
    "category" "StockWasteCategory" NOT NULL,

    -- Escrito por una persona. No hay merma sin motivo: un saldo que baja sin
    -- explicación es indistinguible de un robo o de un error de carga.
    "reason" TEXT NOT NULL,
    -- Obligatorio cuando la categoría es OTRO.
    "detail" TEXT,

    -- La operación que escribió el movimiento. Única: una operación, una merma.
    "operationId" TEXT NOT NULL,

    -- Cuándo ocurrió físicamente. Lo decide el SERVIDOR.
    "occurredAt" TIMESTAMPTZ(3) NOT NULL,

    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    -- Si se revirtió, con qué operación. Una sola vez.
    "reversalOperationId" TEXT,
    "reversedById" TEXT,
    "reversedAt" TIMESTAMPTZ(3),

    CONSTRAINT "stock_waste_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "stock_waste_operationId_key" ON "stock_waste"("operationId");
CREATE UNIQUE INDEX "stock_waste_reversalOperationId_key" ON "stock_waste"("reversalOperationId");
CREATE INDEX "stock_waste_branchId_occurredAt_idx" ON "stock_waste"("branchId", "occurredAt");
CREATE INDEX "stock_waste_productId_idx" ON "stock_waste"("productId");
CREATE INDEX "stock_waste_category_idx" ON "stock_waste"("category");

ALTER TABLE "stock_waste"
  ADD CONSTRAINT "stock_waste_branchId_fkey"
    FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "stock_waste_productId_fkey"
    FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "stock_waste_operationId_fkey"
    FOREIGN KEY ("operationId") REFERENCES "stock_operation"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "stock_waste_reversalOperationId_fkey"
    FOREIGN KEY ("reversalOperationId") REFERENCES "stock_operation"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "stock_waste_createdById_fkey"
    FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "stock_waste_reversedById_fkey"
    FOREIGN KEY ("reversedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "stock_waste"
  ADD CONSTRAINT "merma_cantidad" CHECK (
    "quantity" > 0 AND "quantity" = round("quantity", 3) AND "quantity" <= 1000000),
  -- Un motivo en blanco es no tener motivo. La base lo dice, no sólo el servicio.
  ADD CONSTRAINT "merma_motivo_escrito" CHECK (length(btrim("reason")) >= 3),
  ADD CONSTRAINT "merma_otro_exige_detalle" CHECK (
    "category" <> 'OTRO' OR (("detail" IS NOT NULL) AND length(btrim("detail")) >= 3)),
  -- Revertida es revertida: los tres campos van juntos o ninguno.
  ADD CONSTRAINT "merma_reversion_completa" CHECK (
    ("reversalOperationId" IS NULL AND "reversedAt" IS NULL)
    OR ("reversalOperationId" IS NOT NULL AND "reversedAt" IS NOT NULL));

-- ---------------------------------------------------------------------------
-- 3. La línea de recuento
--
-- No se reutiliza `ProductStockActivation`: eso es la APERTURA de un artículo en
-- una sucursal, única por par y con su propio movimiento inicial. Un recuento
-- correctivo ocurre muchas veces sobre el mismo par y necesita guardar otra
-- cosa: qué decía el sistema, qué se contó, cuál fue la diferencia y qué
-- operación la asentó.
-- ---------------------------------------------------------------------------

CREATE TABLE "stock_count_line" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,

    -- Lo que el sistema creía, leído con la fila de saldo BLOQUEADA en el
    -- momento de confirmar. Se guarda para poder contestar después «¿contra qué
    -- se comparó?» sin reconstruirlo.
    "expectedQuantity" DECIMAL NOT NULL,
    -- Lo que la persona contó. Cero es un valor válido y significa «no había».
    "countedQuantity" DECIMAL NOT NULL,
    -- Contada − esperada. La calcula el SERVIDOR; el navegador no la manda.
    "difference" DECIMAL NOT NULL,
    "unit" "StockUnit" NOT NULL,

    "resolution" "StockCountLineResolution",
    -- La operación del ajuste. Nula cuando no hubo diferencia.
    "operationId" TEXT,

    "countedById" TEXT,
    "countedAt" TIMESTAMPTZ(3),
    "confirmedById" TEXT,
    "confirmedAt" TIMESTAMPTZ(3),

    "reversalOperationId" TEXT,
    "reversedById" TEXT,
    "reversedAt" TIMESTAMPTZ(3),

    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "stock_count_line_pkey" PRIMARY KEY ("id")
);

-- Un artículo aparece una sola vez por sesión: dos líneas del mismo artículo
-- serían dos verdades sobre lo mismo.
CREATE UNIQUE INDEX "stock_count_line_sessionId_productId_key"
  ON "stock_count_line"("sessionId", "productId");
CREATE UNIQUE INDEX "stock_count_line_operationId_key" ON "stock_count_line"("operationId");
CREATE UNIQUE INDEX "stock_count_line_reversalOperationId_key"
  ON "stock_count_line"("reversalOperationId");
CREATE INDEX "stock_count_line_sessionId_idx" ON "stock_count_line"("sessionId");

ALTER TABLE "stock_count_line"
  ADD CONSTRAINT "stock_count_line_sessionId_fkey"
    FOREIGN KEY ("sessionId") REFERENCES "stock_count_session"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "stock_count_line_productId_fkey"
    FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "stock_count_line_operationId_fkey"
    FOREIGN KEY ("operationId") REFERENCES "stock_operation"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "stock_count_line_reversalOperationId_fkey"
    FOREIGN KEY ("reversalOperationId") REFERENCES "stock_operation"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "stock_count_line_countedById_fkey"
    FOREIGN KEY ("countedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "stock_count_line_confirmedById_fkey"
    FOREIGN KEY ("confirmedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "stock_count_line_reversedById_fkey"
    FOREIGN KEY ("reversedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "stock_count_line"
  ADD CONSTRAINT "recuento_cantidades" CHECK (
    "countedQuantity" >= 0 AND "countedQuantity" = round("countedQuantity", 3)
    AND "countedQuantity" <= 1000000
    AND "expectedQuantity" >= 0 AND "expectedQuantity" = round("expectedQuantity", 3)),
  -- **La diferencia no es un dato de entrada: es una consecuencia.**
  -- Esta CHECK es la que impide que alguien guarde un delta inventado.
  ADD CONSTRAINT "recuento_diferencia_derivada" CHECK (
    "difference" = "countedQuantity" - "expectedQuantity"),
  -- Sin diferencia no hay operación; con diferencia, tiene que haberla.
  ADD CONSTRAINT "recuento_operacion_solo_con_diferencia" CHECK (
    ("resolution" IS NULL)
    OR ("resolution" = 'SIN_DIFERENCIA' AND "difference" = 0 AND "operationId" IS NULL)
    OR ("resolution" = 'AJUSTADA' AND "difference" <> 0 AND "operationId" IS NOT NULL)),
  ADD CONSTRAINT "recuento_confirmada_completa" CHECK (
    "resolution" IS NULL OR ("confirmedAt" IS NOT NULL AND "confirmedById" IS NOT NULL)),
  ADD CONSTRAINT "recuento_reversion_completa" CHECK (
    ("reversalOperationId" IS NULL AND "reversedAt" IS NULL)
    OR ("reversalOperationId" IS NOT NULL AND "reversedAt" IS NOT NULL
        AND "resolution" = 'AJUSTADA'));

-- ---------------------------------------------------------------------------
-- 4. El interruptor de correcciones reales
--
-- El cuarto, y por la misma razón que hay tres: es otra decisión. Una merma o un
-- ajuste sobre un inventario REAL lo cambia sin que ningún comprobante lo
-- respalde, y mientras las ventas no descuenten no hay con qué verificarlo.
-- ---------------------------------------------------------------------------

ALTER TABLE "stock_module_setting"
  ADD COLUMN "realCorrectionsEnabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "correctionsChangedById" TEXT,
  ADD COLUMN "correctionsChangedAt"   TIMESTAMP(3),
  ADD COLUMN "correctionsReason"      TEXT;

ALTER TABLE "stock_module_setting"
  ADD CONSTRAINT "stock_module_setting_correcciones_con_motivo" CHECK (
    "realCorrectionsEnabled" = false OR (
      "correctionsChangedById" IS NOT NULL
      AND "correctionsChangedAt" IS NOT NULL
      AND "correctionsReason" IS NOT NULL)),
  ADD CONSTRAINT "stock_module_setting_correctionsChangedById_fkey"
    FOREIGN KEY ("correctionsChangedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- 5. La defensa temporal y del interruptor, para las correcciones
--
-- El disparador de la fase 4 cubre `PURCHASE_IN` y el de la fase 6 los
-- traslados. Las correcciones quedaban sin esa defensa, y son justamente las que
-- mueven saldo sin ningún comprobante detrás.
--
-- Una corrección es ficticia si lo es la apertura de su sucursal: no tiene
-- sentido descontar mercadería inventada de un inventario real, ni al revés.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION stock_correccion_permitida() RETURNS trigger AS $$
DECLARE
  corte      timestamptz;
  ficticia   boolean;
  habilitado boolean;
BEGIN
  IF NEW."type" NOT IN ('WASTE_OUT', 'INTERNAL_USE_OUT', 'ADJUSTMENT_IN',
                        'ADJUSTMENT_OUT', 'INVENTORY_CORRECTION') THEN
    RETURN NEW;
  END IF;

  SELECT s."cutoffAt", s."ficticia" INTO corte, ficticia
    FROM "stock_count_session" s
   WHERE s."branchId" = NEW."branchId"
     AND s."kind" = 'APERTURA' AND s."status" = 'CONFIRMADA'
   LIMIT 1;

  IF corte IS NULL THEN
    RAISE EXCEPTION
      'No se puede corregir existencias en una sucursal sin apertura confirmada. '
      'Sus artículos no están en cero: están sin contar.';
  END IF;

  IF NEW."effectiveAt" <= corte THEN
    RAISE EXCEPTION
      'Una corrección no puede tener fecha efectiva anterior o igual al corte de '
      'la apertura (% <= %). Lo anterior al corte ya está comprendido en el '
      'conteo inicial.', NEW."effectiveAt", corte;
  END IF;

  IF ficticia THEN
    IF current_database() !~ '(^|[_-])(e2e|test|demo)([_-]|$)' THEN
      RAISE EXCEPTION
        'Una corrección sobre una apertura ficticia sólo se aplica contra una '
        'base de pruebas: el nombre tiene que contener "e2e", "test" o "demo". '
        'Base vista: %', current_database();
    END IF;
  ELSE
    SELECT "realCorrectionsEnabled" INTO habilitado FROM "stock_module_setting" LIMIT 1;
    IF habilitado IS NOT TRUE THEN
      RAISE EXCEPTION
        'El interruptor de correcciones reales de Stock ERP está apagado. Una '
        'merma o un ajuste cambian un inventario real sin ningún comprobante '
        'detrás, y las ventas todavía no descuentan.';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- AFTER, por lo mismo que los anteriores: un BEFORE se comería los mensajes de
-- las CHECK de la fila, que son más precisos.
CREATE TRIGGER "stock_correccion_permitida"
  AFTER INSERT ON "stock_ledger"
  FOR EACH ROW EXECUTE FUNCTION stock_correccion_permitida();

-- ---------------------------------------------------------------------------
-- 6. Qué se puede revertir en ESTA fase
--
-- La elegibilidad vive en la base y no sólo en el servicio, porque es la regla
-- que más caro sale equivocar: revertir una apertura o una recepción dejaría dos
-- inventarios sin punto de partida, y revertir un traslado ya recibido exigiría
-- compensar las DOS sucursales, que es otra fase.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION stock_reversion_elegible() RETURNS trigger AS $$
DECLARE
  original "stock_ledger"%ROWTYPE;
  cab      "stock_transfer"%ROWTYPE;
  renglon  "stock_transfer_line"%ROWTYPE;
  entradas INT;
BEGIN
  IF NEW."reversesId" IS NULL THEN RETURN NEW; END IF;

  SELECT * INTO original FROM "stock_ledger" WHERE id = NEW."reversesId";
  IF NOT FOUND THEN RETURN NEW; END IF;  -- lo dice el otro disparador

  IF original."type" IN ('OPENING_BALANCE', 'PURCHASE_IN', 'TRANSFER_IN',
                         'SALE_OUT', 'CUSTOMER_RETURN_IN', 'SUPPLIER_RETURN_OUT') THEN
    RAISE EXCEPTION
      'Un movimiento de tipo % no se revierte en esta fase. La apertura fija el '
      'punto de partida, una recepción de compra se corrige con una devolución y '
      'una entrada de traslado exigiría compensar las dos sucursales.',
      original."type";
  END IF;

  /*
   * Una salida de traslado se revierte SÓLO mientras el traslado no llegó.
   * Si ya hay recepción, la mercadería está en la otra sucursal y devolverla es
   * otro traslado, no una reversión.
   */
  IF original."type" = 'TRANSFER_OUT' THEN
    SELECT * INTO renglon FROM "stock_transfer_line" WHERE id = original."transferLineId";
    IF NOT FOUND THEN
      RAISE EXCEPTION 'La salida de traslado que se quiere revertir no tiene renglón.';
    END IF;
    SELECT * INTO cab FROM "stock_transfer" WHERE id = renglon."transferId";

    IF cab."status"::text NOT IN ('DESPACHADO', 'REVERSADO') THEN
      RAISE EXCEPTION
        'Sólo se revierte el despacho de un traslado que todavía está en tránsito. '
        'Este traslado está %.', cab."status";
    END IF;

    SELECT count(*) INTO entradas
      FROM "stock_ledger"
     WHERE "transferLineId" = renglon.id AND "type" = 'TRANSFER_IN';
    IF entradas > 0 THEN
      RAISE EXCEPTION
        'Este renglón ya fue recibido en el destino: su despacho no se revierte. '
        'Devolver la mercadería es un traslado nuevo en el otro sentido.';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "stock_reversion_elegible"
  AFTER INSERT ON "stock_ledger"
  FOR EACH ROW EXECUTE FUNCTION stock_reversion_elegible();

-- ---------------------------------------------------------------------------
-- 7. «El traslado llega entero o no llega», ahora contando ORIGINALES
--
-- Reemplaza la función de la fase 6. El cambio es quirúrgico y es el que permite
-- revertir un despacho: las cuentas de salidas y entradas miran sólo los
-- movimientos ORIGINALES (`reversesId IS NULL`), y las reversiones se cuentan
-- aparte.
--
-- Lo que NO cambia: una segunda salida ORIGINAL sigue siendo imposible, una
-- entrada sin su salida sigue siendo imposible, y un traslado no se cierra con
-- una mitad faltante.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION stock_traslado_completo() RETURNS trigger AS $$
DECLARE
  renglon    "stock_transfer_line"%ROWTYPE;
  cab        "stock_transfer"%ROWTYPE;
  salidas    INT;
  entradas   INT;
  reversas   INT;
BEGIN
  SELECT * INTO renglon FROM "stock_transfer_line" WHERE id = NEW."transferLineId";
  IF NOT FOUND THEN RETURN NEW; END IF;
  SELECT * INTO cab FROM "stock_transfer" WHERE id = renglon."transferId";

  IF cab."fromBranchId" = cab."toBranchId" THEN
    RAISE EXCEPTION 'Un traslado necesita dos sucursales distintas.';
  END IF;

  SELECT
    count(*) FILTER (
      WHERE "type" = 'TRANSFER_OUT' AND "branchId" = cab."fromBranchId"
        AND "reversesId" IS NULL
        AND "quantity" = coalesce(renglon."dispatchedQuantity", renglon."quantity")),
    count(*) FILTER (
      WHERE "type" = 'TRANSFER_IN' AND "branchId" = cab."toBranchId"
        AND "reversesId" IS NULL
        AND "quantity" = coalesce(renglon."receivedQuantity", renglon."quantity")),
    count(*) FILTER (WHERE "reversesId" IS NOT NULL)
  INTO salidas, entradas, reversas
  FROM "stock_ledger"
  WHERE "transferLineId" = renglon.id
    AND "productId" = renglon."productId"
    AND "unit" = renglon."unit";

  -- Una segunda salida ORIGINAL sigue prohibida, exista o no una reversión.
  IF salidas > 1 OR entradas > 1 THEN
    RAISE EXCEPTION
      'Un renglón de traslado no puede tener dos salidas ni dos entradas '
      'originales. Se encontraron % y %.', salidas, entradas;
  END IF;

  -- Y una sola reversión por renglón: `reversesId` es único, esto lo dice con
  -- palabras antes de que lo diga el índice.
  IF reversas > 1 THEN
    RAISE EXCEPTION 'Un renglón de traslado no se revierte dos veces.';
  END IF;

  IF entradas = 1 AND salidas = 0 THEN
    RAISE EXCEPTION
      'Una entrada de traslado sin su salida no existe: la mercadería no puede '
      'llegar a % sin haber salido de %.', cab."toBranchId", cab."fromBranchId";
  END IF;

  IF cab."status"::text IN ('BORRADOR', 'CANCELADO') THEN
    IF salidas > 0 OR entradas > 0 OR reversas > 0 THEN
      RAISE EXCEPTION
        'Un traslado en % no escribe en el libro. Se encontraron % salidas, % '
        'entradas y % reversiones.', cab."status", salidas, entradas, reversas;
    END IF;

  ELSIF cab."status"::text = 'DESPACHADO' THEN
    IF salidas <> 1 THEN
      RAISE EXCEPTION
        'Un traslado despachado necesita exactamente una salida original en % por '
        'cada renglón, del mismo artículo, unidad y cantidad. Se encontraron %.',
        cab."fromBranchId", salidas;
    END IF;
    IF entradas <> 0 THEN
      RAISE EXCEPTION
        'Un traslado despachado todavía no llegó: no puede tener entradas en %. '
        'Se encontraron %.', cab."toBranchId", entradas;
    END IF;
    IF reversas <> 0 THEN
      RAISE EXCEPTION
        'Este renglón tiene una reversión pero el traslado sigue DESPACHADO. '
        'Revertir un despacho lo deja REVERSADO.';
    END IF;

  ELSIF cab."status"::text = 'REVERSADO' THEN
    -- El despacho se revirtió: la salida original sigue ahí, con su reversión
    -- exacta al lado, y el destino nunca recibió nada.
    IF salidas <> 1 OR reversas <> 1 THEN
      RAISE EXCEPTION
        'Un traslado reversado necesita su salida original y exactamente una '
        'reversión por renglón. Se encontraron % y %.', salidas, reversas;
    END IF;
    IF entradas <> 0 THEN
      RAISE EXCEPTION
        'Un traslado reversado no puede tener entradas en el destino: si llegó, '
        'no se revierte.';
    END IF;

  ELSIF cab."status"::text IN ('RECIBIDO', 'APLICADO') THEN
    IF salidas <> 1 OR entradas <> 1 THEN
      RAISE EXCEPTION
        'Un traslado % no se cierra con una mitad faltante: cada renglón '
        'necesita una salida en % y una entrada en %, del mismo artículo, '
        'unidad y cantidad. Se encontraron % y %.',
        cab."status", cab."fromBranchId", cab."toBranchId", salidas, entradas;
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------
-- 8. La transición nueva: DESPACHADO → REVERSADO, y sólo ésa
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION stock_traslado_transicion() RETURNS trigger AS $$
BEGIN
  IF NEW."fromBranchId" <> OLD."fromBranchId" OR NEW."toBranchId" <> OLD."toBranchId" THEN
    RAISE EXCEPTION
      'El origen y el destino de un traslado no se reescriben. Si estaban mal, '
      'se cancela el borrador y se hace otro.';
  END IF;

  IF OLD."operationId" IS NOT NULL
     AND NEW."operationId" IS DISTINCT FROM OLD."operationId" THEN
    RAISE EXCEPTION 'La operación de despacho de un traslado no se cambia.';
  END IF;
  IF OLD."receiptOperationId" IS NOT NULL
     AND NEW."receiptOperationId" IS DISTINCT FROM OLD."receiptOperationId" THEN
    RAISE EXCEPTION 'La operación de recepción de un traslado no se cambia.';
  END IF;
  IF OLD."dispatchedAt" IS NOT NULL
     AND NEW."dispatchedAt" IS DISTINCT FROM OLD."dispatchedAt" THEN
    RAISE EXCEPTION 'El momento del despacho es historia: no se mueve.';
  END IF;
  IF OLD."receivedAt" IS NOT NULL
     AND NEW."receivedAt" IS DISTINCT FROM OLD."receivedAt" THEN
    RAISE EXCEPTION 'El momento de la recepción es historia: no se mueve.';
  END IF;

  IF NEW."status"::text = OLD."status"::text THEN
    RETURN NEW;
  END IF;

  IF OLD."status"::text = 'BORRADOR' THEN
    IF NEW."status"::text NOT IN ('DESPACHADO', 'CANCELADO') THEN
      RAISE EXCEPTION 'Un borrador sólo se despacha o se cancela (se intentó %).',
        NEW."status";
    END IF;
  ELSIF OLD."status"::text = 'DESPACHADO' THEN
    -- La fase 7 agrega la reversión del despacho, y NADA más: un traslado
    -- recibido no vuelve, porque revertirlo exigiría compensar las dos
    -- sucursales.
    IF NEW."status"::text NOT IN ('RECIBIDO', 'REVERSADO') THEN
      RAISE EXCEPTION
        'Un traslado despachado sólo se recibe o se revierte (se intentó %).',
        NEW."status";
    END IF;
  ELSE
    RAISE EXCEPTION 'Un traslado % es definitivo: no cambia de estado.', OLD."status";
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Un traslado reversado conserva su despacho y nunca tuvo recepción.
ALTER TABLE "stock_transfer"
  ADD CONSTRAINT "traslado_reversado_completo" CHECK (
    "status"::text <> 'REVERSADO' OR (
      "operationId" IS NOT NULL AND "dispatchedAt" IS NOT NULL
      AND "receiptOperationId" IS NULL AND "receivedAt" IS NULL));

-- ---------------------------------------------------------------------------
-- 9. Lo registrado no se reescribe
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION stock_merma_inmutable() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Una merma registrada no se borra: se revierte.';
  END IF;
  IF NEW."branchId" <> OLD."branchId" OR NEW."productId" <> OLD."productId"
     OR NEW."quantity" <> OLD."quantity" OR NEW."unit" <> OLD."unit"
     OR NEW."category" <> OLD."category" OR NEW."reason" <> OLD."reason"
     OR NEW."operationId" <> OLD."operationId"
     OR NEW."occurredAt" IS DISTINCT FROM OLD."occurredAt" THEN
    RAISE EXCEPTION
      'Una merma registrada es historia: no se edita. Si estaba mal, se revierte '
      'y se registra la correcta.';
  END IF;
  IF OLD."reversalOperationId" IS NOT NULL
     AND NEW."reversalOperationId" IS DISTINCT FROM OLD."reversalOperationId" THEN
    RAISE EXCEPTION 'Una merma ya revertida no se revierte de nuevo.';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "stock_merma_inmutable"
  AFTER UPDATE OR DELETE ON "stock_waste"
  FOR EACH ROW EXECUTE FUNCTION stock_merma_inmutable();

CREATE OR REPLACE FUNCTION stock_recuento_inmutable() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."resolution" IS NOT NULL THEN
      RAISE EXCEPTION 'Una línea de recuento ya confirmada no se borra.';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD."resolution" IS NOT NULL THEN
    IF NEW."countedQuantity" <> OLD."countedQuantity"
       OR NEW."expectedQuantity" <> OLD."expectedQuantity"
       OR NEW."difference" <> OLD."difference"
       OR NEW."operationId" IS DISTINCT FROM OLD."operationId"
       OR NEW."resolution" IS DISTINCT FROM OLD."resolution" THEN
      RAISE EXCEPTION
        'Una línea de recuento confirmada es historia: no se edita. Contar de '
        'nuevo es abrir otra sesión.';
    END IF;
    IF OLD."reversalOperationId" IS NOT NULL
       AND NEW."reversalOperationId" IS DISTINCT FROM OLD."reversalOperationId" THEN
      RAISE EXCEPTION 'Un ajuste ya revertido no se revierte de nuevo.';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "stock_recuento_inmutable"
  AFTER UPDATE OR DELETE ON "stock_count_line"
  FOR EACH ROW EXECUTE FUNCTION stock_recuento_inmutable();

-- ---------------------------------------------------------------------------
-- 10. Reiniciar las bases de prueba, con las tablas nuevas
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
  ALTER TABLE "stock_transfer_line" DISABLE TRIGGER "stock_traslado_renglon_inmutable";
  ALTER TABLE "stock_transfer" DISABLE TRIGGER "stock_traslado_transicion";
  ALTER TABLE "stock_waste" DISABLE TRIGGER "stock_merma_inmutable";
  ALTER TABLE "stock_count_line" DISABLE TRIGGER "stock_recuento_inmutable";

  TRUNCATE TABLE
    "stock_waste",
    "stock_count_line",
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
  ALTER TABLE "stock_transfer_line" ENABLE TRIGGER "stock_traslado_renglon_inmutable";
  ALTER TABLE "stock_transfer" ENABLE TRIGGER "stock_traslado_transicion";
  ALTER TABLE "stock_waste" ENABLE TRIGGER "stock_merma_inmutable";
  ALTER TABLE "stock_count_line" ENABLE TRIGGER "stock_recuento_inmutable";
END;
$$ LANGUAGE plpgsql;
