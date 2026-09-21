# Compras Don Ginés → Control de Stock

Cómo la mercadería de una factura llega a las existencias de Control de Stock.

Este documento está escrito **desde el código y las pruebas** de este
repositorio, no desde lo que se acordó de palabra. Donde algo todavía no está
implementado o no está acordado dice **pendiente**, y dice qué falta. Si al
leerlo encontrás una diferencia con el código, el código es el que vale y el
documento es el que está mal.

Estado en una línea: **el emisor está construido, probado y enchufado a un
botón; la conexión sigue dormida porque faltan las variables, y el primer
recorrido real todavía no se hizo.**

---

## 1. Por qué hay una bandeja en el medio

Son dos aplicaciones con dos bases y **ninguna transacción que abarque a las
dos**. De ahí sale todo lo demás.

Si la compra se aplicara primero y después se llamara a Control de Stock, una
caída en el medio dejaría la mercadería pagada acá y ausente allá. Si se llamara
primero a Control de Stock, una caída después dejaría existencias que nadie
compró. No hay forma de ordenar esas dos escrituras que sea segura.

Lo que sí se puede garantizar es que **el movimiento no se pierda**:

```
Aplicar la compra                          Despachar (después, y las veces que haga falta)
┌──────────────────────────────┐           ┌─────────────────────────────────────────┐
│ transacción de Compras       │           │ despacharPendientes()                   │
│                              │           │   reclama el lote entero                │
│  · comprobante VALIDADO      │           │   arma el cuerpo   (armarLote)          │
│  · costos, agenda de pago    │           │   POST            (TRANSPORTE_HTTP)     │
│  · anotarIngresos(tx, …) ────┼──┐        │   lee el acuse y marca cada fila        │
│                              │  │        └──────────────┬──────────────────────────┘
└──────────────────────────────┘  │                       │
                                  ▼                       ▼
                        ┌───────────────────┐    ┌──────────────────────┐
                        │  stock_outbox     │───▶│  Control de Stock    │
                        │  (bandeja)        │    │  POST /api/…/purchases│
                        └───────────────────┘    └──────────────────────┘
```

La anotación en la bandeja ocurre **dentro de la misma transacción** que escribe
la compra (`src/lib/services/documents.ts`, en el confirmado). Si la compra se
escribe, los movimientos quedan anotados; si algo falla, no queda ni la compra
ni la anotación. Lo peor que puede pasar después es que el envío tarde, y
mientras tanto la pantalla del comprobante lo dice.

## 2. Aplicar una compra y despachar sus movimientos son dos cosas

Y conviene que se note, porque es la separación que hace que un Control de Stock
caído no impida trabajar.

| | Aplicar la compra | Despachar los movimientos |
|---|---|---|
| Quién lo dispara | una persona, desde la vista previa | `despacharPendientes()` |
| Qué escribe | comprobante, costos, agenda de pago y **filas en la bandeja** | sólo el estado de las filas de la bandeja |
| Si Control de Stock está caído | no se entera: la compra se aplica igual | las filas quedan pendientes y se reintenta |
| Se puede repetir | no: un comprobante se aplica una vez | sí, cuantas veces haga falta |

`anotarIngresos` es idempotente por construcción: la clave del evento se arma
con el comprobante y el renglón, y la base tiene dos unicidades sobre eso, así
que volver a aplicar el mismo comprobante no crea filas nuevas ni pierde el
identificador externo de las que ya se mandaron.

**Quién dispara el despacho hoy:** una persona, desde la pantalla del
comprobante, para ese comprobante. No hay envío automático al aplicar la compra,
ni tarea periódica, ni nada que recorra la bandeja entera. Mirá §2 bis.

## 2 bis. El despacho a mano

La única puerta por la que la aplicación despacha hoy.

En la pantalla del comprobante, quien tenga el permiso `stock.sincronizar` ve
los movimientos anotados —sucursal, código de Control de Stock, PLU, cantidad,
unidad y estado—, los renglones que **no** mueven stock con su motivo, y un
botón que pide confirmación aparte antes de mandar.

