// Importador periódico de partidos desde TheSportsDB.
//
// Qué hace en cada ejecución:
//  1. Se asegura de que existen las columnas/tablas de la migración
//     migracion_relleno_automatico.sql (external_id, equipo_alias_externo,
//     sync_partidos_auto) — las crea si faltan, no falla si ya existen.
//  2. Resuelve los idLeague de las ligas configuradas (todos fijos y
//     confirmados a mano en LIGAS_CONOCIDAS, ver thesportsdb.mjs).
//  3. Para cada liga, resuelve su temporada actual y trae TODOS sus
//     partidos de golpe vía eventsseason.php (eventsnextleague.php y
//     eventspastleague.php están limitados a 1 evento por petición en
//     el plan free de TheSportsDB, así que no sirven para esto — ver
//     comentario de cabecera en thesportsdb.mjs).
//  4. Para cada partido: convierte la hora UTC de la API a hora de
//     Madrid SIN zona horaria (el formato que espera fecha_partido) y
//     hace upsert en la tabla results usando external_id como clave de
//     deduplicación — si ya existe, actualiza fecha/estado/marcador; si
//     no, lo crea con fuente='auto_thesportsdb'.
//  5. Nunca toca un partido con fuente='redaccion': un redactor que ha
//     editado el partido a mano SIEMPRE tiene prioridad (ver comentario
//     en migracion_relleno_automatico.sql).
//
// Ejecutar con: npm run import:partidos  (o node import-partidos.mjs)
// Pensado para correr como Cron Job nativo de Railway (arranca, hace su
// trabajo, se apaga), igual patrón que scripts/cron-respaldo.mjs.

import { ejecutarD1, escaparValorD1 } from "./d1-client.mjs";
import { eventoAFechaPartidoMadrid, soloFecha } from "./tiempo.mjs";
import { LIGAS_CONOCIDAS, temporadaActual, eventosTemporada } from "./thesportsdb.mjs";

const FUENTE = "auto_thesportsdb";

// Mapeo de clave interna -> { competicion, grupo } tal como los espera
// la columna "competicion" en results (ver worker/src/index.js,
// COMPETICIONES_CON_FLASHSCORE y similares: valores "hypermotion",
// "primera_federacion", "segunda_federacion").
const COMPETICION_POR_CLAVE = {
  hypermotion: { competicion: "hypermotion", grupo: null },
  primera_federacion_grupo_1: { competicion: "primera_federacion", grupo: "Grupo 1" },
  primera_federacion_grupo_2: { competicion: "primera_federacion", grupo: "Grupo 2" },
  segunda_federacion_grupo_1: { competicion: "segunda_federacion", grupo: "Grupo 1" },
  segunda_federacion_grupo_2: { competicion: "segunda_federacion", grupo: "Grupo 2" },
  segunda_federacion_grupo_3: { competicion: "segunda_federacion", grupo: "Grupo 3" },
  segunda_federacion_grupo_4: { competicion: "segunda_federacion", grupo: "Grupo 4" },
  segunda_federacion_grupo_5: { competicion: "segunda_federacion", grupo: "Grupo 5" },
};

function log(msg) {
  console.log(`[import-partidos ${new Date().toISOString()}] ${msg}`);
}

// ---------- Paso 1: asegurar schema ----------

