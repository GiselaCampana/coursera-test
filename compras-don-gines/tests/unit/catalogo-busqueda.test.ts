import { describe, it, expect } from 'vitest';
import { filtrarCatalogo, type ProductoBuscable } from '@/lib/catalogo-busqueda';

/**
 * El buscador del catálogo mientras se revisa una factura.
 *
 * Los PLU son los reales del catálogo de Control de Stock. Importa que lo sean:
 * la búsqueda tiene que servir con nombres que se parecen entre sí —tres quesos
 * sardo, dos cremosos— que es justamente donde un desplegable sin filtro se
 * vuelve inutilizable.
 */
const CATALOGO: ProductoBuscable[] = [
  { id: 'a', codigo: '1211', nombre: 'Cremoso Punta del Agua', codigosDeProveedor: ['ART-00228'] },
  {
    id: 'b',
    codigo: '1551',
    nombre: 'Queso Sardo bloque Melincué',
    codigosDeProveedor: ['ART-00758'],
  },
  { id: 'c', codigo: '1317', nombre: 'Reggianito', codigosDeProveedor: ['ART-01611', 'ART-82444'] },
  { id: 'd', codigo: '1420', nombre: 'Mozzarella Barraza' },
];

const ids = (productos: ProductoBuscable[]) => productos.map((p) => p.id);

describe('buscar un artículo del catálogo desde el renglón de la factura', () => {
  it('sin nada escrito muestra el catálogo entero', () => {
    expect(filtrarCatalogo(CATALOGO, '')).toHaveLength(4);
    expect(filtrarCatalogo(CATALOGO, undefined)).toHaveLength(4);
    expect(filtrarCatalogo(CATALOGO, '   ')).toHaveLength(4);
  });

  it('encuentra por PLU, que es lo que se sabe de memoria', () => {
    expect(ids(filtrarCatalogo(CATALOGO, '1211'))).toEqual(['a']);
  });

  it('encuentra por el código que imprime el proveedor en el papel', () => {
    expect(ids(filtrarCatalogo(CATALOGO, 'ART-00758'))).toEqual(['b']);
    // El segundo código del mismo proveedor para el mismo PLU también sirve.
    expect(ids(filtrarCatalogo(CATALOGO, 'ART-82444'))).toEqual(['c']);
  });

  it('no obliga a escribir el nombre entero ni en orden', () => {
    expect(ids(filtrarCatalogo(CATALOGO, 'sardo melin'))).toEqual(['b']);
    expect(ids(filtrarCatalogo(CATALOGO, 'melin sardo'))).toEqual(['b']);
  });

  it('no le pide tildes a nadie', () => {
    // «Melincué» se escribe con tilde y nadie la va a poner en el teléfono.
    expect(ids(filtrarCatalogo(CATALOGO, 'melincue'))).toEqual(['b']);
  });

  it('la puntuación del código del proveedor no tiene que coincidir', () => {
    expect(ids(filtrarCatalogo(CATALOGO, 'art 00228'))).toEqual(['a']);
    expect(ids(filtrarCatalogo(CATALOGO, 'art00228'))).toEqual([]);
  });

  it('cuando no hay nada que coincida devuelve la lista vacía, sin inventar', () => {
    /*
     * Devolver "lo más parecido" acá sería peor que no devolver nada: el
     * renglón quedaría asociado a un artículo que nadie eligió.
     */
    expect(filtrarCatalogo(CATALOGO, 'jamon crudo')).toEqual([]);
  });

  it('el artículo ya elegido nunca desaparece de la lista', () => {
    /*
     * El error que no se ve: si el elegido se filtrara, el desplegable quedaría
     * apuntando a una opción inexistente y el navegador lo pondría en "Sin
     * asociar". La asociación se habría perdido por escribir en un buscador.
     */
    const resultado = filtrarCatalogo(CATALOGO, 'reggianito', 'a');
    expect(ids(resultado)).toContain('a');
    expect(ids(resultado)).toContain('c');
  });
});
