'use client';

import { useRef, useState } from 'react';
import { ACCEPT_ATTRIBUTE } from '@/lib/formatos';
import { formatearPeso, prepararArchivo } from '@/lib/cliente/imagenes';
import { toUserMessage } from '@/lib/errors';
import { pedir } from '@/lib/cliente/red';
import { ListaControles } from '@/components/Estado';
import type { CheckResult } from '@/lib/domain/validation';

/**
 * Diagnóstico de la lectura.
 *
 * Muestra lo que normalmente queda invisible: cuánto pesaba la foto y cuánto
 * pesa después de optimizarla, con qué resolución se lee, cuánto tardó el OCR,
 * cuántos artículos salieron y qué dijo cada autocontrol. Es lo que hace falta
 * para decidir si el problema es la foto, el teléfono o el comprobante.
 */

interface Medida {
  pagina: number;
  ancho: number;
  alto: number;
  inclinacion: number;
  perspectivaCorregida: boolean;
}

interface Resultado {
  nombre: string;
  tipoOriginal: string;
  pesoOriginal: number;
  pesoFinal: number;
  comprimido: boolean;
  anchoSubida: number | null;
  altoSubida: number | null;
  medidas: Medida[];
  msPreparacion: number;
  msOcr: number;
  msTotal: number;
  confianza: number;
  articulos: number;
  analizador: string | null;
  estado: string | null;
  controles: CheckResult[];
  observaciones: string[];
  textoArticulos: string | null;
  errorWorker: string | null;
}

