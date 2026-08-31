-- Razón social y CUIT tal como los leyó el OCR.
--
-- Aditiva y sin valor por defecto: los comprobantes ya cargados quedan en NULL,
-- que es exactamente lo que corresponde —de ellos no se guardó esa lectura— y
-- no cambia nada de lo que ya está calculado.
ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "readSupplierName" TEXT;
ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "readSupplierCuit" TEXT;
