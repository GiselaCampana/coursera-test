# Protocolo de prueba en iPhone (Safari)

Las pruebas automáticas corren en Chromium con el perfil del iPhone 13. Eso
verifica el diseño móvil y el circuito completo, **pero no es Safari**: el motor
es otro, y las diferencias que importan —cómo decodifica una foto HEIC, cómo
aplica la orientación EXIF, cuánta memoria le deja a un Web Worker, cómo se
comporta la cámara— sólo aparecen en el teléfono de verdad.

Este protocolo es para correrlo una vez, con el iPhone en la mano, antes de
usar el sistema en serio. Lleva unos 40 minutos.

**Antes de empezar:** la aplicación tiene que estar desplegada y accesible por
**HTTPS**. Sin conexión segura, Safari no da acceso a la cámara y la cookie de
sesión no viaja: nada de esto se puede probar en `http://`.

Anotá lo que salga en la columna de la derecha. Donde diga *falla*, sacá una
captura y guardá el resultado de la pantalla de Diagnóstico.

---

## 1. Ingreso y sesión

| # | Qué hacer | Qué tiene que pasar | Resultado |
|---|---|---|---|
| 1.1 | Abrir la URL en Safari después de varias horas sin usarla | Puede tardar hasta un minuto (Render estaba dormido). No aparece ningún error técnico | |
| 1.2 | Ingresar con el usuario operador | Entra y muestra "Hola, …" | |
| 1.3 | Escribir mal la contraseña una vez | Dice "El correo o la contraseña no son correctos", sin aclarar cuál de los dos | |
| 1.3a | **La primera vez de cada usuario**: ingresar con la contraseña inicial | Va derecho a "Cambiar contraseña" y explica por qué. Escribir a mano `/comprobantes` en la barra vuelve a la misma pantalla | |
| 1.3b | Elegir una contraseña nueva (10+ caracteres, letras y números) y guardarla | Entra a "Hola, …" sin volver a pedir la contraseña. Safari ofrece guardarla en el llavero | |
| 1.3c | Salir e intentar entrar con la contraseña vieja | No la acepta | |
| 1.3d | Más → "Cambiar mi contraseña" con la sesión ya normal | Deja cambiarla de nuevo, sin el aviso de contraseña inicial | |
| 1.4 | Cerrar Safari por completo y volver a abrir la URL | Sigue la sesión iniciada | |
| 1.5 | Agregar la aplicación a la pantalla de inicio (Compartir → Agregar a inicio) y abrirla desde ahí | Abre a pantalla completa y la sesión sigue | |

## 2. Cámara y galería

| # | Qué hacer | Qué tiene que pasar | Resultado |
|---|---|---|---|
| 2.1 | Nueva compra → "Sacar foto" | Abre la cámara **trasera** directamente | |
| 2.2 | Sacar una foto de una factura | Vuelve a la aplicación con la miniatura cargada | |
| 2.3 | "Elegir del teléfono" | Abre la galería y deja elegir **varias** fotos | |
| 2.4 | Elegir una foto **HEIC** (las del iPhone lo son salvo que esté en "Más compatible") | La acepta. Si avisa algo, es en castellano | |
| 2.5 | Elegir un PDF desde Archivos | Lo acepta y lo cuenta como página | |
| 2.6 | Elegir la misma foto dos veces | Avisa "ya estaba agregada" y no la duplica | |
| 2.7 | Sacar una foto sosteniendo el teléfono **en vertical** | La miniatura se ve derecha, no acostada | |

> **Sobre HEIC:** si 2.4 falla, en Ajustes → Cámara → Formatos se puede poner
> "Más compatible" y el iPhone saca JPG. Es un rodeo aceptable, pero anotalo:
> significa que la conversión HEIC no está funcionando en el teléfono.

## 3. Lectura del comprobante

