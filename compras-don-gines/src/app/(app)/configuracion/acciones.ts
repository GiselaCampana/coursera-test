'use server';

import { revalidatePath } from 'next/cache';
import { requireUser } from '@/lib/auth/session';
import { toUserMessage } from '@/lib/errors';
import {
  saveBranch,
  saveProduct,
  saveSupplierCode,
  removeSupplierCode,
  saveRole,
  saveSupplier,
  saveSupplierTaxRule,
  saveSupplierTerm,
  saveUser,
} from '@/lib/services/admin';

export interface ResultadoConfig {
  ok?: boolean;
  error?: string;
}

/** Envuelve una mutación de configuración: autentica, guarda y refresca. */
function accion(
  fn: (user: Awaited<ReturnType<typeof requireUser>>, form: FormData) => Promise<unknown>,
  rutas: string[],
) {
  return async (_prev: ResultadoConfig, form: FormData): Promise<ResultadoConfig> => {
    try {
      const user = await requireUser();
      await fn(user, form);
      for (const ruta of rutas) revalidatePath(ruta);
      return { ok: true };
    } catch (error) {
      return { error: toUserMessage(error) };
    }
  };
}

export const guardarSucursal = accion(saveBranch, ['/configuracion/sucursales']);
export const guardarRol = accion(saveRole, ['/configuracion/roles', '/configuracion/usuarios']);
export const guardarUsuario = accion(saveUser, ['/configuracion/usuarios']);
export const guardarProveedor = accion(saveSupplier, ['/configuracion/proveedores']);
export const guardarPlazo = accion(saveSupplierTerm, ['/configuracion/proveedores']);
export const guardarReglaImpositiva = accion(saveSupplierTaxRule, ['/configuracion/proveedores']);
export const guardarProducto = accion(saveProduct, ['/configuracion/productos', '/precios']);
export const guardarCodigoDeProveedor = accion(saveSupplierCode, ['/configuracion/productos']);
export const quitarCodigoDeProveedor = accion(removeSupplierCode, ['/configuracion/productos']);
