# Puesta en marcha: Render Free + Supabase Free

Esta es la arquitectura elegida para la primera etapa:

| Pieza | Dónde | Plan |
|---|---|---|
| Aplicación | Render | Free |
| PostgreSQL | Supabase | Free |
| Contraseñas | Supabase Auth | Free |
| Imágenes de comprobantes | Supabase Storage, bucket privado `comprobantes` | Free |
| Lectura automática (OCR) | En el teléfono, con Tesseract | Sin servicio, sin costo |

**Ninguno de los pasos de abajo pide una tarjeta de crédito ni activa un plan
pago.** Lo que hay que verificar en cada paso está anotado.

---

## Antes de empezar

Hacen falta dos cuentas gratuitas, con correo y contraseña:

1. **Supabase** — https://supabase.com
2. **Render** — https://render.com

En ninguna de las dos hay que cargar una tarjeta para lo que sigue. Si en algún
momento aparece una pantalla pidiéndola, **frená y avisá**: significa que algo
del recorrido cambió respecto de lo previsto.

---

## Paso 1 — Proyecto en Supabase

El proyecto ya está creado: **`jdhljvfznwkvqcodxrjn`**, plan Free.
`SUPABASE_URL` es `https://jdhljvfznwkvqcodxrjn.supabase.co`.

### Datos que hay que copiar

En *Project Settings*:

| Dónde | Qué | Para qué variable |
|---|---|---|
| Database → Connection string → **Session pooler** | La cadena `postgresql://…` | `DATABASE_URL` |
| API Keys → **Publishable** | `sb_publishable_…` | `SUPABASE_PUBLISHABLE_KEY` |
| API Keys → **Secret** | `sb_secret_…` | `SUPABASE_SECRET_KEY` |

> Los proyectos nuevos usan un formato de claves distinto al de los viejos:
> *publishable* reemplaza a *anon* y *secret* reemplaza a *service_role*. La
> aplicación acepta los dos nombres, así que no importa cuál muestre el panel.

> **Dónde poner cada cosa.** La clave publishable no es un secreto —en una
> aplicación común viaja al navegador—. La **secret** y la contraseña de la base
> sí lo son: **cargalas directamente en el panel de Render**, no las mandes por
> chat ni por correo. Si alguna se filtró, se rota desde el panel de Supabase y
> listo; no hay que rehacer nada.

> **Usá la cadena del pooler, no la directa.** Render Free reinicia el servicio
> cada vez que se duerme y se despierta; con conexiones directas se agota el
> límite de PostgreSQL. El pooler está pensado justamente para eso.

> **La clave `service_role` saltea todas las políticas de seguridad.** Va
> únicamente en las variables de entorno de Render, del lado del servidor.
> Nunca en el repositorio, nunca en una variable `NEXT_PUBLIC_`, nunca en un
> correo.

### Por qué no se usa el arranque rápido que muestra el panel

El panel de Supabase ofrece un ejemplo con `@supabase/ssr`, variables
`NEXT_PUBLIC_…` y un middleware que refresca la sesión en cookies. **Es correcto,
pero para otra arquitectura**: la que se usa cuando el navegador le habla
directamente a Supabase y las políticas RLS deciden qué puede ver cada uno.

Acá el navegador **nunca** le habla a Supabase. El circuito es:

```
teléfono  ──fotos y texto reconocido──>  aplicación en Render  ──>  Supabase
                                          (único cliente)
```

Quién puede ver qué lo decide la aplicación, con el rol y la sucursal del
usuario, antes de pedirle nada a Supabase. Las razones de fondo:

- **El alcance por sucursal y los roles configurables ya viven en nuestra base**,
  porque son reglas del negocio: un operador de Devoto no ve Pueyrredón, y se
  pueden crear roles nuevos sin tocar código. Con RLS habría que mantener las
  mismas reglas escritas dos veces, en dos lugares, con el riesgo de que se
  separen.
- **Las imágenes se sirven con URLs firmadas que vencen a los 15 minutos**, y la
  aplicación decide caso por caso si las emite. El bucket es privado y el
  navegador nunca tiene una credencial de Supabase.
- **Habría dos sesiones a la vez**: la cookie de Supabase y la nuestra, que ya
  maneja el bloqueo por intentos fallidos y la auditoría. Dos mecanismos de
  sesión conviviendo es una fuente de errores difíciles.