Cómo está acotado, que es lo que importa:

- **un comprobante, y sólo ése.** La pantalla no llama a `despacharPendientes()`
  —ahí `documentId` es opcional y sin él manda *todo lo pendiente*— sino a
  `despacharComprobante(user, documentId)`, donde el comprobante es obligatorio
  y se valida antes de tocar nada. Ese modo no se alcanza desde la interfaz ni
  por accidente;
- **el permiso se comprueba en el servidor.** Esconder el botón es una
  comodidad, no una defensa: llamar directamente a la acción encuentra lo mismo;
- **lo ya confirmado no se reenvía**, y lo que salió y no volvió respuesta se
  reintenta por un camino aparte, porque puede haber llegado;
- **queda en la auditoría** con usuario, momento, comprobante y el estado de
  cada movimiento antes y después.

Lo que el despacho **no** toca: el pago, el costo, el egreso, el estado fiscal
ni ningún importe del comprobante.

## 3. Qué entra y qué no

Lo decide `planDeIngresos`, en `src/lib/domain/ingreso-de-stock.ts`, renglón por
renglón:

| Renglón | Qué pasa | Por qué |
|---|---|---|
| Mercadería con artículo del catálogo | **entra** | es lo que se compró |
| Un gasto (flete, envase, **BOLSA GRANDE**) | **sin impacto** | no es mercadería: no hay existencias que mover |
| Mercadería sin artículo asociado | **sin impacto** en el plan | el freno para aplicar ya existe y se ve en la pantalla |
| PLU vacío | **impedimento** | mandar un movimiento sin artículo es mover existencias a ciegas |
| La unidad del renglón no coincide con la del artículo | **impedimento** | kilos contra unidades no se convierten solos |

Sobre la bolsa, que es el caso que más confunde: **queda afuera por ser un
gasto, no por llamarse «BOLSA GRANDE»**. La clasificación es un dato cargado
(`expenseKind`), no una comparación de texto. Esto tiene una prueba propia
justamente porque durante un tiempo la bolsa quedaba afuera por dos razones
superpuestas —era un gasto *y además* no tenía artículo en el catálogo— y romper
cualquiera de las dos no fallaba ninguna prueba. Hoy hay un caso con un gasto
que **sí** tiene artículo, y otro donde alguien le enseñó el alias `4249` a un
producto, así que las dos reglas se ejercitan por separado.

## 4. Códigos de sucursal

Los canónicos, que salen de `branches.code` en la base real de Control de Stock:

| Local | Código |
|---|---|
| Devoto | `devoto` |
| Pueyrredón | `pueyrredon` |
| San Martín | `san_martin` |

Viven en `Branch.stockKey` (único) y están cargados en las tres siembras.

No se manda el nombre —tiene acentos y mayúsculas, y elegir por parecido es
exactamente lo que no se hace con los artículos— ni el identificador interno de
Compras, que cambia de base en base. **Sin `stockKey` cargada no sale nada**: el
lote se marca fallido y el motivo dice qué local le falta el código.

## 5. El contrato, versión 1

Un **POST por compra**, no un pedido por renglón: los movimientos de una factura
se aplican del otro lado en una transacción o no se aplica ninguno. Media compra
ingresada es peor que ninguna, porque la diferencia no se ve en ninguna pantalla
y aparece semanas después.

### Pedido

```
POST <STOCK_INTEGRATION_WRITE_URL>
Authorization: Bearer <STOCK_INTEGRATION_KEY>
Content-Type: application/json
```

El nombre del encabezado (`Authorization`) y el esquema (`Bearer `) **los pone
el código** y no son configurables: el tipo los declara como literales, así que
otro valor no compila. El esquema se agrega solo, y si la clave ya viene con él
no se duplica. Verificado en `src/lib/services/stock-transporte-http.ts` y en
`tests/integration/stock-auth.test.ts`.

Cuerpo (los valores son de ejemplo y no salen de ninguna ejecución real):

