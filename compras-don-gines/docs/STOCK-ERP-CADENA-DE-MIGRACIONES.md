# La cadena de migraciones, de producción a la fase 8

Auditoría de todo lo que hay que aplicar para llevar una base que está en
producción (`f60c68c`) hasta la cabeza de la fase 8.

La conclusión, primero: **la cadena es aditiva**. Si las migraciones se aplican y
después el build nuevo falla, el código productivo actual sigue funcionando. Abajo
está por qué, y lo que se hizo para comprobarlo en vez de suponerlo.

Las afirmaciones de este documento están además como **pruebas** en
`tests/integration/stock-erp-cadena-de-migraciones.test.ts`. No es redundancia: un
documento se pudre con el primer commit y una prueba se pone roja. Ese archivo
nació de una rotura deliberada — una migración nueva que hacía
`UPDATE "documents"` no ponía nada en rojo.

## Qué agrega, exactamente

Producción tiene **21** migraciones aplicadas. La cadena agrega **nueve**, todas
de Stock ERP, en este orden:

| # | Migración | Tablas | Enums | Índices | CHECK | Disparadores |
|---|---|---|---|---|---|---|
| 1 | `stock_erp_fase_1` | 10 | 9 | 28 | 54 | 7 |
| 2 | `stock_erp_fase_2_unidades` | — | — | 1 | 1 | — |
| 3 | `stock_erp_fase_3_estados` | — | 2 | — | — | — |
| 4 | `stock_erp_fase_3_apertura` | 1 | — | 2 | 10 | 2 |
| 5 | `stock_erp_corte_con_zona` | — | — | — | 2 | — |
| 6 | `stock_erp_fase_4_recepcion` | 1 | 1 | 5 | 6 | 3 |
| 7 | `stock_erp_fase_6_estados` | — | 4 | — | — | — |
| 8 | `stock_erp_fase_6_traslados` | — | — | 3 | 18 | 4 |
| 9 | `stock_erp_fase_7_correcciones` | 2 | 3 | 10 | 26 | 4 |

La fase 5 no tiene migración: fue de consultas. Las fases 3 y 6 van en dos
migraciones cada una porque PostgreSQL no permite usar un valor de enum recién
agregado en la misma transacción que lo agregó, y Prisma corre cada migración en
una transacción.

**Ninguna migración productiva fue modificada ni borrada.** Verificado con
`git diff f60c68c..stock-erp-fase-8 -- prisma/migrations`: sólo adiciones.

## Por qué es compatible hacia atrás

Las cuatro maneras de romper código que ya está corriendo, y qué hace la cadena
con cada una:

| Riesgo | En la cadena |
|---|---|
| `DROP COLUMN` | **cero** |
| `RENAME` | **cero** |
| `SET NOT NULL` sobre una columna existente | **cero** |
| `DROP TABLE` | **cero** |

Hay cuatro `ALTER COLUMN` y ninguno aprieta nada:

* `product_purchase_presentation.conversionFactor` pasa a `DECIMAL(18,6)` —
  ensancha, y la tabla es de la fase 1: producción no la tiene;
* `stock_count_session.cutoffAt` pasa a `TIMESTAMPTZ(3)` — tabla de la fase 3;
* `stock_transfer.operationId` pierde el `NOT NULL` — **afloja**, para que un
  traslado pueda ser borrador;
* `stock_transfer.status` cambia su valor por omisión a `BORRADOR`.

**La única columna que la cadena agrega a una tabla de Compras** es
`products.catalogUnit`, y es opcional: nace nula y nadie la rellena. El código
viejo no la conoce y no le hace falta.

**Ningún disparador de la cadena vigila una tabla de Compras.** Los 21 quedan
sobre `stock_ledger`, `stock_balance`, `stock_operation`, `stock_receipt`,
`stock_transfer`, `stock_transfer_line`, `stock_count_session`,
`stock_count_line`, `stock_waste` y `product_stock_activation`. Nada sobre
`documents`, `document_items`, `suppliers`, `payments`, `users` ni `roles`. Ésta es
la afirmación que sostiene todo lo demás: un disparador sobre `documents` podría
rechazar un alta que Compras hace hoy.

## Las tres aplicaciones probadas

**1. Base descartable vacía.** Las 31 migraciones desde cero.
`prisma migrate diff` contra el esquema: *No difference detected*.

