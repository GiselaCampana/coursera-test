import { describe, it, expect } from 'vitest';
import { leerCatalogo, parsearCsv } from '@/lib/domain/catalogo';

/**
 * La lectura del archivo que exporta Control de Stock.
 *
 * Lo que se prueba acá es la parte que no toca la base: entender el archivo.
 * Importa porque el archivo lo genera otro sistema y no se puede negociar su
 * formato: si la lectura es frágil, el catálogo entra mal o no entra.
 */

describe('leer el archivo del catálogo', () => {
  it('lee un CSV con las columnas en español', () => {
    const { filas, problemas } = leerCatalogo(
      ['PLU,Nombre,Familia,Activo', '1211,Cremoso Punta del Agua,Quesos,si'].join('\n'),
    );
    expect(problemas).toEqual([]);
    expect(filas).toHaveLength(1);
    expect(filas[0].plu).toBe('1211');
    expect(filas[0].nombre).toBe('Cremoso Punta del Agua');
    expect(filas[0].familia).toBe('Quesos');
    expect(filas[0].activo).toBe(true);
  });

  it('acepta punto y coma, que es como exportan las planillas en español', () => {
    const { filas } = leerCatalogo(
      ['PLU;Nombre;Familia', '2001;Sardo Bloque Melincué;Queso Sardo'].join('\n'),
    );
    expect(filas).toHaveLength(1);
    expect(filas[0].nombre).toBe('Sardo Bloque Melincué');
    expect(filas[0].familia).toBe('Queso Sardo');
  });

  it('no parte en dos un nombre que trae una coma entre comillas', () => {
    /*
     * Partir por comas a secas rompería «Queso Sardo, en horma» en dos
     * columnas y correría todo lo que sigue: la familia pasaría a ser un
     * pedazo del nombre y el activo, la familia.
     */
    const { filas } = leerCatalogo(
      ['PLU,Nombre,Familia', '2001,"Sardo Bloque, en horma",Queso Sardo'].join('\n'),
    );
    expect(filas[0].nombre).toBe('Sardo Bloque, en horma');
    expect(filas[0].familia).toBe('Queso Sardo');
  });

  it('entiende las comillas dobles adentro de un campo', () => {
    const filas = parsearCsv('a,b\n"dice ""hola""",2');
    expect(filas[1][0]).toBe('dice "hola"');
  });

  it('se banca el BOM que dejan Excel y Sheets al principio del archivo', () => {
    const { filas, problemas } = leerCatalogo('﻿PLU,Nombre\n1211,Cremoso Punta del Agua');
    expect(problemas).toEqual([]);
    expect(filas[0].plu).toBe('1211');
  });

  it('reconoce los encabezados escritos de otras maneras', () => {
    // El archivo lo genera otro sistema: no se le puede exigir que use
    // exactamente nuestras palabras para poder leerlo.
    const { filas } = leerCatalogo(
      ['Código Interno;Producto;Rubro;Código Proveedor;Proveedor', '1211;Cremoso;Quesos;ART-00228;Errecalde'].join(
        '\n',
      ),
    );
    expect(filas[0].plu).toBe('1211');
    expect(filas[0].nombre).toBe('Cremoso');
    expect(filas[0].familia).toBe('Quesos');
    expect(filas[0].codigoProveedor).toBe('ART-00228');
    expect(filas[0].proveedor).toBe('Errecalde');
  });

  it('no confunde el código del proveedor con el PLU', () => {
    /*
     * Cuando el archivo trae las dos cosas, «Código» a secas no puede ganarle a
     * «Código Proveedor»: si se cruzaran, el catálogo entero entraría numerado
     * con los códigos de un proveedor.
     */
    const { filas } = leerCatalogo(
      ['Codigo,Nombre,Codigo Proveedor', '1211,Cremoso Punta del Agua,ART-00228'].join('\n'),
    );
    expect(filas[0].plu).toBe('1211');
    expect(filas[0].codigoProveedor).toBe('ART-00228');
  });

  it('conserva el PLU tal cual, sin rellenarlo ni pasarlo a número', () => {
    // "0125" y "125" pueden ser dos artículos distintos. Normalizar de más es
    // renumerar en silencio.
    const { filas } = leerCatalogo(['PLU,Nombre', '0125,Uno', '125,Otro'].join('\n'));
    expect(filas.map((f) => f.plu)).toEqual(['0125', '125']);
  });

  it('lee un JSON, venga suelto o envuelto', () => {
    const suelto = leerCatalogo('[{"plu":"1211","nombre":"Cremoso","activo":true}]');
    expect(suelto.filas[0].plu).toBe('1211');
    expect(suelto.filas[0].activo).toBe(true);

    const envuelto = leerCatalogo('{"productos":[{"plu":"1211","nombre":"Cremoso"}]}');
    expect(envuelto.filas[0].plu).toBe('1211');
  });

  it('señala la línea de la fila que no se puede importar', () => {
    const { filas, problemas } = leerCatalogo(
      ['PLU,Nombre', '1211,Cremoso', ',Sin PLU', '1300,'].join('\n'),
    );
    expect(filas).toHaveLength(1);
    expect(problemas).toHaveLength(2);
    expect(problemas[0]).toContain('Línea 3');
    expect(problemas[1]).toContain('Línea 4');
  });

  it('dice qué falta cuando el encabezado no es el que hace falta', () => {
    const { filas, problemas } = leerCatalogo(['Cosa,Otra', 'a,b'].join('\n'));
    expect(filas).toEqual([]);
    expect(problemas[0]).toContain('PLU');
    // Y muestra lo que sí leyó, que es lo que permite darse cuenta del error.
    expect(problemas[0]).toContain('cosa');
  });

  it('un activo que no se entiende no da de baja el artículo', () => {
    // Nulo es "el archivo no lo dice", y eso no puede convertirse en "inactivo":
    // sería dar de baja artículos por una columna mal escrita.
    const { filas } = leerCatalogo(['PLU,Nombre,Activo', '1211,Cremoso,quizá'].join('\n'));
    expect(filas[0].activo).toBeNull();
  });

  it('ignora las filas en blanco del final del archivo', () => {
    const { filas, problemas } = leerCatalogo('PLU,Nombre\n1211,Cremoso\n\n\n');
    expect(filas).toHaveLength(1);
    expect(problemas).toEqual([]);
  });
});
