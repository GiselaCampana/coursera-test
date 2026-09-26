-- Stock ERP, fase 6: el traslado entre sucursales, en DOS hechos físicos.
--
-- La fase 1 modeló el traslado como un acto instantáneo: una operación, una
-- transacción, la salida y la entrada juntas. Eso alcanza para un traslado
-- dentro del mismo local y no alcanza para la realidad de la cadena: la
-- mercadería sale de Devoto un lunes y llega a Pueyrredón el martes. Entre las
-- dos cosas existe físicamente y no está en ninguna góndola.
--
-- Esta migración es ADITIVA sobre las tablas que ya existían. No crea un modelo
-- paralelo de traslados: agrega lo que faltaba para distinguir preparado,
-- despachado y recibido, que es exactamente lo que el esquema anterior no podía
-- representar.
--
-- LO QUE CAMBIA DE UN INVARIANTE APROBADO
--
-- El disparador `stock_traslado_completo` de la fase 1 exigía, al COMMIT, la
-- salida Y la entrada de cada renglón. Con mercadería en tránsito eso es
-- imposible: el despacho escribe sólo la salida. La promesa «un traslado llega
-- entero o no llega» no se abandona, se MUEVE: deja de ser «dentro de una
-- transacción» y pasa a ser «antes de poder cerrarse». Un traslado no puede
-- quedar RECIBIDO con una mitad faltante, y una entrada sin su salida sigue
-- siendo imposible en cualquier estado.

-- ---------------------------------------------------------------------------
-- 1. La cabecera: dos operaciones, tres actores, tres momentos
-- ---------------------------------------------------------------------------

ALTER TABLE "stock_transfer"
  -- Un borrador todavía no tiene operación: no escribió nada en el libro.
  -- Antes era obligatoria porque el traslado nacía ya aplicado.
  ALTER COLUMN "operationId" DROP NOT NULL,
  -- Un traslado nace borrador. Los valores viejos siguen siendo válidos para
  -- las filas que ya existían.
  ALTER COLUMN "status" SET DEFAULT 'BORRADOR',

  -- La segunda operación. El despacho y la recepción son dos hechos distintos,
  -- cada uno con su clave idempotente, su huella y su momento: meterlos en una
  -- sola operación haría que reintentar la recepción se pareciera a reintentar
  -- el despacho.
  ADD COLUMN "receiptOperationId" TEXT,

  -- Quién preparó, quién despachó y quién recibió son tres personas posibles y
  -- la pregunta «quién entregó esta mercadería» se contesta con la segunda, no
  -- con la que armó el papel.
  ADD COLUMN "preparedById"   TEXT,
  ADD COLUMN "dispatchedById" TEXT,
  ADD COLUMN "receivedById"   TEXT,
  ADD COLUMN "cancelledById"  TEXT,

  -- Con zona horaria, igual que el corte y la recepción de compras: son
  -- instantes físicos y se comparan contra el corte de la apertura.
  ADD COLUMN "dispatchedAt" TIMESTAMPTZ(3),
  ADD COLUMN "receivedAt"   TIMESTAMPTZ(3),
  ADD COLUMN "cancelledAt"  TIMESTAMPTZ(3),

  -- Bloqueo optimista del borrador: dos personas editando el mismo traslado no
  -- se pisan en silencio.
  ADD COLUMN "version" INTEGER NOT NULL DEFAULT 0;

-- Una operación escribe UN traslado. Sin esto, dos traslados podrían compartir
-- la operación y el `result` guardado dejaría de decir qué pasó en cuál.
CREATE UNIQUE INDEX "stock_transfer_operationId_key" ON "stock_transfer"("operationId");
CREATE UNIQUE INDEX "stock_transfer_receiptOperationId_key" ON "stock_transfer"("receiptOperationId");
CREATE INDEX "stock_transfer_status_idx" ON "stock_transfer"("status");

