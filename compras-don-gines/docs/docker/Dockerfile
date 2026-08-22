# Imagen de Compras Don Ginés.
#
# Se construye desde la raíz del proyecto:
#   docker build -f docs/docker/Dockerfile -t compras-don-gines .
#
# Trae el CLI de Prisma en la imagen final a propósito, para poder correr
# `prisma migrate deploy` y el seed dentro del contenedor.

FROM node:20-bookworm-slim AS deps
WORKDIR /app
# openssl lo necesita Prisma para hablar con PostgreSQL por TLS.
RUN apt-get update && apt-get install -y --no-install-recommends openssl \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN npm ci

FROM node:20-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl \
    && rm -rf /var/lib/apt/lists/*
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# El build no se conecta a la base: sólo genera el cliente y compila.
ENV NEXT_TELEMETRY_DISABLED=1
RUN npx prisma generate && npx next build

FROM node:20-bookworm-slim AS runtime
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/.next ./.next
COPY --from=build /app/public ./public
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/next.config.ts ./next.config.ts

# Los comprobantes del driver local viven acá: montar un volumen.
RUN mkdir -p /app/.storage && chown -R node:node /app/.storage
VOLUME ["/app/.storage"]

USER node
EXPOSE 3000

# Sin sesión, /ingresar tiene que responder 200.
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/ingresar').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["npm", "run", "start"]
