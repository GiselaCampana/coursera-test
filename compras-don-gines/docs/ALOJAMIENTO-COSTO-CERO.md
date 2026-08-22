# Alojamiento de costo cero para la primera etapa

**Este documento es una recomendación. No configuré ni contraté nada.** No hay ninguna
cuenta creada, ningún servicio conectado y ninguna variable de entorno apuntando a un
proveedor externo. La decisión es tuya; cuando la tomes, lo dejo andando.

Las cifras son las que releva la documentación pública de cada proveedor en **agosto de
2026**. Los planes gratuitos cambian seguido: **antes de crear cualquier cuenta, confirmá
los límites en la página de precios del propio proveedor.**

---

## Lo primero, porque cambia todo

La aplicación es de uso **comercial**: la usa una cadena de fiambrerías para llevar sus
compras. Eso descarta el plan gratuito más obvio.

> **Vercel Hobby no sirve.** Su plan gratuito prohíbe explícitamente el uso comercial —
> "any deployment used for the financial gain of anyone involved". Un sistema interno de
> una empresa entra de lleno en esa definición. Usarlo sería una violación de los
> términos, con riesgo de que te bajen el despliegue sin aviso. Para uso comercial en
> Vercel hace falta el plan Pro, USD 20 por mes y por miembro.

Los proveedores de abajo **sí permiten uso comercial en su plan gratuito**.

---

## La propuesta

| Pieza | Servicio | Por qué |
|---|---|---|
| Aplicación | **Render**, plan gratuito | Corre Next.js con Node sin adaptaciones, permite uso comercial, no pide tarjeta. |
| Base de datos | **Neon**, plan gratuito | PostgreSQL de verdad, permite uso comercial, no pide tarjeta, no se borra sola. |
| Archivos (fotos y PDF) | **Volumen de Render** al principio; **Cloudflare R2** cuando crezca | R2 no cobra egreso, pero pide tarjeta. Ver más abajo. |
| Lectura de comprobantes | **Ninguno: corre en el teléfono** | Tesseract dentro del navegador. Costo cero, sin clave, sin límite de consumo. |

La lectura automática ya no es un problema de costos: **no consume ningún servicio
facturable**. Ese era el gasto variable más peligroso —crecía con cada factura cargada— y
desapareció.

---

## Servicio por servicio

### 1. Aplicación: Render (plan gratuito)

- **¿Permite uso comercial?** Sí. El plan gratuito de Render no prohíbe el uso comercial.
- **¿Pide tarjeta de crédito?** No para el servicio web gratuito.
- **Límites gratuitos:** 512 MB de RAM y 0,1 CPU por servicio; 100 GB de tráfico por mes;
  500 minutos de build por mes.
- **Qué pasa al alcanzarlos:** el servicio **se apaga tras 15 minutos sin visitas** y la
  primera visita después tarda entre 30 y 60 segundos en levantarlo. No hay cargo
  automático: si te pasás del tráfico o de los minutos de build, Render limita, no
  factura sin tu consentimiento.
- **Lo que hay que saber:** ese arranque en frío se nota. Para el encargado que abre la
  aplicación a las 7 de la mañana para cargar el remito, es medio minuto mirando una
  pantalla en blanco. **No es aceptable como estado definitivo**, sí como primera etapa
  mientras se valida el sistema con uso real.
- **Cuidado con la base de Render:** su PostgreSQL gratuito **se borra a los 30 días**
  (más 14 de gracia). Por eso la base va en Neon, no en Render.

### 2. Base de datos: Neon (plan gratuito)

- **¿Permite uso comercial?** Sí.
- **¿Pide tarjeta de crédito?** No.
- **Límites gratuitos:** 0,5 GB de almacenamiento por proyecto; 100 horas de cómputo (CU)
  por proyecto y por mes; 5 GB de transferencia; hasta 10 ramas. El cómputo baja a cero
  tras 5 minutos sin uso y vuelve a levantar solo.
- **Qué pasa al alcanzarlos:** la base **se suspende hasta el próximo ciclo** o hasta que
  cargues una tarjeta. **No te cobra sin autorización, pero deja de responder**: la
  aplicación quedaría sin base hasta el mes siguiente. Es el riesgo más serio de esta
  arquitectura y hay que vigilarlo.
- **¿Alcanza 0,5 GB?** Para esta aplicación, holgadamente. Las tablas guardan números y
  textos cortos; lo que pesa son las imágenes, y **las imágenes no van en la base**. Una
  estimación gruesa: unos pocos kB por comprobante entre factura, artículos, movimientos
  y auditoría. Con tres sucursales cargando 20 comprobantes por día son unos 20 MB al
  año. Lo que sí puede crecer es el texto reconocido que se guarda por intento de
  lectura, para diagnóstico; si aprieta, se purga el de los comprobantes ya confirmados.
