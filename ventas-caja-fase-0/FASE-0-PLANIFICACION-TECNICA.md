# Ventas y Caja Don Ginés — Fase 0: Auditoría y planificación técnica

Fecha: 2026-09-22 · Estado: **A la espera de la aprobación del plan técnico por Gisela**
Este documento es solo planificación. No crea repositorio nuevo, no contiene código y no modifica ninguna aplicación existente.

---

## 1. Confirmación de lectura completa

Se leyeron completos los dos archivos del paquete:

- **Prompt_Claude_Desarrollo_Ventas_y_Caja_Don_Gines.md** (273 líneas): roles, autorización y alcance, aislamiento obligatorio, arquitectura recomendada, 14 principios no negociables, decisiones funcionales críticas, pendientes que no bloquean, procedimiento por fases 0–9, reglas de calidad, forma de comunicación y primera respuesta requerida.
- **Especificacion_Funcional_Ventas_y_Caja_Don_Gines.docx**: las 24 secciones (alcance, principios, actores, recorridos, balanzas, precios y promociones, clientes y comprobantes, medios de pago, caja, devoluciones, estados, contingencias, integraciones, modelo de datos, pantallas, informes, piloto, arquitectura, MVP, 37 criterios de aceptación, más de 40 casos de prueba PV/PR/CO/PA/CA/FI/DE/VA/CC/EM/IN/SE, riesgos, pendientes y hoja de aprobación) y las 25 tablas.

**Correcciones de Gisela incorporadas con prioridad sobre el texto de los archivos:**

1. **Código de balanza**: `2 + PLU de cinco dígitos + peso de SEIS dígitos + verificador EAN13` (13 dígitos en total). La mención a "peso de cinco dígitos" del prompt es un error de escritura; la Tabla 4 de la especificación ya lo dice correctamente (posiciones 7 a 12, `000250` = 0,250 kg). Se verificó aritméticamente el dígito verificador EAN13 de ambos ejemplos: `2001010002501` → PLU 00101 = 101, peso 000250 = 0,250 kg, verificador 1 ✓; `2012110002551` → PLU 01211 = 1211, peso 000255 = 0,255 kg, verificador 1 ✓.
2. Donde el prompt dice "movimientos OUT e inversiones desde el futuro Stock ERP" debe leerse **"movimientos OUT y reversiones mediante el futuro Stock ERP"**.
3. La especificación funcional **ya fue aprobada por Gisela** para planificación técnica y desarrollo exclusivamente en desarrollo, pruebas y homologación, aunque la portada y la sección 24 todavía digan "para aprobación". Siguen pendientes antes de pruebas fiscales definitivas o producción: validaciones del contador, monto vigente de identificación de consumidor final, tratamiento fiscal de combos con alícuotas mixtas, procedimiento y leyendas de contingencia ARCA, y la aprobación expresa del corte productivo. Ninguno bloquea arquitectura, simuladores, núcleo de venta, caja, seguridad, pruebas ni homologación.

---

## 2. Diagnóstico del entorno y límites

**Entorno auditado (solo lectura):**

- Sesión sobre el repositorio `GiselaCampana/coursera-test`, rama de trabajo `claude/ventas-caja-fase-0-xg4wau` (esta rama solo recibirá documentación de Fase 0).
- El repositorio es un contenedor mixto: proyectos de cursos antiguos (G.Bell, Panoramix, Soulvape, SuCostura, module2–5) y, en ramas separadas, la aplicación **Compras Don Ginés** (`compras-don-gines/` en ramas `compras-produccion-candidata`, `compras-release-candidate`, `compras-cierre-operativo`, `compras-don-gines-deploy`, `claude/compras-don-gines-app-xuy4qp`), la rama protegida **`motor-general-facturas`** y la rama **`stock-erp-fase-1`**.
- **Stack y convenciones de Compras** (auditadas para compatibilidad futura, sin modificar nada): Next.js 15 + React 19, TypeScript estricto, Prisma 6 + PostgreSQL (Supabase), Zod, `decimal.js`, Vitest (unit/integration/rendimiento) + Playwright (e2e), seeds con `tsx`, despliegue en Render (`render.yaml`). Convenciones del esquema: dinero `Decimal(18,4)`, tasas `Decimal(9,6)`, pesos/cantidades `Decimal(14,4)`, "nunca Float para dinero", permisos como strings de capacidad (`permissions: String[]` en `Role`), roles con alcance por sucursal, 27 modelos.