export function PanelDiagnostico({
  maximoIntentos,
  usuario,
}: {
  maximoIntentos: number;
  usuario: string;
}) {
  const [trabajando, setTrabajando] = useState(false);
  const [etapa, setEtapa] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [resultado, setResultado] = useState<Resultado | null>(null);
  const [verTexto, setVerTexto] = useState(false);
  const entrada = useRef<HTMLInputElement>(null);

  const analizar = async (lista: FileList | null) => {
    if (!lista || lista.length === 0) return;
    setTrabajando(true);
    setError(null);
    setResultado(null);
    setEtapa('Preparando la imagen');

    const comienzo = performance.now();
    let errorWorker: string | null = null;

    // Un error dentro del Web Worker no viaja por el try/catch: llega como
    // evento global. Se captura para poder mostrarlo, que es justamente lo que
    // hoy no se ve cuando la lectura falla en un teléfono.
    const capturar = (e: ErrorEvent | PromiseRejectionEvent) => {
      const mensaje =
        'message' in e ? e.message : String((e as PromiseRejectionEvent).reason ?? '');
      if (mensaje) errorWorker = mensaje;
    };
    window.addEventListener('error', capturar);
    window.addEventListener('unhandledrejection', capturar);

    try {
      const preparado = await prepararArchivo(lista[0]);
      const finPreparacion = performance.now();

      setEtapa('Cargando el lector');
      const { SesionLectura } = await import('@/lib/cliente/ocr/lector');
      const sesion = new SesionLectura((avance) => setEtapa(etiquetaEtapa(avance.etapa)));

      await sesion.preparar([{ archivo: preparado.archivo, nombre: preparado.nombre }]);
      const medidas: Medida[] = sesion.medidasDePaginas.map((m, i) => ({ pagina: i + 1, ...m }));

      const inicioOcr = performance.now();
      const lectura = await sesion.leer(1);
      const finOcr = performance.now();

      setEtapa('Interpretando y controlando');
      // Se interpreta con los mismos analizadores y controles que la carga real,
      // pero sin guardar nada: es un ensayo, no un comprobante.
      const respuesta = await pedir('/api/diagnostico/lectura', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paginas: lectura.paginas }),
      });
      const analisis = await respuesta.json();
      if (!respuesta.ok) throw new Error(analisis.error ?? 'No pudimos interpretar la lectura.');

      setResultado({
        nombre: preparado.nombre,
        tipoOriginal: preparado.tipoOriginal,
        pesoOriginal: preparado.pesoOriginal,
        pesoFinal: preparado.pesoFinal,
        comprimido: preparado.comprimido,
        anchoSubida: preparado.ancho,
        altoSubida: preparado.alto,
        medidas,
        msPreparacion: Math.round(finPreparacion - comienzo),
        msOcr: Math.round(finOcr - inicioOcr),
        msTotal: Math.round(performance.now() - comienzo),
        confianza: lectura.confianza,
        articulos: analisis.articulos ?? 0,
        analizador: analisis.analizador ?? null,
        estado: analisis.estado ?? null,
        controles: analisis.controles ?? [],
        observaciones: analisis.observaciones ?? [],
        textoArticulos: lectura.paginas[0]?.textoArticulos ?? lectura.paginas[0]?.textoCompleto ?? null,
        errorWorker,
      });
    } catch (e) {
      setError(toUserMessage(e));
    } finally {
      window.removeEventListener('error', capturar);
      window.removeEventListener('unhandledrejection', capturar);
      setTrabajando(false);
      setEtapa(null);
      if (entrada.current) entrada.current.value = '';
    }
  };

  return (
    <>
      <h1>Diagnóstico de lectura</h1>
      <p className="medio chico">
        Probá una foto y mirá qué pasa con ella: cuánto pesa, con qué resolución se lee, cuánto
        tarda el OCR y qué dice cada control. <strong>No se guarda nada</strong>: ni el
        comprobante, ni la imagen, ni espacio de almacenamiento.
      </p>

      {error ? (
        <p className="mensaje mensaje-error" role="alert">
          {error}
        </p>
      ) : null}

      <div className="card">
        <h2>La foto a probar</h2>
        <input
          ref={entrada}
          type="file"
          accept={ACCEPT_ATTRIBUTE}
          onChange={(e) => analizar(e.target.files)}
          disabled={trabajando}
        />
        {etapa ? (
          <p className="mensaje mensaje-info mb0" role="status">
            {etapa}…
          </p>
        ) : null}
      </div>

      {resultado ? (
        <>
          <div className="card">
            <h2>La imagen</h2>
            <dl style={{ margin: 0 }}>
              <Dato etiqueta="Archivo" valor={resultado.nombre} />
              <Dato etiqueta="Formato" valor={resultado.tipoOriginal} />
              <Dato etiqueta="Tamaño original" valor={formatearPeso(resultado.pesoOriginal)} />
              <Dato
                etiqueta="Tamaño optimizado"
                valor={`${formatearPeso(resultado.pesoFinal)}${
                  resultado.comprimido ? '' : ' (no hizo falta comprimir)'
                }`}
              />
              <Dato
                etiqueta="Resolución al subir"
                valor={
                  resultado.anchoSubida && resultado.altoSubida
                    ? `${resultado.anchoSubida} × ${resultado.altoSubida} px`
                    : 'no aplica (PDF)'
                }
              />
              {resultado.medidas.map((m) => (
                <Dato
                  key={m.pagina}
                  etiqueta={`Resolución al leer (pág. ${m.pagina})`}
                  valor={
                    `${m.ancho} × ${m.alto} px` +
                    (m.perspectivaCorregida ? ' · perspectiva corregida' : '') +
                    (Math.abs(m.inclinacion) >= 0.1
                      ? ` · enderezada ${m.inclinacion.toFixed(1)}°`
                      : '')
                  }
                />
              ))}
            </dl>
          </div>

          <div className="card">
            <h2>La lectura</h2>
            <dl style={{ margin: 0 }}>
              <Dato etiqueta="Preparación de la imagen" valor={`${resultado.msPreparacion} ms`} />
              <Dato etiqueta="OCR (Tesseract)" valor={`${(resultado.msOcr / 1000).toFixed(1)} s`} />
              <Dato etiqueta="Total" valor={`${(resultado.msTotal / 1000).toFixed(1)} s`} />
              <Dato
                etiqueta="Confianza del OCR"
                valor={`${Math.round(resultado.confianza * 100)} %`}
              />
              <Dato etiqueta="Analizador" valor={resultado.analizador ?? '—'} />
              <div className="dato destacado">
                <dt>Artículos detectados</dt>
                <dd>{resultado.articulos}</dd>
              </div>
            </dl>

            {resultado.errorWorker ? (
              <p className="mensaje mensaje-error mb0" role="alert">
                <strong>Error del lector:</strong> {resultado.errorWorker}
              </p>
            ) : (
              <p className="mensaje mensaje-ok mb0">El lector no reportó errores.</p>
            )}
          </div>

          <div className="card">
            <div className="card-titulo">
              <h2>Los autocontroles</h2>
              <span className="chico medio">{resultado.estado ?? 'sin estado'}</span>
            </div>
            <ListaControles checks={resultado.controles} />
            {resultado.observaciones.length > 0 ? (
              <div className="mensaje mensaje-info">
                {resultado.observaciones.map((o, i) => (
                  <div key={i}>{o}</div>
                ))}
              </div>
            ) : null}
          </div>

          <div className="card">
            <div className="card-titulo">
              <h2>Texto reconocido</h2>
              <button
                type="button"
                className="boton boton-secundario boton-chico"
                onClick={() => setVerTexto((v) => !v)}
              >
                {verTexto ? 'Ocultar' : 'Ver'}
              </button>
            </div>
            {verTexto ? (
              <pre className="texto-ocr">{resultado.textoArticulos ?? 'Sin texto.'}</pre>
            ) : (
              <p className="ayuda mb0">
                Es lo que Tesseract leyó, tal cual. Sirve para ver si el problema está en la
                lectura o en la interpretación.
              </p>
            )}
          </div>

          <p className="ayuda">
            Diagnóstico hecho por {usuario}. La lectura reintenta hasta {maximoIntentos} veces
            cuando no cierra; acá se hace una sola pasada para medir el caso base.
          </p>
        </>
      ) : null}
    </>
  );
}

function Dato({ etiqueta, valor }: { etiqueta: string; valor: string }) {
  return (
    <div className="dato">
      <dt>{etiqueta}</dt>
      <dd>{valor}</dd>
    </div>
  );
}

function etiquetaEtapa(etapa: string): string {
  const textos: Record<string, string> = {
    PREPARANDO_LECTOR: 'Cargando el lector',
    PREPARANDO_IMAGENES: 'Preparando la imagen',
    LEYENDO_ENCABEZADO: 'Leyendo el encabezado',
    LEYENDO_ARTICULOS: 'Leyendo los artículos',
    LEYENDO_RESUMEN: 'Leyendo los totales',
    RELEYENDO: 'Releyendo',
  };
  return textos[etapa] ?? 'Trabajando';
}
