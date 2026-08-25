/**
 * La salida cruda de Tesseract sobre Safari, en un iPhone de verdad.
 *
 * Es la misma foto que `errecalde-ocr.ts`, pero leída en el teléfono en vez de
 * en Chromium, y el texto es **distinto**: no peor, distinto. El recorte del pie
 * cae en otro lado, el análisis de disposición parte las filas en otros puntos y
 * los separadores se pierden en renglones que en Chromium salen enteros.
 *
 * Por eso existe este fixture aparte. Está copiado tal cual, sin corregir una
 * letra: si se lo "limpia" deja de servir, porque lo que prueba es justamente la
 * capacidad de leer esta basura.
 *
 * Lo que hay que saber para entenderlo:
 *
 *  - **Los artículos vienen de la lectura por franjas**, así que muchos renglones
 *    aparecen dos veces y no siempre igual. SARDO BLOQUE sale una vez como
 *    "A75kg $13.29525 $6315243" —sin la coma en los tres números— y otra como
 *    "4.75 kg $13.295,25 $63.152,43".
 *  - **El recorte del pie tiene el total bien y el IVA cortado**: $804.398,1, sin
 *    el último dígito. La etiqueta "NetoGravado" está, pero su número no.
 *  - **La página completa tiene el IVA entero** ($804.398,16) **y el neto
 *    deformado**: "63,830.46737", que como importe argentino no es nada, pero
 *    contiene los dígitos de $3.830.467,37.
 *
 * O sea que ninguna de las dos lecturas del pie alcanza sola, y ésa es la razón
 * de ser de la combinación por campos.
 */

export const SAFARI_ARTICULOS = `copIGO   DESCRIPCION                               UNID. CANTIDAD

ART-00873 BARRA DANBO PUNTA DE AGUA                                            8       39.2 kg        $8.090,08 0% 21%       $317.131,24
ART-00177 CAYFAR LATA BATATA                                                         6               6        $9.659,63 0% 21%        $57.957,76
ART-00178 CAYFAR LATA CHOCOLATE                                               ed              4 — $965963 0% 21%  $3863850
ART-81221 CHEDDAR FETEADO LA TONADITA                               »      6             6      $19.871,90     0%     21%      $119.231.41
ART-00228 CREMOSO PUNTA DEL AGUA                                            720 785kg        $6.933,06 0% 21% — $544245,04
ART-00293 GOYA NEGRO MELINCUE                                          Va        17kg — $1268914 0% 21% — $215.71540
ART-00327 JAMON COCIDO NAT BOCATTI                                               3      18.38 kg      $15.07300 0% Z21%       $277.041,69
ART-00347 LEBERWURST CALCHAQUI                                               7 10            10        $1.092,01 0% 21%        $10.920,12
ART-81559 MATAMBRE DE CARNE DYC                                                7 4         9.2 kg        $6.201,65 0% 21%        $57.055,21
ART-60487 MORTADELA PICCOLA MINI CALCHAQUI                      710        10     $2.25873 0% 21%      $22.587,34

ART-00495 MOZZARELLA CILINDRO BARRAZA X3                                       Ma            9 kg         $8.800,83 0% 21%         $79.207,44

ALT. O174 oroniN TCosacui                                                AN    7" Y 1 E A      4 04 41a    nas     Uy      kreEAna aa AP    A

ART-60487 MORTADELA PICCOLA MINI CALCHAQUI                               10           10       $2.258,73 0%

ART-00495 MOZZARELLA CILINDRO BARRAZA X3                                          3            9 kg        $8.800,83      0%
ART-62174 PERNIL TERMOLI                                               40    156.3 kg      $3,847,48    0%    21%
ART-01011 PLANCHA BARRAZA X10KG                                              io         30 kg        $8.112,84     0%      21%
ART-82444 PLANCHA BARRAZA X5KG                                         73        15 kg       $8.210,33 0% 21%  $123.154,88  |
ART-00643 POSTRE CAVIWA X 3,3KG                                          / 3            3 $2293041 0% 21%       $68.791,22 |
ART-00704 REGGIANITO BARRA MELINCUE                                       13       10.6 kg — $12.308,09 0% 21%  $130465,79  |
ART-00710 REGGIANITO SIN PINTAR ENTERO MELINCUE                         13         22kg  $12.597,84 0% 21%  $277.152,45 |
ART-00714 RICOTA AL VACIO SILVIA                                             fa       14.4 kg       $3.170,54 0% 21%       $45 65574 |
ART-00721 ROQUEFORT AZUL LA QUESERA                                       é 8 1921kg  s1045208 0% 21% $20078437 |
ART-80719 ROQUEFORT BAVARIA                           3    79kg —$14.79916 0% 21%  $11691332
ART-00758 SARDO BLOQUE MELINCUE                                L 3 A75kg  $13.29525 0% 21%  $6315243

ART-00722 SARDO DON ALFONSO        . 7 28.9 kg $6.478,76 0% 21%  $187.236,17

ART-00758 SARDO      MELINCUE                        73    4.75 kg   $13.295,25 0% 121%    $63.152,43
BLOQUE

ART-00722 SARDO DON ALFONSO                     7 39   28.9 kg   $6.478,776 0% 21%   $187.236,17

—
ART-01477 TOMATE EN BOTELLA DON FRANCISCO X950GRS    7  32 $1.021,35 0% 21%  $32.683,24`;