**Límites que se respetan (recursos identificados y expresamente excluidos):**

- No se despliega ni modifica producción; no se usan bases, usuarios, cajas, movimientos, stock, certificados, puntos de venta, comprobantes ni secretos reales.
- No se toca la rama `motor-general-facturas` ni ninguna rama `compras-*` ni `stock-erp-fase-1`.
- No se modifica la aplicación de Compras ni la aplicación publicada de Control de Stock; no se escribe en sus tablas; Control de Stock nunca recibe movimientos desde Ventas.
- Ventas y Caja no se incorpora dentro del código de Compras ni de este repositorio: nace en repositorio propio (sección 6).
- Cualquier simulación de stock corresponde al futuro Stock ERP y usa únicamente datos ficticios.

---

## 3. Arquitectura propuesta

Solución web instalable como **PWA** para las PC Windows de caja (teclado, lector USB tipo teclado, táctil o mouse), con servicio central y capa local con continuidad offline.

**Stack (alineado al prompt y compatible con las convenciones de Compras):**

- **TypeScript estricto** en todo el sistema.
- **Frontend**: React + Vite, PWA instalable (service worker, precache del shell, arranque sin red). Se elige SPA/PWA con Vite en lugar de Next.js porque la caja exige operación offline-first y foco en velocidad de escaneo; Next.js aporta SSR que aquí no agrega valor. Se reutilizan las convenciones transversales de Compras (TS estricto, Zod, decimal, Vitest, Playwright, Prisma).
- **Backend**: Node.js + Fastify con API explícita versionada (`/api/v1`), validación Zod en el borde, OpenAPI generado.
- **Persistencia central**: PostgreSQL + Prisma. Mismas convenciones de tipos que Compras: dinero `Decimal(18,4)`, tasas `Decimal(9,6)`, cantidades `Decimal(14,4)`; en los contratos externos las cantidades viajan como **cadenas con tres decimales**.
- **Persistencia local de caja**: IndexedDB transaccional (Dexie) para borradores, ventas en espera, copia versionada de catálogo/precios y **cola outbox** local.
- **Patrón outbox de dos niveles**: (a) outbox local PC→servidor para operaciones hechas sin conexión; (b) outbox central en la misma transacción de la venta confirmada para los mensajes a Stock ERP (simulado), ARCA (homologación/simulador), correo y Finanzas (futuro). Toda entrega lleva `idempotency_key` estable.
- **Adaptadores independientes** (puertos y adaptadores): `stock-erp`, `arca`, `correo`, `impresora POS80 (ESC/POS)`, `medios de pago`. En desarrollo, cada puerto tiene un **simulador** con fallas inyectables (demoras, duplicados, timeouts, rechazos) y datos inequívocamente sintéticos.
- **Monorepo interno del nuevo repositorio** (pnpm workspaces): `apps/pos` (PWA), `apps/server` (API), `packages/dominio` (reglas puras: decodificador de balanza, promociones, descuentos, estados), `packages/contratos` (esquemas Zod versionados de Stock/ARCA/Compras/Finanzas), `packages/simuladores`.
- **Calidad**: Vitest (unitarias e integración), Playwright (e2e con lector simulado), CI obligatoria con lint + typecheck + migraciones + pruebas; migraciones Prisma versionadas y reversibles; ADRs (registros de decisión breves) en `docs/adr/`.
- **Ambientes separados** desarrollo / pruebas / homologación / producción, con etiqueta visual de ambiente en pantalla y datos sintéticos imposibles de confundir con producción. El teléfono solo accede a vistas de administración, consulta, alertas y autorizaciones; nunca a una caja de venta.

---

## 4. Estrategia offline y recuperación

**Modos de operación:**

1. **Normal**: PC conectada al servicio central; venta, cobro, OUT y fiscalización siguen el flujo estándar (estados separados, sección 11 de la especificación).
2. **Modo local (sin Internet, caja operativa)**: la PWA sigue vendiendo con la copia local versionada de catálogo, precios y promociones (con fecha de sincronización y control de antigüedad). Las operaciones se confirman localmente con identificador estable + `idempotency_key`, quedan en el outbox local y se señaliza "MODO LOCAL" en pantalla. Medios electrónicos solo si el dispositivo externo conserva conectividad y muestra aprobación válida; si cae el proveedor: efectivo y cuenta corriente autorizada.
3. **Contingencia total (falla externa al ERP, sin posibilidad de cobrar en el sistema)**: incidente crítico; solo se venden artículos con ticket de balanza cobrando el importe impreso. Al recuperar, cada ticket se carga como venta separada dentro de un **lote de contingencia** revisado por Gisela o Mathías, con las diferencias contra el precio ERP marcadas como "precio de contingencia".

