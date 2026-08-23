import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth/session';
import { MIN_PASSWORD_LENGTH } from '@/lib/auth/password';
import { salir } from '@/app/ingresar/acciones';
import { FormularioCambio } from './FormularioCambio';

export const metadata: Metadata = { title: 'Cambiar contraseña' };
export const dynamic = 'force-dynamic';

/**
 * Cambio de contraseña.
 *
 * Vive fuera del grupo (app) a propósito: ese layout manda acá a quien tiene la
 * marca `mustChangePassword`, y si la pantalla estuviera adentro se mandaría a
 * sí misma en un bucle. Por eso tampoco tiene la navegación: mientras la marca
 * esté puesta no hay a dónde ir, salvo salir.
 */
export default async function PaginaCambiarContrasena() {
  const user = await getCurrentUser();
  if (!user) redirect('/ingresar');

  const obligatorio = user.mustChangePassword;

  return (
    <main className="ingreso">
      <div className="ingreso-card">
        <div className="ingreso-marca">
          <div className="ingreso-sello" aria-hidden="true">
            DG
          </div>
          <h1>Cambiar contraseña</h1>
          <p>{user.email}</p>
        </div>

        {obligatorio ? (
          <p className="mensaje mensaje-aviso">
            Estás usando la contraseña con la que se creó tu usuario. Elegí una nueva, que sólo
            vos conozcas, para poder seguir.
          </p>
        ) : null}

        <FormularioCambio minimo={MIN_PASSWORD_LENGTH} />

        <form action={salir} className="mt">
          <button type="submit" className="boton boton-secundario boton-bloque">
            Salir
          </button>
        </form>
      </div>
    </main>
  );
}
