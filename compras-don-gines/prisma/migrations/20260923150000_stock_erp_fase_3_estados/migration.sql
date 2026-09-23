-- Stock ERP, fase 3: los dos estados de una sesión de apertura.
--
-- Va SOLA, en su propia migración, y no es un capricho de orden: PostgreSQL no
-- deja usar un valor de enum recién agregado dentro de la misma transacción que
-- lo agregó. La migración que sigue crea un índice parcial y un CHECK que
-- nombran 'CONFIRMADA'; si el ALTER TYPE viviera ahí, fallaría con «unsafe use
-- of new value of enum type».
--
-- ABIERTA y CERRADA quedan para los recuentos periódicos, que son otra cosa.
-- Una apertura vive entre BORRADOR y CONFIRMADA, y «confirmada» dice algo que
-- «cerrada» no dice: que de esa sesión salió un asiento en el libro.

ALTER TYPE "StockCountSessionStatus" ADD VALUE IF NOT EXISTS 'BORRADOR';
ALTER TYPE "StockCountSessionStatus" ADD VALUE IF NOT EXISTS 'CONFIRMADA';
