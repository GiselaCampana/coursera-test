-- Stock ERP, fase 3: la apertura que inaugura una sucursal.
--
-- QUÉ SE REUTILIZA, Y POR QUÉ NO HAY TABLAS NUEVAS DE APERTURA
--
-- La fase 1 ya dejó las dos tablas que esta fase necesita, y crear
-- `stock_opening` / `stock_opening_line` habría sido duplicarlas:
--
--   `stock_count_session`       la sesión de conteo. Una apertura ES una sesión
--                               de conteo: la primera de esa sucursal.
--   `product_stock_activation`  el estado de un artículo EN una sucursal, con
--                               su corte, su motivo y el movimiento que lo
--                               activó. Es la línea de la apertura.
--
-- Lo que se agrega son columnas que faltaban, no estructuras paralelas.
--
--
-- LOS CINCO ESTADOS FUNCIONALES NO SON UNA COLUMNA NUEVA
--
-- Se derivan de lo que ya existe, y eso es deliberado: dos columnas de estado
-- en la misma fila se contradicen tarde o temprano.
--
--   PENDIENTE         state = SIN_INICIAR / LISTO_PARA_CONTAR y countedQuantity NULL
--   CONTADO           countedQuantity > 0
--   CONTADO_CERO      countedQuantity = 0
--   NO_SE_MANEJA      state = NO_SE_MANEJA (ya exige motivo por CHECK de la fase 1)
--   BLOQUEADO_UNIDAD  state = PENDIENTE_CONFIGURACION
--
-- Una fila OMITIDA no es cero: `countedQuantity` nula y cero son valores
-- distintos, y ninguna consulta los confunde.

-- Los estados BORRADOR y CONFIRMADA los agrega la migración anterior,
-- 20260923150000_stock_erp_fase_3_estados, por lo que allí se explica.

