/**
 * Iconografía simple, de trazo, dibujada a mano en SVG.
 * `currentColor` para que hereden el color del estado activo de la navegación.
 */
type Props = { className?: string };

const base = {
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.7,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
};

export function IconoInicio({ className = 'nav-icono' }: Props) {
  return (
    <svg {...base} className={className}>
      <path d="M3 10.5 12 3.5l9 7" />
      <path d="M5.5 9.5V20h13V9.5" />
      <path d="M9.75 20v-5.5h4.5V20" />
    </svg>
  );
}

export function IconoComprobante({ className = 'nav-icono' }: Props) {
  return (
    <svg {...base} className={className}>
      <path d="M6 2.8h12v18.4l-2.4-1.5-2.4 1.5-2.4-1.5-2.4 1.5L6 19.7z" />
      <path d="M9.3 8h5.4M9.3 11.5h5.4M9.3 15h3.2" />
    </svg>
  );
}

export function IconoCamara({ className = 'nav-icono' }: Props) {
  return (
    <svg {...base} className={className}>
      <path d="M3.2 8.4h3.4l1.5-2.4h7.8l1.5 2.4h3.4v11H3.2z" />
      <circle cx="12" cy="13.6" r="3.5" />
    </svg>
  );
}

export function IconoPagos({ className = 'nav-icono' }: Props) {
  return (
    <svg {...base} className={className}>
      <rect x="3" y="5.5" width="18" height="14" rx="2.2" />
      <path d="M3 10h18" />
      <path d="M7 15h4" />
    </svg>
  );
}

export function IconoPrecios({ className = 'nav-icono' }: Props) {
  return (
    <svg {...base} className={className}>
      <path d="M3.5 12.6V4.5h8.1l8.9 8.9-8.1 8.1z" />
      <circle cx="7.6" cy="8.6" r="1.5" />
    </svg>
  );
}

export function IconoCompras({ className = 'nav-icono' }: Props) {
  return (
    <svg {...base} className={className}>
      <path d="M3.5 20.5V13m5-9v16.5m5-11.5v11.5m5-6.5v6.5" />
      <path d="M2.5 20.5h19" />
    </svg>
  );
}

export function IconoConfiguracion({ className = 'nav-icono' }: Props) {
  return (
    <svg {...base} className={className}>
      <circle cx="12" cy="12" r="3.1" />
      <path d="M12 2.8v2.6M12 18.6v2.6M4.5 12H2m20 0h-2.5M6.4 6.4 4.6 4.6m14.8 1.8 1.8-1.8M6.4 17.6l-1.8 1.8m14.8-1.8 1.8 1.8" />
    </svg>
  );
}

export function IconoMas({ className = 'nav-icono' }: Props) {
  return (
    <svg {...base} className={className}>
      <circle cx="5.5" cy="12" r="1.4" />
      <circle cx="12" cy="12" r="1.4" />
      <circle cx="18.5" cy="12" r="1.4" />
    </svg>
  );
}

export function IconoTilde({ className = 'control-marca' }: Props) {
  return (
    <svg {...base} className={className} strokeWidth={2.1}>
      <path d="M4.5 12.6 9.4 17.5 19.5 6.9" />
    </svg>
  );
}

export function IconoAlerta({ className = 'control-marca' }: Props) {
  return (
    <svg {...base} className={className} strokeWidth={2}>
      <path d="M12 3.6 22 20.4H2z" />
      <path d="M12 9.7v4.4M12 17.1h.01" />
    </svg>
  );
}

export function IconoInfo({ className = 'control-marca' }: Props) {
  return (
    <svg {...base} className={className} strokeWidth={2}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5.2M12 7.8h.01" />
    </svg>
  );
}

export function IconoGuion({ className = 'control-marca' }: Props) {
  return (
    <svg {...base} className={className} strokeWidth={2}>
      <path d="M6 12h12" />
    </svg>
  );
}
