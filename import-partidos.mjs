// Importador de partidos TheSportsDB -> D1 (versión por lotes).
//
// Qué cambia respecto a la versión anterior (ver README, "Revisión"):
//  - Lee los partidos existentes UNA vez y escribe solo lo que cambia, en
//    lotes (antes: 2-3 llamadas a wrangler POR partido y un UPDATE de
//    todos en cada pasada -> horas de ejecución y miles de escrituras D1/día).
//  - No pisa partidos en directo, finalizados ni editados por redacción.
//  - Adopta los partidos del primer importador (auto_api_football, hora en
//    UTC) y les corrige la hora en vez de saltárselos como "duplicados".
//  - Respeta el "Calendario de jornadas" del panel (prioridad sobre intRound).
//  - Casa nombres de equipo con los ya existentes (sin tildes/CD/UD...).
//  - DRY_RUN=1: no escribe nada, solo cuenta y enseña lo que haría.
import { pathToFileURL } from "node:url";
import { ejecutarD1, ejecutarD1Lote, escaparValorD1 } from "./d1-client.mjs";
import { LIGAS_CONOCIDAS, temporadaActual, eventosTemporada } from "./thesportsdb.mjs";
import { FUENTE, eventoAPartido, planificar, sqlDeAccion, temporadaEsperada, inicioTemporada } from "./plan.mjs";

const DRY_RUN = process.env.DRY_RUN === "1";
const TAM_LOTE = Number(process.env.IMPORT_TAM_LOTE || 150);

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

const log = (m) => console.log(`[import-partidos ${new Date().toISOString()}] ${m}`);

async function asegurarSchema() {
  const cols = new Set((await ejecutarD1(`PRAGMA table_info(results);`)).map((c) => c.name));
  if (!cols.has("fuente")) await ejecutarD1(`ALTER TABLE results ADD COLUMN fuente TEXT NOT NULL DEFAULT 'redaccion';`);
  if (!cols.has("external_id")) await ejecutarD1(`ALTER TABLE results ADD COLUMN external_id TEXT;`);
  await ejecutarD1(`CREATE UNIQUE INDEX IF NOT EXISTS idx_results_external_id ON results(external_id) WHERE external_id IS NOT NULL;`);
  await ejecutarD1(`CREATE TABLE IF NOT EXISTS equipo_alias_externo (id INTEGER PRIMARY KEY AUTOINCREMENT, nombre_externo TEXT NOT NULL UNIQUE, nombre_interno TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')));`);
  await ejecutarD1(`CREATE TABLE IF NOT EXISTS sync_partidos_auto (id INTEGER PRIMARY KEY CHECK (id = 1), ultimo_sync_at TEXT, ultimo_sync_ok INTEGER NOT NULL DEFAULT 1, ultimo_error TEXT);`);
  await ejecutarD1(`INSERT OR IGNORE INTO sync_partidos_auto (id, ultimo_sync_at) VALUES (1, NULL);`);
}

async function traerEventosLiga(clave, liga, esperada) {
  let eventos = await eventosTemporada(liga.idLeague, esperada);
  if (eventos.length) return eventos;
  // Plan B: la temporada que declara la API, pero SOLO si no es una antigua
  // (strCurrentSeason se queda desfasado en ligas poco mantenidas).
  const t = await temporadaActual(liga.idLeague);
  if (t && t !== esperada && Number(String(t).slice(0, 4)) >= Number(esperada.slice(0, 4))) {
    log(`${clave}: sin eventos en ${esperada}; probando la temporada de la API (${t}).`);
    eventos = await eventosTemporada(liga.idLeague, t);
  } else {
    log(`AVISO ${clave}: sin eventos en ${esperada} (la API declara ${t || "nada"}). Se omite.`);
  }
  return eventos;
}

