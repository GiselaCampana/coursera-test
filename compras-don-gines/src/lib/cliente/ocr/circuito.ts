import { AppError } from '@/lib/errors';
import { pedir } from '@/lib/cliente/red';
import { CODIGO_LECTURA_UTILIZABLE } from '@/lib/domain/lectura-utilizable';
import type { ZonaAReleer } from '@/lib/ocr/types';

/**
 * El circuito de lectura, en un solo lugar.
 *
 * Lo usan las dos entradas que existen: la carga de un comprobante nuevo y el
 * "volver a leer" de uno ya cargado. Que sea el mismo código no es una comodidad
 * sino el punto: si cada camino armara su propio bucle, uno de los dos podría
 * quedar leyendo con reglas viejas —o saltearse una vuelta de relectura— y no
 * habría forma de darse cuenta mirando la pantalla. Acá el analizador, los
 * reintentos y los autocontroles son necesariamente los mismos.
 *
 * El OCR corre en el teléfono. Al servidor va texto, nunca conclusiones.
 */

export interface FuenteDePagina {
  archivo: Blob;
  nombre: string;
}

export interface AvanceDeCircuito {
  etapa: string;
  detalle?: string | null;
  avance?: number | null;
}

export interface EntradaDeCircuito {
  documentId: string;
  fuentes: FuenteDePagina[];
  maximoIntentos: number;
  alAvanzar: (avance: AvanceDeCircuito) => void;
  alEsperar?: (mensaje: string | null) => void;
}

export interface SalidaDeCircuito {
  intentos: number;
  observaciones: string[];
  /**
   * La foto no se pudo leer, y no hay revisión que hacer.
   *
   * Es distinto de "el comprobante no cierra". Un comprobante que no cierra se
   * revisa a mano y para eso está la pantalla de revisión; una foto que no se
   * leyó no tiene qué revisar, y llevar a esa pantalla dos renglones de once es
   * ofrecer una compra que no existe.
   */
  lecturaInsuficiente: boolean;
  /** Qué decirle a quien está con el papel en la mano. */
  motivoInsuficiente: string | null;
}

export async function leerYControlar(entrada: EntradaDeCircuito): Promise<SalidaDeCircuito> {
  const { documentId, fuentes, maximoIntentos, alAvanzar, alEsperar } = entrada;

  // El lector pesa varios megabytes: se carga sólo cuando hace falta, no en el
  // arranque de la aplicación.
  const { SesionLectura } = await import('@/lib/cliente/ocr/lector');

  const sesion = new SesionLectura((avance) => {
    alAvanzar({
      etapa: avance.etapa,
      detalle:
        avance.totalPaginas && avance.totalPaginas > 1
          ? `Página ${avance.pagina} de ${avance.totalPaginas}`
          : null,
      avance: avance.avance,
    });
  });

  alAvanzar({ etapa: 'PREPARANDO_IMAGENES' });
  await sesion.preparar(fuentes.map((f) => ({ archivo: f.archivo, nombre: f.nombre })));

  const observaciones: string[] = [];
  let intento = 1;
  let motivo: string | undefined;
  /*
   * Qué zona pidió releer el servidor en la vuelta anterior.
   *
   * El servidor sabe qué le faltó al texto; el lector sabe dónde cae eso en la
   * foto. Cuando lo único que falta es el final de la tabla, el lector va a
   * buscar esa franja sola en vez de repetir la página entera.
   */
  let zona: ZonaAReleer | null = null;
  let insuficiente: { code: string; severity: string; message: string } | undefined;

  for (;;) {
    if (intento > 1) alAvanzar({ etapa: 'RELEYENDO', detalle: motivo ?? null });
    const lectura = await sesion.leer(intento, motivo, zona);

    alAvanzar({ etapa: 'VERIFICANDO_TOTALES' });
    const respuesta = await pedir(`/api/comprobantes/${documentId}/lectura`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(lectura),
      alEsperar,
    });
    const control = await respuesta.json();
    if (!respuesta.ok) {
      throw new AppError(control.error ?? 'No pudimos controlar el comprobante.');
    }

    if (Array.isArray(control.observaciones)) {
      for (const o of control.observaciones) if (!observaciones.includes(o)) observaciones.push(o);
    }

    /*
     * El veredicto de calidad se toma de la última vuelta, no de la primera.
     *
     * Una relectura focalizada puede recuperar los renglones que faltaban, así
     * que cortar en la primera vuelta por lectura insuficiente sería tirar
     * justamente la vuelta que existe para arreglarla. Se deja que el bucle
     * termine y recién ahí se decide.
     */
    insuficiente = (control.controles ?? []).find(
      (c: { code: string; severity: string }) =>
        c.code === CODIGO_LECTURA_UTILIZABLE && c.severity === 'ERROR',
    );

    if (control.puedeGuardar || !control.releer || intento >= maximoIntentos) break;
    motivo = control.releer.motivo;
    zona = control.releer.zona ?? null;
    intento += 1;
  }

  return {
    intentos: intento,
    observaciones,
    lecturaInsuficiente: Boolean(insuficiente),
    motivoInsuficiente: insuficiente?.message ?? null,
  };
}

/**
 * Baja de nuevo las imágenes que ya están guardadas del comprobante.
 *
 * Es lo que hace que "volver a leer" sea de verdad volver a leer: se parte del
 * archivo original, el mismo que quedó en el comprobante, y se lo vuelve a pasar
 * por todo el circuito. No se reutiliza ni un dato del análisis anterior.
 */
export async function bajarPaginas(
  paginas: { url: string; orden: number; tipo: string }[],
): Promise<FuenteDePagina[]> {
  const ordenadas = [...paginas].sort((a, b) => a.orden - b.orden);
  const fuentes: FuenteDePagina[] = [];

  for (const pagina of ordenadas) {
    const respuesta = await fetch(pagina.url);
    if (!respuesta.ok) {
      throw new AppError(
        'No pudimos recuperar la imagen guardada del comprobante para volver a leerla.',
      );
    }
    const blob = await respuesta.blob();
    const extension = pagina.tipo === 'application/pdf' ? 'pdf' : 'jpg';
    fuentes.push({ archivo: blob, nombre: `pagina-${pagina.orden}.${extension}` });
  }

  return fuentes;
}