-- ---------------------------------------------------------------------------
-- 2. El interruptor del módulo
--
-- Persistente y auditado, NO una variable de entorno. Una variable se cambia
-- en un panel sin dejar rastro y sin que nadie la apruebe; esto exige un
-- permiso sensible, un motivo y queda en la auditoría.
--
-- Una sola fila, garantizada por la columna `unica`: es un interruptor del
-- módulo, no una preferencia por sucursal.
-- ---------------------------------------------------------------------------
CREATE TABLE "stock_module_setting" (
    "id" TEXT NOT NULL,
    -- Siempre true. Con el índice único de abajo, impide una segunda fila.
    "unica" BOOLEAN NOT NULL DEFAULT true,

    -- Mientras esté en false, una apertura con datos REALES no se confirma.
    "realOpeningEnabled" BOOLEAN NOT NULL DEFAULT false,

    "changedById" TEXT,
    "changedAt" TIMESTAMP(3),
    "reason" TEXT,

    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "stock_module_setting_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "stock_module_setting_unica_key" ON "stock_module_setting"("unica");

ALTER TABLE "stock_module_setting"
  ADD CONSTRAINT "stock_module_setting_unica_true" CHECK ("unica" = true),
  -- Encenderlo exige decir quién y por qué. Apagarlo no: apagar es la posición
  -- segura y no puede quedar trabada por un formulario incompleto.
  ADD CONSTRAINT "stock_module_setting_encendido_con_motivo" CHECK (
    "realOpeningEnabled" = false
    OR ("changedById" IS NOT NULL AND "changedAt" IS NOT NULL AND "reason" IS NOT NULL)
  );

ALTER TABLE "stock_module_setting"
  ADD CONSTRAINT "stock_module_setting_changedById_fkey"
  FOREIGN KEY ("changedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- 3. La sesión de apertura
-- ---------------------------------------------------------------------------

-- El instante en que TERMINÓ el conteo físico. TIMESTAMPTZ, no TIMESTAMP: la
-- persona elige una hora argentina y lo que se guarda es el instante, no el
-- texto. Sin zona, un corte «a las 20:00» significaría cosas distintas según
-- dónde corra el servidor.
ALTER TABLE "stock_count_session" ADD COLUMN "cutoffAt" TIMESTAMPTZ(3);

-- Cuándo se sacó la foto del catálogo. Sirve para detectar que entraron
-- artículos activos nuevos entre la preparación y la confirmación.
ALTER TABLE "stock_count_session" ADD COLUMN "catalogSnapshotAt" TIMESTAMP(3);

ALTER TABLE "stock_count_session" ADD COLUMN "confirmedById" TEXT;
ALTER TABLE "stock_count_session" ADD COLUMN "confirmedAt" TIMESTAMP(3);
ALTER TABLE "stock_count_session" ADD COLUMN "operationId" TEXT;

-- Si los datos son inventados. Las aperturas de homologación van en true y
-- sólo se confirman contra una base de pruebas; las reales exigen el
-- interruptor. Lo comprueba un disparador más abajo, no sólo el servicio.
ALTER TABLE "stock_count_session" ADD COLUMN "ficticia" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "stock_count_session"
  ADD CONSTRAINT "stock_count_session_operationId_fkey"
  FOREIGN KEY ("operationId") REFERENCES "stock_operation"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "stock_count_session_confirmedById_fkey"
  FOREIGN KEY ("confirmedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Una sesión CONFIRMADA no puede quedar a medias.
ALTER TABLE "stock_count_session"
  ADD CONSTRAINT "sesion_confirmada_completa" CHECK (
    "status" <> 'CONFIRMADA'
    OR ("cutoffAt" IS NOT NULL AND "confirmedById" IS NOT NULL
        AND "confirmedAt" IS NOT NULL AND "operationId" IS NOT NULL)
  );

-- UNA sola apertura confirmada por sucursal, garantizada por la base.
--
-- Índice parcial: los borradores no chocan entre sí, pero dos confirmaciones
-- simultáneas de la misma sucursal no pueden ganar las dos. Esto es lo que
-- hace que la concurrencia se resuelva en PostgreSQL y no en una comprobación
-- del servicio que dos procesos pueden pasar a la vez.
CREATE UNIQUE INDEX "una_apertura_confirmada_por_sucursal"
  ON "stock_count_session" ("branchId")
  WHERE "status" = 'CONFIRMADA';

-- ---------------------------------------------------------------------------
-- 4. La línea de la apertura, sobre la activación que ya existía
-- ---------------------------------------------------------------------------

-- Lo contado. NULA no es cero: nula significa «nadie lo contó todavía».
--
-- DECIMAL sin escala, igual que `stock_ledger.quantity` de la fase 1, y NO
-- DECIMAL(14,3). HALLAZGO al probarlo: con la escala fija, PostgreSQL redondea
-- 4.2401 a 4.240 AL INSERTAR, y recién después evalúa el CHECK — que entonces
-- pasa siempre. El control de tres decimales quedaba de adorno y el cuarto
-- decimal entraba en silencio, que es justo lo que no puede pasar con una
-- cantidad de inventario. Sin escala, el valor llega entero al CHECK y se
-- rechaza.
ALTER TABLE "product_stock_activation" ADD COLUMN "countedQuantity" DECIMAL;
ALTER TABLE "product_stock_activation" ADD COLUMN "countedUnit" "StockUnit";
-- Quién lo contó y cuándo. La apertura la firma quien confirma, pero el conteo
-- lo hace otra persona, y esa distinción importa cuando algo no cierra.
ALTER TABLE "product_stock_activation" ADD COLUMN "countedById" TEXT;
ALTER TABLE "product_stock_activation" ADD COLUMN "countedAt" TIMESTAMP(3);

ALTER TABLE "product_stock_activation"
  ADD CONSTRAINT "product_stock_activation_countedById_fkey"
  FOREIGN KEY ("countedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "product_stock_activation"
  -- Tres decimales, como el resto del libro. 4.2401 se rechaza acá, antes de
  -- cualquier cast que lo redondearía en silencio.
  ADD CONSTRAINT "activacion_conteo_escala" CHECK (
    "countedQuantity" IS NULL
    OR ("countedQuantity" >= 0
        AND "countedQuantity" = round("countedQuantity", 3)
        AND "countedQuantity" <= 1000000)
  ),
  -- Si hay cantidad contada, hay unidad y hay autor. Un número sin unidad no
  -- es una cantidad.
  ADD CONSTRAINT "activacion_conteo_con_unidad" CHECK (
    "countedQuantity" IS NULL
    OR ("countedUnit" IS NOT NULL AND "countedById" IS NOT NULL AND "countedAt" IS NOT NULL)
  ),
  -- Un artículo que la sucursal no maneja no se cuenta. Tener las dos cosas
  -- sería no saber cuál mandó.
  ADD CONSTRAINT "activacion_no_se_maneja_sin_conteo" CHECK (
    "state" <> 'NO_SE_MANEJA' OR "countedQuantity" IS NULL
  );

-- ---------------------------------------------------------------------------
-- 5. El corte es inmutable una vez confirmada la apertura
--
-- Y con él, la sucursal y la bandera de ficticia. Mover el corte de una
-- apertura confirmada reinterpretaría qué quedó adentro y qué afuera del
-- conteo, sin tocar una sola fila del libro.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION stock_count_session_corte_inmutable() RETURNS trigger AS $$
BEGIN
  IF OLD."status" = 'CONFIRMADA' THEN
    IF NEW."cutoffAt" IS DISTINCT FROM OLD."cutoffAt" THEN
      RAISE EXCEPTION
        'La apertura ya está confirmada: su fecha y hora de corte no se cambia. '
        'Mover el corte reinterpretaría qué quedó dentro del conteo.';
    END IF;
    IF NEW."branchId" IS DISTINCT FROM OLD."branchId" THEN
      RAISE EXCEPTION 'Una apertura confirmada no cambia de sucursal.';
    END IF;
    IF NEW."ficticia" IS DISTINCT FROM OLD."ficticia" THEN
      RAISE EXCEPTION 'Una apertura confirmada no cambia de ficticia a real ni al revés.';
    END IF;
    IF NEW."status" <> 'CONFIRMADA' THEN
      RAISE EXCEPTION 'Una apertura confirmada no vuelve a borrador.';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "stock_count_session_corte_inmutable"
  BEFORE UPDATE ON "stock_count_session"
  FOR EACH ROW EXECUTE FUNCTION stock_count_session_corte_inmutable();

-- ---------------------------------------------------------------------------
-- 6. La defensa del interruptor, EN LA BASE
--
-- No alcanza con que el servicio lo compruebe: el servicio se puede saltear
-- con una consulta, y una apertura escrita de costado es indistinguible de una
-- buena una semana después.
--
-- Dos reglas, y son complementarias:
--
--   * una apertura FICTICIA sólo se confirma contra una base cuyo nombre diga
--     test, e2e o demo —la misma regla que ya usa el sembrador—;
--   * una apertura REAL sólo se confirma con el interruptor encendido.
--
-- Juntas dejan una sola combinación posible en una base conectada: datos
-- reales, con el interruptor deliberadamente encendido por alguien.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION stock_apertura_permitida() RETURNS trigger AS $$
DECLARE habilitado boolean;
BEGIN
  IF NEW."status" <> 'CONFIRMADA' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD."status" = 'CONFIRMADA' THEN
    RETURN NEW;  -- ya estaba confirmada; no se vuelve a juzgar
  END IF;

  IF NEW."ficticia" THEN
    IF current_database() !~ '(^|[_-])(e2e|test|demo)([_-]|$)' THEN
      RAISE EXCEPTION
        'Una apertura de datos ficticios sólo se confirma contra una base de '
        'pruebas: el nombre tiene que contener "e2e", "test" o "demo". Base vista: %',
        current_database();
    END IF;
  ELSE
    SELECT "realOpeningEnabled" INTO habilitado FROM "stock_module_setting" LIMIT 1;
    IF habilitado IS NOT TRUE THEN
      RAISE EXCEPTION
        'El interruptor de aperturas reales de Stock ERP está apagado. '
        'Una apertura con datos reales no se confirma hasta que alguien lo '
        'encienda con motivo y quede auditado.';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "stock_apertura_permitida"
  BEFORE INSERT OR UPDATE ON "stock_count_session"
  FOR EACH ROW EXECUTE FUNCTION stock_apertura_permitida();

-- ---------------------------------------------------------------------------
-- 7. La fila del interruptor, apagada
--
-- Nace apagada y sin autor: encenderla es una decisión que todavía no tomó
-- nadie. El seed NO la toca —no la nombra siquiera— así que resembrar no puede
-- encenderla.
-- ---------------------------------------------------------------------------
INSERT INTO "stock_module_setting" ("id", "unica", "realOpeningEnabled", "createdAt", "updatedAt")
VALUES ('stock-module-setting', true, false, now(), now());
