/**
 * Texto OCR real de la factura de Distribución Errecalde.
 *
 * No está escrito a mano ni recreado: es exactamente lo que devolvió Tesseract
 * sobre la foto que se sacó con el iPhone, zona por zona, corriendo el mismo
 * preprocesamiento y las mismas franjas que corren en el teléfono. Por eso trae
 * la basura que trae —"ART-60457" por ART-00487, "$9.65963" sin la coma, los
 * "7", "»" y "Za" que salen de las tildes manuscritas sobre la columna Unid., y
 * dos renglones repetidos porque las franjas se solapan—: si el fixture
 * estuviera limpio, las pruebas dirían que el analizador anda y en el teléfono
 * seguiría sin andar.
 *
 * La factura de papel dice:
 *   Factura-Remito A 00008-00002647, 22/08/2026, 23 renglones,
 *   Neto gravado 3.830.467,37 · IVA 804.398,16 ·
 *   Percepción IVA RG 5329 114.914,02 · Percepción IIBB 67.033,18 ·
 *   Total 4.816.812,73
 */

export const ERRECALDE_COMPLETO = `CuIT 30717808904

BUENOS AIRES

3          DISTRIBUCION ERRECALDE 5. A.      A

SARRACHAGA 5752, ISIDRO CASANOVA, 1765,

¿OD 000

E

ORIGINAL

FACTURA-REMITO A
FAR-A 00008-00002647

Fecha 22/08/2026
CUIT 30717808904

1BB 30-71780890-4
Cond. IVA Resp. Inscripto
Inicio Act. 01/01/2023

[-rzovsoca asa CAMPANA

LOCALIDAD SAN MARTIN

COND, VENTA Cuenta Corriente
bs

CUIT/DNI 27333422919

PROVINCIA BUENOS AIRES
VENDEDOR Noelia Errecalde

DOMICILIO MITRE 3555, ENTRE
CERRITO Y SA

COND. IVA IVA Responsable Inscripto

CONTACTO gisela.campanaEgmail.com

CODIGO DESCRIPCION

UNID. CANTIDAD     PRECIO — DTO:    VA      UBTOTA
ART-00873 BARRA DANBO PUNTA DE AGUA                                        A       39.2 kg        $8.090,08 0% 21%       $317.131,24
ART-00177 CAYFAR LATA BATATA                          6       6 $965963 0% 21% — $57957,76
ART-00178 CAYFAR LATA CHOCOLATE                     ha      4 $965963 0% 21% — $3863850
ART-01221 CHEDDAR FETEADO LA TONADITA                     D./6         6 $19871,90 0% 21% | $11923141
ART-00228 CREMOSO PUNTA DEL AGUA                           720 785kg — $693306 0% 21% — $544.24504
ART-00293 GOYA NEGRO MELINCUE                              pa      17kg — $1268914 0% 21% $21571540
ART-00527 JAMON COCIDO NAT BOCATTI                          2 3 1838kg —$1507300 0% 21%  $277.041,69 |/
ART-00347 LEBERWURST CALCHAQUI                      710      10    $1.092,01 0% 21%    $10.920,12
ART-01559: MATAMBRE DE CARNE DVC                                     74  92kg9 — $620165 0% 21% $57055,21
ART-60487 IMORTADELA PICCOLA MINI CALCHAQUI                                 7 10            10        $2.258,73     0%     21%        $22.587,34
ART-00495 MOZZARELLA CILINDRO BARRAZA X3               fe:     9kg — $880083 0% 21% — $79207,44
ART-02174 PERNIL TERMOLI                                    0 40 1563kg — $3:84748 0% 21% — $601.36145 |:5) €
 ART-01011 PLANCHA BARRAZA XI0KG                       A     30kg — $8:11284 0% 21% — $243385,16
T-82444 PLANCHA BARRAZA                            73     15kg —- $821033 0% 21% — $123.15488 |
TRE CAVIWA                                 3 $2293041 0% 21%   $68791,22 |
106kg — $1230809 0% 21% — $130465,79
22kg 1259784 0% 21% $277152,45
Mákg — $3.17054 0% 21% — $45.655,74
1921kg — $10452,08 0% 21% — $20078437 | 4%
79kg — $1479916 0% 21% — $11691332
3 A75kg  $1329525 0% 21%  $6315243
289kg 4647876 0% 21% $187236,7 | 25,
:                0% 21% — $3268324`;

