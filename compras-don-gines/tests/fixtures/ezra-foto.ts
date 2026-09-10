/**
 * La foto real de Ezra, zona por zona, tal como sale del teléfono.
 *
 * Se guarda sin retocar: las erratas son el punto. Es lo que permite probar en
 * CI, sin la foto y sin Tesseract, exactamente el texto sobre el que se
 * descubrió el corrimiento de columnas.
 *
 * Las tres zonas fallan en lugares distintos, y esa es la situación que hay que
 * poder probar:
 *
 *  - el **recorte de la tabla** trae los cuatro importes de cada fila en su
 *    línea, pero corta la columna de códigos contra el borde izquierdo: el
 *    título sale «digo Cantidad» —«Có» quedó afuera— y con él se van los seis
 *    códigos. Los dos primeros renglones pierden además todos sus números;
 *
 *  - la **página completa** trae los seis códigos y las seis cantidades
 *    enteros y en orden, pero Tesseract le desarma la tabla: cada columna
 *    numérica queda en un bloque vertical aparte, separada de su fila;
 *
 *  - y trae también «LOS CALVOS», que no es el proveedor sino la **marca** del
 *    artículo 10. Es lo que hacía que esta factura se la quedara el analizador
 *    de Los Calvos.
 *
 * El número del comprobante sale distinto en cada zona: «00002-00000185» en el
 * encabezado y «00002-000001435» en la página completa, con un dígito de más.
 */

export const EZRA_FOTO_ENCABEZADO = `'                     r
VINYIN VE SOWOUd        y       Ef
———             y       Ya
»        EA       —  “      no    bea
Y   :                << ar
- AUN                EAN
e    —_              ==  5 Moo, 025 uo      0
/A      á     | A        Comprobante Electrónico
NONE       ON liar   TIA        Original
MANE ES  |        N* 00002-00000185     "
— mm N                    Fecha : 09/09/2026
7 - 4! NO  ñ   YA       C.U.LT.: 30-71951960-8 ¡ig 5.
EOOPERATIVA DE TRABAJO EZRA ALIMENTOS          Inicio Actividades : 01/07/2026
2                                          l.:                                            |
DOCTO           LBIN 2919 - - Buenos Aires (1019                                       |
|  — ——                   Responsable Inscripto                    |
`;

export const EZRA_FOTO_ARTICULOS = `— ta AA

o GISELA CAMPANA                                                                       Código : C998

A                                                                                              Código Vend :
Dir. : ARTIGAS 4920 (7301)
C e.- PUEYRREDON - Buenos Aires (7301)
+ 27-33342291-9       IVA : Responsable Inscripto                 Nro.Orden de Compra :                          A
ondición de Pago : Transf.: MP|
digo Cantidad               Descripción           Marca      P.Unit Desc.% P.U.Desc. Importe
4,240 Cremoso — LA PAULINA                     La Pauli
3,805 PERNIL PATA CELESTE MINI 1284             GALAICO       A—  5.00   SA 00    Ai
7:45 QUESO DE MAQUINA DAMBO.— LA PAULINA            La Paulina             8,612,184 4,000 8.267,69 — 60,726,232
-en JAMON coro E TRADICIONAL                  LOS CALVOS      12.508,959 2,000 12.258,780  49.525,474
,665 JAMON                                        IL MOLISE        9.218,160 3,000 8.941,615 — 68.537,481

3,000 BOLSA GRAN
                                                                                                                                   74,380                                 74,380                  223,140


VA IAN ICI VINITRADICIONAL                           LOS CALVOS         12.508,959 2,000 12.258,780        49.525,474
7,665 JAMON COCIDO MINI                                                    IL MOLISE                9.218,160 3,000  8.941,615        68.537,481
—  3,000 BOLSA GRANDE                                                                                            74,380                       74,380            223,140


PESOS : DOSCIENTOS SESENTA Y SIETE MIL OCHOCIENTOS OCHENTA CON 50/8008-TOTAL :       221.388,84
DESCUENTOS:                 0,00

Y[m] Comprobante Autorizado         SUB-TOTAL: — 221.388,84

[a
me ” 7  5 CAE. ACGARI72ANANAIAN
`;

export const EZRA_FOTO_RESUMEN = `AD   Comprobante Autorizado                         SUB-TOTAL: + 221.388,84
577 an CAE: 86362260109330                             IVA 21,00 46.491.66
TR A FVIOCAE: 19/09/2026                                 IVA 10,50       0,00
Pr                                                 Total 267.880,50
`;

export const EZRA_FOTO_COMPLETA = `Dir. : ARTIGAS 4920 (7301)
Loc.: PUEYRREDON - Buenos Aires (7301)

Código Vend :

CUIT : 27-33342291-9    IVA : Responsable Inscripto

Nro.Orden de Compra :

A             Stop -
y”                                    2:
,            Copy            (y
Peho
Meg   907-   Ud,    e
—-             5 M2 025
Comprobante Electrónico — |
DIS           o                    —                   Original
TRIBUIDORA                     N* 00002-000001435
Fecha : 09/09/2026
C.U.LT.: 30-71951960-8 ¡|g 5                 |
CONDEDI Te >
COOPERATIVA DE TRABAJO EZRA ALIMENTOS        licIo Acuvidados : Ub.
1:
DOCTOR RICARDO BALBIN 2919 - - Buenos Aires (10  gr
Responsable Inscripto                           | Responsable Inscripto
Sr. : GISELA CAMPANA                                                               Código: com

Ci          de Pago : Transf.: MP|

Codigo Cantidad                 Descripción            Marca

P.Unit Desc.% P.U.Desc. Importe |

47           4,240 Cremoso     LA PAULINA                               La Paulina
49           3,985 PERNIL PATA CELESTE MINI 1284                     GALAICO

48            7,345 QUESO DE MAQUINA DAMBO LA PAULINA           La Paulina

10           4,040 JAMON COCIDO MINI TRADICIONAL                    LOS CALVOS
2514         7,665 JAMON COCIDO MINI                                     IL MOLISE
4249       3,000 BOLSA GRANDE

6.723,279
4.040,189
8.612,184
12.508,959
9.218,160
74,380

5,000
5,000
4,000
2,000
3,000

PESOS : DOSCIENTOS SESENTA Y SIETE MIL OCHOCIENTOS OCHENTA CON 50/S10B-TOTAL

6.387,115
3.838,180
8.267,596
12.258,780
8.941,615
74,380

DESCUENTOS:

y CAE: 86362260109330
F.VIOCAE ; 19/09/2026

SUB-TOTAL: — 221.388,84 |

“sjstema de Comprobante Electrónicos Ver: 4:1 "!P'lIwww.Igoffeeciolid.com

IVA 21,00
IVA 10,50

Total

27.081,371
15,295,149
60.726,232
49.525,474
68.537,481
223,140 |

221.388,84
0,00 |

46.491,66
0,00 |

—_267.880,50 |

lA

`;

/** Las cuatro zonas juntas, como se las pasa el lector al analizador. */
export const EZRA_FOTO = {
  completo: EZRA_FOTO_COMPLETA,
  encabezado: EZRA_FOTO_ENCABEZADO,
  articulos: EZRA_FOTO_ARTICULOS,
  resumen: EZRA_FOTO_RESUMEN,
};
