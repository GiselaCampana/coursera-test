
/**
 * La foto real de Mabelherdi, zona por zona, tal como sale del teléfono.
 *
 * `MABELHERDI_COMPLETO`, más arriba, es una sola pasada de OCR sobre la página
 * entera. Esto es lo otro: **las cuatro zonas de una lectura de verdad**, con
 * el recorte de la tabla y el del pie leídos por separado, que es como trabaja
 * el lector en el iPhone.
 *
 * Hace falta guardarlo porque las dos zonas fallan en lugares distintos, y esa
 * es justamente la situación que hay que poder probar en CI:
 *
 *  - el **recorte de la tabla** trae los nueve renglones y suman exactos los
 *    32.998,85 del papel, pero de esa pasada no sale el pie: ni neto, ni IVA,
 *    ni percepción;
 *  - la **página completa** trae el pie entero, y el detalle con dos renglones
 *    rotos: «$2068612» donde el papel dice 2.066,12, y «$212545» por 2.125,15.
 *
 * Elegir una de las dos lecturas enteras obliga a tirar la mitad buena de la
 * que pierde. Con la página completa el comprobante se cargaba con $51.619,15
 * de mercadería donde el papel dice $32.998,85.
 *
 * Se guarda sin retocar. Las erratas son el punto.
 */
export const MABELHERDI_FOTO_COMPLETA = `MABELHERDI S.A.                                              FACTURA

Jose Hemandez 4453                                           Comprobante:                   0007-00248491
CP: 1653                  Fecha de Emislon:                        20/08/2026
Tot 4800648 Coetdor 24m                                                                                CUIT                            30-67804306-7
Ingresos Brutos:                       902-114553-0
NA                     Inscripto _(-onginal_]__ Inicio de Actividad:                          02/03/1994
03231 CANPANA VERONICA GISELA        Zona: 613                  Fecha Entrega: 22/08/2026
AV SAN MARTIN 5891                  Vend: AGUSTIN        Condicion IVA: - Inscripto
AGRONOMIA ()                               Repart 7]                  Telefono            1158523979
ota NT Flambrerla            CUIT:           27333422919
LO ME           POR WHATSAPP 1121                              Horario            9:30 a 20:30
Codigo Art. Descripcion                                                                Desc                 Cantidad             Sugerido Pr Unit           Importe
300052821       PEP COMUN 120GRX21                          0.00%         1.00 Unidad $3500 1 $206812 $2066.12
300052756       PEP RUEDITAS 120GRX21                         0.00%          1.00 Unidad $3500  $206612 $2068612
300063097 TWISTOS MINIT QUESO 95GX30X1                0.00%          1.00 Unidad $3600  $212545 $212545
300060664 CHEETOS QUESO 856X24X1                      0.00%          2.00 Unidades —$3500  $206612 $413224
300065284 LAYS PROVOLETA 776X25X1                     0.00%          1.00 Unidad $3500 1 $206612 2066.12
300060192 DORITOS QUESO 776X26                             0.00%           2.00 Unidades — $ 3500 — $206612 $ 4132.24
300065287       LAYS CLASICAS 1346X18X1                      0.00%         3.00 Unidades $5500  $324675 974025
300064630 PEHUA PAPA ACANA 906X22 RM                   0.00%           2.00 Unidades $2500  $147580 $ 2951.60
300059545 DORITOS QUESO 40GX70X1                      0.00%         3.00 Unidades $2100 $123067 $3719.01

Comentario: B2B.AR.1002097479

ONTROLE SU PEDIDO AL RECIBIRLO, DESPUES NO SE RECONOCERA NIN      RECLAMO"* GRACIAS!!!

Neto 21.00% $32998.85 IVA 21.00%        $ 6929.76 Percepcion IIBB                $577.48
Total:                                $ 40506.09
CAE N': 6349182460702    Vto CAE: 30/08/2026
Comprobante Autorizado
Esta admi

por los dalos

federal no
ingresados en el detalle de la operación

Hoja 1 de 1

`;

export const MABELHERDI_FOTO_ENCABEZADO = ` e! COST SOI
SAA  Cn MT
—— PRE NN
.        e MED      5 DA
E. 511700 TA
ue TR     AIN A a
BA 7 ATAR
—    ¿12 MANDO
ATA TA  O
iZ
                                  o E
Meer...
DN AAA A
—.   A Ped 4
7 € AA EPA
EA
MABELHERDI S.A.          A                    FACTURA                               Z
a A   Jose Hemandez 4453                                        Comprobante:                 0007-00348491
E                                         CP: 1653                   Fecha de Emision:                        20/08/2026
Tot: 4838-3848 Contestador 24 ha                                                                   CUIT:                      30-87804306-7
Ingresos Brutos:                        902-114553-0
IVA Responsable Inscripto (— Origina¡ ] _ Inicio de Actividad:                          02/03/1994
93231  CAMPANA VERONICA GISELA    Zona: 613        Fecha Entrega: 22/08/2026
AV SAN MARTIN 5891                  Vend: AGUSTIN        Condicion IVA: — Inscripto
AGRONOMIA ()                                  Repart                            Telefono:            1158523979
CUIT:          27333422919
ENI O MENSAJES DAR WHATGSADD 44 7nEN AGA                Hararia         0230 a 70 30
`;

export const MABELHERDI_FOTO_ARTICULOS = `L                                                                      AA? ME         | A IA A

Codigo Art. Descripcion      NTE     Desc    Cantidad Sugerido PrUnit + Importe
300052821 — PEPCOMUN 120GRX21 000% 1.00 Unidad 1$3500 $206.12 $2066.12
300052756        PEP RUEDITAS 120GRX21                            0.00%           1.00 Unidad       $3500 $206612 $2066.12
300063097        TWISTOS MINIT QUESO 956X30X1                 0.00%           1.00 Unidad       $ 3600       $2125.15  $2125.15
300060664         CHEETOS QUESO 856X24X1                            0.00%             200 Unidades $ 3500  $206812 $4132.24
300065284       LAYS PROVOLETA 77GX25X1                      0.00%           1.00 Unidad       $3500 $2066812 $2066.12
300060192         DORITOS QUESO 77GX26                                0.00%             2.00 Unidades $ 3500  $2068.12 $4132.24
300065287        LAYS CLASICAS 1346X18X1                         0.00%           3.00 Unidades $5500 5324675 $974025
300064630        PEHUA PAPA ACANA 90GX22 RM                     0.00%            2.00 Unidades $2500 $147580 $2951.60

300059545       DORITOS QUESO 40GX70X1                        0.00%           3.00 unidades $2100      $123967 $ 3719.01


a


Comentario: B2B.AR.1002097479
“CONTROLE SU PEDIDO AL RECIBIRLO, DESPUES NO SE RECONOCERA NINGUN RECLAMO"* GRACIAS!!!

Neto 21.00%       $ 32998.85 IVA 21.00%        $ 6929.76 Percepcion IIBB                 $ 577.48
Total:                               $ 40506.09

CAE N9- ARIU01A7460702          Vto CAE: 30/08/2026
`;

export const MABELHERDI_FOTO_RESUMEN = `Total:                               $ 40506.09

CAE N": 86349182460702               Vto CAE: 30/08/2026
C      "” Comprobante Autorizado
A R     A       Esta administracion federal no se responsabiliza por los datos
ae        ingresados en el detalle de la operación

Hoja 1 de 1

`;

/** Las filas que el detector contó sobre la imagen: diez donde hay nueve. */
export const MABELHERDI_FOTO_FILAS_DETECTADAS = 10;