export const ERRECALDE_ENCABEZADO = `[E
pa     o       —    ro     —_    —    —     ———    »    NN
.-—    —.—    ..  — d. ——  —    m_ >         CAD    r  — — ——— imtiim e de   PEE MEU               E , ——
DE
N
A      A      ORIGINAL                       ACTUR                                    |
-3        DISTRIBUCION ERRECALDE 5. A.       :                              F         A-REMITO A
3,            cuIT 30717808904                      o                                    FAR-A 00008-00002647
ERRECALDE    SARRACHAGA 5752, ISIDRO CASANOVA, 1765,                                                         Fecha 22/08/2026                          ;        Y
TRISUCIÓN — BUENOSAIES                                                                                            CUIT 30717808904                     ¡         7N
NB 30-71780890-4                                  2
_—                                                                                        Cond. IVA Resp. Inscripto                            >
Inicio Act. 01/01/2023                            ZN A L
Da
7 Pat
D          o»
RAZON SOCIAL GISELA CAMPANA                 CUIT/DNI 27333422919               DOMICILIO MITRE 3555, ENTRE                         A ]
CERRITO Y SA
LOCALIDAD SAN MARTIN                           PROVINCIA BUENOS AIRES               COND, IVA IVA Responsable Inscripto                        Í   ps
COND. VENTA Cuenta Corriente                   VENDEDOR Noelia Errecalde            CONTACTO gisela.campana gmail.com                    ,    ;    ,`;

