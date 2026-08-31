/**
 * Lectura real de la factura de MABELHERDI S.A. 0007-00348491.
 *
 * Es la salida literal de Tesseract sobre la foto que se sacó con el teléfono
 * —`tests/fixtures/imagenes/mabelherdi-0007-00348491.jpg`—, sin retocar. Se
 * guarda tal cual, con sus errores, porque el analizador tiene que vérselas con
 * esto y no con una transcripción limpia.
 *
 * Los estropicios que trae esta pasada, y que el analizador tiene que sortear:
 *
 *  - la columna «Pr Unit» pierde el punto decimal en cuatro de los nueve
 *    renglones (`$206812` por 2.066,12) y en dos el signo pesos se lee como un
 *    cinco (`5206612`);
 *  - la «G» de los gramajes sale como seis: `956X30X1` por `95GX30X1`;
 *  - la cantidad «2.00» aparece como `200` en un renglón;
 *  - hay basura pegada al final de dos filas (`—-`, `6 xo`);
 *  - el pie viene en una sola línea y con la etiqueta partida: `IVA21 .00%`.
 *
 * Lo que **no** se rompe es la columna Importe: los nueve importes salen bien
 * formados. Por eso el analizador la usa como ancla y deriva de ahí el precio
 * unitario, en vez de confiar en una columna que se rompe la mitad de las veces.
 */

export const MABELHERDI_COMPLETO = `MABELHERDI S.A. FACTURA

Gino) Jose Hernandez 4453 Comprobante: 0007-00348491
ho. CP: 1653 Fecha de Emision: 20/08/2026
Tol: 4838-3848 Contestador 24 ha CUIT: 30-67804306-7

Ingresos Brutos: 902-114553-0

IVA Responsable Inscripto Inicio de Actividad: 02/03/1994

9323 CAMPANA VERONICA GISELA Zona: 613 Fecha Entrega: 22/08/2026

AV SAN MARTIN 5891 Vend: AGUSTIN Condicion IVA: Inscripto
AGRONOMIA () Repart [218] Telefono: 1158523979
Fiambreria - B CUIT: 27333422919

SOLO MENSAJES POR WHATSAPP 11 2850 0294 Horario 9:30 a 20:30

Codigo Art. Descripcion | Desc Cantidad Sugerido pruUnit + Importe

300052821  PEPCOMUN 120GRX21 ...DO0.00% 1.00 unidad — $3500  $206812 $ 2066.12

300052756 PEP RUEDITAS 120GRX21 0.00% 1.00 Unidad $ 3500 $2066.12 $ 2066.12

300063087  TWISTOS MINIT QUESO 956X30X1 0.00% 1.00 Unidad $3600  $2125.15 $2125.15

300060664 CHEETOS QUESO 856X24X1 0.00% 200 Unidades $ 3500  $206612 $4132.24 —-
300065284 LAYS PROVOLETA 77GX25X1 0.00% 1.00 Unidad $3500 5206612 $2066.12 6 xo
300060192 DORITOS QUESO 77GX26 0.00% 2.00 Unidades $ 3500 $2066.12 $ 4132.24
300065287 LAYS CLASICAS 1346X18X1 0.00% 3.00 Unidades —$5500 + $324675 $9740.25
300064630 PEHUA PAPA ACANA 906X22 RM 0.00% 2.00 Unidades $2500 $147580 $2951.60
300059545 DORITOS QUESO 40GX70X1 0.00% 3.00 Unidades $2100 5123967 $3719.01

A
' MD
411)
MIN E

Comentario: B2B.AR.1002097479
CONTROLE SU PEDIDO AL RECIBIRLO, DESPUES NO SE RECON

OCERA NINGUN RECLAMO** GRACIAS!!!

Neto 21.00% $ 32998.85 IVA21 .00% $ 6929.76 Percepcion IIBB $ 577.48
Total: $ 40506.09
CAE N”: 86349182460702 Vto CAE: 30/08/2026
Comprobante Autorizado

Esta administracion federal no se responsabiliza por los datos

NET ALA ingresados en el detalle de la operación
Hoja 1 de 1

`;
