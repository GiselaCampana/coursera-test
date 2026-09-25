# Fase 5 de Stock ERP: no hay nada que revertir en la base

La fase 5 —consultas, saldos, auditoría y diagnóstico de integridad— **no agrega
ninguna migración, ningún índice y ninguna columna.** Por eso no tiene archivo de
rollback: no hay nada que deshacer.

Se deja escrito porque la ausencia de un archivo es ambigua. Sin esta nota, quien
busque `prisma/rollback/` el día que haya que volver atrás no va a saber si la
fase 5 no necesitaba rollback o si alguien se olvidó de escribirlo.

## Por qué no hizo falta ningún índice

La instrucción era agregar índices **sólo cuando una medición o el plan de
consulta los justifique**, y las mediciones no los justificaron. Lo que las
consultas nuevas necesitan ya existía desde la fase 1:

| Consulta | Índice que la sostiene |
|---|---|
| Página del libro por orden de registración | `stock_ledger.seq` (único) |
| Movimientos de un artículo en una sucursal | `@@index([productId, branchId, effectiveAt])` |
| Movimientos de una sucursal por fecha efectiva | `@@index([branchId, effectiveAt])` |
| Movimientos de una operación | `@@index([operationId])` |
| Movimientos de un comprobante | `@@index([documentId])` |
| Saldo de un artículo en una sucursal | `@@unique([productId, branchId])` |
| Auditoría por fecha y por usuario | `@@index([createdAt])`, `@@index([userId, createdAt])` |

El cursor de paginación ordena por `seq` descendente, y `seq` tiene índice único
por ser `@unique`. Agregar un índice compuesto `(branchId, seq)` sería razonable
el día que una sucursal tenga cientos de miles de movimientos; hoy no hay ninguno
en producción y medir sobre datos inventados diría cualquier cosa.

## Qué revertir si hace falta volver atrás

Sólo código. `git revert` de los commits de la fase, o mover la rama:

```
git checkout stock-erp-fase-5
git reset --hard 2c34bee5fb08dc31e3c73a59b275aff2b9c5d30b   # cabeza aprobada de la fase 4
```

No hay que tocar la base. Las cuatro pantallas nuevas y el servicio de consultas
**sólo leen**: no crean filas, no las modifican y no las borran. Quitarlos deja el
libro exactamente como estaba.

## Lo único que la fase 5 cambió fuera de las consultas

Tres cosas, todas de código y ninguna de esquema:

1. **Dos permisos de lectura nuevos** (`stockerp.movimientos.ver`,
   `stockerp.integridad.ver`). Viven en `src/lib/auth/permissions.ts`, no en la
   base. Los roles guardan una lista de códigos: un rol que ya existía conserva
   la suya, porque los upserts del sembrado usan `update: {}`. Revertir el código
   hace que esos códigos dejen de existir; si alguien se los hubiera asignado a
   un rol, quedarían como cadenas sin efecto, que es inofensivo y visible desde
   Configuración → Roles.
2. **`exigirBaseDescartable`** en `src/lib/base-de-pruebas.ts`, usada por las
   pruebas. No corre en producción.
3. **El sembrado de end to end** siembra dos ingresos más y unos asientos de
   auditoría, en las dos sucursales de recepción. Sólo afecta a la base de
   pruebas end to end, que se tira y se vuelve a crear en cada corrida.