```json
{
  "contractVersion": 1,
  "source": "compras-don-gines",
  "purchaseId": "<id del comprobante en Compras>",
  "branchCode": "devoto",
  "document": {
    "documentId": "<id del comprobante en Compras>",
    "type": "A",
    "pointOfSale": "00003",
    "number": "00000185",
    "issuedAt": "2026-09-09",
    "supplierTaxId": "30712345678",
    "supplierName": "Ezra"
  },
  "confirmedBy": { "userId": "<id del usuario>", "name": "Nombre Apellido" },
  "movements": [
    {
      "sourceLineId": "<id del renglón en Compras>",
      "idempotencyKey": "compras-don-gines:compra:<documentId>:<documentItemId>",
      "plu": "1211",
      "quantity": "4.240",
      "unit": "KG",
      "direction": "IN",
      "reason": "PURCHASE"
    }
  ]
}
```

Notas sobre campos que se prestan a confusión:

- `issuedAt` es **la emisión de la factura**, no el momento del envío: el hecho
  es del día que ocurrió.
- `supplierTaxId` va sin guiones: es el identificador, no su presentación.
- `sourceLineId` es el renglón de Compras, y existe para poder volver desde un
  movimiento de Control de Stock hasta la línea de la factura.

### Dirección y motivo

`direction` es **siempre** `IN` y `reason` es **siempre** `PURCHASE`. Son
constantes del dominio, no parámetros: **no existe ningún camino en el código
que registre una compra como egreso**.

### Cantidades: cadenas con exactamente tres decimales

`quantity` es una **cadena decimal de tres posiciones**, para `KG` y para `UNIT`
por igual. Tres bolsas son `"3.000"`.

Por qué importa: la base guarda `Decimal(14,4)`, y al serializarla sin más sale
`"4.24"` donde el papel dice `4,240`. Es el mismo peso, y mientras las dos
puntas comparen decimales da lo mismo; pero **la idempotencia compara
contenido**, y ahí `"4.24"` y `"4.240"` son dos cosas distintas: Control de
Stock vería un conflicto que no existe, sobre un movimiento idéntico al
anterior.

Tres cosas que la normalización **no** hace:

1. No pasa por `Number` ni por ningún flotante binario: los decimales se cuentan
   sobre el texto.
2. No redondea en silencio. Un valor con más de tres decimales significativos no
   es algo que haya que acomodar: es un dato que nadie miró. Mandar `4,2401`
   como `4,240` sería mandar una cantidad que no es la de la factura, con una
   diferencia de gramos que después no se puede rastrear. **Se rechaza el lote
   entero** y el motivo dice cuál era el valor. Los ceros a la derecha no
   cuentan: `4.2400` entra, `4.2401` no.
3. No se aplica adentro. Es sólo el borde del contrato HTTP: los importes, los
   costos y los cálculos internos siguen siendo los mismos decimales de siempre.

### Respuesta

Se espera un acuse del mismo contrato:

```json
{
  "contractVersion": 1,
  "status": "APPLIED",
  "movements": [
    { "idempotencyKey": "compras-don-gines:compra:…:…", "status": "APPLIED", "movementId": "<id en Control de Stock>" }
  ]
}
```

## 6. Idempotencia

```
compras-don-gines:compra:<documentId>:<documentItemId>
```

Una clave por **renglón**, no por lote.

- **No lleva el reloj adentro.** Una clave con hora es una clave distinta en
  cada reintento, y entonces no deduplica nada. Se arma con identificadores que
  ya existen y no cambian.
- **Nunca se genera una nueva en un reintento.** El reintento va con la misma, y
  eso es lo único que impide que la mercadería entre dos veces.
- La base la sostiene con **dos unicidades**: `eventKey` y `documentItemId`. Dos
  filas para el mismo renglón no se pueden escribir ni aunque dos pedidos
  concurrentes lo intenten a la vez.

El caso peligroso, y por qué esto está así: Control de Stock recibe, aplica, y
la respuesta se pierde. Desde acá es **indistinguible** de un pedido que nunca
llegó. Así que el reintento sale igual —es recuperable— y lo único que evita el
ingreso doble es la clave. Tiene prueba propia.

