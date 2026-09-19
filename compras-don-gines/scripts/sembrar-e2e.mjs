/**
 * Siembra los datos de prueba con el entorno de las end to end.
 *
 * Existe porque `tsx tests/e2e/sembrar.ts` a secas no sabe contra qué base
 * corre: al importarse, el cliente de Prisma lee el `.env` del proyecto, que en
 * una máquina de trabajo apunta a la base de **desarrollo**. El sembrado
 * empieza con un TRUNCATE, así que eso no era un detalle de configuración sino
 * la base de trabajo vacía.
 *
 * Hoy la guarda del sembrado lo frena antes de escribir. Esto es lo que
 * faltaba del otro lado: cargar `.env.e2e` primero, para que el comando haga lo
 * que su nombre promete en vez de fallar.
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ruta = path.join(raiz, '.env.e2e');

if (!existsSync(ruta)) {
  console.error('Falta .env.e2e. Copiá .env.example y apuntá DATABASE_URL a una base de pruebas.');
  process.exit(1);
}

for (const linea of readFileSync(ruta, 'utf8').split('\n')) {
  const limpia = linea.trim();
  if (limpia === '' || limpia.startsWith('#')) continue;
  const corte = limpia.indexOf('=');
  if (corte < 0) continue;
  process.env[limpia.slice(0, corte).trim()] = limpia
    .slice(corte + 1)
    .trim()
    .replace(/^["']|["']$/g, '');
}

const sembrado = spawn('npx', ['tsx', 'tests/e2e/sembrar.ts'], {
  cwd: raiz,
  stdio: 'inherit',
  env: process.env,
});

sembrado.on('exit', (codigo) => process.exit(codigo ?? 0));
