'use client';

import { useEffect, useMemo, useState } from 'react';
import { consistentPerceptionLines, costItems, type RawItem } from '@/lib/domain/costing';
import { validateDocument } from '@/lib/domain/validation';
import { PAYMENT_METHODS, PAYMENT_METHOD_LABEL } from '@/lib/domain/payments';
import { formatARS, formatQty } from '@/lib/money';
import { AppError, toUserMessage } from '@/lib/errors';
import { consultar, pedir } from '@/lib/cliente/red';
import { filtrarCatalogo } from '@/lib/catalogo-busqueda';
import { ListaControles, Semaforo } from '@/components/Estado';
import { Pasos } from './NuevaCompra';
import type { ComprobanteRevision, Opcion, OpcionProducto } from './tipos';

interface Props {
  comprobante: ComprobanteRevision;
  proveedores: Opcion[];
  productos: OpcionProducto[];
  hoy: string;
  puedeForzar: boolean;
  paso: 1 | 2 | 3;
  onPaso: (paso: 1 | 2 | 3) => void;
  onVolver: () => void;
  /** Vuelve a leer desde las imágenes guardadas, con el analizador actual. */
  onReleer: () => void;
  onGuardado: (documentId: string) => void;
  onActualizar: (comprobante: ComprobanteRevision) => void;
}

interface ArticuloEditable {
  clave: string;
  renglon: number;
  codigo: string | null;
  descripcion: string;
  cantidad: string;
  unidad: 'KG' | 'UNIT';
  piezas: string;
  precioUnitario: string;
  /**
   * Importe impreso del renglón, tal como salió del comprobante, y si de
   * verdad salió de ahí. Se conserva aunque se corrija la cantidad: es contra
   * este número que el control verifica que cantidad × precio dé bien.
   */
  bruto: string;
  brutoImpreso: boolean;
  descuentoPct: string;
  ivaTasa: string;
  productoId: string;
  asociacionOriginal: string;
  /** ¿Se guarda la asociación para las próximas facturas del proveedor? */
  recordar: boolean;
}

const vacio = (v: string | null | undefined) => (v === null || v === undefined ? '' : v);

/**
 * Prepara un número para un campo editable.
 *
 * Los valores llegan del servidor en formato canónico, con punto decimal:
 * "2196120.52". Esta es la pantalla donde alguien compara contra el papel, así
 * que tienen que verse como en el papel: "2.196.120,52". Lo que se escribe en
 * el campo se vuelve a interpretar con las reglas argentinas, así que el
 * formato de ida y el de vuelta son el mismo.
 *
 * Las tasas quedan afuera: la bonificación viaja como fracción (0,14) y el
 * recálculo en vivo la lee como tal, no como porcentaje.
 */
const editable = (v: string | null | undefined, decimales = 2) =>
  v === null || v === undefined || v.trim() === '' ? '' : formatQty(v, decimales);

