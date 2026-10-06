// Lógica PURA del importador (sin red ni D1): decide qué hacer con cada
// evento de TheSportsDB. Está separada de import-partidos.mjs para poder
// probarla con datos inventados (ver test/plan.test.mjs).
import { eventoAFechaPartidoMadrid, soloFecha } from "./tiempo.mjs";

export const FUENTE = "auto_thesportsdb";
// Fuente del primer intento de importación (24-ago, horas en UTC por error).
export const FUENTE_LEGADA = "auto_api_football";
// Estados en los que el importador puede tocar marcador/estado. Cualquier
// otro (en_juego, descanso, colgado, finalizado, anulado...) lo gestiona el
// cron del worker o un redactor y NO se pisa.
export const ESTADOS_EDITABLES = ["programado", "retrasado"];

const PREFIJOS = new Set(["cd", "ud", "cf", "rc", "rcd", "sd", "ad", "cp", "ce", "fc", "sad", "ue"]);

/** Clave comparable de un nombre de equipo (sin tildes, mayúsculas ni prefijos CD/UD/RC...). */
export function claveEquipo(nombre) {
  return String(nombre || "")
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/[^a-z0-9 ]/g, " ")
    .split(/\s+/).filter((t) => t && !PREFIJOS.has(t)).join(" ");
}

/** Temporada "AAAA-AAAA" que toca a una fecha (la temporada cambia en julio). */
export function temporadaEsperada(ahora = new Date()) {
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Madrid", year: "numeric", month: "2-digit" })
    .formatToParts(ahora).reduce((a, x) => ((a[x.type] = x.value), a), {});
  const y = Number(p.year), m = Number(p.month);
  return m >= 7 ? `${y}-${y + 1}` : `${y - 1}-${y}`;
}

export function inicioTemporada(temporada) {
  return `${String(temporada).slice(0, 4)}-07-01`;
}

function entero(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number.parseInt(v, 10);
  return Number.isNaN(n) ? null : n;
}

/** Jornada según el "Calendario de jornadas" del panel (prioridad sobre intRound). */
export function jornadaDeCalendario(calendario, competicion, grupo, fechaYmd) {
  if (!fechaYmd) return null;
  const f = String(fechaYmd).slice(0, 10);
  const cand = (calendario || []).filter((c) =>
    c.competicion === competicion &&
    (c.grupo === null || c.grupo === undefined || c.grupo === (grupo ?? null)) &&
    String(c.fecha_inicio) <= f && String(c.fecha_fin) >= f);
  if (!cand.length) return null;
  cand.sort((a, b) => String(b.fecha_inicio).localeCompare(String(a.fecha_inicio)));
  return Number(cand[0].jornada);
}

/** Traduce un evento de la API a los campos de results (o null si no vale). */
export function eventoAPartido(ev, { competicion, grupo, hoyYmd }) {
  if (!ev || !ev.idEvent || !ev.strHomeTeam || !ev.strAwayTeam || !ev.dateEvent) return null;
  const fecha_partido = ev.strTime ? eventoAFechaPartidoMadrid(ev.dateEvent, ev.strTime) : soloFecha(ev.dateEvent);
  if (!fecha_partido) return null;
  const gl = entero(ev.intHomeScore), gv = entero(ev.intAwayScore);
  const estadoApi = String(ev.strStatus || "");
  // Un 0-0 "de relleno" en un partido sin empezar o suspendido no es un resultado.
  const noJugado = /not started|^ns$|postpon|cancel|abandon|suspend|^pst$|^canc/i.test(estadoApi);
  const terminado = gl !== null && gv !== null && !noJugado && String(ev.dateEvent) <= hoyYmd;
  return {
    external_id: String(ev.idEvent),
    competicion, grupo,
    jornada: entero(ev.intRound),
    equipo_local: ev.strHomeTeam, equipo_visitante: ev.strAwayTeam,
    fecha_partido,
    estado: terminado ? "finalizado" : "programado",
    goles_local: terminado ? gl : null,
    goles_visitante: terminado ? gv : null,
  };
}

/** Cambios a aplicar sobre una fila existente (objeto vacío = nada que hacer). */
export function cambiosPara(fila, p, { adoptando = false } = {}) {
  const c = {};
  const editable = ESTADOS_EDITABLES.includes(fila.estado);
  if (!editable && !adoptando) return c;
  // La fecha solo se corrige en partidos aún sin jugar, o al adoptar un
  // partido heredado del primer importador (que tenía la hora en UTC).
  if (editable || adoptando) {
    const f = p.fecha_partido;
    const filaTieneHora = String(fila.fecha_partido || "").length === 16;
    const apiSoloFecha = String(f).length === 10;
    const mismaFecha = String(fila.fecha_partido || "").slice(0, 10) === String(f).slice(0, 10);
    if (f && f !== fila.fecha_partido && !(apiSoloFecha && filaTieneHora && mismaFecha)) c.fecha_partido = f;
  }
  if (p.jornada !== null && p.jornada !== undefined && Number(fila.jornada) !== Number(p.jornada)) c.jornada = p.jornada;
  if (editable && p.estado === "finalizado") {
    c.estado = "finalizado"; c.goles_local = p.goles_local; c.goles_visitante = p.goles_visitante;
  }
  return c;
}