**Recuperación y sincronización:**

- Al volver la conexión, el outbox local drena en orden con reintentos de espera progresiva y límite operativo; los rechazos definitivos pasan a revisión de Gisela o Mathías.
- Reenviar la misma clave devuelve el resultado original: el servidor registra respuesta por `idempotency_key` (reintentos, reimpresiones y cambios fiscales nunca duplican caja ni stock).
- Al reiniciar la PWA (corte de luz, cierre del navegador), los borradores y ventas en espera se recuperan desde IndexedDB sin pérdida de renglones.
- La fiscalización pendiente (ARCA caído) y los OUT pendientes (Stock caído) no bloquean la venta confirmada; se reintentan con la misma identidad y son consultables en la pantalla de Contingencias.
- Las fechas operativas se registran con zona horaria y se muestran en horario argentino.

---

## 5. Modelo de seguridad y permisos

- **Identidad individual**: usuario y contraseña propios por persona (hash Argon2id), sin cuentas compartidas; sesiones con vencimiento y bloqueo rápido; cambio de operador durante el turno conservando siempre el usuario real de cada acción.
- **Permisos por capacidad** (no solo por nombre de rol), siguiendo la convención ya probada en Compras: cada rol otorga una lista de capacidades (`venta.confirmar`, `caja.cierre`, `autorizacion.aprobar`, `informes.recaudacion`, …). El backend valida capacidades en cada operación: **ocultar botones no constituye seguridad**.
- **Cajero con mínimo privilegio**: sin acceso a recaudación diaria, costos, márgenes, cierres anteriores, auditoría sensible ni búsquedas amplias de comprobantes (acceso solo por número o código exacto). El arqueo es ciego (nunca ve el esperado) y las respuestas de la API se filtran en el servidor para que no pueda inferir la recaudación.
- **Gisela y Mathías**: exactamente los mismos permisos superiores. Autorizaciones remotas desde su propia sesión (celular): de un solo uso, vinculadas a una operación puntual, con vencimiento corto, motivo y auditoría; llegan simultáneamente a ambos, la primera respuesta resuelve y queda visible quién actuó; sin respuesta en cinco minutos se envía correo de respaldo. Los intentos rechazados o vencidos también quedan registrados.
- **Auditoría inmutable**: registro append-only de eventos sensibles (actor, acción, valores anteriores y nuevos, motivo, autorizador, fecha, sucursal, caja, dispositivo), sin UPDATE ni DELETE.
- **Secretos** fuera del repositorio (`.env.example` sin valores reales), nunca en logs ni pantallas; solicitudes y respuestas fiscales protegidas contra exposición de datos personales.

---

## 6. Propuesta de repositorio independiente

- **Nombre y ubicación exacta**: repositorio privado nuevo **`GiselaCampana/don-gines-ventas-caja`** en GitHub (misma cuenta que `coursera-test`).
- Ventas y Caja no se incorpora a `coursera-test` ni a ninguna rama de Compras. En este repositorio solo queda este documento de Fase 0, en la rama `claude/ventas-caja-fase-0-xg4wau`.
- **Nota de permisos**: el acceso GitHub de esta sesión está limitado hoy a `coursera-test`. Cuando Gisela apruebe el plan, se intentará crear `don-gines-ventas-caja` con las herramientas disponibles; si la creación o el acceso fallan, se pedirá únicamente esa autorización (crear el repositorio o habilitarlo para Claude) antes de continuar, sin improvisar el módulo dentro de Compras.
- Reutilización permitida: criterios, librerías y convenciones de Compras auditadas (tipos decimales, Zod, Vitest/Playwright, permisos por capacidad). Prohibida: dependencia de tablas, rutas internas o componentes privados de Compras. Toda integración futura será por contratos versionados, autenticados e idempotentes.

---

## 7. Módulos y modelo de datos inicial

**Módulos** (paquetes/límites de dominio dentro del nuevo repositorio):