export function PasoRevision({
  comprobante,
  proveedores,
  productos,
  hoy,
  puedeForzar,
  paso,
  onPaso,
  onVolver,
  onReleer,
  onGuardado,
}: Props) {
  const [proveedorId, setProveedorId] = useState(comprobante.proveedor?.id ?? '');
  const [tipo, setTipo] = useState<'FACTURA' | 'REMITO'>(comprobante.tipo);
  const [letra, setLetra] = useState(vacio(comprobante.letra));
  const [puntoDeVenta, setPuntoDeVenta] = useState(comprobante.puntoDeVenta);
  const [numero, setNumero] = useState(comprobante.numero);
  const [fecha, setFecha] = useState(comprobante.fecha ?? hoy);

  const [resumen, setResumen] = useState({
    grossSubtotal: editable(comprobante.resumen.grossSubtotal),
    discountTotal: editable(comprobante.resumen.discountTotal),
    netTotal: editable(comprobante.resumen.netTotal),
    ivaTotal: editable(comprobante.resumen.ivaTotal),
    perceptionsTotal: editable(comprobante.resumen.perceptionsTotal),
    total: editable(comprobante.resumen.total),
    lineCount: comprobante.resumen.lineCount?.toString() ?? '',
    netWeightKg: editable(comprobante.resumen.netWeightKg),
    totalUnits: editable(comprobante.resumen.totalUnits),
  });

  const [articulos, setArticulos] = useState<ArticuloEditable[]>(() =>
    comprobante.articulos.map((a) => ({
      clave: a.id,
      renglon: a.renglon,
      codigo: a.codigo,
      descripcion: a.descripcion,
      cantidad: editable(a.cantidad),
      unidad: a.unidad,
      piezas: a.piezas?.toString() ?? '',
      precioUnitario: editable(a.precioUnitario),
      bruto: a.bruto,
      brutoImpreso: a.brutoImpreso,
      descuentoPct: a.descuentoPct,
      ivaTasa: a.ivaTasa,
      productoId: a.productoId ?? '',
      asociacionOriginal: a.asociacion,
      /*
       * ¿Se guarda la asociación para las próximas facturas?
       *
       * Marcado por omisión, porque es lo que uno quiere el 99 % de las veces:
       * asociar a mano el mismo artículo en cada factura es exactamente el
       * trabajo que la aplicación viene a sacarse de encima. Se puede
       * desmarcar cuando la asociación es de este comprobante y nada más —una
       * descripción rara, un artículo que vino por única vez—.
       */
      recordar: true,
    })),
  );

  /*
   * El alta de un proveedor que todavía no existe, sin salir del comprobante.
   *
   * Cuando aparece una factura de un proveedor nuevo, todo el trabajo ya está
   * hecho: la foto sacada, el OCR corrido, los renglones asociados a mano.
   * Mandar a Configuración → Proveedores en ese momento tira todo eso, así que
   * el alta pasa acá, con lo que se leyó del papel ya cargado en los campos.
   */
  const leido = comprobante.proveedorLeido;
  const [proveedoresDisponibles, setProveedoresDisponibles] = useState(proveedores);
  const [altaProveedorAbierta, setAltaProveedorAbierta] = useState(false);
  const [proveedorNombre, setProveedorNombre] = useState(leido?.nombre ?? '');
  const [proveedorCuit, setProveedorCuit] = useState(leido?.cuit ?? '');
  const [proveedorGuardando, setProveedorGuardando] = useState(false);
  const [proveedorError, setProveedorError] = useState<string | null>(null);
  const [proveedorAviso, setProveedorAviso] = useState<string | null>(null);

  const crearProveedorRapido = async () => {
    setProveedorError(null);
    setProveedorAviso(null);
    setProveedorGuardando(true);
    try {
      const respuesta = await fetch('/api/proveedores/rapido', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          nombre: proveedorNombre,
          razonSocial: leido?.nombre ?? null,
          cuit: proveedorCuit || null,
        }),
      });
      const datos = await respuesta.json();
      if (!respuesta.ok) throw new AppError(datos.error ?? 'No pudimos crear el proveedor.');

      setProveedoresDisponibles((prev) =>
        prev.some((p) => p.id === datos.id) ? prev : [...prev, { id: datos.id, nombre: datos.nombre }],
      );
      setProveedorId(datos.id);
      setAltaProveedorAbierta(false);
      /*
       * Si el CUIT ya estaba cargado no se creó nada: se enganchó al que existe.
       * Decirlo importa, porque si no la pantalla mostraría un proveedor con
       * otro nombre que el tipeado y parecería un error.
       */
      if (!datos.creado) {
        setProveedorAviso(
          datos.motivo === 'CUIT'
            ? `Ese CUIT ya estaba cargado como ${datos.nombre}: se usó el proveedor que ya existía.`
            : `Ya había un proveedor llamado ${datos.nombre}: se usó ése.`,
        );
      }
    } catch (e) {
      setProveedorError(toUserMessage(e));
    } finally {
      setProveedorGuardando(false);
    }
  };

  const [productosDisponibles, setProductosDisponibles] = useState(productos);
  /** Lo que se está escribiendo en el buscador de catálogo de cada renglón. */
  const [busquedaProducto, setBusquedaProducto] = useState<Record<string, string>>({});
  const [altaProductoClave, setAltaProductoClave] = useState<string | null>(null);
  const [altaNombre, setAltaNombre] = useState('');
  const [altaPlu, setAltaPlu] = useState('');
  const [altaBarcode, setAltaBarcode] = useState('');
  const [altaUsaPlu, setAltaUsaPlu] = useState(true);
  const [altaGuardando, setAltaGuardando] = useState(false);
  const [altaError, setAltaError] = useState<string | null>(null);

  const abrirAltaProducto = (articulo: ArticuloEditable) => {
    setAltaProductoClave(articulo.clave);
    setAltaNombre(articulo.descripcion);
    setAltaPlu('');
    setAltaBarcode('');
    setAltaUsaPlu(true);
    setAltaError(null);
  };

  const crearProductoRapido = async (articulo: ArticuloEditable) => {
    setAltaError(null);
    setAltaGuardando(true);
    try {
      const respuesta = await fetch('/api/productos/rapido', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          nombre: altaNombre,
          plu: altaPlu || null,
          usaPlu: altaUsaPlu,
          codigoBarras: altaBarcode || null,
          unidadCompra: articulo.unidad,
        }),
      });
      const datos = await respuesta.json();
      if (!respuesta.ok) {
        throw new AppError(datos.error ?? 'No pudimos crear el producto.');
      }
      setProductosDisponibles((prev) => [...prev, datos]);
      actualizarArticulo(articulo.clave, 'productoId', datos.id);
      // El buscador vuelve a cero: lo que se buscaba ya no hace falta, y con el
      // filtro puesto el artículo recién creado podría no verse en la lista.
      setBusquedaProducto((prev) => ({ ...prev, [articulo.clave]: '' }));
      setAltaProductoClave(null);
    } catch (e) {
      setAltaError(toUserMessage(e));
    } finally {
      setAltaGuardando(false);
    }
  };

  /*
   * Con "factura contra factura" la fecha no se completa sola.
   *
   * Los demás plazos salen de una cuenta —el mismo día, a x días— y siempre dan
   * algo. Éste depende de cuándo vuelve a pasar el proveedor, y si esa fecha no
   * está cargada no hay nada que calcular: poner la de emisión, o sumarle días
   * inventados, sería agendar plata en un día que no acordó nadie. Se deja
   * vacía y la completa quien está mirando la factura, que es el que sabe.
   */
  const contraFactura = comprobante.condiciones.plazo === 'NEXT_INVOICE';
  const [vencimiento, setVencimiento] = useState(
    comprobante.condiciones.vencimiento ?? (contraFactura ? '' : (comprobante.fecha ?? hoy)),
  );
  const [plazoTexto, setPlazoTexto] = useState<string | null>(null);
  const [formaDePago, setFormaDePago] = useState(
    comprobante.condiciones.formaDePago ?? 'TRANSFERENCIA',
  );
  const [observaciones, setObservaciones] = useState('');
  const [motivoForzado, setMotivoForzado] = useState('');
  const [quiereForzar, setQuiereForzar] = useState(false);

  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /*
   * ¿Lo que se está mostrando lo produjo la versión que está corriendo?
   *
   * Cada intento guarda el commit que lo interpretó. Si el más reciente no es el
   * de ahora, el comprobante se leyó antes de un despliegue y lo que hay en
   * pantalla salió de otro código. Cuando alguna de las dos puntas no se conoce
   * —una lectura vieja, anterior a que se guardara el dato— no se dice nada:
   * avisar de una diferencia que no se puede afirmar sería peor que callarse.
   */
  const lecturaDeOtraVersion = useMemo(() => {
    const actual = comprobante.version?.commit;
    if (!actual) return null;
    const ultima = [...comprobante.lecturas].sort((a, b) => b.numero - a.numero)[0];
    if (!ultima?.build || ultima.build === actual) return null;
    return ultima;
  }, [comprobante.version?.commit, comprobante.lecturas]);

  // --- Recálculo en vivo --------------------------------------------------
  // Se usan exactamente las mismas funciones que corre el backend al guardar,
  // así que lo que se ve en pantalla no puede diferir de lo que se controla.
  const { costeados, informe } = useMemo(() => {
    const crudos: RawItem[] = articulos.map((a) => ({
      lineNumber: a.renglon,
      supplierCode: a.codigo,
      description: a.descripcion,
      quantity: a.cantidad || '0',
      unit: a.unidad,
      pieceCount: a.piezas ? Number(a.piezas) : null,
      unitNetPrice: a.precioUnitario || '0',
      // Sólo se pasa cuando salió impreso: si se calculó, no hay nada que
      // verificar y el informe de la pantalla tiene que decir lo mismo que el
      // del servidor.
      grossSubtotal: a.brutoImpreso ? a.bruto : undefined,
      discountPct: a.descuentoPct || '0',
      ivaRate: a.ivaTasa || '0',
    }));

    const printed = {
      grossSubtotal: resumen.grossSubtotal || undefined,
      discountTotal: resumen.discountTotal || undefined,
      netTotal: resumen.netTotal || undefined,
      ivaTotal: resumen.ivaTotal || undefined,
      perceptionsTotal: resumen.perceptionsTotal || undefined,
      total: resumen.total || undefined,
      lineCount: resumen.lineCount ? Number(resumen.lineCount) : null,
      netWeightKg: resumen.netWeightKg || undefined,
      totalUnits: resumen.totalUnits || undefined,
    };

    const costeados = costItems(crudos, {
      netTotal: printed.netTotal ?? '0',
      ivaTotal: printed.ivaTotal ?? '0',
      perceptionsTotal: printed.perceptionsTotal ?? '0',
      // Las percepciones que el comprobante discrimina. `consistentPerceptionLines`
      // las descarta si alguien editó el total y ya no lo suman, para que el
      // desglose no contradiga el número de arriba.
      perceptionLines: consistentPerceptionLines(
        comprobante.impuestos
          .filter((i) => i.tipo === 'PERCEPCION')
          .map((i) => ({ label: i.etiqueta, amount: i.importe })),
        printed.perceptionsTotal ?? '0',
      ),
    });

    const reglas =
      comprobante.condiciones.ivaTasa || comprobante.condiciones.iibbTasa
        ? {
            ivaRate: comprobante.condiciones.ivaTasa ?? undefined,
            iibbRate: comprobante.condiciones.iibbTasa ?? undefined,
          }
        : undefined;

    return {
      costeados,
      informe: validateDocument({
        items: costeados,
        printed,
        supplierRules: reglas,
        attempts: comprobante.lecturas.length,
        /*
         * La conciliación de centavos viene del servidor y se arrastra tal cual.
         *
         * Esta pantalla recalcula los controles en vivo mientras se editan los
         * renglones, pero la conciliación no se puede recalcular acá: es el
         * servidor el que decide si se dieron sus condiciones, y el importe que
         * *se leyó de la foto* ya no está en la pantalla —lo que se ve es el
         * conciliado—. Sin arrastrarla, el aviso desaparecía en cuanto la
         * pantalla recalculaba, que es siempre.
         */
        reconciliation: comprobante.informe?.reconciliation ?? null,
      }),
    };
  }, [
    articulos,
    resumen,
    comprobante.condiciones,
    comprobante.lecturas.length,
    comprobante.informe,
    comprobante.impuestos,
  ]);

  // Al cambiar el proveedor o la fecha se recalcula la fecha prevista de pago.
  useEffect(() => {
    if (!proveedorId || !fecha) return;
    let cancelado = false;
    consultar(`/api/proveedores/${proveedorId}/condiciones?fecha=${fecha}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((datos) => {
        if (cancelado || !datos) return;
        setVencimiento(datos.vencimiento);
        setPlazoTexto(datos.plazo);
        setFormaDePago(datos.formaDePago);
      })
      .catch(() => {
        // Si falla, quedan los valores que ya había: no se bloquea la carga.
      });
    return () => {
      cancelado = true;
    };
  }, [proveedorId, fecha]);

  const actualizarArticulo = (
    clave: string,
    campo: keyof ArticuloEditable,
    valor: string | boolean,
  ) => {
    setArticulos((prev) =>
      prev.map((a) => (a.clave === clave ? { ...a, [campo]: valor } : a)),
    );
  };

  const quitarArticulo = (clave: string) => {
    setArticulos((prev) => prev.filter((a) => a.clave !== clave));
  };

  const agregarArticulo = () => {
    const renglon = articulos.reduce((max, a) => Math.max(max, a.renglon), 0) + 1;
    setArticulos((prev) => [
      ...prev,
      {
        clave: `nuevo-${renglon}-${Date.now()}`,
        renglon,
        codigo: null,
        descripcion: '',
        cantidad: '',
        bruto: '',
        brutoImpreso: false,
        unidad: 'KG',
        piezas: '',
        precioUnitario: '',
        descuentoPct: comprobante.articulos[0]?.descuentoPct ?? '0',
        ivaTasa: comprobante.condiciones.ivaTasa ?? '0.21',
        productoId: '',
        asociacionOriginal: 'MANUAL',
        recordar: true,
      },
    ]);
  };

  const guardar = async () => {
    setError(null);

    if (!proveedorId) {
      setError('Elegí el proveedor del comprobante.');
      return;
    }
    if (!puntoDeVenta.trim() || !numero.trim()) {
      setError('Cargá el punto de venta y el número del comprobante.');
      return;
    }
    if (!informe.canSave && !quiereForzar) {
      setError(
        'El comprobante no cierra: revisá los controles en rojo antes de guardarlo.',
      );
      return;
    }

    setGuardando(true);
    try {
      const cuerpo = {
        supplierId: proveedorId,
        docType: tipo,
        letter: letra || null,
        pointOfSale: puntoDeVenta.trim(),
        number: numero.trim(),
        issueDate: fecha,
        printed: {
          grossSubtotal: resumen.grossSubtotal || undefined,
          discountTotal: resumen.discountTotal || undefined,
          netTotal: resumen.netTotal || undefined,
          ivaTotal: resumen.ivaTotal || undefined,
          perceptionsTotal: resumen.perceptionsTotal || undefined,
          total: resumen.total || undefined,
          lineCount: resumen.lineCount ? Number(resumen.lineCount) : null,
          netWeightKg: resumen.netWeightKg || undefined,
          totalUnits: resumen.totalUnits || undefined,
        },
        items: articulos.map((a) => ({
          lineNumber: a.renglon,
          supplierCode: a.codigo,
          description: a.descripcion,
          quantity: a.cantidad || '0',
          unit: a.unidad,
          pieceCount: a.piezas ? Number(a.piezas) : null,
          unitNetPrice: a.precioUnitario || '0',
          grossSubtotal: a.brutoImpreso ? a.bruto : undefined,
          discountPct: a.descuentoPct || '0',
          ivaRate: a.ivaTasa || '0',
          productId: a.productoId || null,
          /*
           * Aprender la asociación es lo que hace que la próxima factura del
           * proveedor se vincule sola: queda guardado que su ART-00228 es el
           * PLU 1211, y desde entonces el código alcanza.
           *
           * No se aprende nada cuando ya vino asociado por código —ya estaba
           * aprendido— ni cuando el operador desmarcó la casilla.
           */
          learnAlias:
            Boolean(a.productoId) && a.recordar && a.asociacionOriginal !== 'SUPPLIER_CODE',
        })),
        payment: {
          dueDate: vencimiento,
          paymentMethod: formaDePago,
          notes: observaciones || null,
        },
        override: quiereForzar ? { reason: motivoForzado } : undefined,
      };

      const respuesta = await fetch(`/api/comprobantes/${comprobante.id}/confirmar`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(cuerpo),
      });
      const datos = await respuesta.json();
      if (!respuesta.ok) throw new AppError(datos.error ?? 'No pudimos guardar el comprobante.');
      onGuardado(datos.documentId);
    } catch (e) {
      setError(toUserMessage(e));
    } finally {
      setGuardando(false);
    }
  };

  const totalAPagar = resumen.total || informe.computed.totalCost;

  // --- Paso 3: agenda de pago --------------------------------------------
  if (paso === 3) {
    return (
      <>
        <h1>Guardar y agendar el pago</h1>
        <Pasos actual={3} />

        {error ? (
          <p className="mensaje mensaje-error" role="alert">
            {error}
          </p>
        ) : null}

        <Semaforo report={informe} />

        <div className="card">
          <h2>El pago</h2>
          <dl style={{ margin: '0 0 6px' }}>
            <div className="dato destacado">
              <dt>Total a pagar</dt>
              <dd>{formatARS(totalAPagar)}</dd>
            </div>
            <div className="dato">
              <dt>Fecha de emisión</dt>
              <dd>{fecha.split('-').reverse().join('/')}</dd>
            </div>
            <div className="dato">
              <dt>Plazo del proveedor</dt>
              <dd>{plazoTexto ?? 'Sin condición configurada'}</dd>
            </div>
          </dl>

          <div className="fila fila-2 mt">
            <div className="campo">
              <label htmlFor="vencimiento">Fecha prevista de pago</label>
              <input
                id="vencimiento"
                type="date"
                value={vencimiento}
                onChange={(e) => setVencimiento(e.target.value)}
              />
              <p className="ayuda">
                {contraFactura
                  ? vencimiento
                    ? 'Es la fecha en que se espera la próxima factura del proveedor, así que es provisoria: cuando llegue, se confirma contra la fecha real. Podés cambiarla.'
                    : 'Este proveedor cobra factura contra factura y no hay una próxima visita cargada. Poné vos la fecha en que esperás que vuelva a pasar.'
                  : 'Se calcula con el plazo del proveedor. Podés cambiarla antes de guardar.'}
              </p>
            </div>
            <div className="campo">
              <label htmlFor="formaDePago">Forma de pago prevista</label>
              <select
                id="formaDePago"
                value={formaDePago}
                onChange={(e) => setFormaDePago(e.target.value)}
              >
                {PAYMENT_METHODS.map((m) => (
                  <option key={m} value={m}>
                    {PAYMENT_METHOD_LABEL[m]}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="campo">
            <label htmlFor="observaciones">Observaciones</label>
            <textarea
              id="observaciones"
              value={observaciones}
              onChange={(e) => setObservaciones(e.target.value)}
              placeholder="Opcional: algo para tener en cuenta al pagar."
            />
          </div>

          <p className="mensaje mensaje-info mb0">
            El comprobante queda <strong>agendado</strong>, no pagado. Vas a poder confirmar el
            pago desde la pantalla de Pagos cuando efectivamente se abone.
          </p>
        </div>

        {!informe.canSave ? (
          <div className="card">
            <h2>El comprobante no cierra</h2>
            <p className="chico medio">
              Mientras el detalle no coincida con los totales impresos no se puede guardar como
              controlado.
            </p>
            {puedeForzar ? (
              <>
                <label className="etiqueta" htmlFor="forzar">
                  <input
                    id="forzar"
                    type="checkbox"
                    checked={quiereForzar}
                    onChange={(e) => setQuiereForzar(e.target.checked)}
                    style={{ width: 'auto', minHeight: 0, marginRight: 8 }}
                  />
                  Guardarlo igual, dejando constancia del motivo
                </label>
                {quiereForzar ? (
                  <div className="campo">
                    <label htmlFor="motivo">Motivo de la anulación del control</label>
                    <textarea
                      id="motivo"
                      value={motivoForzado}
                      onChange={(e) => setMotivoForzado(e.target.value)}
                      placeholder="Por ejemplo: el proveedor imprimió mal el subtotal y lo confirmó por teléfono."
                    />
                    <p className="ayuda">
                      Queda registrado en la auditoría con tu usuario y la fecha.
                    </p>
                  </div>
                ) : null}
              </>
            ) : (
              <p className="mensaje mensaje-aviso mb0">
                Sólo un administrador puede guardar un comprobante que no cierra.
              </p>
            )}
          </div>
        ) : null}

        <div className="barra-accion">
          <div className="acciones" style={{ marginTop: 0 }}>
            <button
              type="button"
              className="boton boton-secundario"
              onClick={() => onPaso(2)}
              disabled={guardando}
            >
              Volver a revisar
            </button>
            <button
              type="button"
              className="boton"
              onClick={guardar}
              disabled={guardando || (!informe.canSave && !quiereForzar)}
            >
              {guardando ? 'Guardando…' : 'Guardar y agendar el pago'}
            </button>
          </div>
        </div>
      </>
    );
  }

  // --- Paso 2: revisar los datos -----------------------------------------
  return (
    <>
      <h1>Revisar los datos</h1>
      <Pasos actual={2} />

      {error ? (
        <p className="mensaje mensaje-error" role="alert">
          {error}
        </p>
      ) : null}

      {/*
        Si lo que está en pantalla lo produjo una versión anterior del código,
        hay que decirlo. Es el caso que hace perder horas: se despliega una
        corrección, se abre un comprobante que ya estaba leído y los números
        siguen siendo los de antes —porque son los de antes, guardados—, y no hay
        nada en la pantalla que lo distinga de una corrección que no funcionó.
      */}
      {lecturaDeOtraVersion ? (
        <div className="card">
          <p className="mensaje mensaje-info mb0" role="status">
            Estos números los calculó una versión anterior de la aplicación
            {lecturaDeOtraVersion.buildCorto ? ` (${lecturaDeOtraVersion.buildCorto})` : ''}; ahora
            está corriendo {comprobante.version?.commitCorto ?? 'otra'}. Volvé a leer el comprobante
            para que se procese con la versión actual.
          </p>
          <div className="acciones">
            <button type="button" className="boton" onClick={onReleer}>
              Volver a leer esta imagen
            </button>
          </div>
        </div>
      ) : null}

      <Semaforo report={informe} />

      {!informe.canSave ? (
        <div className="card">
          <div className="card-titulo">
            <h2>Qué no cierra</h2>
          </div>
          <ListaControles checks={informe.checks.filter((c) => c.severity !== 'OK')} />
          <div className="acciones">
            <button type="button" className="boton" onClick={onReleer}>
              Volver a leer esta imagen
            </button>
            <button type="button" className="boton boton-secundario" onClick={onVolver}>
              Reemplazar la imagen
            </button>
          </div>
          <p className="ayuda mb0">
            &quot;Volver a leer&quot; arranca de cero desde la foto guardada y descarta la lectura
            anterior por completo.
          </p>
        </div>
      ) : null}

      {/*
        Un proveedor que no está cargado tiene que decirse antes que nada.

        Sin este aviso, el comprobante llega a la revisión con el desplegable de
        proveedor vacío y no hay forma de distinguir "el OCR no lo reconoció" de
        "este proveedor no existe todavía". Son dos problemas distintos y se
        arreglan distinto.
      */}
      {!proveedorId && leido ? (
        <div className="card">
          <div className="card-titulo">
            <h2>Proveedor nuevo</h2>
          </div>
          <p className="mensaje mensaje-info" role="status">
            Este comprobante lo emite{' '}
            <strong>{leido.nombre ?? 'un proveedor sin nombre legible'}</strong>
            {leido.cuit ? (
              <>
                {' '}
                (CUIT <strong>{leido.cuit}</strong>)
              </>
            ) : null}
            , que todavía no está cargado. Podés darlo de alta acá mismo sin perder la lectura ni
            las asociaciones que ya hiciste.
          </p>
          {proveedorError ? (
            <p className="mensaje mensaje-error" role="alert">
              {proveedorError}
            </p>
          ) : null}
          {altaProveedorAbierta ? (
            <>
              <div className="fila fila-2">
                <div className="campo">
                  <label htmlFor="alta-proveedor-nombre">Nombre del proveedor</label>
                  <input
                    id="alta-proveedor-nombre"
                    type="text"
                    value={proveedorNombre}
                    onChange={(e) => setProveedorNombre(e.target.value)}
                  />
                </div>
                <div className="campo">
                  <label htmlFor="alta-proveedor-cuit">CUIT</label>
                  <input
                    id="alta-proveedor-cuit"
                    type="text"
                    inputMode="numeric"
                    value={proveedorCuit}
                    onChange={(e) => setProveedorCuit(e.target.value)}
                    placeholder="30-12345678-9"
                  />
                </div>
              </div>
              <p className="ayuda">
                Queda con lo que se lee del papel. El plazo de pago y las tasas se cargan después en
                Configuración → Proveedores; hasta entonces la fecha prevista de pago se completa a
                mano.
              </p>
              <div className="acciones">
                <button
                  type="button"
                  className="boton boton-secundario"
                  onClick={() => setAltaProveedorAbierta(false)}
                  disabled={proveedorGuardando}
                >
                  Cancelar
                </button>
                <button
                  type="button"
                  className="boton"
                  onClick={crearProveedorRapido}
                  disabled={proveedorGuardando}
                >
                  {proveedorGuardando ? 'Creando…' : 'Crear proveedor y continuar'}
                </button>
              </div>
            </>
          ) : (
            <div className="acciones">
              <button
                type="button"
                className="boton"
                onClick={() => {
                  setProveedorNombre(leido.nombre ?? '');
                  setProveedorCuit(leido.cuit ?? '');
                  setProveedorError(null);
                  setAltaProveedorAbierta(true);
                }}
              >
                Crear proveedor y continuar
              </button>
            </div>
          )}
        </div>
      ) : null}

      <div className="card">
        <h2>El comprobante</h2>
        {proveedorAviso ? (
          <p className="mensaje mensaje-info" role="status">
            {proveedorAviso}
          </p>
        ) : null}
        <div className="fila fila-2">
          <div className="campo">
            <label htmlFor="proveedor">Proveedor</label>
            <select
              id="proveedor"
              value={proveedorId}
              onChange={(e) => setProveedorId(e.target.value)}
            >
              <option value="">Elegí el proveedor…</option>
              {proveedoresDisponibles.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.nombre}
                </option>
              ))}
            </select>
          </div>
          <div className="campo">
            <label htmlFor="fecha">Fecha de emisión</label>
            <input
              id="fecha"
              type="date"
              value={fecha}
              onChange={(e) => setFecha(e.target.value)}
            />
          </div>
        </div>

        <div className="fila fila-2">
          <div className="campo">
            <label htmlFor="tipo">Tipo</label>
            <select
              id="tipo"
              value={tipo}
              onChange={(e) => setTipo(e.target.value as 'FACTURA' | 'REMITO')}
            >
              <option value="FACTURA">Factura</option>
              <option value="REMITO">Remito</option>
            </select>
          </div>
          <div className="campo">
            <label htmlFor="letra">Letra</label>
            <input
              id="letra"
              type="text"
              value={letra}
              maxLength={1}
              onChange={(e) => setLetra(e.target.value.toUpperCase())}
              autoCapitalize="characters"
            />
          </div>
        </div>

        <div className="fila fila-2">
          <div className="campo">
            <label htmlFor="pv">Punto de venta</label>
            <input
              id="pv"
              type="text"
              inputMode="numeric"
              value={puntoDeVenta}
              onChange={(e) => setPuntoDeVenta(e.target.value)}
            />
          </div>
          <div className="campo">
            <label htmlFor="numero">Número</label>
            <input
              id="numero"
              type="text"
              inputMode="numeric"
              value={numero}
              onChange={(e) => setNumero(e.target.value)}
            />
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-titulo">
          <h2>Artículos</h2>
          <span className="chico medio">
            {articulos.length === 1 ? '1 renglón' : `${articulos.length} renglones`}
          </span>
        </div>

        <ul className="lista">
          {articulos.map((articulo, indice) => {
            const calculado = costeados[indice];
            return (
              <li key={articulo.clave} className="fila-dato">
                <div className="campo">
                  <label htmlFor={`desc-${articulo.clave}`}>
                    Renglón {articulo.renglon}
                    {articulo.codigo ? ` · código ${articulo.codigo}` : ''}
                  </label>
                  <input
                    id={`desc-${articulo.clave}`}
                    type="text"
                    value={articulo.descripcion}
                    onChange={(e) =>
                      actualizarArticulo(articulo.clave, 'descripcion', e.target.value)
                    }
                  />
                </div>

                <div className="fila fila-3">
                  <div className="campo">
                    <label htmlFor={`cant-${articulo.clave}`}>
                      {articulo.unidad === 'KG' ? 'Kilos' : 'Unidades'}
                    </label>
                    <input
                      id={`cant-${articulo.clave}`}
                      type="text"
                      inputMode="decimal"
                      value={articulo.cantidad}
                      onChange={(e) =>
                        actualizarArticulo(articulo.clave, 'cantidad', e.target.value)
                      }
                    />
                  </div>
                  <div className="campo">
                    <label htmlFor={`precio-${articulo.clave}`}>Precio unitario</label>
                    <input
                      id={`precio-${articulo.clave}`}
                      type="text"
                      inputMode="decimal"
                      value={articulo.precioUnitario}
                      onChange={(e) =>
                        actualizarArticulo(articulo.clave, 'precioUnitario', e.target.value)
                      }
                    />
                  </div>
                  <div className="campo">
                    <label htmlFor={`desc-pct-${articulo.clave}`}>Bonificación</label>
                    <input
                      id={`desc-pct-${articulo.clave}`}
                      type="text"
                      inputMode="decimal"
                      value={articulo.descuentoPct}
                      onChange={(e) =>
                        actualizarArticulo(articulo.clave, 'descuentoPct', e.target.value)
                      }
                    />
                  </div>
                </div>

                <div className="fila fila-3">
                  <div className="campo">
                    <label htmlFor={`unidad-${articulo.clave}`}>Unidad</label>
                    <select
                      id={`unidad-${articulo.clave}`}
                      value={articulo.unidad}
                      onChange={(e) =>
                        actualizarArticulo(articulo.clave, 'unidad', e.target.value)
                      }
                    >
                      <option value="KG">Kilos</option>
                      <option value="UNIT">Unidades</option>
                    </select>
                  </div>
                  <div className="campo">
                    <label htmlFor={`piezas-${articulo.clave}`}>Piezas</label>
                    <input
                      id={`piezas-${articulo.clave}`}
                      type="text"
                      inputMode="numeric"
                      value={articulo.piezas}
                      onChange={(e) =>
                        actualizarArticulo(articulo.clave, 'piezas', e.target.value)
                      }
                    />
                  </div>
                  <div className="campo">
                    <label htmlFor={`prod-${articulo.clave}`}>PLU Don Ginés</label>
                    {/*
                      Buscar en el catálogo antes de elegir.

                      Con ciento veinticinco PLU, el desplegable solo obliga a
                      barrer la lista entera con el pulgar en cada renglón. Acá
                      se escribe cualquier pedazo de lo que se está mirando —el
                      PLU, una palabra del nombre, el código que imprime el
                      proveedor— y quedan a la vista las pocas opciones que
                      pueden ser.
                    */}
                    <input
                      id={`buscar-${articulo.clave}`}
                      type="search"
                      className="mb-chico"
                      value={busquedaProducto[articulo.clave] ?? ''}
                      placeholder="Buscar por PLU, nombre o código del proveedor…"
                      aria-label={`Buscar el producto del renglón ${articulo.renglon}`}
                      onChange={(e) =>
                        setBusquedaProducto((prev) => ({
                          ...prev,
                          [articulo.clave]: e.target.value,
                        }))
                      }
                    />
                    <select
                      id={`prod-${articulo.clave}`}
                      value={articulo.productoId}
                      onChange={(e) =>
                        actualizarArticulo(articulo.clave, 'productoId', e.target.value)
                      }
                    >
                      <option value="">Sin asociar</option>
                      {/*
                        Cada opción lleva el PLU, el nombre y los códigos con
                        que los proveedores lo facturan. Es lo que permite
                        encontrarlo tecleando cualquiera de los tres: el PLU si
                        se lo sabe de memoria, el nombre si no, y el código que
                        se está mirando en el papel.
                      */}
                      {filtrarCatalogo(
                        productosDisponibles,
                        busquedaProducto[articulo.clave],
                        articulo.productoId,
                      ).map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.codigo} · {p.nombre}
                          {p.codigosDeProveedor && p.codigosDeProveedor.length > 0
                            ? ` · ${p.codigosDeProveedor.join(' ')}`
                            : ''}
                        </option>
                      ))}
                    </select>
                    <div className="acciones">
                      <button
                        type="button"
                        className="boton boton-secundario boton-chico"
                        onClick={() => abrirAltaProducto(articulo)}
                      >
                        Crear producto nuevo…
                      </button>
                    </div>
                  </div>
                </div>

                {altaProductoClave === articulo.clave ? (
                  <div className="card card-compacta mt">
                    <h3>Nuevo producto</h3>
                    {altaError ? <p className="mensaje mensaje-error">{altaError}</p> : null}
                    <div className="campo">
                      <label htmlFor={`alta-nombre-${articulo.clave}`}>Nombre</label>
                      <input
                        id={`alta-nombre-${articulo.clave}`}
                        type="text"
                        value={altaNombre}
                        onChange={(e) => setAltaNombre(e.target.value)}
                      />
                    </div>
                    <label className="casilla">
                      <input
                        type="checkbox"
                        checked={altaUsaPlu}
                        onChange={(e) => setAltaUsaPlu(e.target.checked)}
                      />
                      <span>Este producto usa PLU</span>
                    </label>
                    <div className="fila fila-2">
                      <div className="campo">
                        <label htmlFor={`alta-plu-${articulo.clave}`}>PLU nuevo</label>
                        <input
                          id={`alta-plu-${articulo.clave}`}
                          type="text"
                          value={altaPlu}
                          onChange={(e) => setAltaPlu(e.target.value)}
                          disabled={!altaUsaPlu}
                          placeholder="Ej. 9099"
                        />
                      </div>
                      <div className="campo">
                        <label htmlFor={`alta-barcode-${articulo.clave}`}>Código de barras</label>
                        <input
                          id={`alta-barcode-${articulo.clave}`}
                          type="text"
                          inputMode="numeric"
                          value={altaBarcode}
                          onChange={(e) => setAltaBarcode(e.target.value)}
                          placeholder="Escanealo o escribilo"
                        />
                      </div>
                    </div>
                    <p className="ayuda">
                      Al crear el artículo queda seleccionado en este renglón. Si marcás “recordar
                      asociación”, el código del proveedor se aprende al guardar la factura.
                    </p>
                    <div className="acciones">
                      <button
                        type="button"
                        className="boton boton-secundario"
                        onClick={() => setAltaProductoClave(null)}
                        disabled={altaGuardando}
                      >
                        Cancelar
                      </button>
                      <button
                        type="button"
                        className="boton"
                        onClick={() => crearProductoRapido(articulo)}
                        disabled={altaGuardando}
                      >
                        {altaGuardando ? 'Creando…' : 'Crear y seleccionar'}
                      </button>
                    </div>
                  </div>
                ) : null}

                {/*
                  Los dos códigos, uno al lado del otro y sin ocupar lugar.

                  Son cosas distintas y conviene que se vean como tales: a la
                  izquierda el que imprime el proveedor en su factura, a la
                  derecha el PLU con el que Don Ginés vende el artículo. El de
                  la factura nunca reemplaza al PLU.
                */}
                <div className="fila-dato-meta">
                  <span>
                    Código proveedor: <strong>{articulo.codigo ?? 'sin código'}</strong>
                  </span>
                  <span>
                    Producto Don Ginés:{' '}
                    <strong>
                      {(() => {
                        /*
                          El PLU con su nombre, no el número solo.
                          
                          "PLU 1211" no alcanza para saber si es el artículo
                          correcto: quien revisa la factura está mirando
                          "CREMOSO PUNTA DEL AGUA" en el papel y necesita ver
                          contra qué se lo está asociando.
                        */
                        const elegido = productosDisponibles.find((p) => p.id === articulo.productoId);
                        return elegido
                          ? `PLU ${elegido.codigo} · ${elegido.nombre}`
                          : 'Sin asociar';
                      })()}
                    </strong>
                  </span>
                  {articulo.asociacionOriginal === 'SUPPLIER_CODE' ? (
                    <span>Vinculado por el código del proveedor</span>
                  ) : null}
                </div>

                {/*
                  Sólo se ofrece recordar cuando hay algo nuevo que recordar: si
                  el renglón ya vino asociado por código, la asociación existe.
                */}
                {articulo.productoId && articulo.asociacionOriginal !== 'SUPPLIER_CODE' ? (
                  <label className="casilla">
                    <input
                      type="checkbox"
                      checked={articulo.recordar}
                      onChange={(e) =>
                        actualizarArticulo(articulo.clave, 'recordar', e.target.checked)
                      }
                    />
                    <span>
                      Recordar esta asociación para futuras facturas de{' '}
                      {proveedoresDisponibles.find((p) => p.id === proveedorId)?.nombre ??
                        'este proveedor'}
                    </span>
                  </label>
                ) : null}

                {calculado ? (
                  <dl style={{ margin: 0 }}>
                    <div className="dato">
                      <dt>Neto del renglón</dt>
                      <dd>{formatARS(calculado.netAmount)}</dd>
                    </div>
                    {/*
                      De dónde sale el costo de este artículo: su neto más la
                      parte que le toca de cada impuesto del comprobante. Sin
                      esto, el costo unitario final es un número que aparece sin
                      explicación.
                    */}
                    <div className="dato">
                      <dt>IVA proporcional</dt>
                      <dd>{formatARS(calculado.ivaAmount)}</dd>
                    </div>
                    {calculado.perceptionBreakdown.map((percepcion) => (
                      <div className="dato" key={percepcion.label}>
                        <dt>{percepcion.label} proporcional</dt>
                        <dd>{formatARS(percepcion.amount)}</dd>
                      </div>
                    ))}
                    {/* El centavo de redondeo que le tocó, si le tocó alguno. */}
                    {!calculado.netCostBase.eq(calculado.netAmount) ? (
                      <div className="dato">
                        <dt>Redondeo</dt>
                        <dd>{formatARS(calculado.netCostBase.minus(calculado.netAmount))}</dd>
                      </div>
                    ) : null}
                    <div className="dato">
                      <dt>Costo final del renglón</dt>
                      <dd>{formatARS(calculado.totalCost)}</dd>
                    </div>
                    <div className="dato">
                      <dt>Costo unitario final</dt>
                      <dd>
                        {formatARS(calculado.unitCost)} por{' '}
                        {articulo.unidad === 'KG' ? 'kg' : 'unidad'}
                      </dd>
                    </div>
                  </dl>
                ) : null}

                <div className="acciones">
                  <button
                    type="button"
                    className="boton boton-secundario boton-chico"
                    onClick={() => quitarArticulo(articulo.clave)}
                  >
                    Quitar este renglón
                  </button>
                </div>
              </li>
            );
          })}
        </ul>

        <div className="acciones">
          <button type="button" className="boton boton-secundario" onClick={agregarArticulo}>
            Agregar un renglón
          </button>
        </div>
      </div>

      <div className="card">
        <h2>Totales impresos en el comprobante</h2>
        <p className="chico medio">
          Son los del pie de la factura. Contra estos se controla el detalle, así que tienen que
          ser exactamente los que están impresos.
        </p>

        <div className="fila fila-2">
          <CampoImporte
            id="grossSubtotal"
            etiqueta="Subtotal bruto"
            valor={resumen.grossSubtotal}
            onChange={(v) => setResumen((r) => ({ ...r, grossSubtotal: v }))}
          />
          <CampoImporte
            id="discountTotal"
            etiqueta="Descuento total"
            valor={resumen.discountTotal}
            onChange={(v) => setResumen((r) => ({ ...r, discountTotal: v }))}
          />
        </div>
        <div className="fila fila-2">
          <CampoImporte
            id="netTotal"
            etiqueta="Neto gravado"
            valor={resumen.netTotal}
            onChange={(v) => setResumen((r) => ({ ...r, netTotal: v }))}
          />
          <CampoImporte
            id="ivaTotal"
            etiqueta="IVA"
            valor={resumen.ivaTotal}
            onChange={(v) => setResumen((r) => ({ ...r, ivaTotal: v }))}
          />
        </div>
        <div className="fila fila-2">
          <CampoImporte
            id="perceptionsTotal"
            etiqueta="Percepciones"
            valor={resumen.perceptionsTotal}
            onChange={(v) => setResumen((r) => ({ ...r, perceptionsTotal: v }))}
          />
          <CampoImporte
            id="total"
            etiqueta="Total"
            valor={resumen.total}
            onChange={(v) => setResumen((r) => ({ ...r, total: v }))}
          />
        </div>
        <div className="fila fila-2">
          <div className="campo">
            <label htmlFor="lineCount">Cantidad de renglones</label>
            <input
              id="lineCount"
              type="text"
              inputMode="numeric"
              value={resumen.lineCount}
              onChange={(e) => setResumen((r) => ({ ...r, lineCount: e.target.value }))}
            />
          </div>
          <CampoImporte
            id="netWeightKg"
            etiqueta="Peso neto (kg)"
            valor={resumen.netWeightKg}
            onChange={(v) => setResumen((r) => ({ ...r, netWeightKg: v }))}
          />
        </div>
      </div>

      <div className="card">
        <h2>Lo que da el detalle</h2>
        <dl style={{ margin: 0 }}>
          <div className="dato">
            <dt>Renglones</dt>
            <dd>{informe.computed.itemCount}</dd>
          </div>
          {/*
            Kilos y unidades por separado, nunca sumados.
            Son magnitudes distintas: 480,34 kg de fiambre y 71 latas no se
            suman a 551. Cada una dice cuántos artículos la componen, para poder
            contarlos contra el papel.
          */}
          <div className="dato">
            <dt>Kilos</dt>
            <dd>
              {formatQty(informe.computed.totalQuantityKg, 2)} kg
              <span className="chico medio"> · {informe.computed.kgItemCount} artículos</span>
            </dd>
          </div>
          <div className="dato">
            <dt>Unidades</dt>
            <dd>
              {formatQty(informe.computed.totalUnits, 0)}
              <span className="chico medio"> · {informe.computed.unitItemCount} artículos</span>
            </dd>
          </div>
          <div className="dato">
            <dt>Subtotal bruto</dt>
            <dd>{formatARS(informe.computed.grossSubtotal)}</dd>
          </div>
          <div className="dato">
            <dt>Descuentos</dt>
            <dd>{formatARS(informe.computed.discountAmount)}</dd>
          </div>
          <div className="dato">
            <dt>Neto</dt>
            <dd>{formatARS(informe.computed.netAmount)}</dd>
          </div>
          {/*
            Los centavos que separan la suma de los renglones del neto impreso.
            El costo final se arma sobre los importes del pie, que es lo que la
            sucursal termina pagando, así que si los renglones quedan a unos
            centavos hay que decir dónde están: el resumen tiene que poder
            sumarse a mano y dar el total de abajo.
          */}
          {informe.computed.netRounding !== '0.00' ? (
            <div className="dato">
              <dt>Redondeo contra el neto impreso</dt>
              <dd>{formatARS(informe.computed.netRounding)}</dd>
            </div>
          ) : null}

          {/*
            Del neto al costo final, un renglón por cada impuesto.
            El costo de comprar no es el neto: es el neto más todo lo que hay
            que pagar por él. Mostrarlos sumados en un solo "impuestos" impide
            contrastar cada uno con su renglón del pie de la factura.
          */}
          <div className="dato">
            <dt>IVA</dt>
            <dd>{formatARS(informe.computed.ivaAmount)}</dd>
          </div>
          {informe.computed.perceptionsByLabel.map((percepcion) => (
            <div className="dato" key={percepcion.label}>
              <dt>{percepcion.label}</dt>
              <dd>{formatARS(percepcion.amount)}</dd>
            </div>
          ))}
          <div className="dato destacado">
            <dt>Total del comprobante</dt>
            <dd>{formatARS(informe.computed.totalCost)}</dd>
          </div>
        </dl>
        <p className="ayuda mb0">
          El total es el costo real de la compra: el neto más el IVA y las percepciones. Cada
          artículo lleva su parte proporcional, repartida sobre los importes impresos del pie.
        </p>
      </div>

      {informe.canSave ? (
        <div className="card">
          <div className="card-titulo">
            <h2>Controles</h2>
          </div>
          <ListaControles checks={informe.checks} />
        </div>
      ) : null}

      {comprobante.paginas.length > 0 ? (
        <div className="card">
          <h2>Imágenes del comprobante</h2>
          <ul className="miniaturas">
            {comprobante.paginas.map((pagina) => (
              <li key={pagina.id} className="miniatura">
                <span className="miniatura-orden">{pagina.orden}</span>
                <a href={pagina.url} target="_blank" rel="noreferrer">
                  {pagina.esPdf ? (
                    <div className="miniatura-pdf">Ver el PDF</div>
                  ) : (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={pagina.url} alt={`Página ${pagina.orden} del comprobante`} />
                  )}
                </a>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="barra-accion">
        <div className="acciones" style={{ marginTop: 0 }}>
          <button type="button" className="boton boton-secundario" onClick={onVolver}>
            Volver a las imágenes
          </button>
          <button
            type="button"
            className="boton"
            onClick={() => onPaso(3)}
            disabled={vencimiento === ''}
            title={vencimiento === '' ? 'Falta la fecha prevista de pago.' : undefined}
          >
            Continuar al pago
          </button>
        </div>
      </div>
    </>
  );
}

function CampoImporte({
  id,
  etiqueta,
  valor,
  onChange,
}: {
  id: string;
  etiqueta: string;
  valor: string;
  onChange: (valor: string) => void;
}) {
  return (
    <div className="campo">
      <label htmlFor={id}>{etiqueta}</label>
      <input
        id={id}
        type="text"
        inputMode="decimal"
        value={valor}
        onChange={(e) => onChange(e.target.value)}
        placeholder="—"
      />
    </div>
  );
}
