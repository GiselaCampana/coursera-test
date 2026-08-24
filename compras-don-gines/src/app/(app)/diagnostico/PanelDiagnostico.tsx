'use client';

import { useRef, useState } from 'react';
import { ACCEPT_ATTRIBUTE } from '@/lib/formatos';
import { formatearPeso, prepararArchivo } from '@/lib/cliente/imagenes';
import { toUserMessage } from '@/lib/errors';
import { pedir } from '@/lib/cliente/red';
import { formatDateTimeAr } from '@/lib/datetime';
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
  textoResumen: string | null;
  textoCompleto: string | null;
  /** Filas que el lector contó en la imagen, antes de interpretar nada. */
  filasDetectadas: number | null;
  tiempos: { zona: string; ms: number }[];
  errorWorker: string | null;
}

export function PanelDiagnostico({
  maximoIntentos,
  usuario,
  version,
}: {
  maximoIntentos: number;
  usuario: string;
  version: { commitCorto: string; rama: string | null; iniciado: string };
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
        textoArticulos: lectura.paginas[0]?.textoArticulos ?? null,
        textoResumen: lectura.paginas[0]?.textoResumen ?? null,
        textoCompleto: lectura.paginas[0]?.textoCompleto ?? null,
        filasDetectadas: lectura.paginas[0]?.regiones?.filasDetectadas ?? null,
        tiempos: lectura.paginas[0]?.tiempos ?? [],
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

  /*
   * ¿La interpretación falló?
   *
   * Alcanza con que no haya renglones, con que algún control dé error, o con
   * que se hayan visto en la imagen bastantes más filas de las que se pudieron
   * entender. Ese último caso es el que importa: una lectura de un renglón
   * sobre una tabla de veintitrés no dispara ningún otro control, porque el
   * único renglón que leyó cierra perfecto solo.
   */
  const filasVistas = resultado?.filasDetectadas ?? null;
  const fallo = resultado
    ? resultado.articulos === 0 ||
      resultado.controles.some((c) => c.severity === 'ERROR') ||
      (filasVistas !== null && filasVistas >= 8 && resultado.articulos < filasVistas * 0.7)
    : false;
  // Si falló, el texto se muestra sin que haya que pedirlo.
  const mostrarTexto = verTexto || fallo;

  return (
    <>
      <h1>Diagnóstico de lectura</h1>
      <p className="medio chico">
        Probá una foto y mirá qué pasa con ella: cuánto pesa, con qué resolución se lee, cuánto
        tarda el OCR y qué dice cada control. <strong>No se guarda nada</strong>: ni el
        comprobante, ni la imagen, ni espacio de almacenamiento.
      </p>

      {/*
        Qué versión está corriendo.
        Va arriba de todo y antes de cualquier prueba, porque es el dato que
        cambia el significado de todos los demás: un resultado raro de una
        versión anterior a la corrección no dice nada sobre la corrección. Desde
        el teléfono no hay otra forma de saberlo —el plan gratuito de Render no
        da consola—, así que tiene que estar en la pantalla.
      */}
      <div className="card">
        <h2>Versión en ejecución</h2>
        <dl style={{ margin: 0 }}>
          <Dato etiqueta="Commit" valor={version.commitCorto} />
          {version.rama ? <Dato etiqueta="Rama" valor={version.rama} /> : null}
          <Dato etiqueta="En línea desde" valor={formatDateTimeAr(version.iniciado)} />
        </dl>
        <p className="ayuda mb0">
          Es el commit que Render está sirviendo ahora mismo. Si no coincide con el que se
          esperaba, el despliegue no llegó y lo que se vea acá abajo corresponde a la versión
          anterior.
        </p>
      </div>

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
              {/*
                Las dos cifras juntas, que es como se leen: cuántas filas hay en
                la foto y cuántas se entendieron. Separadas no dicen nada.
              */}
              <Dato
                etiqueta="Filas vistas en la imagen"
                valor={filasVistas === null ? 'no se pudo contar' : String(filasVistas)}
              />
              <div className={`dato destacado${fallo ? ' atencion' : ''}`}>
                <dt>Artículos interpretados</dt>
                <dd>{resultado.articulos}</dd>
              </div>
            </dl>

            {/*
              En qué se fue el tiempo, zona por zona.
              El total no alcanza para decidir nada: siete minutos repartidos en
              diez pasadas parejas y siete minutos que se van casi enteros en la
              tabla se arreglan de maneras distintas, y sin abrirlo no se sabe
              cuál de los dos es.
            */}
            {resultado.tiempos.length > 0 ? (
              <>
                <h3 className="chico">Dónde se fue el tiempo</h3>
                <dl style={{ margin: 0 }}>
                  {resultado.tiempos.map((t) => (
                    <Dato
                      key={t.zona}
                      etiqueta={t.zona}
                      valor={t.ms >= 1000 ? `${(t.ms / 1000).toFixed(1)} s` : `${t.ms} ms`}
                    />
                  ))}
                </dl>
              </>
            ) : null}

            {resultado.errorWorker ? (
              <p className="mensaje mensaje-error mb0" role="alert">
                <strong>Error del lector:</strong> {resultado.errorWorker}
              </p>
            ) : (
              /*
                "Sin errores" acá quiere decir que el motor de OCR funcionó, no
                que el comprobante haya cerrado. Decirlo en verde justo encima de
                unos autocontroles en rojo confundía las dos cosas: son fallas de
                naturaleza distinta y se arreglan de maneras distintas.
              */
              <p className="mensaje mensaje-ok mb0">
                El motor OCR no tuvo errores técnicos. Que la lectura cierre o no es otra cosa:
                lo dicen los autocontroles de abajo.
              </p>
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
                {mostrarTexto ? 'Ocultar' : 'Ver'}
              </button>
            </div>

            {/*
              Cuando la interpretación falla, esto se abre solo.
              Es la única forma de saber, sin conectar el teléfono a nada, si
              Tesseract no leyó la tabla o si la leyó bien y el analizador no la
              entendió. Son dos problemas distintos y se arreglan en lugares
              distintos.
            */}
            {fallo ? (
              <p className="mensaje mensaje-aviso">
                {resultado.filasDetectadas !== null
                  ? `En la imagen se contaron ${resultado.filasDetectadas} filas y se interpretaron ${resultado.articulos} renglones. `
                  : ''}
                Abajo está el texto tal cual salió del lector: si la tabla se ve bien escrita, el
                problema es del analizador; si se ve rota, es de la lectura.
              </p>
            ) : null}

            {mostrarTexto ? (
              <>
                <h3 className="chico">Tabla de artículos</h3>
                <pre className="texto-ocr">
                  {resultado.textoArticulos ?? 'No se recortó la tabla: no se detectó la zona.'}
                </pre>

                <h3 className="chico">Pie con los totales</h3>
                <pre className="texto-ocr">
                  {resultado.textoResumen ?? 'No se recortó el pie: no se detectó la zona.'}
                </pre>

                <h3 className="chico">Página completa</h3>
                <pre className="texto-ocr">{resultado.textoCompleto ?? 'Sin texto.'}</pre>
              </>
            ) : (
              <p className="ayuda mb0">
                Es lo que Tesseract leyó, tal cual, zona por zona. Sirve para ver si el problema
                está en la lectura o en la interpretación.
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