**2. Base descartable con el esquema productivo anterior y datos ficticios.** Se
aplicaron primero las 21 de producción —desde un worktree temporal en `f60c68c`,
con su propio `prisma migrate deploy`—, se corrió el seed productivo y se cargaron
datos ficticios representativos: proveedor con condición de pago y alias, tres
artículos con sus alias, dos comprobantes (uno validado, uno borrador) con tres
renglones, un archivo con su clave de bucket y su sha256, una agenda de pago con su
evento, un historial de costo y una entrada de auditoría.

Después se aplicaron las nueve. **Conteos y hashes idénticos antes y después**, por
tabla: proveedores, alias, condiciones, artículos, alias de artículo,
comprobantes, renglones, archivos, agenda, eventos de pago, costos, usuarios,
roles con sus permisos y sucursales.

Los hashes se calculan sobre el contenido ordenado y con las columnas nombradas de
a una, **no** sobre un `pg_dump`: un volcado cambia por el solo hecho de haber
migrado y no diría nada sobre los datos. Y nombrar las columnas evita que el hash
cambie por agregar una columna nueva, que es justamente lo que una migración
aditiva hace.

Sobre esa misma base migrada se probó además que **el código productivo sigue
escribiendo**: alta de comprobante, renglones, archivo, agenda de pago, costo,
confirmación del comprobante, edición de artículo, edición de alias y borrado de
un renglón. Todo entró; después se deshizo la sonda.

**3. Restauración aislada del respaldo productivo.** **No ejecutada**: el respaldo
no está disponible en este entorno, y no pido credenciales ni lo reemplazo por una
conexión a producción. El procedimiento exacto, para correr localmente:

```sh
# 1. Restaurar el respaldo en una base NUEVA, con «test» en el nombre.
createdb compras_ensayo_test
pg_restore --no-owner --no-privileges -d compras_ensayo_test <archivo-de-respaldo>

# 2. La foto de antes. El guion está en el repositorio.
psql "postgresql://…/compras_ensayo_test" -f prisma/rollback/foto-de-conservacion.sql \
  > /tmp/foto-antes.txt

# 3. Aplicar la cadena. Nada de `migrate dev` ni `migrate reset`.
DATABASE_URL="postgresql://…/compras_ensayo_test?schema=public" npx prisma migrate deploy

# 4. La foto de después, y comparar.
psql "postgresql://…/compras_ensayo_test" -f prisma/rollback/foto-de-conservacion.sql \
  > /tmp/foto-despues.txt
diff /tmp/foto-antes.txt /tmp/foto-despues.txt && echo "los datos no se movieron"

# 5. Y que no apareció inventario de la nada.
psql "postgresql://…/compras_ensayo_test" -tAc \
  'SELECT (SELECT count(*) FROM stock_ledger), (SELECT count(*) FROM stock_balance),
           (SELECT count(*) FROM stock_outbox)'   -- tiene que dar 0|0|0
```

La base restaurada **se tira después**. No se deja conectada a nada.

## El rollback, en orden inverso

Probado en la base del caso 2, en este orden: fase 7, fase 6, fase 4, corte con
zona, fase 3 apertura, fase 2, fase 1. Los siete guiones aplicaron y la foto de
Compras quedó **idéntica a la original**. La única tabla `stock_*` que sobrevive es
`stock_outbox`, que es de Compras y precede al módulo.

Después se reaplicó la cadena y `migrate diff` no reportó deriva: el viaje redondo
cierra.

**Y con historia, cada guión se niega — el suyo.** Con una apertura confirmada y un
asiento en el libro: los guiones de las fases 7, 6 y 4 aplicaron, porque no había
mermas, ni traslados, ni recepciones que destruir; los de la fase 3 y la fase 1 se
negaron nombrando qué encontraron, y **el libro quedó intacto**.

Que las negativas son lo único que separa una corrida apurada de un inventario
perdido está comprobado por el camino contrario: con las negativas retiradas de los
siete guiones, la cadena inversa aplica entera y **la tabla del libro desaparece
con su historia**.

## Qué no se puede deshacer

Los valores de enum. PostgreSQL no quita un valor sin recrear el tipo, y recrearlo
obliga a reescribir toda columna que lo use. Quedan declarados y sin usar, que es
inofensivo. Los tres tipos que la fase 7 **creó** sí se borran, porque se crearon
ahí.