- **Alternativa equivalente:** **Supabase** (500 MB, uso comercial permitido, sin
  tarjeta), con una diferencia importante: **pausa el proyecto tras 7 días sin ninguna
  petición**. Para un sistema que se usa todos los días no es problema; para uno que
  descansa en las vacaciones de enero, sí. Neon es más previsible.

### 3. Archivos: dos etapas

Las fotos de los comprobantes son lo único que crece de verdad. Cada factura optimizada
pesa alrededor de 1,5 MB; con 20 comprobantes por día son ~11 GB al año.

**Etapa 1 — volumen de Render (`STORAGE_DRIVER=local`).** Sin costo y sin tarjeta, pero
un volumen persistente en Render es una función de pago: en el plan gratuito el disco es
**efímero** y las fotos se perderían en cada despliegue. Sirve **sólo para probar**, no
para operar.

**Etapa 2 — Cloudflare R2 (`STORAGE_DRIVER=s3`).** Es la buena, y la aplicación ya la
soporta sin tocar código.

- **¿Permite uso comercial?** Sí.
- **¿Pide tarjeta de crédito?** **Sí.** Cloudflare exige una tarjeta para habilitar R2,
  aunque no cobre nada dentro del tramo gratuito. **Como pediste que no configure nada
  que pueda generar cargos sin consultarte, esto queda esperando tu decisión.**
- **Límites gratuitos:** 10 GB-mes de almacenamiento, 1 millón de operaciones de escritura
  y 10 millones de lectura por mes, y **egreso sin cargo** (lo que lo hace mucho más
  barato que S3 para servir fotos).
- **Qué pasa al alcanzarlos:** empieza a facturar el excedente, del orden de USD 0,015 por
  GB-mes. Pasados los 10 GB —más o menos a los diez meses de uso real— serían centavos por
  mes, pero **son centavos que se cobran a esa tarjeta**. Es un cargo chico y previsible,
  no una sorpresa, pero es un cargo.
- **Alternativa sin tarjeta:** **Backblaze B2** da 10 GB gratis. Conviene confirmar si hoy
  pide tarjeta al registrarse; su egreso gratuito está atado a un múltiplo de lo
  almacenado.

**Mientras tanto, sin tarjeta y sin riesgo:** guardar las fotos en el volumen de una
máquina propia (ver más abajo) o aceptar la etapa 1 sabiendo que las imágenes son
descartables durante las pruebas. Los datos contables —que son los que importan— están en
Neon en los dos casos.

---

## La opción sin plan gratuito de nadie

Si en la fiambrería hay una computadora que queda prendida, **el sistema corre ahí**:
Docker Compose con la aplicación y PostgreSQL, las fotos en un disco propio, y acceso
desde los teléfonos por la red del local o por un túnel gratuito de Cloudflare. Costo
cero, sin tarjeta, sin límites y sin arranque en frío. Lo que cambia es que las copias de
seguridad pasan a ser responsabilidad tuya.

Está documentado en [`DESPLIEGUE.md`](DESPLIEGUE.md), opción 3.

---

## Cuándo dejará de alcanzar el costo cero

| Señal | Qué pasó | Qué hacer |
|---|---|---|
| La base deja de responder a fin de mes | Se agotaron las 100 horas de cómputo de Neon | Neon Launch, USD 19/mes |
| Se llenó el medio giga de la base | Muchos comprobantes, o mucho texto de diagnóstico | Purgar texto de OCR viejo, o Neon Launch |
| Abrir la aplicación tarda medio minuto | Render apagó el servicio por inactividad | Render Starter, USD 7/mes |
| El bucket pasó los 10 GB | Alrededor de diez meses de fotos | Se factura el excedente en R2, centavos por mes |

Ninguno de estos saltos ocurre solo: **ninguno de los servicios propuestos sube de plan
automáticamente**. Se agotan y avisan, o dejan de responder. Eso es lo que pediste.

---

## Lo que hace falta que decidas

1. **¿Aceptás el arranque en frío de Render** (medio minuto la primera visita del día) a
   cambio de no pagar nada, o preferís los USD 7/mes que lo eliminan?
2. **¿Cargamos una tarjeta en Cloudflare para R2?** Sin tarjeta no hay R2, y sin R2 las
   fotos no tienen dónde vivir de forma persistente y gratuita en la nube.
3. **¿Hay una máquina en la fiambrería que quede prendida?** Si la hay, la opción 3 es
   mejor que todas las anteriores para esta etapa.

Decime y lo dejo configurado. Hasta entonces no toco ninguna cuenta.