export async function main() {
  const resumenError = { ligas_con_error: 0, lotes_con_error: 0 };
  try {
    if (!DRY_RUN) await asegurarSchema();
    const esperada = temporadaEsperada();
    const hoyYmd = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Madrid", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
    log(`${DRY_RUN ? "[DRY_RUN] " : ""}Temporada ${esperada}, hoy ${hoyYmd} (Madrid).`);

    const aliasMap = new Map((await ejecutarD1(`SELECT nombre_externo, nombre_interno FROM equipo_alias_externo;`)).map((f) => [f.nombre_externo, f.nombre_interno]));
    const calendario = await ejecutarD1(`SELECT competicion, grupo, jornada, fecha_inicio, fecha_fin FROM jornadas_calendario;`).catch(() => []);
    const competiciones = [...new Set(Object.values(COMPETICION_POR_CLAVE).map((x) => x.competicion))].map(escaparValorD1).join(",");
    const existentes = await ejecutarD1(
      `SELECT id, competicion, grupo, jornada, equipo_local, equipo_visitante, fecha_partido, estado, goles_local, goles_visitante, fuente, external_id
       FROM results WHERE competicion IN (${competiciones}) AND (fecha_partido IS NULL OR fecha_partido >= ${escaparValorD1(inicioTemporada(esperada))});`
    );
    log(`En D1: ${existentes.length} partidos de la temporada, ${calendario.length} tramos de calendario, ${aliasMap.size} alias.`);

    const partidos = [];
    for (const [clave, liga] of Object.entries(LIGAS_CONOCIDAS)) {
      const meta = COMPETICION_POR_CLAVE[clave];
      if (!meta) continue;
      try {
        const eventos = await traerEventosLiga(clave, liga, esperada);
        const antes = partidos.length;
        for (const ev of eventos) {
          const p = eventoAPartido(ev, { ...meta, hoyYmd });
          if (p && p.fecha_partido >= inicioTemporada(esperada).slice(0, 4) + "-06-01") partidos.push(p);
        }
        log(`${clave} (idLeague=${liga.idLeague}): ${eventos.length} eventos, ${partidos.length - antes} válidos.`);
      } catch (err) {
        log(`ERROR trayendo ${clave}: ${err.message}`);
        resumenError.ligas_con_error++;
      }
    }

    const { acciones, resumen, sinAlias } = planificar({ partidos, existentes, aliasMap, calendario });
    log(`Plan: ${JSON.stringify(resumen)}`);
    if (sinAlias.length) {
      log(`Equipos de la API sin coincidencia con ninguno existente (${sinAlias.length}). Si alguno es un club que ya usáis con otro nombre, añadid un alias en equipo_alias_externo:`);
      for (const n of sinAlias) log(`   · ${n}`);
    }

    const sentencias = acciones.map((a) => sqlDeAccion(a, escaparValorD1));
    if (DRY_RUN) {
      for (const s of sentencias.slice(0, 20)) log(`   ${s}`);
      log(`[DRY_RUN] ${sentencias.length} sentencias que se ejecutarían. No se ha escrito nada.`);
      return;
    }
    for (let i = 0; i < sentencias.length; i += TAM_LOTE) {
      const lote = sentencias.slice(i, i + TAM_LOTE);
      try { await ejecutarD1Lote(lote); }
      catch (err) { log(`ERROR en lote ${i / TAM_LOTE + 1}: ${err.message.slice(0, 400)}`); resumenError.lotes_con_error++; }
    }

    const hayError = resumenError.ligas_con_error > 0 || resumenError.lotes_con_error > 0;
    const msg = hayError ? `Ligas con error: ${resumenError.ligas_con_error}; lotes con error: ${resumenError.lotes_con_error}` : null;
    await ejecutarD1(`UPDATE sync_partidos_auto SET ultimo_sync_at = datetime('now'), ultimo_sync_ok = ${hayError ? 0 : 1}, ultimo_error = ${escaparValorD1(msg)} WHERE id = 1;`);
    log(`Terminado${hayError ? " CON ERRORES" : ""}. ${JSON.stringify(resumen)}`);
    if (hayError) process.exitCode = 1;
  } catch (err) {
    log(`FALLO GENERAL: ${err.message}`);
    if (!DRY_RUN) {
      await ejecutarD1(`UPDATE sync_partidos_auto SET ultimo_sync_at = datetime('now'), ultimo_sync_ok = 0, ultimo_error = ${escaparValorD1(String(err.message).slice(0, 500))} WHERE id = 1;`).catch(() => {});
    }
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main();
