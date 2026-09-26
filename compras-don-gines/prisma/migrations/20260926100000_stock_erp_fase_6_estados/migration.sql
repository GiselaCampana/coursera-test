-- Stock ERP, fase 6: los estados del traslado.
--
-- **Va en una migración aparte a propósito, y no es estilo: es obligatorio.**
--
-- PostgreSQL no deja usar un valor de enum recién agregado en la MISMA
-- transacción que lo agregó («unsafe use of new value of enum type»). Prisma
-- corre cada migración en una transacción, y la migración siguiente necesita
-- esos valores en un DEFAULT y en varias CHECK. Juntas fallarían; separadas
-- funcionan y quedan igual de aditivas.
--
-- Los dos valores viejos NO se tocan. `APLICADO` era el traslado instantáneo de
-- la fase 1 —una sola transacción, salida y entrada juntas— y `REVERSADO` su
-- reversión. La fase 6 agrega el flujo en dos hechos físicos y deja los viejos
-- donde están: quitarlos sería reescribir historia que la base ya sabe leer.

ALTER TYPE "StockTransferStatus" ADD VALUE IF NOT EXISTS 'BORRADOR';
ALTER TYPE "StockTransferStatus" ADD VALUE IF NOT EXISTS 'DESPACHADO';
ALTER TYPE "StockTransferStatus" ADD VALUE IF NOT EXISTS 'RECIBIDO';
ALTER TYPE "StockTransferStatus" ADD VALUE IF NOT EXISTS 'CANCELADO';
