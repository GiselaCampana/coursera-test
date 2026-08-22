import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth/session';
import { FormularioIngreso } from './FormularioIngreso';

export const metadata: Metadata = { title: 'Ingresar' };

export default async function PaginaIngreso() {
  const user = await getCurrentUser();
  if (user) redirect('/');

  return (
    <main className="ingreso">
      <div className="ingreso-card">
        <div className="ingreso-marca">
          <div className="ingreso-sello" aria-hidden="true">
            DG
          </div>
          <h1>Compras Don Ginés</h1>
          <p>Gestión de compras de la cadena</p>
        </div>
        <FormularioIngreso />
      </div>
    </main>
  );
}
