# Despliegue de Compras Don Ginés

Tres formas de ponerlo en producción, de la más simple a la más autónoma. En todas, lo
que no se puede saltear está en [Antes de exponerlo](#antes-de-exponerlo).

---

## Antes de exponerlo

- [ ] `NODE_ENV=production`.
- [ ] `APP_URL` con la URL pública real.
- [ ] `STORAGE_SIGNING_SECRET` generado con `openssl rand -base64 48`. La aplicación se
      niega a arrancar en producción sin él.
- [ ] **HTTPS.** La cookie de sesión se marca `secure` en producción: sin TLS no viaja y
      nadie puede iniciar sesión. Además, sin contexto seguro Safari no da acceso a la
      cámara del iPhone.
- [ ] Bucket S3 **privado** (o volumen persistente con el driver local).
- [ ] `ANTHROPIC_API_KEY` cargada, si se quiere lectura automática real.
- [ ] Migraciones aplicadas con `npx prisma migrate deploy`.
- [ ] Seed corrido una vez y contraseña del administrador cambiada en el primer ingreso.
- [ ] Copias de seguridad configuradas y **una restauración probada**.

> Las claves van por variables de entorno, nunca en el repositorio. `.env` está en
> `.gitignore`.

---

## Opción 1 — Vercel

La más rápida. Vercel corre la aplicación; la base y los archivos van aparte.

1. **Base de datos.** Neon, Supabase o cualquier PostgreSQL administrado. Copiar la
   cadena de conexión (con `sslmode=require`).
2. **Almacenamiento.** Un bucket privado en S3, Cloudflare R2 o Backblaze B2. En Vercel
   el sistema de archivos es efímero: **el driver local no sirve**.
3. **Importar el repositorio** en Vercel, con *Root Directory* en `compras-don-gines`.
4. **Variables de entorno** en Settings → Environment Variables:

   ```
   DATABASE_URL, STORAGE_SIGNING_SECRET, APP_URL,
   STORAGE_DRIVER=s3, S3_BUCKET, S3_REGION,
   S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY,
   ANTHROPIC_API_KEY
   ```

5. **Migraciones.** Poner el *Build Command* en:

   ```
   npx prisma migrate deploy && npm run build
   ```

6. **Seed**, una sola vez, desde una máquina con acceso a la base:

   ```bash
   DATABASE_URL="…" npm run db:seed
   ```

**A tener en cuenta:** la lectura de un comprobante con varias páginas y relecturas puede
pasar los 60 segundos del plan Hobby. Las rutas ya declaran `maxDuration` de 300 s, que
requiere un plan Pro.

---

## Opción 2 — Docker

Autónomo y reproducible. `Dockerfile` y `docker-compose.yml` están en `docs/docker/`.

```bash
cd compras-don-gines/docs/docker
cp ../../.env.example .env      # completar
docker compose up -d --build
docker compose exec app npx prisma migrate deploy
docker compose exec app npm run db:seed
```

Levanta la aplicación en el 3000 y un PostgreSQL con volumen persistente. Los
comprobantes van al volumen `comprobantes` con el driver local, o a S3 si se configura.

Detrás hay que poner un proxy con TLS (Caddy, Traefik o nginx). Con Caddy alcanza:

```
compras.dongines.com.ar {
    reverse_proxy app:3000
}
```

---

## Opción 3 — Servidor propio (VPS)

```bash
# 1. Node 20 y PostgreSQL 16
sudo apt install -y postgresql nginx
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && sudo apt install -y nodejs

# 2. Base
sudo -u postgres createuser --pwprompt dongines
sudo -u postgres createdb --owner=dongines compras_don_gines

# 3. Aplicación
git clone <repositorio> /opt/dongines && cd /opt/dongines/compras-don-gines
npm ci
cp .env.example .env && $EDITOR .env
npx prisma migrate deploy
npm run db:seed
npm run build
```

**Servicio de systemd** en `/etc/systemd/system/dongines.service`:

```ini
[Unit]
Description=Compras Don Gines
After=network.target postgresql.service

[Service]
Type=simple
User=dongines
WorkingDirectory=/opt/dongines/compras-don-gines
EnvironmentFile=/opt/dongines/compras-don-gines/.env
ExecStart=/usr/bin/npm run start
Restart=always
RestartSec=5
# El directorio de comprobantes tiene que sobrevivir a los reinicios.
ReadWritePaths=/opt/dongines/compras-don-gines/.storage

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now dongines
```

**nginx con TLS** (`certbot --nginx` para el certificado):

```nginx
server {
    listen 443 ssl http2;
    server_name compras.dongines.com.ar;

    # Las fotos de iPhone llegan a varios MB y van hasta 10 por comprobante.
    client_max_body_size 30M;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # La lectura con relecturas focalizadas puede tardar minutos.
        proxy_read_timeout 300s;
        # El progreso de la lectura va por SSE: sin esto se entrega todo junto al final.
        proxy_buffering off;
    }
}
```

---

## Actualizar

```bash
git pull
npm ci
npx prisma migrate deploy   # antes del build: el código nuevo espera el esquema nuevo
npm run build
sudo systemctl restart dongines
```

Las migraciones de este proyecto son aditivas. Antes de aplicar una que borre o cambie
columnas, hacer un `pg_dump`.

---

## Monitoreo

- **Salud:** `GET /ingresar` tiene que devolver 200. Es la única pantalla sin sesión.
- **Errores:** van a la salida estándar. Con systemd, `journalctl -u dongines -f`.
- **Base:** vigilar conexiones activas; Prisma abre un pool por instancia.
- **Storage:** con el driver local, alertar cuando el disco pase el 80 %. Cada
  comprobante ocupa entre 1 y 2 MB por página, contando original y versión de trabajo.
- **Costo del lector:** cada comprobante consume tokens del modelo. Los intentos quedan
  registrados en `ocr_attempts` con su duración; si suben mucho los reintentos, conviene
  revisar la calidad de las fotos antes que subir `OCR_MAX_ATTEMPTS`.

---

## Seguridad

Lo que ya hace la aplicación:

- Contraseñas con scrypt (N=32768) y comparación en tiempo constante.
- Token de sesión de 32 bytes; en la base sólo su SHA-256.
- Cookie `httpOnly`, `sameSite=lax` y `secure` en producción.
- Bloqueo temporal tras 8 intentos fallidos, con el mismo mensaje exista o no el usuario.
- Permisos verificados en el servidor en cada operación, y alcance por sucursal aplicado
  también en las consultas: un operador no ve otra sucursal ni pidiéndola por la URL.
- Comprobantes fuera de `public/`, accesibles sólo por URL firmada, con vencimiento y
  previa verificación de sesión y alcance.
- Consultas parametrizadas por Prisma.
- `X-Content-Type-Options`, `X-Frame-Options` y `Referrer-Policy` en todas las respuestas.
- Anulaciones y guardados forzados con motivo obligatorio y registro de auditoría.

Lo que queda del lado de la instalación: TLS, la rotación de `STORAGE_SIGNING_SECRET`
(invalida los enlaces vigentes, no las sesiones), el acceso a la base y las copias.
