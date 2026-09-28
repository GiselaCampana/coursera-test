# Homologación en la vista previa: qué revisar y qué pulsar

Este documento es el paso que **yo no hago**. Todo lo anterior a él está
verificado desde acá; esto necesita el panel de Render, y del panel no tengo
acceso ni lo pido.

## Lo que sí pude establecer, y lo que no

**Establecido desde el repositorio y desde git:**

| Qué | Valor |
|---|---|
| Blueprint de la demo | `compras-don-gines/deploy/vista-previa.render.yaml` |
| Servicio que declara | `compras-vista-previa-demo` |
| Base que declara | `compras-demo-db`, base lógica `compras_demo` |
| Rama que declara | `compras-release-candidate` |
| SHA remoto de esa rama hoy | `a93c9f9` |
| Entornos de vista previa automáticos | `generation: "off"` |
| Variables de Control de Stock | ninguna |
| Blueprint de **producción** | `render.yaml` de la raíz → servicio `compras-don-gines`, base en Supabase |

`a93c9f9` es **anterior a toda la fase 1 de Stock ERP**: la demo viene mostrando
Compras sin el módulo. Avanzarla a la cabeza de la fase 8 es un **avance directo**
— verificado: `a93c9f9` es ancestro de esa cabeza —.

**NO establecido, y por eso freno acá:** que el panel de Render tenga hoy esa
configuración. Un blueprint versionado dice qué se pidió, no qué quedó. Sólo el
panel sabe qué archivo está leyendo el Blueprint, qué rama sigue el servicio y qué
`DATABASE_URL` tiene cargada. Verificarlo requiere entrar, y no tengo —ni pido—
credenciales.

## Antes de tocar nada: las cinco comprobaciones del panel

1. **Que el Blueprint lea el archivo de la demo.** En la lista de recursos del
   Blueprint tienen que aparecer **exactamente dos**: `compras-vista-previa-demo` y
   `compras-demo-db`. **Si aparece `compras-don-gines`, pará**: ese Blueprint está
   administrando producción. Hay que borrarlo sin sincronizar.
2. **Que el servicio siga `compras-release-candidate`.** Settings → Branch. Si
   sigue otra rama, el avance no va donde creés.
3. **Que su `DATABASE_URL` sea la de la demo.** Environment → `DATABASE_URL`
   viene `fromDatabase` de `compras-demo-db`. El nombre de la base tiene que
   contener «demo»: es lo que la guarda del sembrado exige, y si no lo cumple el
   servicio no va a arrancar (a propósito).
4. **Que no haya ninguna variable de Control de Stock** ni del endpoint de precios.
5. **Respaldo de la base de demo.** Render → `compras-demo-db` → backup, o
   `pg_dump` a un archivo local. Es una demo y se puede volver a sembrar, pero un
   respaldo cuesta un minuto y vuelve reversible cualquier sorpresa.

## Qué migraciones se van a aplicar

La demo está en `a93c9f9`, que es anterior a Stock ERP. Al avanzar, su
`startCommand` corre `prisma migrate deploy` y aplica **las nueve migraciones del
módulo**, en este orden:

1. `20260921120000_stock_erp_fase_1`
2. `20260923100000_stock_erp_fase_2_unidades`
3. `20260923150000_stock_erp_fase_3_estados`
4. `20260923160000_stock_erp_fase_3_apertura`
5. `20260924090000_stock_erp_corte_con_zona`
6. `20260924100000_stock_erp_fase_4_recepcion`
7. `20260926100000_stock_erp_fase_6_estados`
8. `20260926100500_stock_erp_fase_6_traslados`
9. `20260927100000_stock_erp_fase_7_correcciones`

Más las que Compras haya agregado entre `a93c9f9` y la cabeza, si hubiera alguna.
La cadena está probada desde cero y desde el esquema productivo anterior, con los
datos intactos: conteos y hashes idénticos antes y después.

## El push

```sh
git fetch origin compras-release-candidate
git rev-parse origin/compras-release-candidate      # tiene que dar a93c9f9
git merge-base --is-ancestor origin/compras-release-candidate stock-erp-fase-8 \
  && echo "avance directo"                          # tiene que decirlo
git push origin stock-erp-fase-8:compras-release-candidate
```

Push normal. **Nunca `--force`.** No se usa Blueprint Sync —eso re-lee el
blueprint y puede tocar recursos—, no se cambian variables ni secretos, y no se
toca `compras-don-gines-deploy`, que es producción y sigue en `f60c68c`.

## Qué mirar cuando el despliegue termine

1. **Que arrancó.** `https://<url-de-la-demo>/api/version` devuelve el commit que
   está sirviendo. Tiene que ser el de la cabeza de la fase 8. No pide sesión, así
   que se puede abrir desde el teléfono.
2. **Que el sembrado corrió.** El registro del arranque tiene que mostrar el
   sembrado de homologación sin errores. Si dice *«sólo se permite contra la base
   de la DEMO»*, la `DATABASE_URL` del servicio no apunta a una base con «demo» en
   el nombre: eso es el punto 3 de arriba sin cumplir.
3. **Que los cuatro interruptores están apagados.** Stock ERP → cada pantalla lo
   dice arriba. Ninguno se enciende en esta etapa.
4. **El recorrido de homologación**, que es el mismo que el ensayo automático hace
   y conviene repetir con los dedos: unidades → apertura → recepción → existencias
   y libro → traslado → merma → recuento → reversión → auditoría e integridad.

## Si algo sale mal: rollback de la demo

La demo **no tiene datos que perder**: se siembra sola en cada arranque. El
rollback es volver la rama a donde estaba.

```sh
git push origin a93c9f9:compras-release-candidate
```

Si la base quedó migrada y hace falta dejarla como antes —no es necesario para que
la demo funcione, porque la cadena es aditiva—, están los guiones de
`prisma/rollback/`, en orden inverso: fase 7, fase 6, fase 4, corte con zona,
fase 3 apertura, fase 2, fase 1. Cada uno **se niega si hay historia de su fase**,
y esa negativa está probada en las dos direcciones. Si alguno se niega, no lo
fuerces: significa que hay algo que ese guión borraría.

`git reset --hard` no es un procedimiento de rollback: descarta commits que otros
clones ya tienen y no deja rastro.

## Lo que este documento no autoriza

Producción. `compras-don-gines-deploy` sigue en `f60c68c` y no se toca. Encender
cualquiera de los cuatro interruptores reales tampoco es de esta etapa.
