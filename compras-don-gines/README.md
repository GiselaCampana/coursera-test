# Compras Don Ginés

Aplicación web para administrar las compras de la cadena de fiambrerías Don Ginés.

Se le saca una foto a la factura desde el teléfono y la aplicación la lee sola: extrae
los artículos, las cantidades, los precios, los descuentos y los impuestos, **controla
que el detalle cierre contra los totales impresos**, calcula el costo final de cada
producto, agenda el pago según las condiciones del proveedor y guarda el historial de
precios y de kilos comprados.

La regla que ordena todo el sistema: **un comprobante que no cierra no se guarda como
controlado**. Ni el frontend ni una lectura "casi buena" pueden saltearse ese control.

---

## Índice

1. [Qué hace](#qué-hace)
2. [Decisiones técnicas](#decisiones-técnicas)
3. [Puesta en marcha](#puesta-en-marcha)
4. [Variables de entorno](#variables-de-entorno)
5. [Usuarios iniciales](#usuarios-iniciales)
6. [Cómo funciona la lectura](#cómo-funciona-la-lectura)
7. [Los autocontroles](#los-autocontroles)
8. [Pruebas](#pruebas)
9. [Despliegue](#despliegue)
10. [Copias de seguridad](#copias-de-seguridad)
11. [Qué está hecho y qué falta](#qué-está-hecho-y-qué-falta)

---

## Qué hace

**Carga desde el teléfono.** Mobile first. Dos accesos separados: *Sacar foto* (abre la
cámara trasera) y *Elegir del teléfono* (abre la galería). Acepta JPG, PNG, WEBP, HEIC y
PDF, hasta 10 páginas por comprobante, con miniaturas que se reordenan y se borran. Una
foto repetida no se agrega dos veces. Las fotos pesadas se optimizan solas: nunca se le
pide al usuario que vuelva a elegir la imagen. Los errores se muestran en castellano.

**Lectura automática.** El comprobante se lee por etapas y, si el detalle no cierra
contra el resumen impreso, la aplicación **vuelve sola sobre la imagen**: recorta y
amplía la tabla de artículos y el pie, los lee por separado, compara todas las lecturas
y se queda con la más consistente. Nunca completa un dato para que la cuenta cierre.

**Control contable.** Semáforo de tres estados. Verde sólo cuando los artículos, el
neto, los impuestos y el total coinciden de verdad. Amarillo cuando hizo falta corregir
la lectura pero reconcilió. Rojo cuando no cierra, y ahí **el guardado queda
bloqueado**. Un administrador puede forzarlo, pero tiene que dejar el motivo y queda
registrado en auditoría.

**Pagos.** El vencimiento se calcula con el plazo del proveedor vigente al momento de la
carga. Vencer y pagar son eventos distintos: el comprobante queda *agendado* y pasa a
*vence hoy* o *vencido* por el paso del tiempo, y sólo se marca *pagado* cuando alguien
confirma el pago con su fecha efectiva, forma de pago y referencia. La fecha prevista
nunca se pisa con la efectiva.

**Historial y precios.** Cada compra deja su movimiento: kilos, unidades, piezas, precio
neto, descuento, IVA y percepciones prorrateados, y costo unitario final. Con eso la
aplicación arma el historial de costos con su variación, y sugiere precios de venta
(por kilo, por 100 g, por 1/4, por pieza u horma, en pago digital y en efectivo).

**Administración.** Sucursales, usuarios, roles y permisos, proveedores con historial de
condiciones y de tasas, productos con alias, márgenes, descuentos y redondeos. Todo
desde la aplicación: **agregar una cuarta sucursal o un rol de encargado no requiere
tocar el código**.

---

## Decisiones técnicas

| Decisión | Por qué |
|---|---|
| **Next.js 15 + React 19, TypeScript de punta a punta** | Un solo proyecto para la interfaz y la API. Los Server Components permiten que el control de permisos viva en el servidor, no en el navegador. |
| **PostgreSQL + Prisma** | Migraciones versionadas y tipos generados. `Decimal` nativo para los importes. |
| **decimal.js para toda la aritmética de dinero** | Con `float`, `0.1 + 0.2` no da `0.3`. En una factura de dos millones de pesos con prorrateos por renglón, eso se convierte en diferencias de centavos que hacen fallar los controles. Ningún importe pasa por `number`. |
| **Almacenamiento detrás de una interfaz (`ObjectStorage`)** | Driver local para desarrollo o una instalación chica con disco montado, y driver S3 para producción. Cambiar de uno a otro es una variable de entorno. |
| **La lectura corre en el teléfono, gratis** | Tesseract, su WebAssembly y el idioma español los sirve la propia aplicación: no hay clave de API, ni servicio externo, ni costo por comprobante. La foto no sale del teléfono. |
| **El navegador reconoce, el servidor interpreta** | El teléfono sólo produce texto. Quién es el proveedor, qué dice cada columna, cuánto da cada renglón y si el comprobante cierra lo decide el servidor: la contabilidad nunca depende de lo que mande el cliente. |
| **Un analizador por formato de comprobante** | Cada proveedor imprime distinto. `src/lib/ocr/parsers/` tiene un analizador por formato —el de Los Calvos ya escrito— y un genérico como red de contención. Sumar un proveedor es escribir su analizador y agregarlo al registro. |
| **Sesiones propias con scrypt y cookie httpOnly** | Sin dependencias extra ni servicios de terceros. El token va en la cookie; en la base sólo su SHA-256. |
| **Permisos en la base, no en el código** | Los roles guardan una lista de permisos. Se crean roles nuevos desde Configuración. |
| **El mismo código de cálculo en el navegador y en el servidor** | La pantalla de revisión recalcula en vivo con `costItems` y `validateDocument`, exactamente las mismas funciones que corre el backend al guardar. Lo que ve el usuario no puede diferir de lo que se controla. |

### Estructura

```
src/
  lib/
    money.ts              Aritmética decimal y formato es-AR
    datetime.ts           Fechas en America/Argentina/Buenos_Aires
    domain/
      costing.ts          Cálculo por artículo y prorrateo de impuestos
      validation.ts       Los autocontroles del comprobante
      payments.ts         Plazos, vencimientos y estados de pago
      pricing.ts          Precios de venta
      matching.ts         Reconocimiento de productos
    cliente/ocr/          Lectura en el navegador (corre en el teléfono)
      tesseract.ts        Worker de Tesseract, servido localmente
      imagen.ts           Escala de grises, contraste, ruido, inclinación, perspectiva
      preproceso.ts       Preparación de la página y de cada recorte
      regiones.ts         Dónde están la tabla de artículos y el pie
      pdf.ts              Rasterización de PDF con PDF.js
      lector.ts           Sesión de lectura por etapas
    ocr/
      types.ts            Vocabulario de la lectura
      text-parser.ts      Lectura del texto reconocido, por columnas
      parsers/            Un analizador por formato de comprobante
        los-calvos.ts     Analizador del proveedor Los Calvos
        generico.ts       Red de contención para formatos desconocidos
    storage/              Interfaz + drivers local, S3 y Supabase
    services/
      almacenamiento.ts   Espacio usado, aviso al 80 %, bloqueo al 95 %
      archivado.ts        Exportación en ZIP y archivado de imágenes viejas
    auth/
      proveedor.ts        Quién verifica la contraseña: local o Supabase Auth
    cliente/
      red.ts              Pedidos tolerantes al arranque en frío de Render
    auth/                 Contraseñas, sesiones y permisos
    services/             Casos de uso (comprobantes, pagos, precios, reportes)
  app/                    Pantallas y rutas de API
prisma/                   Esquema, migraciones y datos iniciales
tests/                    unit / integration / e2e
```

---

## Puesta en marcha

**Requisitos:** Node.js 20.11 o superior y PostgreSQL 14 o superior.

```bash
cd compras-don-gines
npm install

cp .env.example .env
# Editar .env: como mínimo DATABASE_URL.

createdb compras_don_gines          # o el nombre que se haya puesto en .env
npm run db:migrate                  # aplica las migraciones
npm run db:seed                     # crea roles, sucursales, usuarios y Los Calvos

npm run dev                         # http://localhost:3000
```

El seed imprime las credenciales iniciales **una sola vez**. Si no se definen
`SEED_ADMIN_PASSWORD` y `SEED_OPERATOR_PASSWORD`, las genera al azar; si sí se
definen, no las imprime, porque ya las conoce quien las eligió.

Es idempotente: crea sólo lo que falta y no pisa nada. Correrlo de nuevo sobre
una base ya sembrada no cambia ninguna contraseña.

Esas contraseñas sirven **para entrar una vez**. Todo usuario que crea el seed
queda con `mustChangePassword`, y el layout del servidor lo manda a
`/cambiar-contrasena` hasta que elija una propia: no llega a ninguna pantalla
antes de eso, ni escribiendo la URL a mano.

---

## Variables de entorno

Todas están documentadas en [`.env.example`](.env.example). Las que importan:

### Obligatorias

| Variable | Para qué |
|---|---|
| `DATABASE_URL` | Conexión a PostgreSQL. |
| `STORAGE_SIGNING_SECRET` | Firma las URLs de los comprobantes. **Obligatoria en producción.** Generar con `openssl rand -base64 48`. |

### Lectura automática

| Variable | Por defecto | Para qué |
|---|---|---|
| `OCR_MAX_ATTEMPTS` | `3` | Vueltas de relectura focalizada cuando el detalle no cierra. |

### Supabase

| Variable | Por defecto | Para qué |
|---|---|---|
| `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` | — | Proyecto de Supabase. Obligatorias con `STORAGE_DRIVER=supabase` o `AUTH_PROVIDER=supabase`. |
| `SUPABASE_BUCKET` | `comprobantes` | Bucket **privado** de las imágenes. |
| `AUTH_PROVIDER` | `local` | `local` (hash scrypt propio) o `supabase` (Supabase Auth verifica la contraseña). |
| `STORAGE_LIMIT_BYTES` | `1073741824` (1 GB) | Cuánto espacio se permite ocupar. Avisa al 80 % y bloquea al 95 %. |

> `SUPABASE_SERVICE_ROLE_KEY` saltea todas las políticas de seguridad de Supabase. Va
> sólo en el servidor: nunca en una variable `NEXT_PUBLIC_`, nunca en el repositorio.

**No hay ninguna clave que configurar.** El lector corre dentro del navegador con
Tesseract, y los archivos que necesita los sirve la propia aplicación desde `public/ocr/`
(los copia `npm run ocr:preparar`, que ya corren `npm run dev` y `npm run build`). El
costo por comprobante es cero y la foto no sale del teléfono.

### Almacenamiento

| Variable | Por defecto | Para qué |
|---|---|---|
| `STORAGE_DRIVER` | `local` | `local` o `s3`. |
| `STORAGE_LOCAL_DIR` | `./.storage` | Directorio del driver local. Tiene que ser un volumen persistente. |
| `S3_BUCKET`, `S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | — | Obligatorias con `STORAGE_DRIVER=s3`. |
| `S3_ENDPOINT`, `S3_FORCE_PATH_STYLE` | — | Para MinIO, Cloudflare R2 o Backblaze B2. |
| `SIGNED_URL_TTL_SECONDS` | `900` | Vigencia de los enlaces a los comprobantes. |

> **El bucket tiene que ser privado.** Los comprobantes nunca se sirven en abierto: se
> accede a ellos con una URL firmada, con vencimiento y previa verificación de que el
> usuario tenga alcance sobre esa sucursal.

---

## Usuarios iniciales

El seed crea:

| Usuario | Rol | Alcance |
|---|---|---|
| `admin@dongines.local` | Administrador | Las tres sucursales, configuración, pagos y auditoría |
| `devoto@dongines.local` | Operador de sucursal | Devoto |
| `pueyrredon@dongines.local` | Operador de sucursal | Pueyrredón |
| `sanmartin@dongines.local` | Operador de sucursal | San Martín |

Y un rol **Supervisor** sin usuarios asignados, como ejemplo de que se pueden agregar
roles desde Configuración sin tocar el código.

**Qué puede cada rol**

| | Operador | Administrador |
|---|---|---|
| Cargar comprobantes | Sólo de su sucursal | Todas |
| Revisar y confirmar comprobantes | Sólo de su sucursal | Todas |
| Consultar comprobantes y compras | Sólo de su sucursal | Todas |
| Confirmar pagos | No | Sí |
| Anular comprobantes | No | Sí, con motivo |
| Configuración | No | Sí |
| Auditoría | No | Sí |

Los permisos se editan en *Configuración → Roles y permisos*. El sistema no deja quitarle
al rol Administrador los permisos de administrar usuarios y roles, ni dar de baja al
último usuario que pueda administrar usuarios: sin eso, nadie podría volver a entrar.

---

## Cómo funciona la lectura

La lectura **corre entera en el teléfono**, con Tesseract compilado a WebAssembly y el
idioma español, servidos por la propia aplicación. No interviene ningún servicio externo,
no hace falta ninguna clave y no hay costo por comprobante.

1. **Preparación en el navegador.** La foto se endereza según sus metadatos EXIF (con
   `createImageBitmap(…, { imageOrientation: 'from-image' })`, que es lo que entiende
   Safari en iPhone). Si es un PDF, PDF.js rasteriza hasta 10 páginas. Después, sobre el
   lienzo: detección de las cuatro esquinas del papel y corrección de perspectiva,
   escala de grises perceptual, estiramiento de contraste, filtro de mediana contra el
   ruido, realce de bordes y enderezado por perfil de proyección.
2. **Lectura completa.** Tesseract lee la página entera y devuelve el texto con la
   disposición conservada, más la caja de cada línea.
3. **Recortes.** Con esas cajas se ubican la tabla de artículos y el resumen del pie. Se
   recortan, se amplían hasta ×4 y se binarizan con Sauvola —umbral adaptativo, que es lo
   que salva un papel con sombra— antes de volver a leerlos por separado.
4. **Interpretación en el servidor.** El teléfono manda sólo texto. El servidor elige el
   analizador del proveedor —el de Los Calvos conoce el orden de sus columnas, que el
   importe es bruto y que la unidad es el kilo—, repara las confusiones típicas del OCR
   (`O`→0, `l`→1, `S`→5) **sólo en las columnas numéricas**, calcula cada renglón y corre
   los autocontroles contra el resumen impreso.
5. **Recuperación automática.** Si algo no cierra, el servidor responde *qué* no cerró y
   el navegador vuelve a leer: página completa en modo columna, recortes ensanchados y
   preprocesado más agresivo. Hasta `OCR_MAX_ATTEMPTS` vueltas.
6. **Elección.** Se arman todas las combinaciones de lecturas disponibles y gana la más
   consistente: primero la que tiene menos errores, después la que queda más cerca del
   neto impreso, después la que trae más renglones. **No gana la última, gana la mejor.**
7. **Si sigue sin cerrar** queda en rojo, con la diferencia detectada, y no se puede
   guardar. Los datos parciales se conservan para diagnóstico, junto con todos los
   intentos: estrategia, duración, confianza, inclinación corregida y texto reconocido.

En ningún momento se completa un número para hacer cerrar la cuenta. Lo que no se pudo
leer queda vacío y el semáforo lo marca.

### Números argentinos

El parser resuelve como el mismo importe `2.196.120,52`, `2 196 120,52`, `$ 2.196.120,52`
y `2196120,52`, y distingue una tasa del `1,5 %` de un importe de `$ 1,50`. La regla del
punto: agrupa miles sólo si lo que está antes es un primer grupo real de 1 a 3 dígitos sin
cero a la izquierda, así `16.037` son dieciséis mil pero `0.015` es una fracción.

---

## Los autocontroles

Por artículo: `bruto = cantidad × precio`, `neto = bruto − descuento`, IVA y percepciones
prorrateados sobre el neto, `costo total = neto + IVA + percepciones`,
`costo unitario = costo total / cantidad`. **El residuo de redondeo del prorrateo se
ajusta en el último artículo**, para que la suma dé exactamente el IVA y la percepción de
la factura.

Por comprobante se controla que la suma de los netos coincida con el neto impreso, que el
bruto y los descuentos coincidan, que los kilos sumen el peso neto, que la cantidad de
renglones coincida con la impresa, que el IVA y las percepciones se correspondan con las
tasas del proveedor y que `neto + IVA + percepciones` dé el total impreso.

La tolerancia es el **mayor entre $1 y el 0,5 %** del importe de referencia. Una
diferencia mayor bloquea la validación.

Dos casos que el sistema detecta explícitamente:

- **Base incompleta con impuestos correctos.** Si los artículos suman $1.670.389 y sobre
  eso el IVA del 21 % y el IIBB del 1,5 % dan bien, el cálculo porcentual es correcto pero
  la factura sigue mal leída si el neto impreso era $1.792.751,44. No se muestra verde.
- **Totales que son de un renglón.** Si lo leído como totales es de un orden de magnitud
  menor que el detalle, la aplicación avisa que probablemente se leyeron los importes de
  una línea en lugar del resumen, y señala con qué renglón coinciden.

---

## Pruebas

```bash
npm test              # unitarias e integración (144)
npm run test:unit     # sólo unitarias
npm run test:e2e      # end to end: prepara la base, compila y corre Playwright (70)
npm run test:all      # todo
```

Las de integración necesitan un PostgreSQL y usan `.env.test`; las end to end usan
`.env.e2e`. **Ambas se niegan a correr si `DATABASE_URL` no apunta a una base cuyo nombre
contenga `test` o `e2e`**, porque empiezan por vaciar las tablas.

Las de integración aplican las migraciones sobre una base vacía, así que comprueban
además que las migraciones corran desde cero.

**Qué cubren.** Separadores argentinos y tasas contra importes; el cálculo completo de la
factura de Los Calvos; el prorrateo de IVA e IIBB con el ajuste en el último artículo; la
detección de renglones faltantes, precios mal leídos, totales incorrectos y totales que
son de un renglón; el bloqueo del guardado; el preprocesado de imagen —grises, contraste,
ruido, binarización de Sauvola, umbral de Otsu, inclinación, detección de esquinas y
perspectiva—; los analizadores por proveedor y la reparación de las confusiones del OCR
sólo en columnas numéricas; la relectura automática y la elección del conjunto más
consistente; la conversión y compresión de imágenes y la orientación EXIF; el flujo
completo contra PostgreSQL (leer, controlar, confirmar, agendar, pagar); duplicados;
restricciones por sucursal; permisos; transacciones y rollback; historial de precios y
cálculo de precios de venta; y, desde el navegador con perfil de iPhone 13, **la lectura
real de la factura de Los Calvos con Tesseract corriendo en la página**, el ingreso, la
carga desde cámara y galería, las fotos repetidas, la optimización automática, el semáforo
rojo con el guardado bloqueado, la agenda y confirmación de pagos, que no se pida ninguna
clave de API, que los archivos del lector los sirva la propia aplicación y que el
navegador no salga a ningún dominio externo, y que ninguna pantalla tenga scroll
horizontal.

### El caso de aceptación

La factura A 0010-00212356 de Los Calvos del 14/08/2026 se verifica de punta a punta:

| | Esperado | Resultado |
|---|---|---|
| Artículos | 9 | 9 |
| Kilos | 153,70 | 153,70 |
| Subtotal bruto | $2.084.594,70 | $2.084.594,70 |
| Descuento 14 % | $291.843,26 | $291.843,26 |
| Neto | $1.792.751,44 | $1.792.751,44 |
| IVA 21 % | $376.477,81 | $376.477,81 |
| IIBB 1,5 % | $26.891,27 | $26.891,27 |
| Total | $2.196.120,52 | $2.196.120,52 |
| Fecha prevista de pago | 14/08/2026 | 14/08/2026 |
| Estado del pago | agendado, no pagado | agendado, no pagado |

Un detalle que vale la pena: el IVA impreso de $376.477,81 **no** es el 21 % del neto
total, que da $376.477,80. Sale de redondear el IVA renglón por renglón. Es un centavo, y
la tolerancia lo absorbe sin marcar error.

---

## Despliegue

**La puesta en marcha elegida es Render Free + Supabase Free**, sin tarjeta de crédito y
sin ningún servicio pago: ver [`docs/DESPLIEGUE-RENDER-SUPABASE.md`](docs/DESPLIEGUE-RENDER-SUPABASE.md),
que incluye los límites gratuitos, qué pasa al alcanzarlos y las copias de seguridad.

Para otras formas de desplegar —servidor propio, Docker, S3— ver
[`docs/DESPLIEGUE.md`](docs/DESPLIEGUE.md); y para cómo se comparó cada opción de
alojamiento gratuito, [`docs/ALOJAMIENTO-COSTO-CERO.md`](docs/ALOJAMIENTO-COSTO-CERO.md).
En resumen:

```bash
npm ci
npx prisma migrate deploy       # migraciones
npm run build                   # build de producción
npm run start                   # o el proceso que maneje el servidor
```

Antes de exponerlo:

- `NODE_ENV=production` y `APP_URL` con la URL pública real.
- `STORAGE_SIGNING_SECRET` generado con `openssl rand -base64 48`.
- **HTTPS obligatorio**: la cookie de sesión se marca `secure` en producción y sin TLS no
  viaja. Además, sin contexto seguro Safari no da acceso a la cámara.
- `STORAGE_DRIVER=s3` con un bucket **privado**, o un volumen persistente si se usa el
  driver local.
- El primer ingreso con el usuario administrador. Del cambio de contraseña no hay que
  acordarse: la aplicación no deja entrar a ninguna pantalla hasta que se haga.

---

## Copias de seguridad

Hay dos cosas que respaldar, y las dos hacen falta: **la base** y **los archivos de los
comprobantes**. Una factura sin su imagen no se puede auditar.

```bash
# Base, diario
pg_dump --format=custom --file=dongines-$(date +%F).dump "$DATABASE_URL"

# Restaurar
pg_restore --clean --if-exists --dbname="$DATABASE_URL" dongines-2026-08-22.dump

# Comprobantes con el driver local
tar czf comprobantes-$(date +%F).tar.gz .storage/
```

Con S3, activar el versionado del bucket y una regla de ciclo de vida.

Recomendado: retención de 30 días diarios y 12 meses mensuales; los comprobantes se
conservan al menos el plazo de prescripción impositiva. **Probar la restauración cada
tanto**: una copia que nunca se restauró no es una copia.

---

## Qué está hecho y qué falta

### Funcionando y verificado

- Persistencia real en PostgreSQL con migraciones desde base vacía.
- Autenticación con scrypt, sesiones en base, bloqueo por intentos fallidos y RBAC
  verificado en el backend.
- Almacenamiento de imágenes y PDF con URLs firmadas.
- Lectura por etapas con recuperación automática y registro de cada intento.
- Autocontroles contables, con el guardado bloqueado cuando no cierran.
- Guardado transaccional de factura, artículos, movimientos, costos y agenda.
- Agenda de pagos y confirmación con historial completo.
- Historial de precios y de cantidades, con exportación a CSV.
- Cálculo de precios de venta con las dos bases de margen.
- Administración de sucursales, usuarios, roles, proveedores y productos.
- Auditoría de las operaciones sensibles.
- Interfaz mobile first, verificada con perfil de iPhone 13.
- Lectura automática gratuita con Tesseract en el navegador, sin clave ni costo por comprobante, verificada sobre la imagen de la factura de Los Calvos.
- Imágenes comprimidas a ~500 kB, en una sola versión, con indicador de espacio, aviso al 80 %, bloqueo preventivo al 95 % y archivado en ZIP que conserva todos los datos.
- Tolerancia al arranque en frío de Render: reintentos automáticos y aviso en castellano.
- Pantalla de diagnóstico de lectura, que no guarda nada.

### Limitaciones conocidas

- **Supabase Auth está implementado pero no verificado.** No existía un proyecto de
  Supabase contra el cual probarlo. Por eso `AUTH_PROVIDER` viene en `local`, que sí está
  probado, y pasar a `supabase` es cambiar una variable —y volver atrás, también—. El
  primer ingreso con el proveedor nuevo es la prueba. Lo mismo vale para el driver de
  Supabase Storage: el código está, las pruebas corren contra el driver local.
- **El plan gratuito de Supabase pausa el proyecto a los 7 días sin actividad.** Si la
  fiambrería cierra dos semanas, al volver hay que reactivarlo a mano desde el panel. Los
  datos no se pierden, pero el sistema no arranca solo.
- **El aviso de arranque en frío no alcanza a la primerísima visita.** Mientras Render
  levanta el contenedor, la aplicación todavía no corre, así que no hay nada nuestro que
  pueda dibujar un mensaje: el navegador muestra su propio indicador de carga. El aviso sí
  aparece cuando la aplicación ya está abierta y el servidor se durmió entre dos acciones,
  que es el caso frecuente.
- **El plan gratuito de Supabase no hace copias de seguridad automáticas.** Es lo único de
  toda la configuración que puede terminar en una pérdida irrecuperable. Ver el
  procedimiento mensual en `docs/DESPLIEGUE-RENDER-SUPABASE.md`.

- **El caso de Los Calvos se verifica sobre una factura generada, no sobre la foto
  original.** No conté con el papel. La prueba end to end dibuja la factura completa como
  imagen, la sube y la lee con Tesseract dentro del navegador: 9 artículos, 153,70 kg y
  $2.196.120,52, y después la guarda con el pago agendado. Lo que falta medir es cuánto
  degrada una foto de verdad —papel arrugado, sombra del hombro, impresora con poca
  tinta—. Es la primera prueba a hacer con comprobantes reales, y de ahí saldrá el ajuste
  fino del preprocesado.
- **El tamaño de la letra manda.** Sobre el comprobante generado, la lectura es exacta y
  estable cuando los dígitos quedan en unos 26 px de alto, que es lo que da una A4 impresa
  fotografiada a 2200 px. Con letra más chica el OCR empieza a confundir el 6 con el 0.
  Si un proveedor imprime muy apretado, conviene acercar más la cámara.
- **Tesseract es más lento que un lector en la nube.** En el contenedor donde corren las
  pruebas, leer una página con sus recortes lleva unos diez segundos. **En un iPhone va a
  ser bastante más**, y no lo pude medir: no tuve un teléfono para probar. La aplicación
  muestra el avance etapa por etapa justamente por eso. A cambio no hay clave, no hay
  costo por comprobante y la foto no sale del teléfono.
- **Los archivos del lector pesan ~52 MB** en `public/ocr/` (todas las variantes del
  WebAssembly de Tesseract más el idioma español). El navegador baja sólo la variante que
  soporta —unos 15 MB— y la deja en caché. En una conexión móvil lenta conviene abrir la
  aplicación una vez con wifi.
- **Una lectura que no cierra a la primera no es una falla.** Sobre el comprobante bien
  fotografiado cierra en la primera vuelta; sobre uno peor, la relectura corrige y el
  comprobante queda controlado en amarillo, que es el estado previsto para eso. Con una
  foto peor pueden hacer falta las tres vueltas, y si aun así no cierra queda en rojo con
  el guardado bloqueado, que también es lo correcto.
- **La conversión de HEIC no está ejercitada con un archivo real.** El entorno no tiene
  encoder HEVC para generar uno. Está probada la detección del formato y el mensaje de
  error en castellano cuando la conversión falla.
- **Las pruebas end to end corren en Chromium, no en WebKit**, porque el entorno no lo
  tiene instalado. Verifican el diseño móvil, no el motor de Safari. Para correrlas en
  WebKit: `npx playwright install webkit` y descomentar el proyecto `safari-iphone` de
  `playwright.config.ts`.
- **La imagen de Docker no está construida ni probada.** El `Dockerfile` y el
  `docker-compose.yml` de `docs/docker/` están escritos y revisados, pero este entorno no
  tiene un daemon de Docker corriendo. Los despliegues verificados son el de servidor
  propio y el flujo `migrate deploy` + `build` + `start`.

### Preparado pero no implementado

- **Conciliación con ventas.** La tabla `sales_movements` y sus relaciones están en el
  modelo, listas para recibir las ventas de Maxirest y comparar compra, venta, merma y
  stock teórico. Falta el importador y las pantallas.
- **Pagos parciales.** El modelo los admite y el servicio los procesa (hay una prueba que
  lo verifica); falta la pantalla que los ofrezca explícitamente.
- **Otras percepciones además de IIBB.** El campo `otherPerceptions` existe en las reglas
  del proveedor; hoy la interfaz configura IVA e IIBB.
- **Un lector asistido por IA como ayuda opcional.** La interfaz
  `LectorAsistidoOpcional` (`src/lib/ocr/types.ts`) está declarada y **no se usa**: ningún
  camino del código la invoca y la aplicación no la necesita. Está sólo para que, si algún
  día se quisiera sumar un lector de pago como complemento, exista dónde enchufarlo sin
  tocar la contabilidad ni los analizadores. Mientras tanto, la lectura gratuita con
  Tesseract es el único camino que corre.
