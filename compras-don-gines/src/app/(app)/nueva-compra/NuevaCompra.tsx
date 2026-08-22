'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ACCEPT_ATTRIBUTE } from '@/lib/formatos';
import {
  formatearPeso,
  prepararArchivo,
  type ArchivoPreparado,
} from '@/lib/cliente/imagenes';
import { PasoRevision } from './PasoRevision';
import type { ComprobanteRevision, Opcion, OpcionProducto } from './tipos';

const MAX_PAGINAS = 10;

type Paso = 1 | 2 | 3;

interface EtapaProgreso {
  etapa: string;
  texto: string;
  detalle?: string | null;
}

const ETAPAS_ESPERADAS = [
  'PREPARANDO',
  'SUBIENDO',
  'LEYENDO_ENCABEZADO',
  'LEYENDO_ARTICULOS',
  'VERIFICANDO_TOTALES',
];

const ETAPA_TEXTO: Record<string, string> = {
  PREPARANDO: 'Preparando las imágenes',
  SUBIENDO: 'Subiendo el comprobante',
  LEYENDO_ENCABEZADO: 'Leyendo el encabezado',
  LEYENDO_ARTICULOS: 'Leyendo los artículos',
  VERIFICANDO_TOTALES: 'Verificando los totales',
  RELEYENDO: 'La lectura no cerró: releyendo el comprobante',
  LISTO: 'Listo',
  ERROR: 'No se pudo leer el comprobante',
};

interface Props {
  sucursales: Opcion[];
  sucursalPorDefecto: string;
  proveedores: Opcion[];
  productos: OpcionProducto[];
  hoy: string;
  puedeForzar: boolean;
}

export function NuevaCompra({
  sucursales,
  sucursalPorDefecto,
  proveedores,
  productos,
  hoy,
  puedeForzar,
}: Props) {
  const router = useRouter();
  const [paso, setPaso] = useState<Paso>(1);
  const [sucursalId, setSucursalId] = useState(sucursalPorDefecto);
  const [archivos, setArchivos] = useState<ArchivoPreparado[]>([]);
  const [avisos, setAvisos] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [trabajando, setTrabajando] = useState(false);
  const [progreso, setProgreso] = useState<EtapaProgreso | null>(null);
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
          nuevosAvisos.push(
            `No pudimos preparar "${archivo.name}". Probá sacar la foto de nuevo.`,
          );
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

  /** Sube las páginas, dispara la lectura y espera el informe de control. */
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
    setProgreso({ etapa: 'PREPARANDO', texto: ETAPA_TEXTO.PREPARANDO });

    try {
      // 1. Abrir el comprobante en borrador.
      const alta = await fetch('/api/comprobantes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ branchId: sucursalId }),
      });
      const datosAlta = await alta.json();
      if (!alta.ok) throw new Error(datosAlta.error ?? 'No pudimos abrir el comprobante.');
      const documentId: string = datosAlta.id;

      // 2. Subir las páginas.
      setEtapasHechas(['PREPARANDO']);
      setProgreso({ etapa: 'SUBIENDO', texto: ETAPA_TEXTO.SUBIENDO });
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

      // 3. Leer, con el progreso en vivo.
      setEtapasHechas(['PREPARANDO', 'SUBIENDO']);
      await leerConProgreso(documentId);

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
      setProgreso({ etapa: 'ERROR', texto: ETAPA_TEXTO.ERROR });
    } finally {
      setTrabajando(false);
    }
  };

  /** Consume el flujo de eventos de la lectura. */
  const leerConProgreso = async (documentId: string) => {
    const respuesta = await fetch(`/api/comprobantes/${documentId}/leer`, { method: 'POST' });
    if (!respuesta.ok || !respuesta.body) {
      throw new Error('No pudimos iniciar la lectura del comprobante.');
    }

    const lector = respuesta.body.getReader();
    const decodificador = new TextDecoder();
    let pendiente = '';
    let fallo: string | null = null;

    while (true) {
      const { done, value } = await lector.read();
      if (done) break;
      pendiente += decodificador.decode(value, { stream: true });

      const bloques = pendiente.split('\n\n');
      pendiente = bloques.pop() ?? '';

      for (const bloque of bloques) {
        const evento = bloque.match(/^event: (.+)$/m)?.[1];
        const datosCrudos = bloque.match(/^data: (.+)$/m)?.[1];
        if (!evento || !datosCrudos) continue;

        let datos: Record<string, unknown>;
        try {
          datos = JSON.parse(datosCrudos);
        } catch {
          continue;
        }

        if (evento === 'progreso') {
          const etapa = String(datos.etapa);
          setProgreso({
            etapa,
            texto: ETAPA_TEXTO[etapa] ?? String(datos.texto ?? ''),
            detalle: (datos.detalle as string | null) ?? null,
          });
          setEtapasHechas((prev) => {
            const indice = ETAPAS_ESPERADAS.indexOf(etapa);
            if (indice < 0) return prev;
            return ETAPAS_ESPERADAS.slice(0, indice);
          });
        } else if (evento === 'error') {
          fallo = String(datos.mensaje ?? 'No pudimos leer el comprobante.');
        }
      }
    }

    if (fallo) throw new Error(fallo);
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
          Sacale una foto a la factura o al remito, o elegí una imagen que ya tengas en el
          teléfono. Podés cargar hasta {MAX_PAGINAS} páginas y también archivos PDF.
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
                    <div className="miniatura-pdf">PDF<br />{formatearPeso(archivo.pesoFinal)}</div>
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
            {ETAPAS_ESPERADAS.map((etapa) => {
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
