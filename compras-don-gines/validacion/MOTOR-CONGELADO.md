# Motor congelado para la validación

No se agregan más reglas mirando el banco de diseño hasta medir sobre facturas
nuevas. Esta es la versión contra la que se van a comparar las actas ciegas.

```
commit  47157d80338915f6897823140881f405b3375021
sha256  5039747219e829d3cd9e3e10ad34a179d51c6ceb2b231326c9d13a157591d401
        (sobre los 38 archivos .ts de src/lib/ocr, en orden de ruta)
```

Cada acta de `validacion/ciega/` registra esos dos valores. Si no coinciden con
los de arriba, el acta se produjo con otra versión del motor y no es comparable
con las demás: eso es todo el punto de anotarlos.

## Estado del banco de diseño en este commit

| | artículos | recon. | interp. | cierran | pie | decisión | acciones humanas |
|---|---|---|---|---|---|---|---|
| Ezra | 6 | 6 | 6 | 6 | completo | **automática** | 0 |
| Barraza | 2 | 2 | 2 | 2 | completo | revisión | 4 columnas |
| Mabelherdi | 9 | 9 | 9 | 9 | completo | revisión | 4 columnas |
| Errecalde | 23 | 23 | 22 | 15 | **parcial** | revisión | 8 |
| Los Calvos 212356 | 9 | 1 | 1 | 0 | parcial | **rechazo** | 6 |
| Los Calvos 213103 | 9 | 17 | 15 | 11 | parcial | **rechazo** | 7 |

Errecalde y Los Calvos no están cerrados, y **no se van a seguir ajustando
ahora**: para los proveedores conocidos siguen estando los analizadores
específicos como respaldo, y forzar el motor general a reconstruir datos que la
imagen no contiene antes de saber cómo responde ante facturas realmente nuevas
es la forma más directa de sobreajustarlo.