| # | Qué hacer | Qué tiene que pasar | Resultado |
|---|---|---|---|
| 3.1 | Con una factura bien iluminada y encuadrada, tocar "Leer el comprobante" | Muestra las etapas y avanza. **Anotá cuánto tarda** | |
| 3.2 | Mientras lee, bloquear la pantalla 10 segundos y volver | La lectura sigue o se reanuda; no queda colgada | |
| 3.3 | Al terminar | Llega a "Revisar los datos" con los renglones cargados | |
| 3.4 | Comparar los números con el papel | Cantidades, precios y total coinciden | |
| 3.5 | Repetir con una foto **movida o con sombra** | O cierra, o queda en rojo con el guardado bloqueado. **Nunca inventa números** | |
| 3.6 | Repetir con un comprobante de **letra muy chica** | Anotá si cierra y en cuántos intentos | |

> La primera lectura de cada teléfono descarga unos 15 MB del lector. Hacela con
> wifi. Después queda en caché.

## 4. Diagnóstico

| # | Qué hacer | Qué tiene que pasar | Resultado |
|---|---|---|---|
| 4.1 | Más → Diagnóstico de lectura, elegir la foto de 3.6 | Muestra peso original y optimizado, formato, resolución y duración del OCR | |
| 4.2 | Mirar "Resolución al leer" | Debería rondar los 2200 px de lado mayor | |
| 4.3 | Mirar "Errores del lector" | Dice que no hubo errores | |
| 4.4 | Mirar "Duración del OCR" | **Anotá el número.** Es la referencia de cuánto tarda este modelo de iPhone | |
| 4.5 | Tocar "Ver" en Texto reconocido | Se lee el texto crudo y se puede desplazar sin romper el ancho de la pantalla | |

## 5. Guardado y pagos

| # | Qué hacer | Qué tiene que pasar | Resultado |
|---|---|---|---|
| 5.1 | Guardar la compra de 3.1 | Guarda y muestra "El comprobante se guardó y el pago quedó agendado" | |
| 5.2 | Ir a Pagos | Aparece el pago agendado con su fecha | |
| 5.3 | Con usuario administrador, confirmar el pago | Pasa a pagados y queda el evento | |
| 5.4 | Volver a cargar el mismo comprobante | Avisa que ya está cargado | |

## 6. Diseño y accesibilidad

| # | Qué hacer | Qué tiene que pasar | Resultado |
|---|---|---|---|
| 6.1 | Recorrer todas las pantallas | Ninguna se desborda a lo ancho | |
| 6.2 | Girar el teléfono a horizontal | Se sigue usando, sin scroll horizontal | |
| 6.3 | Ajustes → Pantalla → Texto más grande, subirlo dos pasos | Los textos crecen sin romper el diseño ni tapar botones | |
| 6.4 | Probar los botones con el pulgar | Se tocan cómodos, sin errar | |
| 6.5 | Mirar la barra inferior en una pantalla larga | No tapa el último control | |

## 7. Conexión

| # | Qué hacer | Qué tiene que pasar | Resultado |
|---|---|---|---|
| 7.1 | Poner el teléfono en modo avión y tocar "Leer el comprobante" | Avisa en castellano que no hay conexión. No muestra "Failed to fetch" | |
| 7.2 | Empezar a leer con wifi y pasar a datos móviles a mitad | Reintenta y sigue, o avisa claro | |
| 7.3 | Dejar la aplicación abierta 20 minutos sin tocarla y después guardar algo | Puede tardar (Render se durmió) y muestra "Estamos iniciando el sistema…" | |

---

## Qué hacer con los resultados

- **Todo bien:** anotá el tiempo de OCR de 4.4 y la resolución de 4.2. Son la
  referencia para comparar cuando alguien diga "hoy está lento".
- **Falla la lectura (3.x):** guardá el diagnóstico completo de la pantalla 4 y
  la foto que la produjo. Con eso se puede ajustar el preprocesado o escribir un
  analizador para el formato de ese proveedor.
- **Falla HEIC (2.4):** es lo más probable que aparezca. Anotá el mensaje exacto.
- **Falla algo de 6.x:** es diseño, se arregla sin tocar la lógica.

## Lo que este protocolo no cubre

- **Más de un iPhone.** El tiempo del OCR depende mucho del modelo. Un iPhone SE
  puede tardar el triple que uno reciente.
- **iPad.** No se probó ni se diseñó para esa pantalla.
- **Android.** El diseño es estándar y debería andar, pero no está verificado.
