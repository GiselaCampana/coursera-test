import type { CandidataDeTabla, RenglonCandidato } from '@/lib/ocr/motor/candidatas';
import { cantidadQueCuesta, netoDelRenglon } from '@/lib/ocr/motor/candidatas';
import type { InformeDelMotor } from '@/lib/ocr/motor/motor';

/**
 * El informe de lo que el motor entendió de un comprobante, en castellano.
 *
 * Existe porque un motor que decide solo tiene que poder explicarse. La decisión
 * —usarlo, mandarlo a configurar o rechazarlo— no vale nada si no se puede
 * revisar **por qué**: qué columna creyó que era cada cosa, qué cuentas hizo,
 * cuál cerró y cuál no, cuánto le ganó la lectura elegida a la segunda.
 *
 * Es lo que va a leer una persona cuando el comprobante quede frenado, y es
 * también lo que queda como registro de una lectura que pasó sola. Sin esto, un
 * error de interpretación se descubre semanas después, en el costo de un
 * artículo que no cierra.
 *
 * **No lleva la foto ni el texto crudo**: son de la lectura, no de la
 * interpretación, y el diagnóstico ya los muestra por su cuenta.
 */
export function informeEnTexto(informe: InformeDelMotor): string {
  const l: string[] = [];
  const v = informe.veredicto;

  l.push('EMISOR');
  l.push(`  Razón social : ${informe.emisor.razonSocial ?? '(no se pudo leer)'}`);
  l.push(`  CUIT         : ${informe.emisor.cuit ?? '(no se pudo leer)'}`);
  if (informe.emisor.estadoCuit) l.push(`  Estado CUIT  : ${informe.emisor.estadoCuit}`);
  l.push(`  Huella del formato : ${informe.huella ?? '(sin tabla)'}`);
  l.push('');

  l.push('COLUMNAS');
  if (informe.encabezados.length === 0) {
    l.push('  No se encontró la fila de títulos.');
  } else {
    informe.encabezados.forEach((encabezado, i) => {
      const columna = informe.columnas[i];
      const campo = columna ? columna.campo : 'SIN RESOLVER';
      l.push(`  ${String(i + 1).padStart(2)}. «${encabezado}» → ${campo}`);
    });
    if (informe.ambiguas.length > 0) {
      l.push(`  Ambiguas: ${informe.ambiguas.map((a) => `«${a}»`).join(', ')}`);
    }
  }
  l.push('');

  l.push('PIE FISCAL');
  l.push(`  Neto        : ${informe.pie.netTotal?.toFixed(2) ?? '—'}`);
  l.push(`  IVA         : ${informe.pie.ivaTotal?.toFixed(2) ?? '—'}`);
  l.push(`  Percepciones: ${informe.pie.percepciones?.toFixed(2) ?? '—'}`);
  l.push(`  Total       : ${informe.pie.total?.toFixed(2) ?? '—'}`);
  if (informe.pie.ignorados.length > 0) {
    l.push('  Números del pie que NO son del comprobante y se dejaron afuera:');
    for (const ignorado of informe.pie.ignorados) {
      l.push(`    - ${ignorado.etiqueta}: ${ignorado.valor}`);
    }
  }
  l.push('');

  l.push('RENGLONES');
  l.push(`  Filas vistas: ${informe.filasVistas}`);
  l.push(`  Filas interpretadas: ${v.ganadora?.renglones.length ?? 0}`);
  for (const renglon of v.ganadora?.renglones ?? []) {
    l.push(...describirRenglon(renglon));
  }
  l.push('');

  l.push('LECTURAS');
  for (const candidata of informe.candidatas) {
    l.push(...describirCandidata(candidata, candidata === v.ganadora, candidata === v.segunda));
  }
  l.push('');

  l.push('DECISIÓN');
  l.push(`  ${v.decision.toUpperCase()}`);
  l.push(`  Margen sobre la segunda: ${v.margen.toFixed(2)}`);
  l.push(`  ${v.motivo}`);

  return l.join('\n');
}

