import type { Metadata, Viewport } from 'next';
import { Fraunces, Source_Sans_3 } from 'next/font/google';
import './globals.css';

// Serif con carácter para los títulos y una sans muy legible para el resto,
// que es lo que se lee a la carrera desde el teléfono en el mostrador.
const serif = Fraunces({
  subsets: ['latin'],
  weight: ['500', '600', '700'],
  variable: '--fuente-serif',
  display: 'swap',
  fallback: ['Iowan Old Style', 'Palatino', 'Georgia', 'serif'],
});

const sans = Source_Sans_3({
  subsets: ['latin'],
  weight: ['400', '600', '700'],
  variable: '--fuente-sans',
  display: 'swap',
  fallback: ['-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'sans-serif'],
});

export const metadata: Metadata = {
  title: {
    default: 'Compras Don Ginés',
    template: '%s · Compras Don Ginés',
  },
  description: 'Gestión de compras de la cadena de fiambrerías Don Ginés.',
  manifest: '/manifest.webmanifest',
  appleWebApp: {
    capable: true,
    title: 'Compras Don Ginés',
    statusBarStyle: 'black-translucent',
  },
  formatDetection: { telephone: false },
};

export const viewport: Viewport = {
  themeColor: '#1f3d2b',
  width: 'device-width',
  initialScale: 1,
  // Sin maximumScale: impedir el zoom rompe la accesibilidad en el iPhone.
  viewportFit: 'cover',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es-AR" className={`${serif.variable} ${sans.variable}`}>
      <body>{children}</body>
    </html>
  );
}
