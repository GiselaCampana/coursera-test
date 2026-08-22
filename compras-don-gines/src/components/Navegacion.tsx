'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  IconoCamara,
  IconoComprobante,
  IconoCompras,
  IconoConfiguracion,
  IconoInicio,
  IconoMas,
  IconoPagos,
  IconoPrecios,
} from '@/components/Iconos';

export interface ItemNavegacion {
  href: string;
  etiqueta: string;
  icono: 'inicio' | 'comprobantes' | 'nueva' | 'pagos' | 'precios' | 'compras' | 'configuracion' | 'mas';
  /** Sólo aparece en el menú "Más" del teléfono, no en la barra inferior. */
  soloEnMas?: boolean;
  badge?: number;
}

const ICONOS = {
  inicio: IconoInicio,
  comprobantes: IconoComprobante,
  nueva: IconoCamara,
  pagos: IconoPagos,
  precios: IconoPrecios,
  compras: IconoCompras,
  configuracion: IconoConfiguracion,
  mas: IconoMas,
};

function esActual(pathname: string, href: string): boolean {
  if (href === '/') return pathname === '/';
  return pathname === href || pathname.startsWith(`${href}/`);
}

/**
 * Navegación inferior en el teléfono y horizontal en escritorio.
 *
 * En móvil la barra tiene cinco destinos como máximo: más que eso deja los
 * botones demasiado finos para el pulgar. El resto vive en "Más".
 */
export function Navegacion({ items }: { items: ItemNavegacion[] }) {
  const pathname = usePathname();
  const enBarra = items.filter((i) => !i.soloEnMas);
  const enMas = items.filter((i) => i.soloEnMas);

  const barra: ItemNavegacion[] = [...enBarra];
  if (enMas.length > 0) {
    barra.push({ href: '/mas', etiqueta: 'Más', icono: 'mas' });
  }

  return (
    <nav className="nav-inferior" aria-label="Secciones">
      {barra.map((item) => {
        const Icono = ICONOS[item.icono];
        const actual = esActual(pathname, item.href);
        return (
          <Link key={item.href} href={item.href} aria-current={actual ? 'page' : undefined}>
            <Icono />
            <span>{item.etiqueta}</span>
            {item.badge && item.badge > 0 ? (
              <span className="nav-badge" aria-label={`${item.badge} pendientes`}>
                {item.badge > 99 ? '99+' : item.badge}
              </span>
            ) : null}
          </Link>
        );
      })}
      {/* En escritorio no hace falta el rodeo por "Más". */}
      {enMas.map((item) => {
        const Icono = ICONOS[item.icono];
        const actual = esActual(pathname, item.href);
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={actual ? 'page' : undefined}
            className="solo-escritorio"
          >
            <Icono />
            <span>{item.etiqueta}</span>
          </Link>
        );
      })}
    </nav>
  );
}
