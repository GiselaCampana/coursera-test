# Stock ERP: permisos e interruptores para la puesta en marcha

Las dos matrices que hay que tener decididas **antes** de empezar la homologación.
Ambas se generan de la fuente, no de la memoria: los permisos salen de
`src/lib/auth/permissions.ts` y los interruptores de `stock_module_setting`.

No hay un solo nombre, correo ni identificador de persona acá. Las columnas de
«quién» dicen **roles**; los nombres los pone quien otorgue, en Configuración →
Roles, que es una decisión con autor y fecha.

## Matriz de permisos

Diecinueve permisos, **once sensibles**. «Sensible» tiene un significado preciso
en este módulo: el permiso no entra en `ADMIN_PERMISSIONS` por el solo hecho de
existir, así que hay que otorgarlo a alguien por su nombre.

| Permiso | Clase | Qué habilita | ¿Admin nuevo? | ¿Se agrega a roles existentes? | Quién en la homologación |
|---|---|---|---|---|---|
| `stockerp.ver` | lectura | Ver el módulo | **sí** | no | todos los que vayan a mirar |
| `stockerp.movimientos.ver` | lectura | Existencias y libro | **sí** | no | todos los que vayan a mirar |
| `stockerp.integridad.ver` | lectura | Diagnóstico de integridad | **sí** | no | quien revise la consistencia |
| `stockerp.auditoria.ver` | lectura | Historial y auditoría | **sí** | no | quien revise qué pasó |
| `stockerp.apertura.preparar` | preparación | Armar aperturas, cargar conteos | **sí** | no | quien recorra la góndola |
| `stockerp.recepcion.preparar` | preparación | Vista previa de recepciones | **sí** | no | quien reciba mercadería |
| `stockerp.traslado.preparar` | preparación | Armar traslados y su revisión | **sí** | no | quien arme el traslado |
| `stockerp.recuento.preparar` | preparación | Abrir recuentos, contar | **sí** | no | quien recorra la góndola |
| `stockerp.unidades.configurar` | **sensible** | Aprobar la unidad de existencia | no | no | **una sola persona**: fija qué significa «uno» en el libro |
| `stockerp.apertura.confirmar` | **sensible** | Confirmar la apertura de una sucursal | no | no | responsable del inventario inicial |
| `stockerp.activacion.habilitar` | **sensible** | Decidir qué maneja cada sucursal | no | no | responsable del inventario inicial |
| `stockerp.recepcion.confirmar` | **sensible** | Ingresar la mercadería de una compra | no | no | encargado de recepción |
| `stockerp.traslado.despachar` | **sensible** | Sacar mercadería del origen | no | no | encargado de la sucursal de origen |
| `stockerp.traslado.recibir` | **sensible** | Recibir y cerrar el traslado | no | no | encargado de la sucursal de destino |
| `stockerp.merma` | **sensible** | Registrar una pérdida con su causa | no | no | encargado de sucursal |
| `stockerp.ajuste` | **sensible** | Confirmar el ajuste de un recuento | no | no | **distinto de quien cuenta**: contar y ajustar son dos actos |
| `stockerp.reversar` | **sensible** | Revertir merma, ajuste o despacho | no | no | responsable del inventario |
| `stockerp.excepcion.historica` | **sensible** | Documentar algo anterior al corte | no | no | sólo si aparece el caso |
| `stockerp.modulo.configurar` | **sensible** | Encender o apagar los interruptores | no | no | **nadie todavía**: no se enciende nada en esta etapa |

Tres cosas que la matriz dice y conviene leer dos veces:

**Contar no es ajustar.** `recuento.preparar` NO es sensible y viene con el
administrador: quien recorre la góndola con el teléfono tiene que poder anotar lo
que ve. Confirmar el ajuste que surge de esa cuenta es otro acto, con otro permiso
y —idealmente— otra persona.

**`stockerp.modulo.configurar` no se otorga en esta etapa.** Sin él nadie puede
encender un interruptor real, y en homologación no hace falta: las aperturas
ficticias sobre una base de demostración funcionan con los cuatro apagados.

**`stock.sincronizar` no está en esta matriz** y no se toca: pertenece al
transporte externo retirado y queda congelado hasta que ese código se elimine.

### Lo que está comprobado sobre esta matriz

* ningún permiso sensible entra en `ADMIN_PERMISSIONS` ni en los roles sembrados;
* **volver a correr el seed no amplía ningún rol existente.** Se recorta cada rol
  a un solo permiso —como quedaría si alguien lo editara a mano—, se corre el seed
  de verdad y se comprueba que lo encontró tal como estaba. Importa porque el seed
  corre en **cada** despliegue: el plan gratuito no da consola para correr un
  comando suelto;
* cada camino sensible se niega sin su permiso, y la negativa queda auditada.

## Matriz de interruptores

Cuatro interruptores reales, **los cuatro apagados**. Viven en la única fila de
`stock_module_setting`, no en variables de entorno.

| Interruptor | Columna | Qué habilita si se enciende | Estado | Exige |
|---|---|---|---|---|
| Aperturas reales | `realOpeningEnabled` | Confirmar una apertura con existencias reales | **apagado** | permiso + autor + fecha + motivo |
| Recepciones reales | `realPurchaseReceiptsEnabled` | Que una compra real ingrese al libro | **apagado** | idem |
| Traslados reales | `realTransfersEnabled` | Mover mercadería real entre sucursales | **apagado** | idem |
| Correcciones reales | `realCorrectionsEnabled` | Mermas y ajustes sobre inventario real | **apagado** | idem |

### Lo que está comprobado sobre los cuatro

| Afirmación | Cómo se comprueba |
|---|---|
| Nacen apagados | el estado, y el `DEFAULT false` de cada columna en la base |
| El seed no los enciende | se **corre** `prisma/seed.ts` de verdad y después se mira el estado — no se lee su texto |
| Ni con todas sus variables en verdadero | se corre el seed con cada variable que llega a leer puesta en `true` |
| Ninguna variable de entorno los enciende | se recorre `src` entero: ninguna línea que nombre una de las cuatro columnas menciona `process.env` |
| Ninguna migración los enciende | se lee el SQL de las 30 migraciones |
| Requieren usuario, fecha y motivo | el servicio exige permiso; la base tiene una CHECK por columna, probada con `UPDATE` suelto |
| Un despliegue o reinicio no cambia su valor | el valor vive en la base, no en una variable, y **sólo los cuatro servicios de cada fase escriben esas columnas**: ningún camino de arranque las toca. El seed, que sí corre en cada despliegue, tiene su propia prueba ejecutándolo |

Encender cualquiera de los cuatro **no es de esta etapa**. Cuando llegue el
momento, es una edición desde la pantalla del módulo, con nombre y motivo, que
queda en la auditoría.
