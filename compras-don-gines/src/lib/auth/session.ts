import 'server-only';
import { createHash, randomBytes } from 'node:crypto';
import { cookies } from 'next/headers';
import { cache } from 'react';
import { prisma } from '@/lib/db';
import { ForbiddenError, UnauthorizedError } from '@/lib/errors';
import type { Permission } from '@/lib/auth/permissions';

export const SESSION_COOKIE = 'dg_session';
/** Duración de la sesión. Se renueva sola mientras se use. */
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const RENEW_AFTER_MS = 30 * 60 * 1000;

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  branchId: string | null;
  branchName: string | null;
  roleId: string;
  roleCode: string;
  roleName: string;
  permissions: string[];
  scopeAllBranches: boolean;
  mustChangePassword: boolean;
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export async function createSession(
  userId: string,
  meta: { ip?: string | null; userAgent?: string | null } = {},
): Promise<string> {
  // 32 bytes de entropía: el token en claro sólo existe en la cookie, en la
  // base va únicamente su SHA-256.
  const token = randomBytes(32).toString('base64url');
  await prisma.session.create({
    data: {
      tokenHash: hashToken(token),
      userId,
      expiresAt: new Date(Date.now() + SESSION_TTL_MS),
      ip: meta.ip ?? null,
      userAgent: meta.userAgent?.slice(0, 500) ?? null,
    },
  });

  const store = await cookies();
  store.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  });
  return token;
}

export async function destroySession(): Promise<void> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (token) {
    await prisma.session.deleteMany({ where: { tokenHash: hashToken(token) } });
  }
  store.delete(SESSION_COOKIE);
}

/**
 * Usuario de la request actual, o null.
 * `cache` de React lo resuelve una sola vez por request aunque lo pidan varios
 * componentes del árbol.
 */
export const getCurrentUser = cache(async (): Promise<AuthUser | null> => {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (!token) return null;

  const session = await prisma.session.findUnique({
    where: { tokenHash: hashToken(token) },
    include: { user: { include: { role: true, branch: true } } },
  });

  if (!session) return null;
  if (session.expiresAt.getTime() <= Date.now()) {
    await prisma.session.delete({ where: { id: session.id } }).catch(() => {});
    return null;
  }
  if (!session.user.active || !session.user.role.active) return null;

  // Renovación perezosa: se toca la base como mucho cada media hora.
  if (Date.now() - session.lastSeenAt.getTime() > RENEW_AFTER_MS) {
    await prisma.session
      .update({
        where: { id: session.id },
        data: { lastSeenAt: new Date(), expiresAt: new Date(Date.now() + SESSION_TTL_MS) },
      })
      .catch(() => {});
  }

  const { user } = session;
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    branchId: user.branchId,
    branchName: user.branch?.name ?? null,
    roleId: user.roleId,
    roleCode: user.role.code,
    roleName: user.role.name,
    permissions: user.role.permissions,
    scopeAllBranches: user.role.scopeAllBranches,
    mustChangePassword: user.mustChangePassword,
  };
});

export async function requireUser(): Promise<AuthUser> {
  const user = await getCurrentUser();
  if (!user) throw new UnauthorizedError();
  return user;
}

export function hasPermission(user: AuthUser, permission: Permission | string): boolean {
  return user.permissions.includes(permission);
}

export function hasAnyPermission(user: AuthUser, permissions: (Permission | string)[]): boolean {
  return permissions.some((p) => user.permissions.includes(p));
}

export async function requirePermission(permission: Permission | string): Promise<AuthUser> {
  const user = await requireUser();
  if (!hasPermission(user, permission)) {
    throw new ForbiddenError('Tu usuario no tiene permiso para hacer esto.');
  }
  return user;
}

/**
 * Alcance por sucursal. Un operador sólo opera sobre la suya; el chequeo vive
 * en el backend porque el del frontend no es una defensa.
 */
export function canAccessBranch(user: AuthUser, branchId: string | null | undefined): boolean {
  if (user.scopeAllBranches) return true;
  if (!branchId) return false;
  return user.branchId === branchId;
}

export function assertBranchAccess(user: AuthUser, branchId: string | null | undefined): void {
  if (!canAccessBranch(user, branchId)) {
    throw new ForbiddenError('Sólo podés operar sobre los comprobantes de tu sucursal.');
  }
}

/** Filtro de sucursal para las consultas: undefined = sin restricción. */
export function branchScopeFilter(user: AuthUser): { branchId?: string } {
  return user.scopeAllBranches ? {} : { branchId: user.branchId ?? '__sin_sucursal__' };
}

/**
 * Cierra las demás sesiones del usuario y deja viva la actual.
 *
 * Se usa al cambiar la contraseña: si alguien más había entrado con la
 * contraseña vieja, cambiarla tiene que echarlo. Sin esto el cambio protege la
 * próxima entrada pero no la sesión que el intruso ya tiene abierta.
 */
export async function closeOtherSessions(userId: string): Promise<number> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  const { count } = await prisma.session.deleteMany({
    where: {
      userId,
      ...(token ? { tokenHash: { not: hashToken(token) } } : {}),
    },
  });
  return count;
}

export async function purgeExpiredSessions(): Promise<number> {
  const { count } = await prisma.session.deleteMany({
    where: { expiresAt: { lte: new Date() } },
  });
  return count;
}
