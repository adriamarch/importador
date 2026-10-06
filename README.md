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

## Revisión (v2): qué se corrigió y por qué

La v1 funcionaba para 1-2 partidos pero tenía problemas serios en producción:

1. **Tardaba horas y gastaba escrituras de D1.** Hacía 2-3 llamadas a `wrangler` *por partido*
   (unos 2.500 partidos entre las 8 ligas, varios segundos cada una) y un `UPDATE` de todos
   los partidos en cada pasada (cada 30 min = miles de escrituras al día). Ahora lee los
   partidos existentes **una vez**, decide en memoria y solo escribe lo que cambia, en lotes
   (`wrangler d1 execute --file`). Una pasada son ~10 peticiones a la API + unas pocas a D1.
2. **Pisaba partidos en directo.** Si un partido automático estaba `en_juego`/`finalizado`
   y la API aún no traía marcador, el `UPDATE` lo devolvía a `programado` con goles `NULL`.
   Ahora solo toca partidos en estado `programado`/`retrasado` (y el SQL lo vuelve a
   comprobar en el `WHERE`, por si un redactor o el cron lo cambia justo en ese momento).
3. **Saltaba los partidos del primer importador** (`auto_api_football`, con la hora en UTC)
   como "duplicados", así que nunca se arreglaba su hora. Ahora los **adopta**: les pone
   `external_id`, `fuente = 'auto_thesportsdb'` y la hora correcta.
4. **El anti-duplicados fallaba cuando la jornada difería** (TheSportsDB se equivoca a menudo
   de jornada), creando un segundo partido encima del de redacción. Ahora el cruce es
   competición + local + visitante dentro de la temporada, sin mirar la jornada.
5. **Ignoraba el "Calendario de jornadas" del panel.** Ahora tiene prioridad sobre `intRound`.
6. **0-0 de relleno.** Un partido sin empezar con 0-0 en la API se marcaba `finalizado`.
   Ahora se mira `strStatus` y que la fecha no sea futura.
7. **Temporada.** Se usa la temporada que toca por fecha (`2026-2027` desde julio) y solo se
   cae a `strCurrentSeason` si no hay eventos, y nunca si es de una temporada antigua.
8. **Nombres de equipo.** Además de `equipo_alias_externo`, se casan automáticamente con los
   nombres ya existentes en esa competición (sin tildes ni CD/UD/RC...). Lo que no case se
   lista en el log para añadirle un alias.
9. `ultimo_sync_ok = 0` y código de salida 1 si falla una liga o un lote (antes quedaba en verde).
10. Timeout de 25 s en cada petición a la API, `concurrency` en el workflow y modo `DRY_RUN`.

## Primera ejecución (hazla así)

1. Lanza el workflow a mano (**Run workflow**, `dry_run = true` por defecto) o en local con
   `npm run import:dry`. No escribe nada; el log enseña el plan (`creado`, `actualizado`,
   `adoptado`, `omitido_*`), los equipos sin alias y las primeras sentencias SQL.
2. Revisa que las 8 ligas traen eventos y que la lista de "equipos sin coincidencia" es razonable.
   Si no, añade alias en `equipo_alias_externo` y repite.
3. Lanza otra vez con `dry_run = false`. Comprueba un partido conocido (hora de Madrid) y
   `sync_partidos_auto.ultimo_sync_ok = 1`.
4. A partir de ahí corre solo cada 30 min.

Secrets del repo: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `D1_DATABASE_NAME`
(opcional) y `THESPORTSDB_API_KEY` (opcional; sin ella usa la gratuita `123`).

## Archivos

- `plan.mjs` — lógica pura (qué hacer con cada partido). Con tests en `test/plan.test.mjs`.
- `import-partidos.mjs` — script principal (lee D1, pide la API, escribe en lotes).
- `thesportsdb.mjs` — cliente de la API (rate limit, IDs de liga).
- `tiempo.mjs` — conversión UTC → hora de Madrid sin zona. Si algo se desajusta 1-2 h, mira aquí primero.
- `d1-client.mjs` — acceso a D1 vía `wrangler d1 execute --remote`.

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

- **Nunca pisa un partido de redacción** (`fuente = 'redaccion'`). Cuando un redactor o admin
  edita un partido desde el panel, el worker lo marca como `redaccion` y el importador deja de tocarlo.
- Solo modifica partidos con `fuente = 'auto_thesportsdb'` en estado `programado`/`retrasado`.
  Nunca escribe `en_juego` (lo gestiona el cron del worker y el Minuto a Minuto).
- Deduplica por `external_id` (`idEvent`) y, si no lo hay, por cruce de equipos en la temporada.