## 7. Dos despachos a la vez

El lote se reclama **entero y en una sola sentencia**, dentro de una
transacción: se toman todas las filas de la compra o ninguna. Quien llega
segundo espera y después no encuentra ninguna en el estado que pedía, así que
saltea la compra completa.

Además se cuentan las filas **sueltas**: un despacho que llegó cuando la compra
ya estaba a medio reclamar vería sólo las que quedaban libres, y sin esa
comprobación mandaría ese pedazo creyendo que es la factura entera.

Por qué no alcanzaba reclamarlas de a una: las filas de una factura se escriben
en la misma transacción y comparten el `createdAt` al milisegundo. Con el orden
empatado PostgreSQL no promete ninguno, así que dos despachos podían recorrerlas
al revés uno del otro, quedarse cada uno con un pedazo y —como ninguno juntaba
el lote entero— retirarse los dos. Nada se perdía, pero no salía nadie. La
regresión provoca ese desorden en vez de esperarlo.

## 8. Cómo se lee cada respuesta

| Lo que llega | Clase | Qué pasa con las filas | Se reintenta |
|---|---|---|---|
| `201` / `200` con `status: APPLIED` | `APLICADO` | `COMPLETADO`, con el `movementId` | — |
| `201` / `200` con `status: ALREADY_APPLIED` | `APLICADO` | `COMPLETADO` | — |
| 200/201 que confirma el lote pero **no** este movimiento | — | esa fila queda `EN_PROCESO` | a pedido |
| `401` / `403` | `SIN_AUTORIZACION` | `FALLIDO` | no: es configuración |
| `409` | `CONFLICTO` | `FALLIDO` | no: la misma clave con otro contenido, hay que mirarlo |
| `422` | `RECHAZADO` | `FALLIDO` | no: el contenido está mal y lo va a seguir estando |
| `429`, `5xx` | `RECUPERABLE` | vuelve a `PENDIENTE` | sí, **con la misma clave** |
| Timeout o conexión cortada | `RECUPERABLE` | vuelve a `PENDIENTE` | sí, **con la misma clave** |
| Otro código | `RESPUESTA_INVALIDA` | queda `EN_PROCESO` | a pedido |
| 200/201 con un cuerpo que no es este contrato | `RESPUESTA_INVALIDA` | queda `EN_PROCESO` | a pedido |
| Falta URL o clave | `SIN_CONFIGURAR` | vuelve a `PENDIENTE` | cuando se configure |

Dos decisiones que conviene entender:

- **Un 200 que no habla este contrato no es un éxito.** Puede ser un
  intermediario contestando, una ruta equivocada o una versión nueva que
  todavía no sabemos leer. Marcarlo como aplicado escondería mercadería que
  nunca entró.
- **Un timeout no es un fracaso.** Es incierto: puede haber llegado. Por eso
  vuelve a la cola en vez de marcarse fallido, y por eso la clave no cambia.

El tiempo límite del pedido es de 15 segundos. Se reintenta hasta 5 veces
(`INTENTOS_MAXIMOS`); pasado eso la fila deja de ser candidata y hay que
mirarla.

## 9. Qué se ve en la aplicación

En la pantalla del comprobante, a partir de `sincronizacionDe(documentId)`:

| Estado | Cuándo |
|---|---|
| `SIN_MOVIMIENTOS` | la compra no tenía mercadería que ingresar |
| `PENDIENTE` | anotado, todavía no enviado (es el estado con la conexión dormida) |
| `EN_PROCESO` | se envió y no se sabe cómo terminó |
| `COMPLETADA` | todas las filas confirmadas por Control de Stock |
| `FALLIDA` | alguna fila fallida; el motivo se muestra |

Un comprobante `VALIDADO` con movimientos sin confirmar está a medio camino, y
la pantalla lo separa a propósito: la diferencia es justamente lo que hay que
poder ver. Los motivos que se muestran nombran el código de estado y **nunca**
llevan la credencial ni nada del cuerpo enviado.