Por eso no hace falta `@supabase/ssr` ni los helpers de `utils/supabase/`. Se
usa `@supabase/supabase-js` desde el servidor, que ya está instalado, y las
credenciales no llevan prefijo `NEXT_PUBLIC_` justamente para que no puedan
terminar en el navegador por descuido.

## Paso 2 — El bucket de comprobantes ✅

**Ya está hecho:** el bucket `comprobantes` existe y quedó **privado**, con
*Public bucket* desactivado. Es lo más importante de toda la configuración: con
el bucket público, cualquiera con el enlace vería las facturas de la fiambrería.

La aplicación nunca sirve un archivo por URL directa: pide una URL firmada con
vencimiento cada vez que alguien abre un comprobante, y decide si se la da según
el rol y la sucursal del usuario.

## Paso 3 — La aplicación en Render

1. Render → **New** → **Blueprint** → conectar el repositorio
   `giselacampana/coursera-test`.
2. Elegir la rama **`compras-don-gines-deploy`**.
3. Render lee `render.yaml` **de la raíz del repositorio** y propone el servicio
   ya configurado: plan **Free**, Node, con `rootDir` en `compras-don-gines`.
4. Completar en *Environment* las variables marcadas como `sync: false`:

   ```
   DATABASE_URL                (la cadena del pooler de Supabase)
   SUPABASE_URL                https://jdhljvfznwkvqcodxrjn.supabase.co
   SUPABASE_PUBLISHABLE_KEY    sb_publishable_…
   SUPABASE_SECRET_KEY         sb_secret_…
   APP_URL                     (la URL que asigne Render, ej. https://compras-don-gines.onrender.com)
   ```

   `STORAGE_SIGNING_SECRET` la genera Render sola. El resto viene del archivo.

5. Deploy. El primer build tarda unos minutos: instala, aplica las migraciones y
   compila.

> **`render.yaml` va en la raíz del repositorio.** Render busca el blueprint ahí
> y sólo ahí. Estuvo un tiempo dentro de `compras-don-gines/` y por eso Render
> no lo encontraba. La aplicación sigue viviendo en la subcarpeta: eso lo
> resuelve `rootDir` dentro del archivo, no la ubicación del archivo.

> **Verificá que el plan diga Free.** Render no sube de plan solo, pero conviene
> mirarlo una vez.

## Paso 4 — Datos iniciales

Una sola vez, desde una máquina con acceso a la base:

```bash
cd compras-don-gines
DATABASE_URL="…la cadena del pooler…" npm run db:seed
```

Crea los roles, las tres sucursales, el proveedor Los Calvos y dos usuarios. Las
contraseñas se imprimen **una sola vez** por pantalla: anotalas y cambialas al
primer ingreso.

Para elegirlas de antemano:

```bash
SEED_ADMIN_PASSWORD="…" SEED_OPERATOR_PASSWORD="…" DATABASE_URL="…" npm run db:seed
```

## Paso 5 — Primer ingreso

Abrir la URL de Render. **La primera vez puede tardar hasta un minuto**: el
servicio está frío. La aplicación lo explica en pantalla cuando puede hacerlo.

Ingresar con el usuario administrador y cambiar la contraseña.

## Paso 6 — Pasar las contraseñas a Supabase Auth (opcional, después)

La aplicación arranca con `AUTH_PROVIDER=local`: las contraseñas se verifican
contra el hash scrypt de nuestra base. Funciona y está probado.

Para pasar a Supabase Auth:

1. Crear los usuarios en Supabase → *Authentication* → *Users*, con el **mismo
   correo** que tienen en la aplicación, y marcarlos como confirmados.
2. Cambiar `AUTH_PROVIDER` a `supabase` en Render y volver a desplegar.
3. **Probar el ingreso antes de cerrar la sesión que ya tenés abierta.** Si algo
   falla, se vuelve a `local` con otra edición de la variable.

Qué cambia: las contraseñas las guarda y verifica Supabase, que además trae
recuperación por correo. Qué no cambia: los roles, los permisos, el alcance por
sucursal, las sesiones y la auditoría siguen siendo de la aplicación.

> **Esto no está verificado todavía**, porque no existía un proyecto de Supabase
> contra el cual probarlo. El primer ingreso con `AUTH_PROVIDER=supabase` es la
> prueba. Por eso el valor por defecto es `local` y el cambio es reversible.

---

## Los límites gratuitos, y qué pasa al alcanzarlos