ALTER TABLE "stock_transfer"
  ADD CONSTRAINT "stock_transfer_receiptOperationId_fkey"
    FOREIGN KEY ("receiptOperationId") REFERENCES "stock_operation"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "stock_transfer_preparedById_fkey"
    FOREIGN KEY ("preparedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "stock_transfer_dispatchedById_fkey"
    FOREIGN KEY ("dispatchedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "stock_transfer_receivedById_fkey"
    FOREIGN KEY ("receivedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "stock_transfer_cancelledById_fkey"
    FOREIGN KEY ("cancelledById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Las reglas de coherencia de estado, en la base.
--
-- Se comparan por texto (`"status"::text`) y no contra el literal del enum a
-- propósito: así estas CHECK no dependen del orden en que PostgreSQL agregó los
-- valores nuevos y se pueden crear en la misma transacción que las usa.
ALTER TABLE "stock_transfer"
  -- Ya lo exigía el disparador de la fase 1; acá queda además como CHECK, que
  -- es más barata y falla antes.
  ADD CONSTRAINT "traslado_sucursales_distintas"
    CHECK ("fromBranchId" <> "toBranchId"),

  -- Un borrador no escribió nada y no tiene a quién atribuirle un despacho.
  ADD CONSTRAINT "traslado_borrador_sin_efectos" CHECK (
    "status"::text <> 'BORRADOR' OR (
      "operationId" IS NULL AND "receiptOperationId" IS NULL
      AND "dispatchedAt" IS NULL AND "dispatchedById" IS NULL
      AND "receivedAt" IS NULL AND "receivedById" IS NULL
      AND "cancelledAt" IS NULL AND "cancelledById" IS NULL)),

  -- Despachado: tiene su operación, su momento y su responsable, y todavía NO
  -- tiene recepción. Que la recepción esté vacía es la definición de «en
  -- tránsito».
  ADD CONSTRAINT "traslado_despachado_completo" CHECK (
    "status"::text <> 'DESPACHADO' OR (
      "operationId" IS NOT NULL AND "dispatchedAt" IS NOT NULL
      AND "dispatchedById" IS NOT NULL
      AND "receiptOperationId" IS NULL AND "receivedAt" IS NULL
      AND "receivedById" IS NULL AND "cancelledAt" IS NULL)),

  -- Recibido: las dos operaciones, los dos momentos, los dos responsables.
  ADD CONSTRAINT "traslado_recibido_completo" CHECK (
    "status"::text <> 'RECIBIDO' OR (
      "operationId" IS NOT NULL AND "dispatchedAt" IS NOT NULL
      AND "dispatchedById" IS NOT NULL
      AND "receiptOperationId" IS NOT NULL AND "receivedAt" IS NOT NULL
      AND "receivedById" IS NOT NULL AND "cancelledAt" IS NULL)),

  -- Cancelado: era un borrador, así que no puede haber tocado el libro.
  ADD CONSTRAINT "traslado_cancelado_sin_libro" CHECK (
    "status"::text <> 'CANCELADO' OR (
      "operationId" IS NULL AND "receiptOperationId" IS NULL
      AND "cancelledAt" IS NOT NULL AND "cancelledById" IS NOT NULL)),

  -- No se recibe antes de despachar. Los dos instantes los decide el servidor,
  -- pero una fila torcida no debería poder existir igual.
  ADD CONSTRAINT "traslado_recibido_despues_del_despacho" CHECK (
    "receivedAt" IS NULL OR "dispatchedAt" IS NULL OR "receivedAt" >= "dispatchedAt");

-- ---------------------------------------------------------------------------
-- 2. El renglón: preparada, despachada y recibida son tres cantidades
--
-- `quantity` pasa a significar **preparada**, que es lo que ya significaba: lo
-- que alguien escribió en el borrador. Las otras dos no existían, y sin ellas
-- no hay forma de contestar «¿cuánto salió?» ni «¿cuánto llegó?» sin deducirlo
-- del libro, que es justamente lo que no hay que hacer cuando la pregunta es
-- del negocio y no del libro.
-- ---------------------------------------------------------------------------

ALTER TABLE "stock_transfer_line"
  ADD COLUMN "dispatchedQuantity" DECIMAL,
  ADD COLUMN "receivedQuantity"   DECIMAL;

ALTER TABLE "stock_transfer_line"
  ADD CONSTRAINT "traslado_renglon_despachada_escala" CHECK (
    "dispatchedQuantity" IS NULL OR (
      "dispatchedQuantity" > 0
      AND "dispatchedQuantity" = round("dispatchedQuantity", 3)
      AND "dispatchedQuantity" <= 1000000)),
  ADD CONSTRAINT "traslado_renglon_recibida_escala" CHECK (
    "receivedQuantity" IS NULL OR (
      "receivedQuantity" > 0
      AND "receivedQuantity" = round("receivedQuantity", 3)
      AND "receivedQuantity" <= 1000000)),

  -- Esta fase despacha lo preparado, sin parciales. Si algún día se despacha de
  -- menos, esta CHECK es la decisión comercial que hay que cambiar a propósito.
  ADD CONSTRAINT "traslado_renglon_despacha_lo_preparado" CHECK (
    "dispatchedQuantity" IS NULL OR "dispatchedQuantity" = "quantity"),

  -- **La recepción es EXACTA.** Una diferencia física no se ajusta sola ni se
  -- convierte en merma: el traslado se queda en tránsito y la diferencia se
  -- resolverá con el flujo de incidencias que todavía no existe. Por eso la
  -- regla vive acá y no sólo en el servicio.
  ADD CONSTRAINT "traslado_renglon_recepcion_exacta" CHECK (
    "receivedQuantity" IS NULL OR "receivedQuantity" = "dispatchedQuantity"),

  -- No se recibe lo que no se despachó.
  ADD CONSTRAINT "traslado_renglon_recibida_con_despachada" CHECK (
    "receivedQuantity" IS NULL OR "dispatchedQuantity" IS NOT NULL);

-- ---------------------------------------------------------------------------
-- 3. «Llega entero o no llega», ahora por ESTADO
--
-- Reemplaza la función de la fase 1. Sigue siendo un disparador de restricción
-- diferido —se juzga al COMMIT, porque las mitades se escriben una después de
-- la otra— y sigue exigiendo que cada mitad case en artículo, unidad y
-- cantidad. Lo que cambia es contra qué se compara la cuenta: contra el estado
-- del traslado.
--
--   BORRADOR / CANCELADO  ninguna mitad. Un borrador no escribe libro.
--   DESPACHADO            exactamente la salida, y ninguna entrada. Es tránsito.
--   RECIBIDO              exactamente una de cada. Acá se cierra la promesa.
--   APLICADO              exactamente una de cada, como en la fase 1.
--
-- Y en cualquier estado: nunca dos mitades del mismo lado, y nunca una entrada
-- sin su salida. La mercadería no puede llegar sin haber salido.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION stock_traslado_completo() RETURNS trigger AS $$
DECLARE
  renglon  "stock_transfer_line"%ROWTYPE;
  cab      "stock_transfer"%ROWTYPE;
  salidas  INT;
  entradas INT;
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
        AND "quantity" = coalesce(renglon."dispatchedQuantity", renglon."quantity")),
    count(*) FILTER (
      WHERE "type" = 'TRANSFER_IN' AND "branchId" = cab."toBranchId"
        AND "quantity" = coalesce(renglon."receivedQuantity", renglon."quantity"))
  INTO salidas, entradas
  FROM "stock_ledger"
  WHERE "transferLineId" = renglon.id
    AND "productId" = renglon."productId"
    AND "unit" = renglon."unit";

  IF salidas > 1 OR entradas > 1 THEN
    RAISE EXCEPTION
      'Un renglón de traslado no puede tener dos salidas ni dos entradas. '
      'Se encontraron % y %.', salidas, entradas;
  END IF;

  IF entradas = 1 AND salidas = 0 THEN
    RAISE EXCEPTION
      'Una entrada de traslado sin su salida no existe: la mercadería no puede '
      'llegar a % sin haber salido de %.', cab."toBranchId", cab."fromBranchId";
  END IF;

  IF cab."status"::text IN ('BORRADOR', 'CANCELADO') THEN
    IF salidas > 0 OR entradas > 0 THEN
      RAISE EXCEPTION
        'Un traslado en % no escribe en el libro. Se encontraron % salidas y % '
        'entradas.', cab."status", salidas, entradas;
    END IF;

  ELSIF cab."status"::text = 'DESPACHADO' THEN
    IF salidas <> 1 THEN
      RAISE EXCEPTION
        'Un traslado despachado necesita exactamente una salida en % por cada '
        'renglón, del mismo artículo, unidad y cantidad. Se encontraron %.',
        cab."fromBranchId", salidas;
    END IF;
    IF entradas <> 0 THEN
      RAISE EXCEPTION
        'Un traslado despachado todavía no llegó: no puede tener entradas en %. '
        'Se encontraron %.', cab."toBranchId", entradas;
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
-- 4. El estado no se alcanza sin lo que promete
--
-- El disparador de arriba mira el libro cuando SE ESCRIBE el libro. Falta el
-- otro lado: pasar un traslado a RECIBIDO sin insertar ninguna fila no
-- dispararía nada, y quedaría cerrado sin haber llegado.
--
-- Diferido también, y por la misma razón: dentro de la transacción el estado y
-- los renglones se acomodan en varios pasos.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION stock_traslado_estado_coherente() RETURNS trigger AS $$
DECLARE
  renglones INT;
  faltan    INT;
BEGIN
  IF NEW."status"::text NOT IN ('DESPACHADO', 'RECIBIDO') THEN
    RETURN NEW;
  END IF;

  SELECT count(*) INTO renglones FROM "stock_transfer_line" WHERE "transferId" = NEW.id;
  IF renglones = 0 THEN
    RAISE EXCEPTION 'Un traslado sin renglones no se despacha ni se recibe.';
  END IF;

  IF NEW."status"::text = 'DESPACHADO' THEN
    SELECT count(*) INTO faltan
      FROM "stock_transfer_line" l
     WHERE l."transferId" = NEW.id
       AND (l."dispatchedQuantity" IS NULL
            OR (SELECT count(*) FROM "stock_ledger" m
                 WHERE m."transferLineId" = l.id AND m."type" = 'TRANSFER_OUT') <> 1);
    IF faltan > 0 THEN
      RAISE EXCEPTION
        'Un traslado despachado necesita la cantidad despachada y su salida en '
        'el libro por cada renglón. Faltan en %.', faltan;
    END IF;

  ELSE
    SELECT count(*) INTO faltan
      FROM "stock_transfer_line" l
     WHERE l."transferId" = NEW.id
       AND (l."receivedQuantity" IS NULL
            OR l."receivedQuantity" <> l."dispatchedQuantity"
            OR (SELECT count(*) FROM "stock_ledger" m
                 WHERE m."transferLineId" = l.id AND m."type" = 'TRANSFER_IN') <> 1);
    IF faltan > 0 THEN
      RAISE EXCEPTION
        'Un traslado no se cierra con una mitad faltante ni con una cantidad '
        'distinta de la despachada. Renglones sin recepción completa: %.', faltan;
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "stock_traslado_estado_coherente"
  AFTER INSERT OR UPDATE ON "stock_transfer"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION stock_traslado_estado_coherente();

-- ---------------------------------------------------------------------------
-- 5. Las transiciones, y lo que ya no se reescribe
--
-- Un traslado avanza; no vuelve. Y lo que quedó decidido —origen, destino, la
-- operación del despacho, el instante del despacho— es historia: cambiarlo
-- dejaría el libro diciendo una cosa y el traslado otra, sin que ninguna fila
-- del libro cambie.
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
    IF NEW."status"::text <> 'RECIBIDO' THEN
      RAISE EXCEPTION
        'Un traslado despachado sólo se recibe (se intentó %). La mercadería ya '
        'salió de la sucursal de origen: no hay vuelta atrás sin un movimiento '
        'nuevo, y esta fase no los tiene.', NEW."status";
    END IF;
  ELSE
    RAISE EXCEPTION 'Un traslado % es definitivo: no cambia de estado.', OLD."status";
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- AFTER y no BEFORE: con BEFORE este disparador se comería los mensajes de las
-- CHECK de coherencia de estado, que son más precisos. Es la misma lección que
-- dejó la fase 4 con el disparador del corte.
CREATE TRIGGER "stock_traslado_transicion"
  AFTER UPDATE ON "stock_transfer"
  FOR EACH ROW EXECUTE FUNCTION stock_traslado_transicion();

-- ---------------------------------------------------------------------------
-- 6. Los renglones, inmutables desde el despacho
--
-- En borrador se editan libremente: para eso es un borrador. Despachado, lo
-- único que puede cambiar es la cantidad recibida. Recibido o cancelado, nada.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION stock_traslado_renglon_inmutable() RETURNS trigger AS $$
DECLARE estado text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    SELECT "status"::text INTO estado FROM "stock_transfer" WHERE id = OLD."transferId";
    -- Si la cabecera ya no está, esto viene de un borrado en cascada de la
    -- cabecera y no de alguien sacando un renglón.
    IF estado IS NULL OR estado = 'BORRADOR' THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'Los renglones de un traslado % no se borran.', estado;
  END IF;

  SELECT "status"::text INTO estado FROM "stock_transfer" WHERE id = NEW."transferId";

  IF estado = 'BORRADOR' THEN RETURN NEW; END IF;

  IF estado = 'DESPACHADO' THEN
    IF NEW."productId" <> OLD."productId"
       OR NEW."quantity" <> OLD."quantity"
       OR NEW."unit" <> OLD."unit"
       OR NEW."dispatchedQuantity" IS DISTINCT FROM OLD."dispatchedQuantity" THEN
      RAISE EXCEPTION
        'Un renglón despachado no se edita: lo único que se le registra es la '
        'cantidad recibida.';
    END IF;
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'Los renglones de un traslado % no se modifican.', estado;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "stock_traslado_renglon_inmutable"
  AFTER UPDATE OR DELETE ON "stock_transfer_line"
  FOR EACH ROW EXECUTE FUNCTION stock_traslado_renglon_inmutable();

-- ---------------------------------------------------------------------------
-- 7. Apertura y corte, también para los traslados
--
-- El disparador de la fase 4 filtra `type <> 'PURCHASE_IN'`, así que los
-- traslados no estaban cubiertos. La regla es la misma y por el mismo motivo:
-- la mercadería anterior al corte YA está contada en la apertura, y moverla
-- otra vez la contaría dos veces.
--
-- Vale para las dos mitades y contra el corte de SU sucursal: la salida contra
-- el corte del origen, la entrada contra el del destino.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION stock_traslado_posterior_al_corte() RETURNS trigger AS $$
DECLARE corte timestamptz;
BEGIN
  IF NEW."type" NOT IN ('TRANSFER_OUT', 'TRANSFER_IN') THEN
    RETURN NEW;
  END IF;

  SELECT s."cutoffAt" INTO corte
    FROM "stock_count_session" s
   WHERE s."branchId" = NEW."branchId" AND s."status" = 'CONFIRMADA'
   LIMIT 1;

  IF corte IS NULL THEN
    RAISE EXCEPTION
      'No se puede trasladar mercadería en una sucursal sin apertura confirmada. '
      'Sus artículos no están en cero: están sin contar.';
  END IF;

  IF NEW."effectiveAt" <= corte THEN
    RAISE EXCEPTION
      'Un traslado no puede tener fecha efectiva anterior o igual al corte de '
      'la apertura de su sucursal (% <= %). Esa mercadería ya está contada en '
      'el conteo inicial.', NEW."effectiveAt", corte;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "stock_traslado_posterior_al_corte"
  AFTER INSERT ON "stock_ledger"
  FOR EACH ROW EXECUTE FUNCTION stock_traslado_posterior_al_corte();

-- ---------------------------------------------------------------------------
-- 8. El interruptor de traslados reales
--
-- El tercero, y por la misma razón por la que hay dos: son decisiones
-- distintas. Mover mercadería entre sucursales de verdad no requiere lo mismo
-- que recibir compras, y mientras las ventas no descuenten, un traslado real
-- mueve saldos que nadie va a poder verificar contra la góndola.
-- ---------------------------------------------------------------------------

ALTER TABLE "stock_module_setting"
  ADD COLUMN "realTransfersEnabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "transfersChangedById" TEXT,
  ADD COLUMN "transfersChangedAt"   TIMESTAMP(3),
  ADD COLUMN "transfersReason"      TEXT;

ALTER TABLE "stock_module_setting"
  ADD CONSTRAINT "stock_module_setting_traslados_con_motivo" CHECK (
    "realTransfersEnabled" = false OR (
      "transfersChangedById" IS NOT NULL
      AND "transfersChangedAt" IS NOT NULL
      AND "transfersReason" IS NOT NULL)),
  ADD CONSTRAINT "stock_module_setting_transfersChangedById_fkey"
    FOREIGN KEY ("transfersChangedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- La defensa del interruptor, en la base y no sólo en el servicio.
--
-- Un traslado es ficticio si lo es la apertura de su ORIGEN: no tiene sentido
-- despachar mercadería inventada desde un inventario real. Ficticio sólo corre
-- contra una base cuyo nombre diga test, e2e o demo; real exige el interruptor.
CREATE OR REPLACE FUNCTION stock_traslado_permitido() RETURNS trigger AS $$
DECLARE
  ficticia   boolean;
  habilitado boolean;
BEGIN
  IF NEW."status"::text NOT IN ('DESPACHADO', 'RECIBIDO', 'APLICADO') THEN
    RETURN NEW;
  END IF;

  SELECT s."ficticia" INTO ficticia
    FROM "stock_count_session" s
   WHERE s."branchId" = NEW."fromBranchId" AND s."status" = 'CONFIRMADA'
   LIMIT 1;

  IF ficticia IS NULL THEN
    RAISE EXCEPTION
      'La sucursal de origen no tiene una apertura confirmada de Stock ERP. Sin '
      'apertura no hay saldo del cual despachar.';
  END IF;

  IF ficticia THEN
    IF current_database() !~ '(^|[_-])(e2e|test|demo)([_-]|$)' THEN
      RAISE EXCEPTION
        'Un traslado sobre una apertura ficticia sólo se aplica contra una base '
        'de pruebas: el nombre tiene que contener "e2e", "test" o "demo". Base '
        'vista: %', current_database();
    END IF;
  ELSE
    SELECT "realTransfersEnabled" INTO habilitado FROM "stock_module_setting" LIMIT 1;
    IF habilitado IS NOT TRUE THEN
      RAISE EXCEPTION
        'El interruptor de traslados reales de Stock ERP está apagado. Los '
        'saldos todavía no incluyen ventas: mover mercadería real entre '
        'sucursales dejaría dos inventarios que nada verifica.';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "stock_traslado_permitido"
  AFTER INSERT OR UPDATE ON "stock_transfer"
  FOR EACH ROW EXECUTE FUNCTION stock_traslado_permitido();

-- ---------------------------------------------------------------------------
-- 9. Reiniciar las bases de prueba: los disparadores nuevos también se apagan
--
-- La lista de tablas sigue siendo explícita y sin CASCADE. Lo que se agrega es
-- apagar los disparadores nuevos, porque si no el TRUNCATE de traslados se
-- pelearía con la inmutabilidad de sus renglones.
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
  ALTER TABLE "stock_transfer_line" ENABLE TRIGGER "stock_traslado_renglon_inmutable";
  ALTER TABLE "stock_transfer" ENABLE TRIGGER "stock_traslado_transicion";
END;
$$ LANGUAGE plpgsql;