export const ERRECALDE_ARTICULOS = `cobIGO  DESCRIPCION                           UNID, CANTIDAD    PRECIO  DTO    /

ART-00873 BARRA DANBO PUNTA DE AGUA                                          7 8       39.2 kg        $8.090,08 0% 21%  $317.131,24
ART-00177 CAYFAR LATA BATATA                                                          6               6        $9.65963 0% 21%         $57.957,76
ART-00178 CAYFAR LATA CHOCOLATE                                                e 4               4  $965963 0% 21%  $3863850
ART-01221 CHEDDAR FETEADO LA TONADITA                                    »       6               6       $19.871,90 0% 21%       $119.231,41
ART-00228 CREMOSO PUNTA DEL AGUA                                               720 785kg  $693306 0% 21% — $544245,04
ART-00293 GOYA NEGRO MELINCUE                                              pa         17kg — $12.66914 0% 21% — $215.71540
ART-00327 JAMON COCIDO NAT BOCATTI                                           9 3 1838kg —$15.07300 0% 21%  $277.041,69 | j

ART-00347 LEBERWURST CALCHAQUI                     7 10     10   $1.092,01  0%  21%    $10.920,12

PEA
ART-00327 JAMON COCIDO NAT BOCATTI                                           3      18.38 kg      $15.073,00 0% 221%      $277.041,69

ART-00347 LEBERWURST CALCHAQUI                                   10        10     $1.092,01 0% 21%      $10.920,12
ART-01559 MATAMBRE DE CARNE DYC                                                  4         9.2 kg        $6.,201,65 0% 21%        $57.055 21
ART-60487 IMORTADELA PICCOLA MINI CALCHAQUI                            10          10      $2.258,73 0% 21%       $22.587,34
ART-00495 MOZZARELLA CILINDRO BARRAZA X3                                    A           9 kg        $8.800,83 0% 21%                   44
ART-02174 PERNIL TERMOLI                                   v 40 1563kg     $3.84748 0% 21%  $601.361,45 9
ART-01011 PLANCHA BARRAZA X10KG                                             7 3         30 kg        $8.112,84 0% 21%  $243385,16
ART-82444 PLANCHA BARRAZA X5KG                                          73        15 kg       $8.210,33 0% 21% — $123.154,88  |
ART-80643 POSTRE CAVIWA X 3,3KG                                   Za          3 $2293041 0% 21%      $68.791,22 |

20” MAaAAá emi á hire mAf:A Ari IAiMIILIP                                   Y FELY      “Ar loma     “4 55nOo NA    no     4 n/      AA ALC A 1

ART-00643 POSTRE CAVIWA X 3,3KG                                                      a               3       $22.930,41      0%      21%

ART-00704 REGGIANITO BARRA MELINCUE                                         123       10.6kg — $12.30809 0% 21%

ART-00718 REGGIANITO SIN PINTAR ENTERO MELINCUE                           AE)          22 kg       $12.597,84 0% 21%

ART-00714 RICOTA AL VACIO SILVIA                                          ía      14.4 kg      $3.170,54 0% 21%       $45.655,74 |
ART-00721 ROQUEFORT AZUL LA QUESERA                               4 8 1921kg $10.452,08 0% 21%     $200.784,37 |
ART-80719 ROQUEFORT BAVARIA                                             3       7.9 kg      $14.79916 0% 21%      $116.913,32
ART-00758 SARDO BLOQUE MELINCUE                                          7 3      4.75 kg      $13.295,25 0% 721%       $63.152,43
ART-00722 SARDO DON ALFONSO                                                :      28.9 kg       $6.478,76 0% 21%  $187.236,17

ART-91477 TOMATE EN BOTELLA DON FRANCISCO X950GRS            y 3       32    $1.021,35 0% 21%    $32.683,24


CobIGO   DESCRIPCION                                        UNID, CANTIDAD      PRECIO DTO     VA

ART-00873 BARRA DANBO PUNTA DE AGUA                                          / 8       39,2 kg        $8.090,08 0% 21%  $317.131,24
ART-00177 CAYFAR LATA BATATA                                                         6               6        $9.659,63 0% 21%        $57.957,76
ART-00178 CAYFAR LATA CHOCOLATE                                                    1 4                4 $96596% 0% 21%         $38.638,50
ART-01221 CHEDDAR FETEADO LA TONADITA                                    De /6               6 $19871,90 0% 21%       $119.231,41
ART-00228 CREMOSO PUNTA DEL AGUA                                              7/20 785kg        $6.933,06 0% 21%       $544.245,04

ART-D0902 F/AVA MEM aAr: sam ur                                     77 A AER       tc       A MPELAE E    e     AL     ee e EA

ART-00228 CREMOSO PUNTA DEL AGUA                   7/20 785kg  $693306 0% 21% — $54424504

ART-00293 GOYA NEGRO MELINCUE                                           6        17kg — $1268914 0% 21% — $215715,40
ART-00327 JAMON COCIDO NAT BOCATTI                                             3 1838kg — $1507300 0% 21%  $277.041,69
ART-00347 LEBERWURST CALCHAQUI                                             7 10            10       $1.092,01     0%     21%        $10.920,12
ART-01559 MATAMBRE DE CARNE DYC                                            7 4        9.2 kg        $6.201,65 0% 21%        $57.055,21
ART-60487 MORTADELA PICCOLA MINI CALCHAQUI                               410            10       $2.258,73     0%     21%        $22.587,34

ART-00495 MOZZARELLA CILINDRO BARRAZA X3                                  3           9 kg        $8.800,83     0%      21%        $79.207,44


ART-80495 MOZZARELLA CILINDRO BARRAZA X3                             3        9 kg      $8.800,83 0% 21%      $79.207 44

ART-02174 PERNIL TERMOLI                                                           40 156.3 kg       $3.84748 0%     21%       $601.361,45

ART-01011 PLANCHA BARRAZA X10KG                                               >          30 kg        $8.112,84 0%      21%       $243.385,16

ART-02444 PLANCHA BARRAZA X5KG                                              3         15 kg        $8.210,33     0%     21%      $123.154,88  |
ART-00643 POSTRE CAVIWA X 3,3KG                                                73              3      $22.930,41     0%     21%        $68.791,22 |
ART-00704 REGGIANITO BARRA MELINCUE                                          1E3       10,6 kg       $12.308,09 0%      21%       $130.465,79  |
ART-800710 REGGIANITO SIN PINTAR ENTERO MELINCUE                           A          22 kg       $12.597,84 0%      21%       $277.152,45  |

E                       1

ART-00/10 REGGIANITO SIN PINTAR ENTERO MELINCUE                        AE)         Ec KO      HI1C.I7/,04     U70     ¿!0      pl. 1IC,43  |

ART-00714 RICOTA AL VACIO SILVIA                                            ña      14.4 kg       $3.170,54 0% 21%       $45.655 7a |
ART-00721 ROQUEFORT AZUL LA QUESERA                               f 8    19.21 kg     $10.452,08 0%    21%     $200.784,37 |
ART-00719 ROQUEFORT BAVARIA                                     Ne3      7.9 kg     $14.73916 0% 21%     $116.913,32 |
ART-00758 SARDO BLOQUE MELINCUE                                          3      4.75 kg      $13.295,25 0% 21%       $63.152,43
ART-00722 SARDO DON ALFONSO                                                ea]      28.9 kg       $6.478,776 0% 21%  $187.236,17

,
ART-01477 TOMATE EN BOTELLA DON FRANCISCO X950GRS                          y 32               32         $1.021,35 0% 21%          $32.683,24`;

