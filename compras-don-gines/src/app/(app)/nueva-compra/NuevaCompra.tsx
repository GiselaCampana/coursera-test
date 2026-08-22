'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ACCEPT_ATTRIBUTE } from '@/lib/formatos';
import { formatearPeso, prepararArchivo, type ArchivoPreparado } from '@/lib/cliente/imagenes';
import { PasoRevision } from './PasoRevision';
import type { ComprobanteRevision, Opcion, OpcionProducto } from './tipos';

const MAX_PAGINAS = 10;

type Paso = 1 | 2 | 3;

/** Etapas que se le muestran al usuario, en orden. */
const ETAPAS = [
  'PREPARANDO_LECTOR',
  'PREPARANDO_IMAGENES',
  'SUBIENDO',
  'LEYENDO_ENCABEZADO',
  'LEYENDO_ARTICULOS',
  'LEYENDO_RESUMEN',
  'VERIFICANDO_TOTALES',
] as const;

const ETAPA_TEXTO: Record<string, string> = {
  PREPARANDO_LECTOR: 'Preparando el lector',
  PREPARANDO_IMAGENES: 'Preparando las imágenes',
  SUBIENDO: 'Guardando el comprobante',
  LEYENDO_ENCABEZADO: 'Leyendo el encabezado',
  LEYENDO_ARTICULOS: 'Leyendo los artículos',
  LEYENDO_RESUMEN: 'Leyendo los totales',
  VERIFICANDO_TOTALES: 'Verificando los totales',
  RELEYENDO: 'La lectura no cerró: releyendo el comprobante',
  LISTO: 'Listo',
  ERROR: 'No se pudo leer el comprobante',
};

interface EstadoProgreso {
  etapa: string;
  detalle?: string | null;
  avance?: number | null;
}

interface Props {
  sucursales: Opcion[];
  sucursalPorDefecto: string;
  proveedores: Opcion[];
  productos: OpcionProducto[];
  hoy: string;
  puedeForzar: boolean;
  maximoIntentos: number;
}

