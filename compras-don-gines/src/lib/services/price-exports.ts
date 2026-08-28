import 'server-only';

import JSZip from 'jszip';
import type { AuthUser } from '@/lib/auth/session';
import { getPriceBoard, type PriceBoardRow } from '@/lib/services/pricing';
import { formatARS, formatRate } from '@/lib/money';
import { formatDateAr } from '@/lib/datetime';

export interface PriceExportFilters {
  category?: string | null;
  supplier?: string | null;
}

export interface PriceExportRow extends PriceBoardRow {
  salePricePerKg: string | null;
}

export async function getPriceExportRows(
  user: AuthUser,
  filters: PriceExportFilters = {},
): Promise<PriceExportRow[]> {
  const rows = await getPriceBoard(user);
  return rows
    .filter((r) => r.purchaseUnitCost !== null)
    .filter((r) => !filters.category || r.category === filters.category)
    .filter((r) => !filters.supplier || r.supplierName === filters.supplier)
    .map((r) => ({
      ...r,
      salePricePerKg: r.approvedPricePerKg ?? r.suggestedPricePerKg,
    }));
}

function xml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function col(n: number): string {
  let x = n;
  let out = '';
  while (x > 0) {
    const rem = (x - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    x = Math.floor((x - 1) / 26);
  }
  return out;
}

function xlsxCell(ref: string, value: string | number | null, style?: number): string {
  const styleAttr = style === undefined ? '' : ` s="${style}"`;
  if (value === null || value === '') return `<c r="${ref}"${styleAttr}/>`;
  if (typeof value === 'number' && Number.isFinite(value)) {
    return `<c r="${ref}"${styleAttr}><v>${value}</v></c>`;
  }
  return `<c r="${ref}" t="inlineStr"${styleAttr}><is><t xml:space="preserve">${xml(String(value))}</t></is></c>`;
}

function n(v: string | null): number | null {
  return v === null ? null : Number(v);
}

export async function priceRowsToXlsx(rows: PriceExportRow[]): Promise<Buffer> {
  const headers = [
    'Identificador',
    'PLU',
    'Código de barras',
    'Producto',
    'Tipo',
    'Subtipo',
    'Proveedor',
    'Modo de venta',
    'Unidad de compra',
    'Kg por unidad comprada',
    'Costo de compra',
    'Costo por kg',
    'Marcaje base',
    'Marcaje horma digital',
    'Marcaje horma efectivo',
    'Marcaje caja efectivo',
    'Marcaje 100 g',
    'Marcaje 1/4 kg',
    'Marcaje pieza digital',
    'Marcaje pieza efectivo',
    'Marcaje unidad entera',
    'Precio por kilo',
    'Horma digital · $/kg',
    'Horma efectivo · $/kg',
    'Caja efectivo · $/kg',
    '100 g · $/kg',
    '1/4 kg · $/kg',
    'Pieza digital · $/kg',
    'Pieza efectivo · $/kg',
    'Precio por unidad',
    'Unidad/lata/cajón entero',
    'Precio base aprobado/kg',
    'Fecha último costo',
  ];

  const data: Array<Array<string | number | null>> = [
    headers,
    ...rows.map((r) => [
      r.usesPlu ? r.internalCode : r.barcode ?? r.internalCode,
      r.usesPlu ? r.internalCode : '',
      r.barcode ?? '',
      r.name,
      r.category ?? '',
      r.subtype ?? '',
      r.supplierName ?? '',
      r.saleMode === 'AL_CORTE' ? 'Al corte' : 'Feteable',
      r.purchaseUnit === 'UNIT' ? 'Unidad' : 'Kg',
      r.purchaseUnitWeightKg ? Number(r.purchaseUnitWeightKg) : null,
      n(r.purchaseUnitCost),
      n(r.lastUnitCost),
      Number(r.targetMarginPct),
      r.alCorteHormaDigitalMarginPct ? Number(r.alCorteHormaDigitalMarginPct) : Number(r.targetMarginPct),
      r.alCorteHormaCashMarginPct ? Number(r.alCorteHormaCashMarginPct) : Number(r.targetMarginPct),
      r.alCorteCajaCashMarginPct ? Number(r.alCorteCajaCashMarginPct) : Number(r.targetMarginPct),
      r.feteado100gMarginPct ? Number(r.feteado100gMarginPct) : Number(r.targetMarginPct),
      r.feteadoQuarterMarginPct ? Number(r.feteadoQuarterMarginPct) : Number(r.targetMarginPct),
      r.feteadoPieceDigitalMarginPct ? Number(r.feteadoPieceDigitalMarginPct) : Number(r.targetMarginPct),
      r.feteadoPieceCashMarginPct ? Number(r.feteadoPieceCashMarginPct) : Number(r.targetMarginPct),
      r.wholeUnitMarginPct ? Number(r.wholeUnitMarginPct) : Number(r.targetMarginPct),
      n(r.salePricePerKg),
      n(r.alCorteHormaDigitalKg),
      n(r.alCorteHormaCashKg),
      n(r.alCorteCajaCashKg),
      n(r.feteado100gKg),
      n(r.feteadoQuarterKg),
      n(r.feteadoPieceDigitalKg),
      n(r.feteadoPieceCashKg),
      r.soldByUnit ? n(r.wholeUnitTotal) : null,
      !r.soldByUnit ? n(r.wholeUnitTotal) : null,
      n(r.approvedPricePerKg),
      r.lastCostDate ? formatDateAr(r.lastCostDate) : '',
    ]),
  ];

  const moneyColumns = new Set([11, 12, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32]);
  const pctColumns = new Set([13, 14, 15, 16, 17, 18, 19, 20, 21]);

  const rowsXml = data
    .map((row, ri) => {
      const cells = row
        .map((value, ci) => {
          const ref = `${col(ci + 1)}${ri + 1}`;
          const oneBased = ci + 1;
          const style = ri === 0 ? 1 : moneyColumns.has(oneBased) ? 2 : pctColumns.has(oneBased) ? 3 : undefined;
          return xlsxCell(ref, value, style);
        })
        .join('');
      return `<row r="${ri + 1}">${cells}</row>`;
    })
    .join('');

  const lastCol = col(headers.length);
  const worksheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetViews>
    <sheetView workbookViewId="0">
      <pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>
    </sheetView>
  </sheetViews>
  <cols>
    <col min="1" max="3" width="18" customWidth="1"/>
    <col min="4" max="4" width="36" customWidth="1"/>
    <col min="5" max="9" width="20" customWidth="1"/>
    <col min="10" max="${headers.length}" width="18" customWidth="1"/>
  </cols>
  <sheetData>${rowsXml}</sheetData>
  <autoFilter ref="A1:${lastCol}${data.length}"/>
</worksheet>`;

  const zip = new JSZip();
  zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>`);
  zip.folder('_rels')!.file('.rels', `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`);
  zip.folder('xl')!.file('workbook.xml', `<?xml version="1.0" encoding="UTF-8"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"
 xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
 <sheets><sheet name="Precios y costos" sheetId="1" r:id="rId1"/></sheets>
</workbook>`);
  zip.folder('xl')!.folder('_rels')!.file('workbook.xml.rels', `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`);
  zip.folder('xl')!.file('styles.xml', `<?xml version="1.0" encoding="UTF-8"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
 <numFmts count="2">
  <numFmt numFmtId="164" formatCode="[$$-es-AR] #,##0.00"/>
  <numFmt numFmtId="165" formatCode="0.00%"/>
 </numFmts>
 <fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>
 <fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>
 <borders count="1"><border/></borders>
 <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
 <cellXfs count="4">
  <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
  <xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>
  <xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
  <xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
 </cellXfs>
 <cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`);
  zip.folder('xl')!.folder('worksheets')!.file('sheet1.xml', worksheet);

  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

function pdfEscapeLatin1(s: string): Buffer {
  const normalized = s
    .replace(/–|—/g, '-')
    .replace(/“|”/g, '"')
    .replace(/’/g, "'")
    .replace(/…/g, '...')
    .replace(/€/g, 'EUR');
  const escaped = normalized.replace(/([\\()])/g, '\\$1');
  return Buffer.from(escaped, 'latin1');
}

function pdfText(x: number, y: number, size: number, value: string, bold = false): Buffer {
  return Buffer.concat([
    Buffer.from(`0 0 0 rg BT /F${bold ? 2 : 1} ${size} Tf ${x} ${y} Td (`, 'ascii'),
    pdfEscapeLatin1(value),
    Buffer.from(') Tj ET\n', 'ascii'),
  ]);
}

function pdfTextColor(
  x: number,
  y: number,
  size: number,
  value: string,
  rgb: [number, number, number],
  bold = false,
): Buffer {
  return Buffer.concat([
    Buffer.from(
      `${rgb[0]} ${rgb[1]} ${rgb[2]} rg BT /F${bold ? 2 : 1} ${size} Tf ${x} ${y} Td (`,
      'ascii',
    ),
    pdfEscapeLatin1(value),
    Buffer.from(') Tj ET\n', 'ascii'),
  ]);
}


function pdfFillRect(x: number, y: number, w: number, h: number, rgb: [number, number, number]): Buffer {
  return Buffer.from(
    `${rgb[0]} ${rgb[1]} ${rgb[2]} rg ${x} ${y} ${w} ${h} re f\n`,
    'ascii',
  );
}

function pdfStrokeRect(
  x: number,
  y: number,
  w: number,
  h: number,
  rgb: [number, number, number],
  lineWidth = 0.7,
): Buffer {
  return Buffer.from(
    `${rgb[0]} ${rgb[1]} ${rgb[2]} RG ${lineWidth} w ${x} ${y} ${w} ${h} re S\n`,
    'ascii',
  );
}

function pdfLine(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  rgb: [number, number, number],
  lineWidth = 0.5,
): Buffer {
  return Buffer.from(
    `${rgb[0]} ${rgb[1]} ${rgb[2]} RG ${lineWidth} w ${x1} ${y1} m ${x2} ${y2} l S\n`,
    'ascii',
  );
}

function truncatePdf(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, Math.max(1, max - 3)) + '...';
}

