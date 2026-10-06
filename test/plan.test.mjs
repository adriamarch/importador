import test from "node:test";
import assert from "node:assert/strict";
import { eventoAFechaPartidoMadrid } from "../tiempo.mjs";
import { claveEquipo, temporadaEsperada, eventoAPartido, planificar, sqlDeAccion, jornadaDeCalendario, FUENTE } from "../plan.mjs";

const esc = (v) => (v === null || v === undefined ? "NULL" : typeof v === "number" ? String(v) : `'${String(v).replace(/'/g, "''")}'`);
const meta = { competicion: "hypermotion", grupo: null, hoyYmd: "2026-10-07" };
const ev = (o = {}) => ({ idEvent: "1", strHomeTeam: "Cádiz", strAwayTeam: "Eibar", dateEvent: "2026-10-10", strTime: "17:30:00", intRound: "9", intHomeScore: null, intAwayScore: null, strStatus: "Not Started", ...o });
const fila = (o = {}) => ({ id: 5, competicion: "hypermotion", grupo: null, jornada: 9, equipo_local: "Cádiz CF", equipo_visitante: "SD Eibar", fecha_partido: "2026-10-10T19:30", estado: "programado", goles_local: null, goles_visitante: null, fuente: FUENTE, external_id: "1", ...o });
const plan = (partidos, existentes = [], extra = {}) => planificar({ partidos, existentes, aliasMap: new Map(), calendario: [], ...extra });

test("hora UTC -> Madrid (verano y invierno)", () => {
  assert.equal(eventoAFechaPartidoMadrid("2026-10-10", "17:30:00"), "2026-10-10T19:30");
  assert.equal(eventoAFechaPartidoMadrid("2026-12-05", "17:30:00+00:00"), "2026-12-05T18:30");
});
test("temporada esperada cambia en julio", () => {
  assert.equal(temporadaEsperada(new Date("2026-10-07T10:00:00Z")), "2026-2027");
  assert.equal(temporadaEsperada(new Date("2027-03-01T10:00:00Z")), "2026-2027");
  assert.equal(temporadaEsperada(new Date("2026-06-30T10:00:00Z")), "2025-2026");
});
test("clave de equipo ignora tildes y prefijos", () => {
  assert.equal(claveEquipo("RC Deportivo Fabril"), claveEquipo("Deportivo Fabril"));
  assert.equal(claveEquipo("Cádiz CF"), claveEquipo("Cadiz"));
});
test("0-0 en partido sin empezar NO es resultado", () => {
  const p = eventoAPartido(ev({ intHomeScore: "0", intAwayScore: "0", strStatus: "Not Started" }), meta);
  assert.equal(p.estado, "programado"); assert.equal(p.goles_local, null);
});
test("marcador con partido ya jugado -> finalizado", () => {
  const p = eventoAPartido(ev({ dateEvent: "2026-10-03", intHomeScore: "2", intAwayScore: "1", strStatus: "Match Finished" }), meta);
  assert.equal(p.estado, "finalizado"); assert.equal(p.goles_local, 2);
});
test("marcador en fecha futura se ignora", () => {
  const p = eventoAPartido(ev({ intHomeScore: "1", intAwayScore: "0", strStatus: "" }), meta);
  assert.equal(p.estado, "programado");
});
test("partido nuevo se crea y casa nombres con los existentes", () => {
  const p = eventoAPartido(ev(), meta);
  const r = plan([p], [fila({ id: 9, external_id: null, fuente: "redaccion", equipo_local: "Cádiz CF", equipo_visitante: "SD Eibar" })]);
  assert.equal(r.resumen.omitido_duplicado, 1); assert.equal(r.acciones.length, 0);
  const r2 = plan([p], []);
  assert.equal(r2.resumen.creado, 1);
  assert.match(sqlDeAccion(r2.acciones[0], esc), /^INSERT OR IGNORE INTO results/);
});
test("duplicado de redacción aunque la jornada difiera", () => {
  const p = eventoAPartido(ev({ intRound: "12" }), meta);
  const r = plan([p], [fila({ external_id: null, fuente: "redaccion", jornada: 9 })]);
  assert.equal(r.resumen.omitido_duplicado, 1); assert.equal(r.resumen.creado, 0);
});
test("nunca toca partidos de redacción por external_id", () => {
  const r = plan([eventoAPartido(ev(), meta)], [fila({ fuente: "redaccion" })]);
  assert.equal(r.resumen.omitido_redaccion, 1); assert.equal(r.acciones.length, 0);
});
test("NO pisa partido en juego aunque la API no tenga marcador", () => {
  for (const estado of ["en_juego", "descanso", "colgado", "finalizado", "anulado"]) {
    const r = plan([eventoAPartido(ev(), meta)], [fila({ estado, goles_local: 1, goles_visitante: 0 })]);
    assert.equal(r.acciones.length, 0, estado); assert.equal(r.resumen.omitido_estado, 1, estado);
  }
});
test("sin cambios no genera escritura", () => {
  const r = plan([eventoAPartido(ev(), meta)], [fila()]);
  assert.equal(r.resumen.sin_cambios, 1); assert.equal(r.acciones.length, 0);
});
test("cambio de hora en partido programado genera UPDATE con guardas", () => {
  const r = plan([eventoAPartido(ev({ strTime: "18:30:00" }), meta)], [fila()]);
  assert.equal(r.resumen.actualizado, 1);
  const sql = sqlDeAccion(r.acciones[0], esc);
  assert.match(sql, /fecha_partido = '2026-10-10T20:30'/);
  assert.match(sql, /AND estado IN \('programado','retrasado'\)/);
});
test("API solo con fecha no degrada una hora ya conocida", () => {
  const r = plan([eventoAPartido(ev({ strTime: "" }), meta)], [fila()]);
  assert.equal(r.acciones.length, 0);
});
test("adopta partido heredado del primer importador y corrige la hora UTC", () => {
  const legado = fila({ fuente: "auto_api_football", external_id: null, fecha_partido: "2026-10-10T17:30" });
  const r = plan([eventoAPartido(ev(), meta)], [legado]);
  assert.equal(r.resumen.adoptado, 1);
  const sql = sqlDeAccion(r.acciones[0], esc);
  assert.match(sql, /fecha_partido = '2026-10-10T19:30'/);
  assert.match(sql, /fuente = 'auto_thesportsdb'/); assert.match(sql, /external_id = '1'/);
});
test("el calendario de jornadas manda sobre intRound", () => {
  const calendario = [{ competicion: "hypermotion", grupo: null, jornada: 10, fecha_inicio: "2026-10-09", fecha_fin: "2026-10-12" }];
  assert.equal(jornadaDeCalendario(calendario, "hypermotion", null, "2026-10-10T19:30"), 10);
  const r = plan([eventoAPartido(ev({ intRound: "9" }), meta)], [], { calendario });
  assert.equal(r.acciones[0].partido.jornada, 10);
});
test("deduplica eventos repetidos en la respuesta", () => {
  const p = eventoAPartido(ev(), meta);
  assert.equal(plan([p, { ...p }], []).resumen.creado, 1);
});
test("apóstrofos se escapan en SQL", () => {
  const p = eventoAPartido(ev({ strHomeTeam: "L'Hospitalet" }), meta);
  assert.match(sqlDeAccion(plan([p], []).acciones[0], esc), /'L''Hospitalet'/);
});