| Módulo | Responsabilidad |
|---|---|
| `seguridad` | Usuarios, credenciales, sesiones, roles/capacidades, autorizaciones remotas, auditoría |
| `organizacion` | Sucursales (`devoto`, `pueyrredon`, `san_martin`), cajas, turnos, asignaciones de línea A–D |
| `catalogo` | Copia local versionada de productos, PLU, unidades KG/UNIT, IVA, códigos comerciales; fotografía histórica por venta |
| `balanza` | Decodificación y validación EAN13 del código individual; rechazo del código general; confirmación de actualización de balanzas |
| `ventas` | Borrador, en espera, confirmada, cancelada; renglones, combos y componentes; correcciones pre-confirmación |
| `precios-promos` | Precios centrales programados, feteables (umbral 245 g), pares/mínimos/escalas, combos, descuento efectivo por tramos inclusivos, exclusiones, prioridad de promociones |
| `cobros` | Medios (efectivo, BUEPP, Cuenta DNI, NAVE, BBVA, plataformas, transferencia autorizada, cuenta corriente, vale), pagos combinados, calculadora de vuelto |
| `caja` | Apertura, recepción, cambio de turno, gastos, retiros, caja ciega, arqueo ciego, cierre con tolerancia $1.000 |
| `fiscal` | Adaptador ARCA desacoplado (homologación), Factura A/B, CAE, ticket interno NO_FISCAL, notas de crédito, contingencia |
| `devoluciones` | Anulaciones, devoluciones, cambios, destinos de stock, vales (30 días, uso único, total ≥ vale) |
| `integraciones` | Outbox, contratos Stock ERP (simulado), Compras (catálogo/costos/precios), Finanzas (futuro), correo diario |
| `informes` | Informes por permiso, alertas, resumen diario por sucursal, exportación Excel/PDF |

**Modelo de datos inicial** (Prisma; refleja la Tabla 18 de la especificación): `Sucursal`, `Caja`, `Turno`, `Usuario`, `Rol`, `AsignacionLinea` (sucursal+turno+letra+empleado+vigencia, con historial), `Venta` (estados Tabla 12), `RenglonVenta` (producto, cantidad, precio, IVA, costo, promoción aplicada, vendedor de línea, fotografía de catálogo), `ComponenteCombo` (cantidad teórica y real distribuida), `Pago` (estados de cobro Tabla 13), `Cliente`, `CuentaCorriente`, `ComprobanteFiscal` (estados Tabla 14, solicitud/respuesta/CAE/idempotencia), `MovimientoCaja`, `LoteCajaCiega`, `MovimientoStock` (estados Tabla 15, contrato Tabla 17), `Promocion`, `PrecioPublicado`, `Autorizacion`, `Devolucion`, `Vale`, `EventoAuditoria`, `OutboxMensaje`. Claves únicas e índices sobre `idempotency_key`, número de comprobante por punto de venta, código de vale; restricciones y transacciones en base de datos.

---

## 8. Plan por fases con criterio de finalización

| Fase | Contenido | Criterio de finalización |
|---|---|---|
| **0** Auditoría y planificación | Este documento | **Aprobación expresa de Gisela del plan técnico** |
| **1** Fundación independiente | Repo `don-gines-ventas-caja`, monorepo, TS estricto, lint, formato, Vitest/Playwright, CI, configs por ambiente, `.env.example`, datos sintéticos, etiquetas de ambiente, docs de instalación/ejecución/recuperación | CI verde en repo nuevo; README reproducible; ningún secreto ni dato real |
| **2** Dominio, seguridad y auditoría | Usuarios, sesiones, sucursales, cajas, turnos, capacidades, autorizaciones remotas de un solo uso, auditoría inmutable, ocultamiento efectivo para cajeros | Pruebas de permisos y auditoría en verde (incl. SE 01, SE 02); recaudación/costos/márgenes inaccesibles para cajero también vía API |
| **3** Núcleo de venta | Estados de venta, lector/búsqueda/carga manual, decodificador de balanza, vendedor A–D, pesables/unidad/combos, foco al campo de lectura | Criterios de aceptación 1–6 y casos PV 01–05 en verde; e2e de venta completa con lector simulado |
| **4** Precios y promociones | Precios versionados y programados, feteables 245 g, pares/mínimos/escalas, combos, tramos inclusivos de efectivo, exclusiones, fotografía histórica | Criterios 7–12 y casos PR 01–04, CO 01–03 en verde; ningún valor de ejemplo fijado en código |
| **5** Cobros y caja | Efectivo y vuelto, todos los medios, pagos combinados, apertura/recepción/cambio de turno/gastos/retiros/caja ciega/arqueo/cierre, inmutabilidad y correcciones vinculadas | Criterios 13–17, 25–28, 34 y casos PA 01–06, CA 01–04 en verde |
| **6** Comprobantes y homologación fiscal | Ticket interno definitivo, adaptador ARCA desacoplado, Factura A/B en homologación con CAE, reintentos idempotentes, notas de crédito | Criterios 21–22 y casos FI 01–04 en verde; cero certificados o puntos de venta productivos |
| **7** Devoluciones, vales y excepciones | Devoluciones pre/post cierre, destinos de stock, nota de crédito + vale vinculados, cambios, autorizaciones, imágenes, auditoría | Criterios 26, 29–33 y casos DE 01–05, VA 01–03, CC 01–02, EM 01 en verde |
| **8** Contratos e informes | Contrato Stock OUT/reversiones simulado con fallas inyectables, contrato catálogo/costos/precios, contrato futuro Finanzas, informes por permiso, correo diario por sucursal | Criterios 18–19, 23–24 y casos IN 01–02 en verde; simuladores con demoras, duplicados, timeouts, rechazos y recuperación |
| **9** Pruebas de operación y piloto | Suite completa de la especificación: unitarias, integración, concurrencia, offline, recuperación, permisos, idempotencia; e2e; comparación paralela sin efectos productivos | Los 37 criterios de aceptación en verde; piloto Pueyrredón (5 jornadas), luego San Martín + Devoto (3 jornadas); criterios 36–37 |

