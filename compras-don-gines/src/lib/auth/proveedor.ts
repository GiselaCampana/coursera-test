import 'server-only';
import { env } from '@/lib/env';
import { AppError } from '@/lib/errors';
import { hashPassword, verifyPassword } from '@/lib/auth/password';

/**
 * Quién valida la contraseña.
 *
 * La aplicación delega **sólo eso**. Todo lo demás sigue siendo suyo:
 *
 *  - la tabla de usuarios, con su rol, su sucursal y sus permisos;
 *  - la sesión, con su cookie httpOnly y su tabla propia;
 *  - el bloqueo por intentos fallidos y la auditoría.
 *
 * Es a propósito. Los roles configurables y el alcance por sucursal son
 * requisitos del negocio que ningún proveedor de identidad resuelve: siempre
 * iban a vivir en nuestra base. Y acotar la delegación a la verificación de la
 * contraseña deja el resto del sistema —autorización, sesiones, auditoría— con
 * las mismas pruebas de siempre, sin depender de un servicio externo para
 * correrlas.
 *
 * Con `supabase`, las contraseñas las guarda y verifica Supabase Auth, que
 * además trae recuperación por correo. Con `local`, el hash scrypt vive en
 * nuestra base. El modo local es el que usan las pruebas y el desarrollo.
 */
export type ProveedorAuth = 'local' | 'supabase';

export interface ResultadoVerificacion {
  ok: boolean;
  /** Identificador del usuario en Supabase, para vincularlo la primera vez. */
  idExterno?: string | null;
  /** true si el problema fue del servicio y no de la contraseña. */
  servicioCaido?: boolean;
}

export function proveedorAuth(): ProveedorAuth {
  return env.authProvider;
}

/**
 * Verifica una contraseña.
 *
 * Nunca distingue "usuario inexistente" de "contraseña equivocada": esa
 * diferencia se la queda quien llama, que ya sabe si el usuario existe, y el
 * mensaje que ve la persona es siempre el mismo.
 */
export async function verificarCredenciales(
  email: string,
  password: string,
  hashLocal: string | null,
): Promise<ResultadoVerificacion> {
  if (proveedorAuth() === 'supabase') {
    return verificarConSupabase(email, password);
  }
  return { ok: await verifyPassword(password, hashLocal ?? '') };
}

async function verificarConSupabase(
  email: string,
  password: string,
): Promise<ResultadoVerificacion> {
  const { createClient } = await import('@supabase/supabase-js');
  const cfg = env.supabase;
  // Cliente anónimo: verificar una contraseña es justamente lo que puede hacer
  // cualquiera. La clave de servicio no tiene nada que hacer acá.
  const cliente = createClient(cfg.url, cfg.anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  try {
    const { data, error } = await cliente.auth.signInWithPassword({ email, password });
    if (error) {
      // Credenciales mal escritas: es un "no", no una falla.
      if (/invalid login credentials|email not confirmed/i.test(error.message)) {
        return { ok: false };
      }
      return { ok: false, servicioCaido: true };
    }
    return { ok: true, idExterno: data.user?.id ?? null };
  } catch {
    // Sin red, o el proyecto pausado: no es que la contraseña esté mal.
    return { ok: false, servicioCaido: true };
  }
}

/**
 * Da de alta la contraseña de un usuario nuevo.
 *
 * Con Supabase se crea el usuario en Auth con el correo ya confirmado: quien lo
 * da de alta es un administrador de la fiambrería, no alguien registrándose
 * solo, así que no hay nada que confirmar por correo.
 *
 * Devuelve lo que haya que guardar en nuestra tabla: el hash local, o el id del
 * usuario en Supabase.
 */
export async function crearCredenciales(
  email: string,
  password: string,
): Promise<{ passwordHash: string; supabaseUserId: string | null }> {
  if (proveedorAuth() !== 'supabase') {
    return { passwordHash: await hashPassword(password), supabaseUserId: null };
  }

  const { createClient } = await import('@supabase/supabase-js');
  const cfg = env.supabase;
  const admin = createClient(cfg.url, cfg.serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });

  if (error || !data.user) {
    // Si el usuario ya existía en Auth, se le cambia la contraseña y se sigue:
    // el alta en nuestra base es lo que define si puede entrar.
    if (error && /already been registered|already exists/i.test(error.message)) {
      const existente = await buscarPorCorreo(admin, email);
      if (existente) {
        await admin.auth.admin.updateUserById(existente, { password, email_confirm: true });
        return { passwordHash: MARCA_EXTERNA, supabaseUserId: existente };
      }
    }
    throw new AppError(
      'No pudimos crear el usuario en el servicio de identidad. Revisá la configuración.',
      { status: 502, code: 'AUTH_ALTA', details: error?.message },
    );
  }

  return { passwordHash: MARCA_EXTERNA, supabaseUserId: data.user.id };
}

/** Cambia la contraseña de un usuario existente. */
export async function cambiarCredenciales(
  supabaseUserId: string | null,
  password: string,
): Promise<{ passwordHash: string }> {
  if (proveedorAuth() !== 'supabase') {
    return { passwordHash: await hashPassword(password) };
  }
  if (!supabaseUserId) {
    throw new AppError(
      'Este usuario todavía no está vinculado al servicio de identidad. Volvé a darlo de alta.',
      { status: 409, code: 'AUTH_SIN_VINCULO' },
    );
  }

  const { createClient } = await import('@supabase/supabase-js');
  const cfg = env.supabase;
  const admin = createClient(cfg.url, cfg.serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { error } = await admin.auth.admin.updateUserById(supabaseUserId, { password });
  if (error) {
    throw new AppError('No pudimos cambiar la contraseña en el servicio de identidad.', {
      status: 502,
      code: 'AUTH_CAMBIO',
      details: error.message,
    });
  }
  return { passwordHash: MARCA_EXTERNA };
}

/**
 * Lo que se guarda en `passwordHash` cuando la contraseña la tiene Supabase.
 *
 * No es un hash y no sirve para verificar nada: es una marca para que quede
 * evidente, mirando la fila, que acá no hay ninguna contraseña guardada.
 */
export const MARCA_EXTERNA = 'supabase-auth';

async function buscarPorCorreo(
  admin: { auth: { admin: { listUsers: (o: { page: number; perPage: number }) => Promise<{ data: { users: { id: string; email?: string }[] } | null }> } } },
  email: string,
): Promise<string | null> {
  const { data } = await admin.auth.admin.listUsers({ page: 1, perPage: 200 });
  const encontrado = data?.users?.find((u) => u.email?.toLowerCase() === email.toLowerCase());
  return encontrado?.id ?? null;
}
