/**
 * La foto real de Barraza, zona por zona, tal como sale del teléfono.
 *
 * Se guarda sin retocar: las erratas son el punto. Lo que este texto permite
 * probar en CI, sin la foto y sin Tesseract, es el defecto que trajo esta
 * factura al proyecto y que ninguna transcripción prolija reproduciría.
 *
 * LA CONTAMINACIÓN ENTRE FILAS. En el recorte de artículos, la línea del
 * renglón 03 sale así:
 *
 *     03    27.00    9.00 | CIL MUZZA BARRAZA X 3 KG      9453.76
 *
 * y ese 9.453,76 es el precio del renglón **30**. La columna de precios está
 * desplazada verticalmente respecto de la de descripciones y el análisis de
 * disposición de Tesseract la reparte sobre la fila de arriba. Un analizador
 * que tome «el último número de la línea» carga el precio del segundo artículo
 * en el primero, que es exactamente lo que mostraba la pantalla.
 *
 * Y hay más que no se ve desde el teléfono:
 *
 *  - **ninguna zona tiene una fila completa.** El recorte de artículos trae
 *    kilos, piezas y descripción; los precios de lista —«10,361.45» y
 *    «9,453.76»— sólo están en la página completa, en un bloque vertical
 *    aparte, junto con dos importes sin separadores («23490760», «23823475»);
 *
 *  - **el importe del renglón 03 no se puede leer.** El papel dice 234.997,69 y
 *    el OCR devuelve 23490760, con dígitos cambiados. El del renglón 30 sí:
 *    23823475 son los 238.234,75 del papel sin los separadores;
 *
 *  - **los números vienen en convención norteamericana**: «10,361.45» y
 *    «473,232.44», al revés que el resto de los proveedores;
 *
 *  - **el detector cuenta tres filas** donde el papel tiene dos, que es de
 *    dónde salía el «3 renglones» de la pantalla;
 *
 *  - **el Subtotal está impreso dos veces** y el «Saldo Ac. $ 532848.64» —un
 *    saldo previo de cuenta corriente, más grande que el neto— convive con los
 *    importes de la tabla.
 */

export const BARRAZA_FOTO_ENCABEZADO = `E                           | A    | FACTURA
|                                                                s=              |
B    -
arraza                 Nro: 0041-00196670                             |
EU—o——— tU]
RA *E                           Lacteos Barraza SA.                             FECHA 08/09/2026                        '
ZA                   CONCORDIA 1344 (1407048) - C.A.B.A.                                                                            |
R                      Tel: 4568-8283 - 4639-1721/5331 (Lin Rotativas)                    CUIT: 30-66138303-4                                         |
>                                                Telefax:0(011) 4568-9547                                             Ing Brutos CM 901-999845-6
IVA RESPONSABLE INSCRIPTO                                   Inicio de Actividades: 09/1993
Señores:                 CAMPANA GISELA VERONICA                                                        __—_—
N             Domicilio:             MITRE 3555                                                 .  A
E                                     SAN MARTIN                              NOS AIRES ( BS.
8/            Telefono:              1168123503                          BUENOS AIRES (                      Remito
a                                     IVA RESPONSABLE INSCRIPTO                                           C.U.I.T.: 27333422919
Sa               Cond.de Venta CONTADO ANTICIPADO                                                                                        HIONICA
ax              Zona            DE LASENASEDP 20080                                         Dom: — 2422 CAMPANA GISELA VE
`;