## 10. Variables y secretos

Sólo los nombres. Los valores no van en este repositorio, ni en un registro, ni
en una captura, ni en un mensaje.

| Nombre | Para qué |
|---|---|
| `STOCK_INTEGRATION_WRITE_URL` | la dirección **completa** del receptor de Control de Stock |
| `STOCK_INTEGRATION_KEY` | la clave compartida; la misma para leer el catálogo y para escribir |

Dónde se cargan: en el panel del servicio en Render (variables de entorno del
servicio), y la clave además del lado de Control de Stock. Nunca en `.env` del
repositorio, nunca en un archivo versionado y **nunca con prefijo
`NEXT_PUBLIC_`**, que las publicaría al navegador. `.env.example` las lista
vacías, sólo como documentación.

Dos cosas que el código hace a propósito:

- **La URL de escritura no se deriva de la del catálogo.** Reemplazar texto
  dentro de una URL funciona hasta el día que el otro lado mueve una ruta, y
  entonces manda movimientos de stock a un lugar que nadie revisó.
- **Sin `STOCK_INTEGRATION_WRITE_URL` no se abre ningún socket.** No es que el
  pedido falle: no se intenta. La respuesta es `SIN_CONFIGURAR`, nombrando la
  variable que falta —el nombre, nunca el valor—, el ingreso queda anotado en la
  bandeja y la pantalla lo dice. Es el estado en el que está hoy, y es
  deliberado.

Sólo se acepta `https`, salvo contra la máquina local, que es lo que hace falta
para las pruebas. Un destino en `http` sería mandar el secreto en claro sin que
nada lo advierta.

## 11. Desplegar, verificar, reintentar, volver atrás

### Desplegar la conexión (cuando corresponda)

1. Cargar `STOCK_INTEGRATION_WRITE_URL` y `STOCK_INTEGRATION_KEY` en el panel
   del servicio. Reiniciar.
2. Verificar sobre **un** comprobante, no sobre la base entera.

### Verificar

- La pantalla del comprobante deja de decir que falta configurar.
- `sincronizacionDe` pasa a `COMPLETADA` y cada fila tiene su `externalId`.
- Del lado de Control de Stock, el movimiento aparece **una sola vez** por
  `idempotencyKey`.

### Reintentar

- `RECUPERABLE` y `SIN_CONFIGURAR` vuelven solos a `PENDIENTE`: alcanza con
  volver a despachar.
- `EN_PROCESO` **no se reintenta solo**: quedó sin respuesta y puede haber
  llegado. Se reintenta a pedido (`incluirInciertas`), y ahí la clave hace su
  trabajo.
- `FALLIDO` por `409` o `422` no se reenvía: hay que mirar el contenido.

### Volver atrás

Vaciar `STOCK_INTEGRATION_WRITE_URL` y reiniciar. La integración vuelve a quedar
dormida: los ingresos se siguen anotando, no sale ningún pedido y no se pierde
nada. **No hace falta desplegar código para cortarla.**

Lo que este lado **no** puede hacer es deshacer un movimiento ya aplicado del
otro lado: no hay compensación implementada, y un egreso compensatorio sería
justamente el movimiento que este sistema no emite. Corregir un ingreso mal
aplicado es hoy una tarea manual en Control de Stock. **Pendiente**, si alguna
vez hace falta automatizarlo.

## 12. Qué falta para el primer recorrido real

Por orden, y separando lo que depende de cada lado:

**De este lado (código): listo.** El transporte está instalado —la composición
lo elige en `stock-despacho-manual.ts` y lo pasa explícito— y el disparador es
el botón de §2 bis, acotado a un comprobante.

**De configuración:**

1. Cargar las dos variables (§10) en el servicio aislado. **Hoy no están**, y
   mientras no estén el botón queda bloqueado diciendo cuáles faltan.

**Del lado de Control de Stock:**

