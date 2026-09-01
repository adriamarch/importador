// Conversión de horas UTC (formato que da TheSportsDB, ver
// "Timezone: utc" al final de su documentación) al formato que espera
// fecha_partido en la base de datos: "YYYY-MM-DDTHH:MM" en hora de
// MADRID, SIN sufijo de zona horaria (igual que lo escribe a mano el
// redactor desde el <input type="datetime-local"> del panel).
//
// Esto es el espejo exacto, pero en sentido inverso, de
// offsetMadridEnMinutos() / fechaPartidoAUtcSqlite() en worker/src/index.js.
// Si algún día cambia cómo ese archivo interpreta fecha_partido, este
// archivo tiene que cambiar en el mismo sentido o se repite el bug de
// desfase de 2h que motivó este importador.
//
// Por qué el bug original: TheSportsDB (y cualquier API real) da la hora
// en UTC. El primer import (24 agosto) copió esa hora UTC directamente en
// fecha_partido, que el resto del sistema trata como si ya fuera hora de
// Madrid sin TZ. En CEST (verano, UTC+2) eso deja el partido guardado 2h
// antes de la hora real.

/**
 * Offset de Madrid (en minutos) respecto a UTC para un instante dado.
 * Positivo: Madrid va por delante de UTC (CEST = +120, CET = +60).
 * Usa Intl para que el cambio de hora de primavera/otoño se resuelva
 * solo, sin tablas de fechas hardcodeadas.
 */
function offsetMadridEnMinutos(instanteUtc) {
  const partes = new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/Madrid", hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(instanteUtc).reduce((acc, p) => (acc[p.type] = p.value, acc), {});
  const comoSiFueraUTC = Date.UTC(
    partes.year, partes.month - 1, partes.day, partes.hour, partes.minute, partes.second
  );
  return Math.round((comoSiFueraUTC - instanteUtc.getTime()) / 60000);
}

/**
 * Convierte dateEvent ("YYYY-MM-DD") + strTime ("HH:MM:SS" o
 * "HH:MM:SS+00:00", ambos en UTC según TheSportsDB) al formato
 * "YYYY-MM-DDTHH:MM" en hora de Madrid que espera fecha_partido.
 *
 * OJO: usa siempre strTime (o strTimestamp con su "Z"/offset explícito),
 * NUNCA strTimestamp a pelo interpretándolo como si ya fuera hora local
 * -ese es exactamente el error que causó el desfase de 2h-.
 */
export function eventoAFechaPartidoMadrid(dateEvent, strTime) {
  if (!dateEvent || !strTime) return null;
  // strTime puede venir como "19:00:00" o "19:00:00+00:00"; en ambos
  // casos son UTC (ver "Timezone: utc" en la documentación de la API),
  // así que forzamos el sufijo Z tras quitar cualquier offset previo.
  const horaLimpia = strTime.replace(/[+-]\d\d:?\d\d$/, "").trim();
  const instanteUtc = new Date(`${dateEvent}T${horaLimpia}Z`);
  if (isNaN(instanteUtc.getTime())) return null;

  const offset = offsetMadridEnMinutos(instanteUtc);
  const instanteMadrid = new Date(instanteUtc.getTime() + offset * 60000);

  const yyyy = instanteMadrid.getUTCFullYear();
  const mm = String(instanteMadrid.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(instanteMadrid.getUTCDate()).padStart(2, "0");
  const hh = String(instanteMadrid.getUTCHours()).padStart(2, "0");
  const mi = String(instanteMadrid.getUTCMinutes()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}T${hh}:${mi}`;
}

/**
 * Caso sin hora conocida todavía (la API a veces da solo dateEvent, sin
 * strTime, para partidos muy lejanos en el calendario): fecha_partido
 * solo con fecha, formato "YYYY-MM-DD" (longitud 10, el resto del
 * sistema ya distingue este caso de "con hora", longitud 16).
 */
export function soloFecha(dateEvent) {
  return dateEvent || null;
}
