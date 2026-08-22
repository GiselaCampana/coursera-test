/**
 * heic-convert no publica tipos. Se declara sólo la forma que usamos:
 * decodificar el HEIC de las fotos de iPhone a JPEG.
 */
declare module 'heic-convert' {
  interface ConvertOptions {
    buffer: Buffer;
    format: 'JPEG' | 'PNG';
    /** 0 a 1. Sólo aplica a JPEG. */
    quality?: number;
  }
  function convert(options: ConvertOptions): Promise<ArrayBuffer>;
  export default convert;
}