export const SAFARI_RESUMEN = `=86349430128613*— EMPEAIA | NetoGravado           ———
Me      Te,              -                 $804.398,1

VENCIMIENTO CA£ 01/09/2026                                     $114.914,02         :
$67.033,18

$4.816.812,73`;

export const SAFARI_COMPLETO = `ERRECALDE

1$TRIBUCIÓN

TU.

CUIT 30717808904

BUENOS AIRES

DISTRIBUCION ERRECALDE 5. A.     A

SARRACHAGA 5752, ISIDRO CASANOVA, 1765,

ORIGINAL

FACTURA-REMITO A
FAR-A 00008-00002647
Fecha 22/08/2026

CUIT 30717808904

188 30-71780890-4

Cond. IVA Resp. Inscripto

Inicio Act. 01/01/2023

—]eeo————

RAZON SOCIAL  GISELA CAMPANA

LOCALIDAD SAN MARTIN

COND, VENTA Cuenta Corriente
Pim

CUIT/DNI 27333422919

PROVINCIA BUENOS AIRES
VENDEDOR Noelia Errecalde

DOMICILIO MITRE 3555, ENTRE
CERRITO Y SA

COND. IVA IVA Responsable Inscripto

CONTACTO gisela.campana gmail.com

CODIGO DESCRIPCION

UNID. CANTIDAD      PRECIO — DTO.     VA
ART-00873 BARRA DANBO PUNTA DE AGUA                                         ña       392 kg        $809008 0% 21%       $317.131,24
ART-00177 CAYFAR LATA BATATA                                     6          6     $9.659,63 0% 21%     $57.957,76
ART-00178 CAYFAR LATA CHOCOLATE                                                 Ka               4        $9,659,63 0% 21%         $38,638,50
ART-01221 CHEDDAR FETEADO LA TONADITA                 » 76       6 $19871,90 0% 21%  $119231,41
ART-00228 CREMOSO PUNTA DEL AGUA                                          720 785kg — $693306 0% 21% — $544.24504
ART-00293 GOYA NEGRO MELINCUE                                       74        17kg — $1268914 0% 21% $215.71540
ART-00327 JAMON COCIDO NAT BOCATTI                                                3      18.38 kg      $15.073,00     0%      21%       $277.041,69 | /
ART-00347 LEBERWURST CALCHAQUI                                    710         10      $1.092,01    0%    21%      $10.920,12
ART-e1559 MATAMBRE DE CARNE DYC                                   E      922kg — $6201,65 0% 21% $57.05521
ART-00487 MORTADELA PICCOLA MINI CALCHAQUI                                  710             10 $225873 0% 21% | $2258734
ART-00495 MOZZARELLA CILINDRO BARRAZA X3                                        (3             9kg — $880083 0% 21% — $7920744
ART-82174 PERNIL TERMOLI                                            0 40 1563kg9 — $3.4748 0% 21% — $601:361,45 |:5)
“ART-01611 PLANCHA BARRAZA XIOKG                       73     30kg— $8.11284 0% 21% — $243385,16
T-024.         BARRAZA X5KG                           73     15kg —— $821033 0% 21% — $12315488 |
TRE CAVIWA X 3,3K6                         7       3 s2209041 0% 21% — se870122 |
RRA MELIN                                     1 3 106kg —$1230809 0% 21% — $130465,79
das       22kg $12597,84 0% 21%  $277.152,45
44 Má4kg — $3.17054 0% 21% — $4565574
4 8 1921kg —$10452,08 0% 21% — $20078437 | 5
13       79kg — $1479916 0% 21% $11691332
A75kg — $13.29525 0% 21% — $63.15243
289kg — $647876 0% 21% $187236,7
2             0% — 21% $3268324
— 63,830.46737
— $804.398,16
—$114.914,02
$67.033,18

Y

73

Ns`;

export const SAFARI_TEXTOS = {
  completo: SAFARI_COMPLETO,
  articulos: SAFARI_ARTICULOS,
  resumen: SAFARI_RESUMEN,
};

/** Lo que dice el papel. Es lo mismo que espera el fixture de Chromium. */
export const SAFARI_ESPERADO = {
  renglones: 23,
  netTotal: '3830467.37',
  ivaTotal: '804398.16',
  percepcionIva: '114914.02',
  percepcionIibb: '67033.18',
  total: '4816812.73',
  kilos: '480.34',
  unidades: '71',
  articulosPorKilo: 16,
  articulosPorUnidad: 7,
};