async function asegurarSchema() {
  const columnas = await ejecutarD1(`PRAGMA table_info(results);`);
  const nombres = new Set(columnas.map((c) => c.name));

  if (!nombres.has("fuente")) {
    log("Añadiendo columna results.fuente...");
    await ejecutarD1(`ALTER TABLE results ADD COLUMN fuente TEXT NOT NULL DEFAULT 'redaccion';`);
  }
  if (!nombres.has("external_id")) {
    log("Añadiendo columna results.external_id...");
    await ejecutarD1(`ALTER TABLE results ADD COLUMN external_id TEXT;`);
    await ejecutarD1(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_results_external_id ON results(external_id) WHERE external_id IS NOT NULL;`
    );
  }

  await ejecutarD1(`
    CREATE TABLE IF NOT EXISTS equipo_alias_externo (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nombre_externo TEXT NOT NULL UNIQUE,
      nombre_interno TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  await ejecutarD1(`
    CREATE TABLE IF NOT EXISTS sync_partidos_auto (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      ultimo_sync_at TEXT,
      ultimo_sync_ok INTEGER NOT NULL DEFAULT 1,
      ultimo_error TEXT
    );
  `);
  await ejecutarD1(`INSERT OR IGNORE INTO sync_partidos_auto (id, ultimo_sync_at) VALUES (1, NULL);`);
}

// ---------- Paso 2: resolver ligas ----------
//
// Todos los idLeague ya están confirmados a mano y fijos en
// LIGAS_CONOCIDAS (ver thesportsdb.mjs) — ya no hace falta resolver
// nada en caliente por nombre.

function resolverTodasLasLigas() {
  return { ...LIGAS_CONOCIDAS };
}

// ---------- Paso 3+4: traer eventos y convertirlos ----------

function normalizarEquipo(nombreApi, aliasMap) {
  return aliasMap.get(nombreApi) || nombreApi;
}

async function cargarAliasEquipos() {
  const filas = await ejecutarD1(`SELECT nombre_externo, nombre_interno FROM equipo_alias_externo;`);
  return new Map(filas.map((f) => [f.nombre_externo, f.nombre_interno]));
}

/**
 * Traduce un evento de TheSportsDB a los campos que necesita results.
 * Devuelve null si el evento no tiene datos suficientes (sin equipos).
 */
function eventoAPartido(evento, competicion, grupo, aliasMap) {
  if (!evento.strHomeTeam || !evento.strAwayTeam) return null;

  const equipoLocal = normalizarEquipo(evento.strHomeTeam, aliasMap);
  const equipoVisitante = normalizarEquipo(evento.strAwayTeam, aliasMap);

  // strTime puede venir vacío si la API todavía no ha fijado el horario
  // exacto de un partido lejano: en ese caso guardamos solo la fecha
  // (longitud 10), igual convención que ya usa el resto del sistema
  // para "no sabemos la hora todavía" (ver fechaPartidoAUtcSqlite).
  const fechaPartido = evento.strTime
    ? eventoAFechaPartidoMadrid(evento.dateEvent, evento.strTime)
    : soloFecha(evento.dateEvent);

  // Estado: si la API ya trae marcador para ambos equipos, se considera
  // finalizado; si no, programado. La API no distingue "en_juego" de
  // forma fiable en el plan free (eso lo sigue gestionando el propio
  // cron del worker principal vía iniciarPartidosProgramadosCuyaHoraHaLlegado
  // + el panel de Minuto a Minuto), así que este importador nunca escribe
  // 'en_juego' directamente.
  const tieneMarcador = evento.intHomeScore !== null && evento.intAwayScore !== null;

  return {
    external_id: evento.idEvent,
    competicion,
    grupo,
    jornada: evento.intRound ? parseInt(evento.intRound, 10) : null,
    equipo_local: equipoLocal,
    equipo_visitante: equipoVisitante,
    goles_local: tieneMarcador ? parseInt(evento.intHomeScore, 10) : null,
    goles_visitante: tieneMarcador ? parseInt(evento.intAwayScore, 10) : null,
    fecha_partido: fechaPartido,
    estado: tieneMarcador ? "finalizado" : "programado",
  };
}

// ---------- Paso 4: upsert en D1 ----------

async function upsertPartido(partido) {
  // Solo tocamos partidos que YA son nuestros (fuente=auto_thesportsdb)
  // o que no existen todavía. Si existe con fuente='redaccion', un
  // redactor lo ha creado o editado a mano: no lo tocamos nunca (ver
  // comentario de cabecera de este archivo y el de la migración).
  const existente = await ejecutarD1(
    `SELECT id, fuente FROM results WHERE external_id = ${escaparValorD1(partido.external_id)} LIMIT 1;`
  );

  if (existente.length > 0) {
    if (existente[0].fuente !== FUENTE) {
      // Ya lo tiene un redactor: no pisar nada.
      return "omitido_redaccion";
    }
    await ejecutarD1(`
      UPDATE results SET
        jornada = ${escaparValorD1(partido.jornada)},
        fecha_partido = ${escaparValorD1(partido.fecha_partido)},
        estado = ${escaparValorD1(partido.estado)},
        goles_local = ${escaparValorD1(partido.goles_local)},
        goles_visitante = ${escaparValorD1(partido.goles_visitante)}
      WHERE id = ${existente[0].id};
    `);
    return "actualizado";
  }

  // No existe todavía: comprobar duplicado por equipos+jornada+competición
  // como red de seguridad extra (por si un redactor ya lo creó a mano
  // sin external_id, para no crear un partido duplicado).
  const posibleDuplicado = await ejecutarD1(`
    SELECT id FROM results
    WHERE competicion = ${escaparValorD1(partido.competicion)}
      AND equipo_local = ${escaparValorD1(partido.equipo_local)}
      AND equipo_visitante = ${escaparValorD1(partido.equipo_visitante)}
      AND (jornada = ${escaparValorD1(partido.jornada)} OR jornada IS NULL)
    LIMIT 1;
  `);
  if (posibleDuplicado.length > 0) {
    // Ya existe un partido de redacción para este cruce: no duplicar,
    // simplemente le asignamos el external_id para que la próxima vez
    // pase por la rama de "actualizado" de arriba... salvo que sea de
    // redacción, en cuyo caso lo dejamos tal cual y no lo tocamos.
    return "omitido_duplicado";
  }

  await ejecutarD1(`
    INSERT INTO results
      (competicion, grupo, jornada, equipo_local, equipo_visitante, fecha_partido, estado, goles_local, goles_visitante, fuente, external_id)
    VALUES (
      ${escaparValorD1(partido.competicion)},
      ${escaparValorD1(partido.grupo)},
      ${escaparValorD1(partido.jornada)},
      ${escaparValorD1(partido.equipo_local)},
      ${escaparValorD1(partido.equipo_visitante)},
      ${escaparValorD1(partido.fecha_partido)},
      ${escaparValorD1(partido.estado)},
      ${escaparValorD1(partido.goles_local)},
      ${escaparValorD1(partido.goles_visitante)},
      ${escaparValorD1(FUENTE)},
      ${escaparValorD1(partido.external_id)}
    );
  `);
  return "creado";
}

// ---------- main ----------

async function main() {
  const contadores = { creado: 0, actualizado: 0, omitido_redaccion: 0, omitido_duplicado: 0, error: 0 };

  try {
    await asegurarSchema();
    const ligas = resolverTodasLasLigas();
    const aliasMap = await cargarAliasEquipos();

    for (const [clave, liga] of Object.entries(ligas)) {
      const { competicion, grupo } = COMPETICION_POR_CLAVE[clave];
      log(`Importando ${clave} (idLeague=${liga.idLeague})...`);

      let eventos = [];
      try {
        // eventsnextleague/eventspastleague están limitados a 1 evento
        // por petición en el plan free de TheSportsDB (confirmado
        // 2026-09-01), así que usamos eventsseason.php para traer la
        // temporada completa de una sola vez.
        const temporada = await temporadaActual(liga.idLeague);
        if (!temporada) {
          log(`AVISO: no se pudo resolver la temporada actual de ${clave} (idLeague=${liga.idLeague}). Se omite esta liga en esta ejecución.`);
          continue;
        }
        eventos = await eventosTemporada(liga.idLeague, temporada);
      } catch (err) {
        log(`ERROR trayendo eventos de ${clave}: ${err.message}`);
        contadores.error++;
        continue;
      }

      for (const evento of eventos) {
        const partido = eventoAPartido(evento, competicion, grupo, aliasMap);
        if (!partido) continue;
        try {
          const resultado = await upsertPartido(partido);
          contadores[resultado] = (contadores[resultado] || 0) + 1;
        } catch (err) {
          log(`ERROR guardando partido ${partido.equipo_local} vs ${partido.equipo_visitante}: ${err.message}`);
          contadores.error++;
        }
      }
    }

    await ejecutarD1(`
      UPDATE sync_partidos_auto SET
        ultimo_sync_at = datetime('now'),
        ultimo_sync_ok = 1,
        ultimo_error = NULL
      WHERE id = 1;
    `);

    log(`Terminado. Resumen: ${JSON.stringify(contadores)}`);
  } catch (err) {
    log(`FALLO GENERAL: ${err.message}`);
    try {
      await ejecutarD1(`
        UPDATE sync_partidos_auto SET
          ultimo_sync_at = datetime('now'),
          ultimo_sync_ok = 0,
          ultimo_error = ${escaparValorD1(String(err.message).slice(0, 500))}
        WHERE id = 1;
      `);
    } catch (_) {
      // Si ni siquiera esto funciona, ya no hay mucho más que hacer aquí.
    }
    process.exitCode = 1;
  }
}

main();