> **De dónde salen estos números.** Los de Supabase los verifiqué durante este
> trabajo contra su documentación y notas de precios. Los de Render los tomé de
> mi conocimiento del servicio y **no los pude volver a verificar en línea antes
> de cerrar esta etapa**. Los planes gratuitos cambian seguido: **confirmalos en
> la página de precios de cada proveedor en el momento de crear la cuenta**, que
> es además cuando se ven las condiciones vigentes.
>
> Lo que sí es independiente de los números: **sin una tarjeta cargada, ninguno
> de los dos puede cobrarte nada.** Es la garantía que no depende de que yo haya
> leído bien una tabla de precios.

### Supabase Free

| Recurso | Límite | Qué pasa al alcanzarlo |
|---|---|---|
| Base de datos | 500 MB | Deja de aceptar escrituras. **No se factura.** |
| Storage | 1 GB | Rechaza subidas nuevas. **No se factura.** |
| Transferencia | 5 GB por mes | Se limita. **No se factura.** |
| Usuarios activos | 50.000 por mes | Muy por encima de lo que usa una fiambrería |
| Proyectos activos | 2 | |
| **Pausa por inactividad** | **7 días sin ninguna consulta** | El proyecto se pausa y hay que reactivarlo **a mano** desde el panel. Los datos no se pierden. |

**Lo que más aprieta es el 1 GB de Storage.** A 500 kB por comprobante son unos
2000 comprobantes. Con las tres sucursales cargando 20 por día, algo más de tres
meses; con menos movimiento, bastante más. Por eso la aplicación avisa al 80 %,
bloquea al 95 % y permite descargar y archivar los viejos.

La base de 500 MB, en cambio, sobra: guarda números y textos cortos. Lo único
que crece es el texto reconocido de cada lectura, que se guarda para
diagnóstico y se puede purgar.

**La pausa a los 7 días es el riesgo real de esta arquitectura.** Si la
fiambrería cierra dos semanas en enero, al volver hay que entrar al panel de
Supabase y reactivar el proyecto antes de poder usar el sistema.

### Render Free

| Recurso | Límite | Qué pasa al alcanzarlo |
|---|---|---|
| Instancia | 512 MB de RAM, 0,1 CPU | |
| **Apagado por inactividad** | **15 minutos sin visitas** | Se apaga. La visita siguiente tarda entre 30 y 60 segundos en despertarlo. **No se factura.** |
| Horas | 750 por mes por cuenta | Alcanza para un servicio siempre disponible |
| Tráfico | 100 GB por mes | Se limita. **No se factura.** |
| Minutos de build | 500 por mes | Se limita. **No se factura.** |

**El arranque en frío se nota todos los días.** El primero que abra la
aplicación a la mañana va a esperar hasta un minuto. La aplicación reintenta
sola y explica qué está pasando, pero la espera existe.

### Qué NO hay

- No hay tarjeta de crédito en ninguna de las dos cuentas.
- No hay plan pago activado.
- No hay cobro automático ni cambio de plan automático: los dos servicios
  **limitan o rechazan**, no facturan.
- No hay servicio de OCR: la lectura corre en el teléfono.

---

## Copias de seguridad

**El plan gratuito de Supabase no hace copias automáticas.** Es responsabilidad
de ustedes, y es lo único de toda esta configuración que puede terminar en una
pérdida de datos irrecuperable.

Una vez por mes, desde una máquina con `pg_dump`:

```bash
pg_dump "postgresql://…la cadena del pooler…" -Fc -f respaldo-$(date +%Y-%m).dump
```

Guardarlo fuera de Supabase: un pendrive, un disco externo, otra nube. Y
**probar una restauración al menos una vez**: una copia que nunca se restauró no
es una copia, es una intención.

Las imágenes se respaldan con la exportación ZIP desde *Configuración →
Almacenamiento*, que además es el paso previo obligatorio para liberar espacio.

---

## Cuándo esta arquitectura deja de alcanzar

| Señal | Qué pasó | Qué hacer |
|---|---|---|
| "El almacenamiento está al 80 %" | Se acumularon comprobantes | Descargar el ZIP y archivar |
| El sistema no acepta comprobantes | Se llegó al 95 % | Archivar ahora |
| A la vuelta de las vacaciones no entra nadie | Supabase pausó el proyecto | Reactivarlo desde el panel |
| Esperar un minuto cada mañana molesta | Render Free | Render Starter, USD 7/mes |
| Se llenó el medio giga de la base | Muchos comprobantes, o mucho texto de diagnóstico | Purgar texto de OCR viejo, o Supabase Pro |

Ninguno de estos saltos ocurre solo. **Los dos servicios se detienen y avisan;
ninguno cobra.**
