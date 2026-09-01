# Importador de partidos — TheSportsDB → D1

Trae periódicamente los partidos de Hypermotion, Primera Federación y
Segunda Federación desde [TheSportsDB](https://www.thesportsdb.com/documentation)
(API gratuita) y los guarda en la tabla `results` de D1, exactamente en
el mismo formato que si los hubiera creado un redactor a mano — pero
marcados con `fuente = 'auto_thesportsdb'` para poder distinguirlos.

## Por qué existe (contexto del bug que lo motivó)

El primer intento de importación automática (`fuente = 'auto_api_football'`,
un lote de 270 partidos insertado el 24 de agosto) guardó la hora que
daba la API **en UTC** directamente en `fecha_partido`, campo que todo
el resto del sistema (`fechaPartidoAUtcSqlite` en `worker/src/index.js`,
`timestampFechaPartido` en `public/js/partidos.js`) trata como **hora de
Madrid sin zona horaria**. Resultado: los partidos se mostraban y
arrancaban 2 horas antes de su hora real.

Este importador corrige eso en origen: `tiempo.mjs` convierte
explícitamente de UTC (lo que da la API) a hora de Madrid sin TZ (lo que
espera `fecha_partido`), teniendo en cuenta el cambio de hora
verano/invierno automáticamente (igual algoritmo que usa el worker
principal, en sentido inverso).

## Archivos

- `thesportsdb.mjs` — cliente de la API (rate limit, IDs de liga).
- `tiempo.mjs` — conversión de horas UTC → Madrid sin TZ. **El archivo
  más importante de todos**: si algo vuelve a desajustarse 1-2h, es
  aquí donde hay que mirar primero.
- `d1-client.mjs` — mismo mecanismo que ya usa
  `worker-secondary/sync/d1-client.mjs` (wrangler d1 execute --remote).
- `import-partidos.mjs` — script principal.

## Ligas configuradas

| Competición | Grupo | idLeague TheSportsDB | Confirmado |
|---|---|---|---|
| Hypermotion (Segunda División) | — | 4400 | ✅ |
| Primera Federación | Grupo 1 | 5086 | ✅ |
| Primera Federación | Grupo 2 | 5088 | ✅ |
| Segunda Federación | Grupo 1 | 5087 | ✅ |
| Segunda Federación | Grupo 2 | 5089 | ✅ |
| Segunda Federación | Grupo 3 | sin confirmar | ⚠️ el script lo verifica solo al arrancar |
| Segunda Federación | Grupo 4 | 5091 | ✅ |
| Segunda Federación | Grupo 5 | sin confirmar | ⚠️ el script lo verifica solo al arrancar |

Grupo 3 y Grupo 5 de Segunda Federación no se pudieron confirmar de
antemano (búsquedas sin resultado claro). El script prueba varios IDs
candidatos contra `lookupleague.php` cada vez que arranca y avisa por
log si no logra resolver alguno — revisa los logs las primeras
ejecuciones. Si falla, confirma el ID a mano visitando
`https://www.thesportsdb.com/api/v1/json/123/lookupleague.php?id=XXXX`
y actualiza `IDS_CANDIDATOS_SEGUNDA_FEDERACION` en `thesportsdb.mjs`.

## Comportamiento

- **Nunca pisa un partido de redacción** (`fuente = 'redaccion'`): si un
  redactor ya creó o editó ese partido a mano, tiene prioridad absoluta.
- Deduplica por `external_id` (el `idEvent` de TheSportsDB). Si el
  partido ya existe con esa fuente, se actualiza (fecha, estado,
  marcador); si no existe, se crea.
- Red de seguridad extra: si no hay `external_id` pero ya hay un
  partido con los mismos equipos/jornada/competición, no lo duplica.
- Cuando el marcador ya está disponible en la API, marca el partido
  como `finalizado` y rellena `goles_local`/`goles_visitante`. Nunca
  escribe `en_juego` (eso lo sigue gestionando el cron del worker
  principal + el panel de Minuto a Minuto).
- Alias de equipos: si el nombre que da la API no coincide con el que
  usáis en `public/js/clubs.js`, añade una fila en
  `equipo_alias_externo` (nombre_externo → nombre_interno) desde D1
  directamente; el script la usará en la siguiente ejecución.

## Desplegar como Cron Job en Railway

1. Crea un repo nuevo (o una carpeta en uno existente) con estos
   archivos.
2. En Railway, nuevo servicio → conecta este repo.
3. **Start Command**: `npm run import:partidos`
4. **Cron Schedule**: por ejemplo `*/30 * * * *` (cada 30 minutos) —
   ajusta según el límite de 30 peticiones/minuto del plan gratuito de
   TheSportsDB (este script ya espacia sus propias peticiones a ~28/min,
   así que 30 min de margen entre ejecuciones es prudente).
5. Variables de entorno necesarias (las mismas que ya usa
   `sync/scheduler.mjs` en Railway, cópialas del servicio existente):
   - Credenciales de Wrangler para que `npx wrangler d1 execute --remote`
     funcione sin pedir login interactivo.
   - `D1_DATABASE_NAME` (opcional, por defecto `elotrofutbol`).
   - `THESPORTSDB_API_KEY` (opcional, por defecto `123`, la key
     gratuita pública).

## Primera ejecución

Antes de dejarlo en cron automático, ejecútalo una vez a mano (`npm run
import:partidos` en local, con las mismas variables de entorno) y
revisa:

1. Que resuelve las 8 ligas (mira los logs "Liga resuelta: ...").
2. Que unos pocos partidos nuevos aparecen en D1 con
   `fuente = 'auto_thesportsdb'` y `fecha_partido` en hora correcta
   (compara con la hora real de un partido conocido, como hicimos con
   Villarreal B - Algeciras).
3. Que `sync_partidos_auto.ultimo_sync_ok = 1` tras la ejecución.