export const ERRECALDE_RESUMEN = `| ART-00722 SARDO                                                                          :
DON ALFONSO                                                       7 9        28.9 kg        $6.478,76 0%      21%       $187.236,17

ART-01477                                                                                              7
TOMATE EN BOTELLA DON FRANCISCO X950GRS                   4 32           32       $1.021,35 0%     21%       $32.683,24

$3.830.467,37
$804.398,16
$114.914,02
$67.033,18

$4.816.812,73`;

export const ERRECALDE_TEXTOS = {
  completo: ERRECALDE_COMPLETO,
  encabezado: ERRECALDE_ENCABEZADO,
  articulos: ERRECALDE_ARTICULOS,
  resumen: ERRECALDE_RESUMEN,
};

/** Lo que dice el papel, para contrastar. */
export const ERRECALDE_ESPERADO = {
  fullNumber: '00008-00002647',
  issueDate: '2026-08-22',
  renglones: 23,
  netTotal: '3830467.37',
  ivaTotal: '804398.16',
  percepcionIva: '114914.02',
  percepcionIibb: '67033.18',
  total: '4816812.73',
};

/**
 * Los 23 artículos tal como están impresos.
 *
 * Las cantidades con "kg" son las que la factura pesa; las otras se venden por
 * unidad y repiten el número de la columna Unid.
 */
