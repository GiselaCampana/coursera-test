-- La foto del artículo, de la que Control de Stock es la fuente.
--
-- Se guarda la dirección y no la imagen. La foto ya vive en Control de Stock;
-- copiarla sería tener dos, y dos copias de una foto son dos fotos distintas en
-- cuanto alguien cambia una sola.
--
-- Aditiva y nulable: los artículos que ya están no cambian, y un artículo sin
-- foto sigue siendo un artículo válido.
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "imageUrl" TEXT;