Ninguna fase se marca terminada sin ejecutar sus pruebas. Al cerrar cada fase se informa: qué se implementó, archivos y migraciones, pruebas ejecutadas y resultado, cómo probarlo Gisela, riesgos reales y confirmación de no haber tocado producción, Compras ni Control de Stock.

---

## 9. Matriz de trazabilidad (requisitos → componentes → pruebas → fase)

| Requisito (especificación) | Componente | Pruebas | Fase |
|---|---|---|---|
| §5.1 Código de balanza 2+PLU(5)+peso(6)+EAN13; rechazo de código general | `balanza` (decodificador puro) | CA 1–4; PV 02–03 | 3 |
| §5.2 Vendedor de línea A–D por sucursal/turno con historial | `organizacion.AsignacionLinea` + UI selección | CA 5; PV 01 | 3 |
| §4.2 Ventas en espera sin efectos | `ventas` (EN_ESPERA) + IndexedDB | CA 6; PV 05 | 3 |
| §4.3 Correcciones pre-confirmación solo sobre borrador | `ventas` | CA 15, 25; DE 01 | 3 |
| §6.2 Feteables: umbral 245 g a todo el peso, configurable | `precios-promos` | CA 7–8; PR 01–02 | 4 |
| §6.3 Promociones por pares/escala | `precios-promos` | CA 10; PR 04 | 4 |
| §6.4 Combos: precio fijo, receta, distribución proporcional | `precios-promos` + `ventas.ComponenteCombo` | CA 9; CO 01–03 | 4 |
| §6.5 Descuento efectivo: tramos inclusivos, exclusiones, vale <20%, sin redondeo | `precios-promos` + `cobros` | CA 11–15; PA 01–02, 05–06; PR 03 | 4–5 |
| §8.1–8.2 Pagos combinados exactos y calculadora de vuelto | `cobros` | CA 16; PA 03 | 5 |
| §8.4 Cuentas corrientes: límite, plazo, evidencia firmada de empleado | `cobros` + `clientes` | CA 30–31; CC 01–02; EM 01 | 7 |
| §8.5 Vales: 30 días, uso único, total ≥ vale, NC previa | `devoluciones.Vale` + `fiscal` | CA 32–33; VA 01–03; DE 05 | 7 |
| §9 Caja: apertura ciega, cambio de turno conjunto, caja ciega, arqueo ciego, tolerancia $1.000, un recuento | `caja` | CA 27–28; CA 01–04 (casos) | 5 |
| §9.2 Gastos: alertas $10.000/$30.000 sin bloqueo | `caja` + `informes.alertas` | CA 34 | 5 |
| §7.2–7.4 Factura A/B por condición fiscal, punto de venta por sucursal, datos fiscales conservados | `fiscal` (adaptador ARCA homologación) | CA 22; FI 01–03 | 6 |
| §7.3 Ticket interno definitivo NO_FISCAL, auditado, sin alerta ni motivo | `fiscal` + `auditoria` | CA 21; FI 04 | 6 |
| §10 Inmutabilidad y operaciones inversas vinculadas | `ventas` + `devoluciones` | CA 17, 26; DE 02–04 | 5, 7 |
| §10.1 Reimpresión: 5 minutos el último; anteriores con autorización; nunca duplica | `fiscal.impresion` | CA 19–20 | 5–6 |
| §11 Estados separados venta/cobro/fiscal/stock | `dominio` (máquinas de estado Tablas 12–15) | Unitarias por transición | 3–6 |
| §12 Contingencias: modo local, lote de contingencia, reintentos progresivos | offline/outbox + `integraciones` | CA 22–23; IN 01–02; pruebas de recuperación | 3, 8 |
| §13.1 Contrato Stock OUT/reversiones idempotente (Tabla 17) | `contratos.stock` + simulador | CA 18, 23; IN 01–02 | 8 |
| §13.2 Catálogo/costos/precios desde Compras con fotografía | `catalogo` + `contratos.compras` | Integración de sincronización | 4, 8 |
| §3 Permisos, autorizaciones remotas, cajero sin recaudación | `seguridad` | CA 24, 29, 35; SE 01–02 | 2 |
| §16 Informes, alertas y correo diario por sucursal | `informes` + adaptador correo | CA 36; pruebas de permisos de informes | 8 |
| §17 Piloto paralelo sin efectos productivos y corte conjunto | homologación + datos sintéticos | CA 36–37; jornadas de piloto | 9 |