export function NuevaCompra({
  sucursales,
  sucursalPorDefecto,
  proveedores,
  productos,
  hoy,
  puedeForzar,
  maximoIntentos,
}: Props) {
  const router = useRouter();
  const [paso, setPaso] = useState<Paso>(1);
  const [sucursalId, setSucursalId] = useState(sucursalPorDefecto);
  const [archivos, setArchivos] = useState<ArchivoPreparado[]>([]);
  const [avisos, setAvisos] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [trabajando, setTrabajando] = useState(false);
  const [progreso, setProgreso] = useState<EstadoProgreso | null>(null);
  const [etapasHechas, setEtapasHechas] = useState<string[]>([]);
  const [comprobante, setComprobante] = useState<ComprobanteRevision | null>(null);

  const inputCamara = useRef<HTMLInputElement>(null);
  const inputGaleria = useRef<HTMLInputElement>(null);

  // Las vistas previas son object URLs: hay que soltarlas al desmontar.
  useEffect(() => {
    return () => {
      for (const a of archivos) {
        if (a.vistaPrevia) URL.revokeObjectURL(a.vistaPrevia);
      }
    };
    // Sólo al desmontar: la limpieza por archivo la hace quitarArchivo.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const marcarEtapa = useCallback((etapa: string, detalle?: string | null, avance?: number | null) => {
    setProgreso({ etapa, detalle: detalle ?? null, avance: avance ?? null });
    const indice = (ETAPAS as readonly string[]).indexOf(etapa);
    if (indice >= 0) setEtapasHechas(ETAPAS.slice(0, indice));
  }, []);

  const agregarArchivos = useCallback(
    async (lista: FileList | null) => {
      if (!lista || lista.length === 0) return;
      setError(null);
      const nuevosAvisos: string[] = [];
      const preparados: ArchivoPreparado[] = [];

      for (const archivo of Array.from(lista)) {
        if (archivos.length + preparados.length >= MAX_PAGINAS) {
          nuevosAvisos.push(`Un comprobante admite hasta ${MAX_PAGINAS} imágenes.`);
          break;
        }
        try {
          const preparado = await prepararArchivo(archivo);
          const yaEsta =
            archivos.some((a) => a.huella === preparado.huella) ||
            preparados.some((a) => a.huella === preparado.huella);
          if (yaEsta) {
            nuevosAvisos.push(`"${preparado.nombre}" ya estaba agregada.`);
            if (preparado.vistaPrevia) URL.revokeObjectURL(preparado.vistaPrevia);
            continue;
          }
          if (preparado.comprimido) {
            nuevosAvisos.push(
              `"${preparado.nombre}" se optimizó de ${formatearPeso(preparado.pesoOriginal)} a ${formatearPeso(preparado.pesoFinal)}.`,
            );
          }
          preparados.push(preparado);
        } catch {
          nuevosAvisos.push(`No pudimos preparar "${archivo.name}". Probá sacar la foto de nuevo.`);
        }
      }

      if (preparados.length > 0) setArchivos((prev) => [...prev, ...preparados]);
      setAvisos(nuevosAvisos);
    },
    [archivos],
  );

  const quitarArchivo = (indice: number) => {
    setArchivos((prev) => {
      const objetivo = prev[indice];
      if (objetivo?.vistaPrevia) URL.revokeObjectURL(objetivo.vistaPrevia);
      return prev.filter((_, i) => i !== indice);
    });
  };

  const moverArchivo = (indice: number, direccion: -1 | 1) => {
    setArchivos((prev) => {
      const destino = indice + direccion;
      if (destino < 0 || destino >= prev.length) return prev;
      const copia = [...prev];
      [copia[indice], copia[destino]] = [copia[destino], copia[indice]];
      return copia;
    });
  };

  /**
   * Lee el comprobante.
   *
   * El OCR corre acá, en el teléfono, con Tesseract: las imágenes no salen del
   * aparato para leerse. Al servidor sólo van las fotos —para guardarlas— y el
   * texto reconocido. Interpretar ese texto y decidir si el comprobante cierra
   * es tarea del servidor, que puede rechazar la lectura y pedir otra vuelta.
   */
  const leerComprobante = async () => {
    if (archivos.length === 0) {
      setError('Agregá al menos una foto o un PDF del comprobante.');
      return;
    }
    if (!sucursalId) {
      setError('Elegí la sucursal en la que estás cargando el comprobante.');
      return;
    }

    setTrabajando(true);
    setError(null);
    setEtapasHechas([]);
    marcarEtapa('PREPARANDO_LECTOR');

    try {
      // El lector pesa varios megabytes: se carga sólo cuando hace falta, no en
      // el arranque de la aplicación.
      const { SesionLectura } = await import('@/lib/cliente/ocr/lector');

      // El nombre de la etapa ya lo pone ETAPA_TEXTO; el detalle sólo hace
      // falta cuando el comprobante tiene más de una página.
      const sesion = new SesionLectura((avance) => {
        marcarEtapa(
          avance.etapa,
          avance.totalPaginas && avance.totalPaginas > 1
            ? `Página ${avance.pagina} de ${avance.totalPaginas}`
            : null,
          avance.avance,
        );
      });

      // 1. Preparar las imágenes: enderezar, corregir perspectiva y limpiar.
      marcarEtapa('PREPARANDO_IMAGENES');
      await sesion.preparar(archivos.map((a) => ({ archivo: a.archivo, nombre: a.nombre })));

      // 2. Abrir el comprobante y subir las páginas para guardarlas.
      marcarEtapa('SUBIENDO');
      const alta = await fetch('/api/comprobantes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ branchId: sucursalId }),
      });
      const datosAlta = await alta.json();
      if (!alta.ok) throw new Error(datosAlta.error ?? 'No pudimos abrir el comprobante.');
      const documentId: string = datosAlta.id;

      const form = new FormData();
      for (const a of archivos) form.append('archivos', a.archivo, a.nombre);
      const subida = await fetch(`/api/comprobantes/${documentId}/archivos`, {
        method: 'POST',
        body: form,
      });
      const datosSubida = await subida.json();
      if (!subida.ok) throw new Error(datosSubida.error ?? 'No pudimos subir las imágenes.');
      if (Array.isArray(datosSubida.rejected) && datosSubida.rejected.length > 0) {
        setAvisos(
          datosSubida.rejected.map(
            (r: { filename: string; reason: string }) => `"${r.filename}": ${r.reason}`,
          ),
        );
      }

      // 3. Leer y controlar, con relectura focalizada si no cierra.
      let intento = 1;
      let motivo: string | undefined;

      for (;;) {
        if (intento > 1) marcarEtapa('RELEYENDO', motivo ?? null);
        const lectura = await sesion.leer(intento, motivo);

        marcarEtapa('VERIFICANDO_TOTALES');
        const respuesta = await fetch(`/api/comprobantes/${documentId}/lectura`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(lectura),
        });
        const control = await respuesta.json();
        if (!respuesta.ok) throw new Error(control.error ?? 'No pudimos controlar el comprobante.');

        if (Array.isArray(control.observaciones) && control.observaciones.length > 0) {
          setAvisos((prev) => [...new Set([...prev, ...control.observaciones])]);
        }

        if (control.puedeGuardar || !control.releer || intento >= maximoIntentos) break;
        motivo = control.releer.motivo;
        intento += 1;
      }

      // 4. Traer el comprobante ya calculado para revisarlo.
      const detalle = await fetch(`/api/comprobantes/${documentId}`);
      const datosDetalle = await detalle.json();
      if (!detalle.ok) {
        throw new Error(datosDetalle.error ?? 'No pudimos abrir el comprobante leído.');
      }
      setComprobante(datosDetalle as ComprobanteRevision);
      setPaso(2);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No pudimos leer el comprobante.');
      setProgreso({ etapa: 'ERROR' });
    } finally {
      setTrabajando(false);
    }
  };

  const volverAlPaso1 = () => {
    setComprobante(null);
    setPaso(1);
  };

  // --- Pasos 2 y 3 -------------------------------------------------------
  if (paso >= 2 && comprobante) {
    return (
      <PasoRevision
        comprobante={comprobante}
        proveedores={proveedores}
        productos={productos}
        hoy={hoy}
        puedeForzar={puedeForzar}
        paso={paso}
        onPaso={setPaso}
        onVolver={volverAlPaso1}
        onGuardado={(id) => router.push(`/comprobantes/${id}?guardado=1`)}
        onActualizar={setComprobante}
      />
    );
  }

  // --- Paso 1: el comprobante --------------------------------------------
  return (
    <>
      <h1>Nueva compra</h1>
      <Pasos actual={1} />

      {error ? (
        <p className="mensaje mensaje-error" role="alert">
          {error}
        </p>
      ) : null}

      {avisos.length > 0 ? (
        <div className="mensaje mensaje-info">
          {avisos.map((aviso, i) => (
            <div key={i}>{aviso}</div>
          ))}
        </div>
      ) : null}

      {sucursales.length > 1 ? (
        <div className="card card-compacta">
          <div className="campo mb0">
            <label htmlFor="sucursal">Sucursal</label>
            <select
              id="sucursal"
              value={sucursalId}
              onChange={(e) => setSucursalId(e.target.value)}
              disabled={trabajando}
            >
              {sucursales.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.nombre}
                </option>
              ))}
            </select>
          </div>
        </div>
      ) : null}

      <div className="card">
        <h2>El comprobante</h2>
        <p className="medio chico">
          Sacale una foto a la factura o al remito, o elegí una imagen que ya tengas en el teléfono.
          Podés cargar hasta {MAX_PAGINAS} páginas y también archivos PDF. La lectura se hace en el
          teléfono: las fotos no se mandan a ningún servicio externo.
        </p>

        {/* Dos accesos bien separados, como pide el mostrador: uno abre la
            cámara trasera y el otro la galería. */}
        <div className="acciones">
          <button
            type="button"
            className="boton"
            onClick={() => inputCamara.current?.click()}
            disabled={trabajando || archivos.length >= MAX_PAGINAS}
          >
            Sacar foto
          </button>
          <button
            type="button"
            className="boton boton-secundario"
            onClick={() => inputGaleria.current?.click()}
            disabled={trabajando || archivos.length >= MAX_PAGINAS}
          >
            Elegir del teléfono
          </button>
        </div>

        <input
          ref={inputCamara}
          type="file"
          accept="image/*"
          capture="environment"
          className="sr-only"
          onChange={(e) => {
            void agregarArchivos(e.target.files);
            e.target.value = '';
          }}
        />
        <input
          ref={inputGaleria}
          type="file"
          accept={ACCEPT_ATTRIBUTE}
          multiple
          className="sr-only"
          onChange={(e) => {
            void agregarArchivos(e.target.files);
            e.target.value = '';
          }}
        />

        {archivos.length > 0 ? (
          <>
            <ul className="miniaturas">
              {archivos.map((archivo, indice) => (
                <li key={archivo.huella} className="miniatura">
                  <span className="miniatura-orden">{indice + 1}</span>
                  {archivo.esPdf ? (
                    <div className="miniatura-pdf">
                      PDF
                      <br />
                      {formatearPeso(archivo.pesoFinal)}
                    </div>
                  ) : (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={archivo.vistaPrevia ?? ''} alt={`Página ${indice + 1}`} />
                  )}
                  <div className="miniatura-acciones">
                    <button
                      type="button"
                      onClick={() => moverArchivo(indice, -1)}
                      disabled={indice === 0 || trabajando}
                      aria-label={`Mover la página ${indice + 1} hacia atrás`}
                    >
                      ‹
                    </button>
                    <button
                      type="button"
                      onClick={() => moverArchivo(indice, 1)}
                      disabled={indice === archivos.length - 1 || trabajando}
                      aria-label={`Mover la página ${indice + 1} hacia adelante`}
                    >
                      ›
                    </button>
                    <button
                      type="button"
                      className="quitar"
                      onClick={() => quitarArchivo(indice)}
                      disabled={trabajando}
                      aria-label={`Quitar la página ${indice + 1}`}
                    >
                      ×
                    </button>
                  </div>
                </li>
              ))}
            </ul>
            <p className="ayuda">
              {archivos.length} de {MAX_PAGINAS} páginas. El orden es el de la numeración.
            </p>
          </>
        ) : (
          <div className="vacio">
            <div className="vacio-titulo">Todavía no agregaste ninguna página</div>
            <p className="mb0">Aceptamos fotos JPG, PNG, WEBP y HEIC, y archivos PDF.</p>
          </div>
        )}
      </div>

      {trabajando && progreso ? (
        <div className="card">
          <h2>Leyendo el comprobante</h2>
          <div className="progreso">
            {ETAPAS.map((etapa) => {
              const hecha = etapasHechas.includes(etapa);
              const activa = progreso.etapa === etapa;
              return (
                <div
                  key={etapa}
                  className={`progreso-paso ${activa ? 'activo' : hecha ? 'hecho' : ''}`}
                >
                  <span className="progreso-marca" aria-hidden="true" />
                  <span>{ETAPA_TEXTO[etapa]}</span>
                </div>
              );
            })}
            {progreso.etapa === 'RELEYENDO' ? (
              <div className="progreso-paso activo">
                <span className="progreso-marca" aria-hidden="true" />
                <span>{ETAPA_TEXTO.RELEYENDO}</span>
              </div>
            ) : null}
          </div>
          {progreso.detalle ? <p className="ayuda mb0">{progreso.detalle}</p> : null}
          <p className="ayuda mb0">
            La primera lectura tarda un poco más porque el teléfono descarga el lector. Después
            queda guardado.
          </p>
        </div>
      ) : null}

      <div className="barra-accion">
        <button
          type="button"
          className="boton boton-bloque"
          onClick={leerComprobante}
          disabled={trabajando || archivos.length === 0}
        >
          {trabajando ? 'Leyendo…' : 'Leer el comprobante'}
        </button>
      </div>
    </>
  );
}

export function Pasos({ actual }: { actual: Paso }) {
  const nombres = ['Comprobante', 'Revisar datos', 'Guardar y agendar'];
  return (
    <ol className="pasos">
      {nombres.map((nombre, i) => {
        const numero = (i + 1) as Paso;
        return (
          <li
            key={nombre}
            className={`paso ${numero === actual ? 'activo' : numero < actual ? 'hecho' : ''}`}
            aria-current={numero === actual ? 'step' : undefined}
          >
            {numero}. {nombre}
          </li>
        );
      })}
    </ol>
  );
}
