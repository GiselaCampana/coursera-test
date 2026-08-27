import type { PrismaClient } from '@prisma/client';
import { checkPasswordStrength, hashPassword } from '@/lib/auth/password';

export const ADMIN_RECOVERY_ACTION = 'usuario.contrasena_restablecida_seed';

export interface AdminRecoveryInput {
  userId: string;
  email: string;
  password: string;
  requestId: string;
}

/**
 * Restablece una contraseña administrativa una sola vez por requestId.
 *
 * Está pensado para el caso en que no queda ningún administrador con sesión
 * válida para hacer el cambio desde Configuración → Usuarios. El requestId se
 * registra en auditoría y vuelve idempotente al seed: aunque Render vuelva a
 * ejecutar el mismo deploy, la contraseña no se pisa otra vez.
 */
export async function recoverAdminPasswordOnce(
  prisma: PrismaClient,
  input: AdminRecoveryInput,
): Promise<{ applied: boolean; alreadyApplied: boolean }> {
  const requestId = input.requestId.trim();
  if (!requestId) return { applied: false, alreadyApplied: false };

  const fuerza = checkPasswordStrength(input.password);
  if (!fuerza.ok) {
    throw new Error(`SEED_ADMIN_PASSWORD: ${fuerza.message}`);
  }

  const reason = `reset-admin:${requestId}`;
  const already = await prisma.auditLog.findFirst({
    where: {
      action: ADMIN_RECOVERY_ACTION,
      entity: 'User',
      entityId: input.userId,
      reason,
    },
    select: { id: true },
  });
  if (already) return { applied: false, alreadyApplied: true };

  const nuevoHash = await hashPassword(input.password);

  await prisma.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: input.userId },
      data: {
        passwordHash: nuevoHash,
        mustChangePassword: true,
        failedLogins: 0,
        lockedUntil: null,
      },
    });

    // Cualquier sesión previa deja de servir. El siguiente ingreso es con la
    // contraseña temporal y obliga a elegir una nueva.
    await tx.session.deleteMany({ where: { userId: input.userId } });

    await tx.auditLog.create({
      data: {
        userId: input.userId,
        action: ADMIN_RECOVERY_ACTION,
        entity: 'User',
        entityId: input.userId,
        reason,
        after: {
          email: input.email,
          requestId,
          mustChangePassword: true,
        },
      },
    });
  });

  return { applied: true, alreadyApplied: false };
}
