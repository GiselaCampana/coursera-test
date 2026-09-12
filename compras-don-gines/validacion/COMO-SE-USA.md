# Validación con facturas nuevas

Todo lo que hay en `tests/fixtures/imagenes` se usó para **diseñar** el motor:
cada regla se escribió mirando en qué fallaba alguna de esas seis facturas. Eso
está bien mientras las reglas sean generales, y no hay manera de saber si lo son
mirando las mismas seis otra vez: un motor sobreajustado y un motor bueno dan el
mismo resultado sobre el corpus con el que se ajustaron.

Este directorio es para medir sobre facturas que el motor **nunca vio**, y el
orden de los pasos es lo único que le da valor a la medición.

## 1. Congelar el motor

```
git rev-parse HEAD
```

El acta registra ese commit y además un `sha256` sobre los fuentes de
`src/lib/ocr`. Si el árbol tiene cambios sin commitear, el acta lo dice y avisa
por pantalla: una primera lectura ciega sobre un árbol sucio no es reproducible.

## 2. Poner las fotos

Las fotos originales van en `validacion/imagenes/`, **sin recortar, sin rotar y
sin cambiarles la extensión**. La extensión tiene que decir lo que el archivo
es: una foto de iPhone renombrada a `.jpg` que en realidad es HEIC hace fallar
la decodificación de una manera que parece un problema de lectura.

## 3. La primera ejecución, a ciegas

```
npx tsx scripts/lectura-ciega.ts
```

Corre el OCR y el motor sobre cada foto nueva y guarda:

- `validacion/evidencia/<nombre>.json` — las palabras con sus cajas;
- `validacion/planes/<nombre>.json` — qué bandas releería, aunque no se releyó;
- `validacion/ciega/<nombre>.json` — **el acta**: hash del motor y de la imagen,
  calidad y resolución, emisor, encabezados, columnas con su origen, filas
  reconstruidas e interpretadas, cada celda con su valor y su procedencia,
  bloqueos raíz con sus alternativas y lo que destraban, advertencias, el cierre
  del detalle, el pie separado en leído / inferido / calculado / faltante,
  confianza y segunda candidata, tiempo de OCR y de motor, la decisión y las
  correcciones que le pediría a una persona.

**Acá no se mira el papel todavía.** Ni para chequear un número.

## 4. Recién ahora, transcribir el papel

A mano, en `validacion/verdad/<nombre>.json`, con el `imagenSha256` que figura
en el acta para que no se comparen dos facturas distintas:

```json
{
  "imagenSha256": "…",
  "emisor": { "cuit": "30-12345678-9" },
  "renglones": [
    { "codigo": "01", "descripcion": "…", "cantidad": "12,5",
      "precioUnitario": "1234,56", "importe": "15432,00" }
  ],
  "pie": {
    "netoGravado": "15432,00",
    "iva": [{ "alicuota": "0.21", "valor": "3240,72" }],
    "percepciones": [],
    "total": "18672,72"
  },
  "notas": ["La última fila salió con sombra."]
}
```

Los campos que se omiten no se comparan: transcribir de menos es honesto,
transcribir de más inventado no.

## 5. Comparar

```
npx tsx scripts/comparar-con-el-papel.ts
```

No da una nota: da un diagnóstico. Por cada campo que el motor **afirmó** y el
papel desmiente, dice dónde se rompió la cadena, y clasifica por la etapa **más
temprana** que ya estaba mal —calidad, emisor, encabezado, geometría,
agrupación de filas, formato numérico, aritmética, pie fiscal, asociación de
producto, unidad, ambigüedad genuina—. Un campo que el motor pidió en vez de
afirmar no cuenta como error: pedirlo es lo correcto.

## 6. Y no arreglar nada todavía

Varias facturas pueden revelar una única carencia general. Corregir la primera
que falla vuelve a sesgar el motor con el mismo mecanismo que esta validación
existe para detectar, y además hace que las que vengan después ya no sean
ciegas. Primero el conjunto completo, después el diagnóstico, después una sola
corrección general.