export const ERRECALDE_ARTICULOS_IMPRESOS = [
  { codigo: 'ART-00873', descripcion: 'BARRA DANBO PUNTA DE AGUA', unidades: 8, cantidad: '39.2', kilos: true, precio: '8090.08', subtotal: '317131.24' },
  { codigo: 'ART-00177', descripcion: 'CAYFAR LATA BATATA', unidades: 6, cantidad: '6', kilos: false, precio: '9659.63', subtotal: '57957.76' },
  { codigo: 'ART-00178', descripcion: 'CAYFAR LATA CHOCOLATE', unidades: 4, cantidad: '4', kilos: false, precio: '9659.63', subtotal: '38638.50' },
  { codigo: 'ART-01221', descripcion: 'CHEDDAR FETEADO LA TONADITA', unidades: 6, cantidad: '6', kilos: false, precio: '19871.90', subtotal: '119231.41' },
  { codigo: 'ART-00228', descripcion: 'CREMOSO PUNTA DEL AGUA', unidades: 20, cantidad: '78.5', kilos: true, precio: '6933.06', subtotal: '544245.04' },
  { codigo: 'ART-00293', descripcion: 'GOYA NEGRO MELINCUE', unidades: 4, cantidad: '17', kilos: true, precio: '12689.14', subtotal: '215715.40' },
  { codigo: 'ART-00327', descripcion: 'JAMON COCIDO NAT BOCATTI', unidades: 3, cantidad: '18.38', kilos: true, precio: '15073.00', subtotal: '277041.69' },
  { codigo: 'ART-00347', descripcion: 'LEBERWURST CALCHAQUI', unidades: 10, cantidad: '10', kilos: false, precio: '1092.01', subtotal: '10920.12' },
  { codigo: 'ART-01559', descripcion: 'MATAMBRE DE CARNE DYC', unidades: 4, cantidad: '9.2', kilos: true, precio: '6201.65', subtotal: '57055.21' },
  { codigo: 'ART-00487', descripcion: 'MORTADELA PICCOLA MINI CALCHAQUI', unidades: 10, cantidad: '10', kilos: false, precio: '2258.73', subtotal: '22587.34' },
  { codigo: 'ART-00495', descripcion: 'MOZZARELLA CILINDRO BARRAZA X3', unidades: 3, cantidad: '9', kilos: true, precio: '8800.83', subtotal: '79207.44' },
  { codigo: 'ART-02174', descripcion: 'PERNIL TERMOLI', unidades: 40, cantidad: '156.3', kilos: true, precio: '3847.48', subtotal: '601361.45' },
  { codigo: 'ART-01011', descripcion: 'PLANCHA BARRAZA X10KG', unidades: 3, cantidad: '30', kilos: true, precio: '8112.84', subtotal: '243385.16' },
  { codigo: 'ART-02444', descripcion: 'PLANCHA BARRAZA X5KG', unidades: 3, cantidad: '15', kilos: true, precio: '8210.33', subtotal: '123154.88' },
  { codigo: 'ART-00643', descripcion: 'POSTRE CAVIWA X 3,3KG', unidades: 3, cantidad: '3', kilos: false, precio: '22930.41', subtotal: '68791.22' },
  { codigo: 'ART-00704', descripcion: 'REGGIANITO BARRA MELINCUE', unidades: 3, cantidad: '10.6', kilos: true, precio: '12308.09', subtotal: '130465.79' },
  { codigo: 'ART-00710', descripcion: 'REGGIANITO SIN PINTAR ENTERO MELINCUE', unidades: 3, cantidad: '22', kilos: true, precio: '12597.84', subtotal: '277152.45' },
  { codigo: 'ART-00714', descripcion: 'RICOTA AL VACIO SILVIA', unidades: 4, cantidad: '14.4', kilos: true, precio: '3170.54', subtotal: '45655.74' },
  { codigo: 'ART-00721', descripcion: 'ROQUEFORT AZUL LA QUESERA', unidades: 8, cantidad: '19.21', kilos: true, precio: '10452.08', subtotal: '200784.37' },
  { codigo: 'ART-00719', descripcion: 'ROQUEFORT BAVARIA', unidades: 3, cantidad: '7.9', kilos: true, precio: '14799.16', subtotal: '116913.32' },
  { codigo: 'ART-00758', descripcion: 'SARDO BLOQUE MELINCUE', unidades: 3, cantidad: '4.75', kilos: true, precio: '13295.25', subtotal: '63152.43' },
  { codigo: 'ART-00722', descripcion: 'SARDO DON ALFONSO', unidades: 9, cantidad: '28.9', kilos: true, precio: '6478.76', subtotal: '187236.17' },
  { codigo: 'ART-01477', descripcion: 'TOMATE EN BOTELLA DON FRANCISCO X950GRS', unidades: 32, cantidad: '32', kilos: false, precio: '1021.35', subtotal: '32683.24' },
];