---

## 10. Riesgos y pendientes fiscales

**Riesgos técnicos principales** (además de los de la Tabla 23 de la especificación, que se adoptan con sus mitigaciones):

| Riesgo | Mitigación |
|---|---|
| Duplicación por reintentos (stock, ARCA, cobros) | Idempotencia extremo a extremo, outbox transaccional, resultado consultable por clave |
| Operación sin conexión prolongada | Copia local versionada con límite de antigüedad, cola persistente, alertas |
| Cajero infiere recaudación | Filtrado en servidor, arqueo ciego, acceso por comprobante exacto, pruebas SE dedicadas |
| Confusión homologación/producción | Etiquetas visuales de ambiente, datos sintéticos inequívocos, ambientes y credenciales separados |
| Deriva respecto de Compras (catálogo/precios) | Contrato versionado, copia local con versión y fecha, fotografía por venta |
| Impresión térmica POS80 y lector en hardware real | Adaptador ESC/POS aislado y validación temprana en homologación con hardware físico |

**Pendientes fiscales (no bloquean el desarrollo; se diseñan como configuración o adaptadores pendientes, sin inventar respuestas):**

1. Monto vigente de identificación obligatoria de consumidor final → parámetro configurable (contador y ARCA, antes de producción).
2. Distribución fiscal del precio de combos con alícuotas 10,5% y 21% → regla contable pendiente del contador, antes de emitir comprobantes de combos mixtos.
3. Procedimiento de contingencia ARCA y eventual CAEA → adaptador con estados previstos, procedimiento a validar antes de producción.
4. Leyenda exacta del comprobante de contingencia → texto configurable, a validar antes de imprimir en producción.
5. Validación con más códigos reales de balanza y productos unitarios → durante homologación.
6. Aprobación expresa del corte productivo por Gisela o Mathías → condición de cualquier paso a producción.

---

## 11. Confirmación de no intervención en aplicaciones y ambientes protegidos

Se confirma expresamente que durante esta Fase 0 **no se tocó ni se tocará**:

- la rama `motor-general-facturas`;
- la aplicación de Compras Don Ginés (ninguna rama `compras-*` ni el directorio `compras-don-gines/`);
- la aplicación publicada de Control de Stock (permanece independiente y nunca recibirá movimientos desde Ventas);
- la rama `stock-erp-fase-1` ni ningún futuro Stock ERP real (toda simulación usará datos ficticios);
- producción, bases reales, stock real, dinero real, ARCA real, certificados, puntos de venta, clientes, ventas, usuarios o secretos reales.

La única escritura de esta fase es este documento de planificación en la rama `claude/ventas-caja-fase-0-xg4wau` de `coursera-test`. No se creó el repositorio nuevo ni se escribió código.

**Próximo paso: esperar la aprobación del plan técnico por Gisela antes de crear `GiselaCampana/don-gines-ventas-caja` e iniciar la Fase 1.**
