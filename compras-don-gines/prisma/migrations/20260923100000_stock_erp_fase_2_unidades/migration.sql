-- Stock ERP, fase 2: la separación de unidades.
--
-- Cuatro conceptos que hasta hoy vivían apretados en una sola columna:
--
--   1. la unidad que INFORMA el catálogo  -> products.catalogUnit   (dato externo)
--   2. la unidad de EXISTENCIA del ERP    -> product_stock_config.stockUnit
--                                            (decisión interna, aprobada a mano)
--   3. la PRESENTACIÓN de compra          -> product_purchase_presentation
--   4. la unidad ESCRITA EN LA FACTURA    -> document_items.unit
--
-- Todo lo de acá es aditivo: una columna nula, una restricción de unicidad y
-- dos CHECK. Ninguna fila existente cambia de valor.
--
--
-- POR QUÉ catalogUnit NACE NULA Y NO SE RELLENA DESDE purchaseUnit
--
-- La tentación es obvia: `UPDATE products SET "catalogUnit" = "purchaseUnit"`.
-- Sería un error, y conviene dejar escrito por qué para que nadie lo agregue
-- después creyendo que se olvidó.
--
-- `products.purchaseUnit` es una columna de PROCEDENCIA MEZCLADA. La escriben,
-- hoy, al menos cinco caminos distintos:
--
--   * la sincronización del catálogo, con `articulo.unidad`, y sólo cuando
--     Control de Stock la trae (`stock-sync.ts`, `catalogo.ts`);
--   * el formulario de precios, con lo que elija una persona, y con `?? 'KG'`
--     como valor por omisión cuando el campo viene vacío (`precios/acciones.ts`);
--   * el formulario de asociaciones, igual (`asociaciones/acciones.ts`);
--   * el backfill de productos (`backfill-productos.ts`);
--   * el servicio de precios (`pricing.ts`).
--
-- Ninguna fila registra cuál de esos caminos la escribió. Así que para un
-- artículo cualquiera es IMPOSIBLE demostrar si su `purchaseUnit` es un dato
-- que vino del catálogo o un KG que puso por omisión un formulario que alguien
-- guardó sin mirar.
--
-- Copiarla a `catalogUnit` convertiría todas esas conjeturas en «lo que dice el
-- catálogo», que es exactamente la mentira que esta separación viene a impedir.
-- Un nulo dice «no lo sé todavía» y se llena solo en la próxima sincronización.
-- Un valor dudoso presentado como externo no se corrige nunca, porque nadie
-- vuelve a mirar un campo que ya tiene algo.
--
-- `purchaseUnit` NO se toca: sigue existiendo, con su nombre y su
-- comportamiento, y la sincronización la sigue actualizando como hoy.

-- 1. La unidad informada por el catálogo. Nula = todavía no se sincronizó.
ALTER TABLE "products" ADD COLUMN "catalogUnit" "PurchaseUnit";

-- 2. Una presentación por artículo, proveedor y código del proveedor.
--
-- En PostgreSQL dos NULL nunca son iguales entre sí, así que esta restricción
-- NO impide varias presentaciones genéricas (sin proveedor). Es una limitación
-- conocida y aceptada: lo que protege es el caso que importa —dos factores
-- distintos para el mismo código del mismo proveedor—, y el servicio cubre el
-- resto. Se deja dicho para que nadie lea de más en esta línea.
CREATE UNIQUE INDEX "product_purchase_presentation_producto_proveedor_codigo_key"
  ON "product_purchase_presentation" ("productId", "supplierId", "supplierCode");

-- 3. El factor de conversión, con precisión fija.
--
-- La columna nació como DECIMAL sin precisión, que en PostgreSQL es «lo que
-- venga». Se fija en (18,6): suficiente para una caja de 12 unidades y para
-- una horma de 4,250 kg, y exacto, que es lo único que no se negocia cuando el
-- número multiplica cantidades de inventario.
--
-- NO se agrega un CHECK de positividad: la fase 1 ya trae
-- `presentacion_factor_positivo`, y es MÁS fuerte que lo que yo iba a escribir
-- —además de `> 0` exige `= round(…, 6)`—. Lo escribí, lo vi duplicado al
-- correr las pruebas y lo saqué: dos restricciones que dicen casi lo mismo
-- hacen dudar de cuál manda, y la que mandaría no es la mía.
ALTER TABLE "product_purchase_presentation"
  ALTER COLUMN "conversionFactor" TYPE DECIMAL(18,6);

-- 4. Una unidad aprobada no puede quedar sin unidad.
--
-- `stockUnit` es nula mientras el estado es PENDIENTE, y obligatoria al
-- aprobar. Eso estaba en un comentario del esquema; acá pasa a ser una regla
-- que la base hace cumplir. Un APROBADA sin unidad sería una configuración que
-- dice estar resuelta y no resuelve nada.
ALTER TABLE "product_stock_config"
  ADD CONSTRAINT "product_stock_config_aprobada_con_unidad"
  CHECK ("status" <> 'APROBADA' OR ("stockUnit" IS NOT NULL AND "approvedById" IS NOT NULL AND "approvedAt" IS NOT NULL));