export const BARRAZA_FOTO_ARTICULOS = `—...— ———

Señores:                 CAMPAÑA GISELA VERONICA
res:                                                                                                         Cod.Cli.: 4987
Domicilio.              MITRE 3555                                                           e
N MARTIN                                               BS. AS
Telefono:                  1168123503                                  PUE             eu

IVA RESPONSABLE INSCRIPTO

Cond.de Venta        CONTADO ANTICIPADO

C.U.LT.: 27333422919

30.00            3.00 | PLAN MUZZA BARRAZA X 10 KG

Zona              DE LASONASEDP 20080                                             Dom: — 2422 CAMPANA GISELA VERONICA
——
Cod
Cantidad” Unidades Descripcion              -—a                                               Importe
EE      E


|
|

Total Kgs.      5700 —                                                          |
— Saldo Ac. $ 532848.64 —                                                                                       Subtotal          473,232.44
Nro.Guia                                                      Original                                                                                         |
Subtotal          473,232.44

AR CA      Comprobante Autorizado                                                               IVA 21.00 % |            99,378.81 |

—.— ——.

Señores:                 CAMPANA GISELA VERONICA                                                        Cod Cli.: 4987
Domicilio:               MITRE 3555                                                    e 00  A
SAN MARTIN                             BUENOS AIRE          -                    Remito
Telefono:                1168123503                                                                                  C.ULT.: 27333422919
IVA RESPONSABLE INSCRIPTO
Cond.de — Y tado uc                               Dom: — 2422 CAMPANA GISELA VERONICA
ona                                    OP                                    E au
Importe
Cod           Cantidad” Unidades Descripcion                                                         ds         .            234 997 69
03                    27.00            9.00 | CIL MUZZA BARRAZA X 3 KG                                   9453.76
30.00            3.00 | PLAN MUZZA BARRAZA X 10 KG

16.00 |        23823475

hotno

ET
CAL

27.00
30.00

_— —«.—zMi

9.00 | CIL MUZZA BARRAZA X 3 KG
3.00 | PLAN MUZZA BARRAZA X 10 KG

16.00
16.00

|

|
|

Total Kgs.       57.00
— Saldo Ac. $ 532848.64 —                                                                                       Subtotal          473,232.44
Nro.Guia                                                           Original                                                                                                 |
E              Comprobante Autorizado                                                              IVA 21.00 %             99.378.81
`;

export const BARRAZA_FOTO_RESUMEN = `_   |

Total Kgs.              57.00
— Saldo Ac. $ 532848.64 —                                                                                   Subtotal         473,232.44
Nro.Guia                                                       Original
Subtotal          473,232.44
A R CA       Comprobante Autorizado                                                                           IVA 21.00 %                99,378.81
20miÉ 60 axcannación CAE 88362071276964                                         Perc IIBB CABA 1.50%             7,098.49

y CONTI DUNE  Vencimiento: 18/09/2026
306613830340010004186362071276964202609184                                  |
É                          TOTAL            579,709.74

`;

export const BARRAZA_FOTO_COMPLETA = `E

Lacteos Barraza S.A.
CONCORDIA 1344 (1407048) - C.A.BA.
Tel: 4568-8283 - 4639-1721/5331 (Lin Rotativas)
Telefax:0(011) 4568-9547
IVA RESPONSABLE INSCRIPTO

Señores:              CAMPAÑA GISELA VERONICA
| Domicitio.             MITRE 3555
|                            SAN MARTIN

Telefono:             1168123503

|                        IVA RESPONSABLE INSCRIPTO

CIL MUZZA BARRAZA X 3 KG
PLAN MUZZA BARRAZA X 10 KG

(9999)
BUENOS AIRES ( BS. AS)

| ConddeVenta — CONTADO ANTI ICIPADO                                                         A            VER          —
|                                                                                                                  'ONICA
Dom: 2422 CAMPANA GISELA VERONICA

T                                   pas

A | FACTURA
J

Nro: 0041-00196670
FECHA 08/09/2026
CUT: 30-66138303-4

Ing Brutos CM 901-999845-6
Mnicio de Actividades: 09/1993

Cod.Cli.: 4987

Remito
C.U.LT.: 27333422919

— 23490760
23823475

10,361.45
9,453.76

|

|

|

|
da

ARCA comen amino

CAE 86362071276964
Fesmmeraconño Vencimiento: 18/09/2026

306613830340010004186362071276964202609184

gs              5700—                                                                                                                                |

— Saldo Ac. $ 532848.64 -                          se                                             Subtotal| — 473,232.44 |
T                                                         riginal

"TE                                                                     :                                                                 Subtotal| — 473,232.44

IVA 21.00 %    99,378.81 |

Perc lIBB CABA 1.50%

TOTAL

`;

/** Las cuatro zonas juntas, como se las pasa el lector al analizador. */
export const BARRAZA_FOTO = {
  completo: BARRAZA_FOTO_COMPLETA,
  encabezado: BARRAZA_FOTO_ENCABEZADO,
  articulos: BARRAZA_FOTO_ARTICULOS,
  resumen: BARRAZA_FOTO_RESUMEN,
};
