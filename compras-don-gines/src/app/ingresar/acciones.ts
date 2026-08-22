'use server';

import { redirect } from 'next/navigation';
import { prisma } from '@/lib/db';
import { verifyPassword } from '@/lib/auth/password';
import { createSession, destroySession, getCurrentUser } from '@/lib/auth/session';
import { AUDIT_ACTIONS, recordAudit, requestMeta } from '@/lib/services/audit';

/** Intentos fallidos seguidos antes de bloquear el usuario. */
const MAX_FAILED = 8;
const LOCK_MINUTES = 10;

export interface LoginState {
  error?: string;
}

/**
 * Ingreso.
 *
 * El mensaje de error es siempre el mismo, exista o no el usuario: decir "ese
 * mail no está registrado" le regala al atacante la mitad del trabajo. Después
 * de varios intentos fallidos el usuario queda bloqueado un rato.
 */
export async function ingresar(_prev: LoginState, formData: FormData): Promise<LoginState> {
  const email = String(formData.get('email') ?? '').trim().toLowerCase();
  const password = String(formData.get('password') ?? '');

  if (email === '' || password === '') {
    return { error: 'Completá el correo y la contraseña.' };
  }

  const meta = await requestMeta();
  const user = await prisma.user.findUnique({
    where: { email },
    include: { role: true },
  });

  const genericError = 'El correo o la contraseña no son correctos.';

  if (!user) {
    // Se verifica igual contra un hash descartable para que el tiempo de
    // respuesta no delate si el usuario existe.
    await verifyPassword(password, 'scrypt$32768$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAA');
    await recordAudit({
      action: AUDIT_ACTIONS.LOGIN_FAILED,
      entity: 'User',
      after: { email, motivo: 'usuario inexistente', ip: meta.ip },
    });
    return { error: genericError };
  }

  if (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
    const minutes = Math.ceil((user.lockedUntil.getTime() - Date.now()) / 60000);
    return {
      error: `Por seguridad el usuario quedó bloqueado. Volvé a intentar en ${minutes} minuto${minutes === 1 ? '' : 's'}.`,
    };
  }

  if (!user.active || !user.role.active) {
    return { error: 'Este usuario está dado de baja. Hablá con el administrador.' };
  }

  const ok = await verifyPassword(password, user.passwordHash);
  if (!ok) {
    const failed = user.failedLogins + 1;
    await prisma.user.update({
      where: { id: user.id },
      data: {
        failedLogins: failed,
        lockedUntil:
          failed >= MAX_FAILED ? new Date(Date.now() + LOCK_MINUTES * 60_000) : null,
      },
    });
    await recordAudit({
      userId: user.id,
      action: AUDIT_ACTIONS.LOGIN_FAILED,
      entity: 'User',
      entityId: user.id,
      after: { email, intentosFallidos: failed },
    });
    return { error: genericError };
  }

  await prisma.user.update({
    where: { id: user.id },
    data: { failedLogins: 0, lockedUntil: null, lastLoginAt: new Date() },
  });
  await createSession(user.id, meta);
  await recordAudit({
    userId: user.id,
    action: AUDIT_ACTIONS.LOGIN,
    entity: 'User',
    entityId: user.id,
  });

  redirect('/');
}

export async function salir() {
  const user = await getCurrentUser();
  if (user) {
    await recordAudit({
      userId: user.id,
      action: AUDIT_ACTIONS.LOGOUT,
      entity: 'User',
      entityId: user.id,
    });
  }
  await destroySession();
  redirect('/ingresar');
}
