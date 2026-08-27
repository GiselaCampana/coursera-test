import 'server-only';

import JSZip from 'jszip';
import type { AuthUser } from '@/lib/auth/session';
import { getPriceBoard, type PriceBoardRow } from '@/lib/services/pricing';
import { applyRounding } from '@/lib/domain/pricing';
import { formatARS, formatRate, toDecimal } from '@/lib/money';
import { formatDateAr } from '@/lib/datetime';

export interface PriceExportFilters {
  category?: string | null;
  supplier?: string | null;
}

export interface PriceExportRow extends PriceBoardRow {
  salePricePerKg: string | null;
  salePricePerKgCash: string | null;
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
    .map((r) => {
      const salePricePerKg = r.approvedPricePerKg ?? r.suggestedPricePerKg;
      const salePricePerKgCash = salePricePerKg
        ? applyRounding(
            toDecimal(salePricePerKg).times(toDecimal(1).minus(toDecimal(r.cashDiscountPct))),
            r.roundingRule,
          ).toFixed(2)
        : null;
      return { ...r, salePricePerKg, salePricePerKgCash };
    });
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

export async function priceRowsToXlsx(rows: PriceExportRow[]): Promise<Buffer> {
  const headers = [
    'PLU',
    'Producto',
    'Tipo',
    'Proveedor',
    'Modo de venta',
    'Unidad de compra',
    'Kg por unidad comprada',
    'Costo de compra',
    'Costo por kg',
    'Marcaje',
    'Precio venta por kg',
    'Precio efectivo por kg',
    'Precio aprobado por kg',
    'Fecha último costo',
  ];

  const data: Array<Array<string | number | null>> = [
    headers,
    ...rows.map((r) => [
      r.internalCode,
      r.name,
      r.category ?? '',
      r.supplierName ?? '',
      r.saleMode === 'AL_CORTE' ? 'Al corte' : 'Feteable',
      r.purchaseUnit === 'UNIT' ? 'Unidad' : 'Kg',
      r.purchaseUnitWeightKg ? Number(r.purchaseUnitWeightKg) : null,
      r.purchaseUnitCost ? Number(r.purchaseUnitCost) : null,
      r.lastUnitCost ? Number(r.lastUnitCost) : null,
      Number(r.targetMarginPct),
      r.salePricePerKg ? Number(r.salePricePerKg) : null,
      r.salePricePerKgCash ? Number(r.salePricePerKgCash) : null,
      r.approvedPricePerKg ? Number(r.approvedPricePerKg) : null,
      r.lastCostDate ? formatDateAr(r.lastCostDate) : '',
    ]),
  ];

  const rowsXml = data
    .map((row, ri) => {
      const cells = row
        .map((value, ci) => {
          const ref = `${col(ci + 1)}${ri + 1}`;
          const isMoney = ri > 0 && [8, 9, 11, 12, 13].includes(ci + 1);
          const isPct = ri > 0 && ci + 1 === 10;
          return xlsxCell(ref, value, ri === 0 ? 1 : isMoney ? 2 : isPct ? 3 : undefined);
        })
        .join('');
      return `<row r="${ri + 1}">${cells}</row>`;
    })
    .join('');

  const worksheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetViews>
    <sheetView workbookViewId="0">
      <pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>
    </sheetView>
  </sheetViews>
  <cols>
    <col min="1" max="1" width="12" customWidth="1"/>
    <col min="2" max="2" width="34" customWidth="1"/>
    <col min="3" max="6" width="20" customWidth="1"/>
    <col min="7" max="14" width="18" customWidth="1"/>
  </cols>
  <sheetViews>\n    <sheetView workbookViewId="0">\n      <pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>\n    </sheetView>\n  </sheetViews>\n  <sheetData>${rowsXml}</sheetData>\n  <autoFilter ref="A1:N${data.length}"/>
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

function pdfText(x: number, y: number, size: number, text: string, bold = false): Buffer {
  return Buffer.concat([
    Buffer.from(`BT /F${bold ? 2 : 1} ${size} Tf ${x} ${y} Td (`, 'ascii'),
    pdfEscapeLatin1(text),
    Buffer.from(') Tj ET\n', 'ascii'),
  ]);
}

export function priceRowsToPdf(
  rows: PriceExportRow[],
  filters: PriceExportFilters = {},
): Buffer {
  const pageW = 842;
  const pageH = 595;
  const margin = 32;
  const lineH = 15;
  const bodySize = 8;
  const perPage = 30;
  const pages: Buffer[] = [];

  for (let start = 0; start < Math.max(rows.length, 1); start += perPage) {
    const chunk = rows.slice(start, start + perPage);
    const parts: Buffer[] = [];
    let y = pageH - 36;

    parts.push(pdfText(margin, y, 16, 'Don Gines - Lista de precios y costos', true));
    y -= 20;
    const filtros = [
      filters.category ? `Tipo: ${filters.category}` : null,
      filters.supplier ? `Proveedor: ${filters.supplier}` : null,
    ].filter(Boolean).join('   |   ');
    if (filtros) {
      parts.push(pdfText(margin, y, 9, filtros));
      y -= 18;
    }

    const xs = [32, 76, 260, 415, 505, 595, 690];
    const heads = ['PLU', 'Producto', 'Proveedor', 'Costo/kg', 'Venta/kg', 'Efectivo/kg', 'Marcaje'];
    heads.forEach((h, i) => parts.push(pdfText(xs[i]!, y, 8, h, true)));
    y -= 8;
    parts.push(Buffer.from(`${margin} ${y} m ${pageW - margin} ${y} l S\n`, 'ascii'));
    y -= 13;

    if (chunk.length === 0) {
      parts.push(pdfText(margin, y, 10, 'No hay productos para los filtros elegidos.'));
    }

    for (const r of chunk) {
      const nombre = r.name.length > 29 ? r.name.slice(0, 28) + '…' : r.name;
      const prov = (r.supplierName ?? '').length > 21
        ? (r.supplierName ?? '').slice(0, 20) + '…'
        : (r.supplierName ?? '');
      const vals = [
        r.internalCode,
        nombre,
        prov,
        r.lastUnitCost ? formatARS(r.lastUnitCost) : '-',
        r.salePricePerKg ? formatARS(r.salePricePerKg) : '-',
        r.salePricePerKgCash ? formatARS(r.salePricePerKgCash) : '-',
        formatRate(r.targetMarginPct),
      ];
      vals.forEach((v, i) => parts.push(pdfText(xs[i]!, y, bodySize, v)));
      y -= lineH;
    }

    pages.push(Buffer.concat(parts));
  }

  // PDF object numbers: 1 catalog, 2 pages, 3 font regular, 4 font bold,
  // then for each page: page object, content object.
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