/**
 * Decide qué hacer con cada partido.
 * @returns {{ acciones: Array, resumen: object, sinAlias: string[] }}
 */
export function planificar({ partidos, existentes, aliasMap, calendario }) {
  const porExterno = new Map();
  const porClave = new Map();
  const nombresPorCompeticion = new Map(); // competicion -> Map(clave -> nombre existente)
  for (const f of existentes) {
    if (f.external_id) porExterno.set(String(f.external_id), f);
    const m = nombresPorCompeticion.get(f.competicion) || new Map();
    for (const n of [f.equipo_local, f.equipo_visitante]) if (n) m.set(claveEquipo(n), n);
    nombresPorCompeticion.set(f.competicion, m);
  }
  const claveCruce = (c, l, v) => `${c}|${claveEquipo(l)}|${claveEquipo(v)}`;
  for (const f of existentes) porClave.set(claveCruce(f.competicion, f.equipo_local, f.equipo_visitante), f);

  const resumen = { creado: 0, actualizado: 0, adoptado: 0, sin_cambios: 0, omitido_redaccion: 0, omitido_estado: 0, omitido_duplicado: 0 };
  const sinAlias = new Set();
  const acciones = [];
  const vistos = new Set();

  const resolver = (nombre, competicion) => {
    if (aliasMap.has(nombre)) return aliasMap.get(nombre);
    const conocido = nombresPorCompeticion.get(competicion)?.get(claveEquipo(nombre));
    if (conocido) return conocido;
    sinAlias.add(`${nombre} (${competicion})`);
    return nombre;
  };

  for (const p0 of partidos) {
    if (vistos.has(p0.external_id)) continue;
    vistos.add(p0.external_id);
    const p = { ...p0 };
    p.equipo_local = resolver(p0.equipo_local, p0.competicion);
    p.equipo_visitante = resolver(p0.equipo_visitante, p0.competicion);
    const jCal = jornadaDeCalendario(calendario, p.competicion, p.grupo, p.fecha_partido);
    if (jCal !== null) p.jornada = jCal;

    let fila = porExterno.get(p.external_id);
    let adoptando = false;
    if (fila) {
      if (fila.fuente !== FUENTE) { resumen.omitido_redaccion++; continue; }
    } else {
      fila = porClave.get(claveCruce(p.competicion, p.equipo_local, p.equipo_visitante));
      if (fila) {
        if (fila.fuente === FUENTE_LEGADA && !fila.external_id) adoptando = true;
        else { resumen.omitido_duplicado++; continue; }
      }
    }

    if (!fila) {
      acciones.push({ tipo: "creado", partido: p });
      resumen.creado++;
      continue;
    }
    const cambios = cambiosPara(fila, p, { adoptando });
    if (!adoptando && !ESTADOS_EDITABLES.includes(fila.estado)) { resumen.omitido_estado++; continue; }
    if (adoptando) {
      acciones.push({ tipo: "adoptado", id: fila.id, cambios, partido: p });
      resumen.adoptado++;
    } else if (Object.keys(cambios).length) {
      acciones.push({ tipo: "actualizado", id: fila.id, cambios, partido: p });
      resumen.actualizado++;
    } else resumen.sin_cambios++;
  }
  return { acciones, resumen, sinAlias: [...sinAlias].sort() };
}

/** SQL (con guardas contra carreras con redactores/cron) de una acción. */
export function sqlDeAccion(a, esc) {
  if (a.tipo === "creado") {
    const p = a.partido;
    return `INSERT OR IGNORE INTO results (competicion, grupo, jornada, equipo_local, equipo_visitante, fecha_partido, estado, goles_local, goles_visitante, fuente, external_id) VALUES (${[
      p.competicion, p.grupo, p.jornada, p.equipo_local, p.equipo_visitante, p.fecha_partido, p.estado, p.goles_local, p.goles_visitante, FUENTE, p.external_id,
    ].map(esc).join(", ")});`;
  }
  const set = Object.entries(a.cambios).map(([k, v]) => `${k} = ${esc(v)}`);
  if (a.tipo === "adoptado") {
    set.push(`fuente = ${esc(FUENTE)}`, `external_id = ${esc(a.partido.external_id)}`);
    return `UPDATE results SET ${set.join(", ")} WHERE id = ${Number(a.id)} AND fuente = ${esc(FUENTE_LEGADA)} AND external_id IS NULL;`;
  }
  return `UPDATE results SET ${set.join(", ")} WHERE id = ${Number(a.id)} AND fuente = ${esc(FUENTE)} AND estado IN ('programado','retrasado');`;
}
