'use server';

import { redirect } from 'next/navigation';
import { prisma } from '@/lib/db';
import { checkPasswordStrength } from '@/lib/auth/password';
import { cambiarCredenciales, verificarCredenciales } from '@/lib/auth/proveedor';
import { closeOtherSessions, getCurrentUser } from '@/lib/auth/session';
import { toUserMessage } from '@/lib/errors';
import { AUDIT_ACTIONS, recordAudit } from '@/lib/services/audit';

export interface CambioState {
  error?: string;
}

/** Los mismos límites que el ingreso: comparten el contador del usuario. */
const MAX_INTENTOS = 8;
const MINUTOS_BLOQUEO = 10;

/**
 * Cambio de la propia contraseña.
 *
 * Pide la actual además de la nueva. No es burocracia: la sesión puede estar
 * abierta en un teléfono que quedó sobre el mostrador, y sin ese paso cualquiera
 * que lo levante se queda con el usuario.
 *
 * La contraseña la guarda quien corresponda según AUTH_PROVIDER: en modo local
 * el hash scrypt en nuestra base, con Supabase Auth allá. Acá no se decide eso.
 */
export async function cambiarMiContrasena(
  _prev: CambioState,
  formData: FormData,
): Promise<CambioState> {
  const user = await getCurrentUser();
  if (!user) redirect('/ingresar');

  const actual = String(formData.get('actual') ?? '');
  const nueva = String(formData.get('nueva') ?? '');
  const repetida = String(formData.get('repetida') ?? '');

  if (actual === '' || nueva === '') {
    return { error: 'Completá la contraseña actual y la nueva.' };
  }
  if (nueva !== repetida) {
    return { error: 'Las dos contraseñas nuevas no coinciden.' };
  }
  if (nueva === actual) {
    return { error: 'La contraseña nueva tiene que ser distinta de la actual.' };
  }

  const fuerza = checkPasswordStrength(nueva);
  if (!fuerza.ok) return { error: fuerza.message };

  const fila = await prisma.user.findUnique({
    where: { id: user.id },
    select: {
      passwordHash: true,
      supabaseUserId: true,
      failedLogins: true,
      lockedUntil: true,
    },
  });
  if (!fila) redirect('/ingresar');

  // El mismo bloqueo que el ingreso, y por el mismo motivo: con una sesión
  // ajena abierta, adivinar acá la contraseña actual es adivinarla en la
  // pantalla de ingreso, sólo que sin límite de intentos.
  if (fila.lockedUntil && fila.lockedUntil.getTime() > Date.now()) {
    const minutos = Math.ceil((fila.lockedUntil.getTime() - Date.now()) / 60_000);
    return {
      error: `Hubo demasiados intentos fallidos. Volvé a probar en ${minutos} minuto${minutos === 1 ? '' : 's'}.`,
    };
  }

  const verificacion = await verificarCredenciales(user.email, actual, fila.passwordHash);
  if (verificacion.servicioCaido) {
    return {
      error:
        'No pudimos verificar tu contraseña actual en este momento. Esperá unos segundos y ' +
        'volvé a intentar.',
    };
  }
  if (!verificacion.ok) {
    const fallidos = fila.failedLogins + 1;
    await prisma.user.update({
      where: { id: user.id },
      data: {
        failedLogins: fallidos,
        lockedUntil:
          fallidos >= MAX_INTENTOS ? new Date(Date.now() + MINUTOS_BLOQUEO * 60_000) : null,
      },
    });
    await recordAudit({
      userId: user.id,
      action: AUDIT_ACTIONS.PASSWORD_CHANGE_FAILED,
      entity: 'User',
      entityId: user.id,
      after: { motivo: 'contraseña actual incorrecta', intentosFallidos: fallidos },
    });
    return { error: 'La contraseña actual no es correcta.' };
  }

  let credenciales: { passwordHash: string };
  try {
    credenciales = await cambiarCredenciales(fila.supabaseUserId, nueva);
  } catch (error) {
    console.error('[contraseña] no se pudo guardar el cambio', error);
    return { error: toUserMessage(error) };
  }

  // Guardar el hash nuevo y bajar la marca van juntos: si se guardara la
  // contraseña sin bajar la marca, la persona quedaría cambiándola para siempre.
  await prisma.user.update({
    where: { id: user.id },
    data: {
      passwordHash: credenciales.passwordHash,
      mustChangePassword: false,
      failedLogins: 0,
      lockedUntil: null,
    },
  });

  // La sesión de este dispositivo sigue viva; las demás se cierran.
  await closeOtherSessions(user.id);

  await recordAudit({
    userId: user.id,
    action: AUDIT_ACTIONS.PASSWORD_CHANGED,
    entity: 'User',
    entityId: user.id,
    after: { email: user.email },
  });

  redirect('/');
}
