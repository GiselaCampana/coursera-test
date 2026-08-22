/**
 * Formatos de archivo aceptados. Vive fuera de lib/images.ts porque el
 * navegador también necesita esta lista (el atributo `accept` del input) y
 * lib/images.ts es sólo de servidor.
 */

export const ACCEPTED_IMAGE_MIME = [
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif',
];

export const ACCEPTED_MIME = [...ACCEPTED_IMAGE_MIME, 'application/pdf'];

/**
 * Safari en iPhone es quisquilloso con `accept`: si sólo se le pasan tipos MIME
 * a veces deja la galería en gris. Por eso van también las extensiones.
 */
export const ACCEPT_ATTRIBUTE =
  'image/jpeg,image/png,image/webp,image/heic,image/heif,application/pdf,.jpg,.jpeg,.png,.webp,.heic,.heif,.pdf';