2. Respaldo de las existencias actuales antes de cualquier movimiento.
3. Arranque limpio y **clasificación correcta de KG/UNIT**: sus artículos
   migraron provisionalmente como `UNIT`, y un ingreso en la unidad equivocada
   es peor que ningún ingreso.
4. Confirmar que el receptor publicado acepta el cuerpo de §5 tal cual, contra
   un comprobante de prueba y no contra existencias reales.

**Y recién entonces:**

5. Un recorrido aislado, con un comprobante, mirando las dos puntas.

**No se ejecutó ningún POST contra Control de Stock desde esta aplicación.** Lo
único que se ejercitó es un receptor HTTP de mentira en `127.0.0.1`, dentro de
las pruebas.

## 13. Auditar una compra, del comprobante a cada movimiento

Reemplazá `<documentId>` por el identificador del comprobante.

```sql
-- Los movimientos anotados para una compra, con su estado y su clave.
SELECT o."eventKey",
       o.plu,
       o.quantity,
       o.unit,
       o.direction,
       o.status,
       o.attempts,
       o."externalId",
       o."lastError"
FROM stock_outbox o
WHERE o."documentId" = '<documentId>'
ORDER BY o."createdAt", o.id;
```

```sql
-- Del renglón de la factura al movimiento, y al revés.
SELECT d."fullNumber",
       b.name          AS sucursal,
       b."stockKey"    AS codigo_de_stock,
       i."lineNumber",
       i.description,
       o.plu,
       o.quantity,
       o.status,
       o."externalId"
FROM stock_outbox o
JOIN documents      d ON d.id = o."documentId"
JOIN branches       b ON b.id = o."branchId"
JOIN document_items i ON i.id = o."documentItemId"
WHERE d."fullNumber" = '<punto de venta>-<número>'
ORDER BY i."lineNumber";
```

```sql
-- Lo que está trabado, y por qué. Para mirar antes de reintentar nada.
SELECT o.status,
       count(*)                     AS filas,
       count(DISTINCT o."documentId") AS compras,
       max(o.attempts)              AS intentos_maximos
FROM stock_outbox o
WHERE o.status <> 'COMPLETADO'
GROUP BY o.status
ORDER BY o.status;
```

```sql
-- Una compra que quedó a medias: algunas confirmadas y otras no.
SELECT o."documentId",
       count(*) FILTER (WHERE o.status = 'COMPLETADO') AS confirmados,
       count(*)                                        AS total
FROM stock_outbox o
GROUP BY o."documentId"
HAVING count(*) FILTER (WHERE o.status = 'COMPLETADO') NOT IN (0, count(*));
```

## 14. Dónde está cada cosa

| Qué | Archivo |
|---|---|
| Reglas puras, contrato, escala decimal | `src/lib/domain/ingreso-de-stock.ts` |
| Bandeja, armado del lote y despacho | `src/lib/services/stock-ingreso.ts` |
| El POST y la lectura del acuse | `src/lib/services/stock-transporte-http.ts` |
| El despacho a mano de un comprobante | `src/lib/services/stock-despacho-manual.ts` |
| El botón y los estados en pantalla | `src/app/(app)/comprobantes/[id]/DespacharStock.tsx` |
| Lectura del catálogo (la otra punta, ya andando) | `src/lib/services/stock-descarga.ts` |
| Tabla `stock_outbox` y `Branch.stockKey` | `prisma/schema.prisma` |
| Reglas renglón por renglón | `tests/unit/ingreso-de-stock.test.ts` |
| Cuerpo exacto, códigos de estado y transporte | `tests/integration/contrato-de-stock.test.ts` |
| Bandeja, idempotencia, concurrencia | `tests/integration/ingreso-a-control-de-stock.test.ts` |
| Encabezado y no filtración de la clave | `tests/integration/stock-auth.test.ts` |
| Despacho a mano, permisos y receptor HTTP local | `tests/integration/despacho-manual.test.ts` |
| Control de Stock de mentira, determinístico | `tests/fixtures/control-de-stock-falso.ts`, `scripts/stock-falso.mjs` |
