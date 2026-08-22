/**
 * Levanta el servidor de producción con el entorno de las pruebas end to end.
 *
 * Next carga `.env` por su cuenta; acá se cargan además las variables de
 * `.env.e2e`, que pisan a las de desarrollo, para que el servidor apunte a la
 * base y al almacenamiento de pruebas.
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ruta = path.join(raiz, '.env.e2e');

if (existsSync(ruta)) {
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
}

const servidor = spawn('npx', ['next', 'start', '-p', '3100', '-H', '127.0.0.1'], {
  cwd: raiz,
  stdio: 'inherit',
  env: process.env,
});

servidor.on('exit', (codigo) => process.exit(codigo ?? 0));
for (const senal of ['SIGINT', 'SIGTERM']) {
  process.on(senal, () => servidor.kill(senal));
}