function makePdf(pages: Buffer[], pageW: number, pageH: number): Buffer {
  const objects: Buffer[] = [];
  objects[1] = Buffer.from('<< /Type /Catalog /Pages 2 0 R >>', 'ascii');
  const pageObjectNumbers = pages.map((_, i) => 5 + i * 2);
  objects[2] = Buffer.from(
    `<< /Type /Pages /Count ${pages.length} /Kids [${pageObjectNumbers.map((n) => `${n} 0 R`).join(' ')}] >>`,
    'ascii',
  );
  objects[3] = Buffer.from('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>', 'ascii');
  objects[4] = Buffer.from('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>', 'ascii');

  pages.forEach((stream, i) => {
    const pageNo = 5 + i * 2;
    const contentNo = pageNo + 1;
    objects[pageNo] = Buffer.from(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageW} ${pageH}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${contentNo} 0 R >>`,
      'ascii',
    );
    objects[contentNo] = Buffer.concat([
      Buffer.from(`<< /Length ${stream.length} >>\nstream\n`, 'ascii'),
      stream,
      Buffer.from('endstream', 'ascii'),
    ]);
  });

  const header = Buffer.from('%PDF-1.4\n%âãÏÓ\n', 'latin1');
  const bodyParts: Buffer[] = [header];
  const offsets: number[] = [0];
  let offset = header.length;
  for (let i = 1; i < objects.length; i++) {
    const obj = Buffer.concat([
      Buffer.from(`${i} 0 obj\n`, 'ascii'),
      objects[i]!,
      Buffer.from('\nendobj\n', 'ascii'),
    ]);
    offsets[i] = offset;
    bodyParts.push(obj);
    offset += obj.length;
  }

  const xrefOffset = offset;
  const xrefLines = [
    `xref\n0 ${objects.length}\n`,
    '0000000000 65535 f \n',
    ...offsets.slice(1).map((o) => `${String(o).padStart(10, '0')} 00000 n \n`),
  ];
  const trailer = `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  bodyParts.push(Buffer.from(xrefLines.join('') + trailer, 'ascii'));
  return Buffer.concat(bodyParts);
}

function filtersLabel(filters: PriceExportFilters): string {
  return [
    filters.category ? `Tipo: ${filters.category}` : null,
    filters.supplier ? `Proveedor: ${filters.supplier}` : null,
  ].filter(Boolean).join('   |   ');
}

function employeePriceText(r: PriceExportRow): string[] {
  if (r.soldByUnit) {
    return [`Unidad: ${r.wholeUnitTotal ? formatARS(r.wholeUnitTotal) : '-'}`];
  }
  if (r.saleMode === 'AL_CORTE') {
    return [
      `Kilo: ${r.salePricePerKg ? formatARS(r.salePricePerKg) : '-'}`,
      `Horma digital: ${r.alCorteHormaDigitalKg ? formatARS(r.alCorteHormaDigitalKg) + '/kg' : '-'}`,
      `Horma efectivo: ${r.alCorteHormaCashKg ? formatARS(r.alCorteHormaCashKg) + '/kg' : '-'}`,
      `Caja efectivo: ${r.alCorteCajaCashKg ? formatARS(r.alCorteCajaCashKg) + '/kg' : '-'}`,
      ...(r.wholeUnitTotal ? [`Unidad entera: ${formatARS(r.wholeUnitTotal)}`] : []),
    ];
  }
  return [
    `100 g: ${r.feteado100gKg ? formatARS(r.feteado100gKg) + '/kg' : '-'}`,
    `1/4 kg: ${r.feteadoQuarterKg ? formatARS(r.feteadoQuarterKg) + '/kg' : '-'}`,
    `Pieza digital: ${r.feteadoPieceDigitalKg ? formatARS(r.feteadoPieceDigitalKg) + '/kg' : '-'}`,
    `Pieza efectivo: ${r.feteadoPieceCashKg ? formatARS(r.feteadoPieceCashKg) + '/kg' : '-'}`,
    ...(r.wholeUnitTotal ? [`Unidad entera: ${formatARS(r.wholeUnitTotal)}`] : []),
  ];
}

export function priceRowsToEmployeePdf(
  rows: PriceExportRow[],
  filters: PriceExportFilters = {},
): Buffer {
  const pageW = 842;
  const pageH = 595;
  const margin = 28;
  const verde: [number, number, number] = [0.08, 0.24, 0.17];
  const dorado: [number, number, number] = [0.73, 0.58, 0.20];
  const crema: [number, number, number] = [0.97, 0.95, 0.88];
  const gris: [number, number, number] = [0.45, 0.45, 0.42];
  const borde: [number, number, number] = [0.82, 0.80, 0.72];

  const ordenadas = [...rows].sort((a, b) => {
    const tipo = (a.category ?? 'Sin tipo').localeCompare(b.category ?? 'Sin tipo', 'es');
    if (tipo !== 0) return tipo;
    const subtipo = (a.subtype ?? 'Sin subtipo').localeCompare(b.subtype ?? 'Sin subtipo', 'es');
    if (subtipo !== 0) return subtipo;
    const modoA = a.soldByUnit ? 'UNIDAD' : a.saleMode;
    const modoB = b.soldByUnit ? 'UNIDAD' : b.saleMode;
    const modo = modoA.localeCompare(modoB, 'es');
    if (modo !== 0) return modo;
    return a.name.localeCompare(b.name, 'es');
  });

  const pages: Buffer[] = [];
  let parts: Buffer[] = [];
  let y = 0;
  let pageNumber = 0;

  const startPage = () => {
    pageNumber += 1;
    parts = [];
    parts.push(pdfFillRect(0, pageH - 64, pageW, 64, verde));
    parts.push(pdfTextColor(margin, pageH - 30, 17, 'Don Ginés · Lista de precios de venta', [1, 1, 1], true));
    parts.push(
      pdfTextColor(
        margin,
        pageH - 49,
        8,
        truncatePdf(filtersLabel(filters) || 'Todos los productos', 90),
        [0.94, 0.88, 0.68],
      ),
    );
    y = pageH - 82;
  };

  const flush = () => {
    parts.push(pdfLine(margin, 22, pageW - margin, 22, borde));
    parts.push(pdfText(margin, 10, 6.5, 'Uso interno de sucursales · sólo precios de venta'));
    parts.push(pdfText(pageW - margin - 70, 10, 6.5, `Página ${pageNumber}`));
    pages.push(Buffer.concat(parts));
  };

  const ensure = (needed: number) => {
    if (y - needed < 34) {
      flush();
      startPage();
      return true;
    }
    return false;
  };

  startPage();

  if (ordenadas.length === 0) {
    parts.push(pdfText(margin, y, 10, 'No hay productos para los filtros elegidos.'));
    flush();
    return makePdf(pages, pageW, pageH);
  }

  let lastType = '';
  let lastSubtype = '';
  let lastMode = '';

  for (const r of ordenadas) {
    const type = r.category?.trim() || 'Sin tipo';
    const subtype = r.subtype?.trim() || 'Sin subtipo';
    const mode = r.soldByUnit ? 'UNIDAD' : r.saleMode;

    const groupChanged = type !== lastType || subtype !== lastSubtype;
    const modeChanged = groupChanged || mode !== lastMode;

    const needed = (groupChanged ? 36 : 0) + (modeChanged ? 22 : 0) + 20;
    const newPage = ensure(needed);
    if (newPage) {
      // Repetir los encabezados del grupo al continuar en una página nueva.
      lastType = '';
      lastSubtype = '';
      lastMode = '';
    }

    if (type !== lastType || subtype !== lastSubtype) {
      parts.push(pdfFillRect(margin, y - 15, pageW - margin * 2, 20, crema));
      parts.push(pdfTextColor(margin + 8, y - 9, 10, type.toUpperCase(), verde, true));
      parts.push(pdfTextColor(margin + 210, y - 9, 8.5, subtype, gris, true));
      y -= 28;
      lastType = type;
      lastSubtype = subtype;
      lastMode = '';
    }

    if (mode !== lastMode) {
      if (mode === 'AL_CORTE') {
        const xs = [30, 82, 360, 475, 595, 710];
        const heads = ['PLU/CÓD.', 'PRODUCTO', 'KILO', 'HORMA DIGITAL', 'HORMA EFECTIVO', 'CAJA EFECTIVO'];
        heads.forEach((h, i) => parts.push(pdfTextColor(xs[i]!, y, 7, h, verde, true)));
      } else if (mode === 'FETEABLE') {
        const xs = [30, 82, 360, 475, 595, 710];
        const heads = ['PLU/CÓD.', 'PRODUCTO', '100 G · $/KG', '1/4 KG · $/KG', 'PIEZA DIGITAL', 'PIEZA EFECTIVO'];
        heads.forEach((h, i) => parts.push(pdfTextColor(xs[i]!, y, 7, h, verde, true)));
      } else {
        const xs = [30, 82, 650];
        const heads = ['CÓDIGO', 'PRODUCTO', 'PRECIO UNIDAD'];
        heads.forEach((h, i) => parts.push(pdfTextColor(xs[i]!, y, 7, h, verde, true)));
      }
      y -= 8;
      parts.push(pdfLine(margin, y, pageW - margin, y, dorado, 0.8));
      y -= 12;
      lastMode = mode;
    }

    const ident = r.usesPlu ? r.internalCode : r.barcode ?? r.internalCode;
    parts.push(pdfText(30, y, 7.2, truncatePdf(ident, 12)));
    parts.push(pdfText(82, y, 7.4, truncatePdf(r.name, 43), true));

    if (mode === 'AL_CORTE') {
      const values = [r.salePricePerKg, r.alCorteHormaDigitalKg, r.alCorteHormaCashKg, r.alCorteCajaCashKg];
      const xs = [360, 475, 595, 710];
      values.forEach((v, i) => parts.push(pdfText(xs[i]!, y, 7.2, v ? formatARS(v) : '-')));
    } else if (mode === 'FETEABLE') {
      const values = [r.feteado100gKg, r.feteadoQuarterKg, r.feteadoPieceDigitalKg, r.feteadoPieceCashKg];
      const xs = [360, 475, 595, 710];
      values.forEach((v, i) => parts.push(pdfText(xs[i]!, y, 7.2, v ? formatARS(v) : '-')));
    } else {
      parts.push(pdfText(650, y, 8, r.wholeUnitTotal ? formatARS(r.wholeUnitTotal) : '-', true));
    }

    y -= 17;
    parts.push(pdfLine(margin, y + 5, pageW - margin, y + 5, borde, 0.35));
  }

  flush();
  return makePdf(pages, pageW, pageH);
}

export function priceRowsToManagementPdf(
  rows: PriceExportRow[],
  filters: PriceExportFilters = {},
): Buffer {
  const pageW = 842;
  const pageH = 595;
  const margin = 28;
  const perPage = 24;
  const pages: Buffer[] = [];

  for (let start = 0; start < Math.max(rows.length, 1); start += perPage) {
    const chunk = rows.slice(start, start + perPage);
    const parts: Buffer[] = [];
    let y = pageH - 34;
    parts.push(pdfText(margin, y, 15, 'Don Gines - Precios, costos y marcajes', true));
    y -= 18;
    parts.push(pdfText(margin, y, 8, filtersLabel(filters) || 'Todos los productos'));
    y -= 20;

    const xs = [28, 72, 250, 365, 450, 545, 640, 730];
    const heads = ['ID', 'Producto', 'Proveedor', 'Costo base', 'Venta base', 'Modalidad 1', 'Modalidad 2', 'Marcaje'];
    heads.forEach((h, i) => parts.push(pdfText(xs[i]!, y, 7, h, true)));
    y -= 9;

    for (const r of chunk) {
      const ident = r.usesPlu ? r.internalCode : r.barcode ?? r.internalCode;
      const nombre = r.name.length > 27 ? r.name.slice(0, 26) + '...' : r.name;
      const prov = (r.supplierName ?? '').length > 16 ? (r.supplierName ?? '').slice(0, 15) + '...' : (r.supplierName ?? '');
      const modality1 = r.soldByUnit
        ? null
        : r.saleMode === 'AL_CORTE'
          ? r.alCorteHormaDigitalKg
          : r.feteado100gKg;
      const modality2 = r.soldByUnit
        ? null
        : r.saleMode === 'AL_CORTE'
          ? r.alCorteHormaCashKg
          : r.feteadoPieceCashKg;
      const costo = r.soldByUnit ? r.purchaseUnitCost : r.lastUnitCost;
      const ventaBase = r.soldByUnit ? r.wholeUnitTotal : r.salePricePerKg;
      const vals = [
        ident,
        nombre,
        prov,
        costo ? formatARS(costo) : '-',
        ventaBase ? formatARS(ventaBase) : '-',
        modality1 ? formatARS(modality1) : '-',
        modality2 ? formatARS(modality2) : '-',
        formatRate(r.targetMarginPct),
      ];
      vals.forEach((v, i) => parts.push(pdfText(xs[i]!, y, 7, v)));
      y -= 15;
    }
    pages.push(Buffer.concat(parts));
  }
  return makePdf(pages, pageW, pageH);
}

// Compatibilidad con llamadas/tests anteriores: el PDF genérico es el completo.
export function priceRowsToPdf(rows: PriceExportRow[], filters: PriceExportFilters = {}): Buffer {
  return priceRowsToManagementPdf(rows, filters);
}
