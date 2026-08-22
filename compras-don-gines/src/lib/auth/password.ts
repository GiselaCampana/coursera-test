import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

// Parámetros de scrypt. N=2^15 tarda ~100 ms en el servidor y hace inviable la
// fuerza bruta sobre el hash. Se guardan en el propio hash para poder subirlos
// más adelante sin invalidar las contraseñas existentes.
const N = 32_768;
const R = 8;
const P = 1;
const KEYLEN = 64;
const MAXMEM = 128 * N * R * 2;

export const MIN_PASSWORD_LENGTH = 10;

/** Formato: scrypt$N$r$p$saltB64$hashB64 */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scrypt(password.normalize('NFKC'), salt, KEYLEN, {
    N,
    r: R,
    p: P,
    maxmem: MAXMEM,
  });
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${derived.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p)) return false;

  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(parts[4], 'base64');
    expected = Buffer.from(parts[5], 'base64');
  } catch {
    return false;
  }

  const derived = await scrypt(password.normalize('NFKC'), salt, expected.length, {
    N: n,
    r,
    p,
    maxmem: Math.max(MAXMEM, 128 * n * r * 2),
  });
  // Comparación en tiempo constante: no filtrar cuántos bytes coinciden.
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

export interface PasswordProblem {
  ok: boolean;
  message?: string;
}

export function checkPasswordStrength(password: string): PasswordProblem {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return {
      ok: false,
      message: `La contraseña tiene que tener al menos ${MIN_PASSWORD_LENGTH} caracteres.`,
    };
  }
  if (!/[a-zA-Z]/.test(password) || !/\d/.test(password)) {
    return { ok: false, message: 'La contraseña tiene que combinar letras y números.' };
  }
  return { ok: true };
}