function describirRenglon(renglon: RenglonCandidato): string[] {
  const l: string[] = [];
  l.push(`  · ${renglon.codigo ?? '(sin código)'} — ${renglon.descripcion}`);
  if (renglon.marca) l.push(`      Marca: ${renglon.marca}`);

  /*
   * Las cantidades, en el orden en que pesan: primero la que cuesta.
   *
   * Una cantidad cuya columna se llama «Cantidad» y no «Kg» se informa **sin
   * unidad**, aunque el papel esté midiendo kilos. El motor no infiere la
   * unidad por el nombre de la columna ni por el del artículo: decirlo cuando
   * no se sabe es peor que no decirlo, porque un costo por kilo y uno por pieza
   * se ven iguales en la pantalla y no lo son.
   */
  const cantidades: string[] = [];
  if (renglon.kilos) cantidades.push(`${renglon.kilos} kg`);
  if (renglon.cantidad) {
    cantidades.push(
      renglon.unidadFacturada === 'KG'
        ? `${renglon.cantidad} kg facturados`
        : renglon.unidadFacturada === 'UNIT'
          ? `${renglon.cantidad} unidades facturadas`
          : `${renglon.cantidad} (unidad de facturación sin determinar)`,
    );
  }
  if (renglon.piezas !== null) cantidades.push(`${renglon.piezas} piezas`);
  l.push(`      Cantidad: ${cantidades.join(' · ') || '—'}`);

  // Cuál cantidad se factura, dicho y no supuesto.
  const cuesta = cantidadQueCuesta(renglon);
  if (cuesta) {
    const unidad =
      renglon.unidadFacturada === 'KG'
        ? ' kg'
        : renglon.unidadFacturada === 'UNIT'
          ? ' unidades'
          : ' (unidad no impresa)';
    l.push(
      `      Cantidad facturada: ${cuesta}${unidad} ` +
        `(sale de ${renglon.campoCantidadFacturada ?? 'ninguna columna'})`,
    );
  }
  l.push(
    `      Destino de stock: ${renglon.productoId ?? '(producto sin asociar)'} · ` +
      `${renglon.unidadDeStock ?? '(unidad de stock sin resolver)'}`,
  );

  const precios: string[] = [];
  if (renglon.precioUnitario) precios.push(`lista ${renglon.precioUnitario}`);
  if (renglon.descuentoPct) precios.push(`descuento ${renglon.descuentoPct.times(100)} %`);
  if (renglon.precioConDescuento) precios.push(`con descuento ${renglon.precioConDescuento}`);
  l.push(`      Precio: ${precios.join(' · ') || '—'}`);

  if (renglon.importe) {
    const cual =
      renglon.descuentoEnElImporte === null
        ? ''
        : renglon.descuentoEnElImporte
          ? ' (neto: ya tiene el descuento)'
          : ' (bruto: el descuento se aplica al pie)';
    l.push(`      Importe impreso: ${renglon.importe}${cual}`);
  }
  l.push(`      Neto del renglón: ${netoDelRenglon(renglon)?.toFixed(2) ?? '(no se pudo calcular)'}`);

  if (renglon.controles.length === 0) {
    l.push('      Controles: ninguno se pudo hacer con lo que trae este renglón.');
  } else {
    for (const control of renglon.controles) {
      l.push(`      ${control.paso ? 'CIERRA' : 'NO CIERRA'} · ${control.nombre}: ${control.detalle}`);
    }
  }
  return l;
}

function describirCandidata(
  candidata: CandidataDeTabla,
  esGanadora: boolean,
  esSegunda: boolean,
): string[] {
  const papel = esGanadora ? ' ← GANADORA' : esSegunda ? ' ← SEGUNDA' : '';
  const l = [
    `  Números a la ${candidata.convencion === 'ar' ? 'argentina' : 'norteamericana'}: ` +
      `puntaje ${candidata.puntaje.toFixed(2)}${papel}`,
    `      ${candidata.renglones.length} renglones, suman ${candidata.sumaDeRenglones.toFixed(2)} ` +
      `contra un neto impreso de ${candidata.pie.netTotal?.toFixed(2) ?? '—'}`,
  ];
  if (candidata.penalizaciones.length === 0) {
    l.push('      Sin penalizaciones.');
  } else {
    for (const penalizacion of candidata.penalizaciones) {
      l.push(`      −${penalizacion.puntos.toFixed(2)} · ${penalizacion.motivo}`);
    }
  }
  return l;
}
