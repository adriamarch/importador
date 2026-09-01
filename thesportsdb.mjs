// Cliente mínimo de TheSportsDB (API gratuita, key pública "123").
// Ver documentación: https://www.thesportsdb.com/documentation
//
// Límites del plan gratuito relevantes aquí:
//  - 30 peticiones/minuto (429 si se supera; ver esperar() más abajo).
//  - eventsnextleague.php / eventspastleague.php: LIMITADO A 1 EVENTO
//    por petición en el plan free (confirmado el 2026-09-01 contra la
//    API real — la doc antigua/comentarios previos de este archivo
//    decían "~15", pero TheSportsDB bajó el límite y ahora devuelve
//    literalmente 1 evento, sin importar la liga). Por eso NO se usan
//    para traer el calendario: solo servirían para "ir arrastrando" 1
//    partido por ejecución, inservible para tener cobertura real.
//  - eventsseason.php: SÍ funciona en el plan free y devuelve la
//    temporada COMPLETA de una liga de una sola vez (confirmado con
//    idLeague=4400, ~100+ eventos). Es el endpoint que usamos ahora
//    para traer partidos (ver eventosTemporada más abajo).
//  - search_all_leagues.php / all_leagues.php: limitados a ~10
//    resultados en el plan free, así que NO se usan para resolver
//    ligas por nombre (ver resolverLigaConocida: los IDs se confirman
//    a mano contra lookupleague.php y se guardan fijos en
//    LIGAS_CONOCIDAS).

const API_KEY = process.env.THESPORTSDB_API_KEY || "123";
const BASE_URL = `https://www.thesportsdb.com/api/v1/json/${API_KEY}`;

// IDs de liga confirmados manualmente contra la propia API (ver
// conversación de configuración inicial). Los 5 grupos de Segunda
// Federación no se pudieron confirmar todos con la key gratuita
// (search_all_leagues.php viene truncado a 10 resultados en el plan
// free), así que esos se resuelven en caliente la primera vez que
// corre el script contra lookupleague.php por nombre y se cachean en
// LIGAS_CACHE_PATH para no tener que repetir la búsqueda cada vez.
export const LIGAS_CONOCIDAS = {
  hypermotion: { idLeague: "4400", nombre: "Spanish La Liga 2", grupo: null },
  primera_federacion_grupo_1: { idLeague: "5086", nombre: "Spanish Primera Federación Group 1", grupo: "Grupo 1" },
  primera_federacion_grupo_2: { idLeague: "5088", nombre: "Spanish Primera Federación Group 2", grupo: "Grupo 2" },
  // Confirmados manualmente contra lookupleague.php el 2026-09-01 (ver
  // conversación de soporte): los 5 grupos de Segunda Federación SÍ
  // existen con estos IDs. El fallo anterior era de comparación de
  // nombre en verificarLiga (buscaba "RFEF"; la API devuelve "Federación").
  segunda_federacion_grupo_1: { idLeague: "5087", nombre: "Spanish Segunda Federación Group 1", grupo: "Grupo 1" },
  segunda_federacion_grupo_2: { idLeague: "5089", nombre: "Spanish Segunda Federación Group 2", grupo: "Grupo 2" },
  segunda_federacion_grupo_3: { idLeague: "5090", nombre: "Spanish Segunda Federación Group 3", grupo: "Grupo 3" },
  segunda_federacion_grupo_4: { idLeague: "5091", nombre: "Spanish Segunda Federación Group 4", grupo: "Grupo 4" },
  segunda_federacion_grupo_5: { idLeague: "5092", nombre: "Spanish Segunda Federación Group 5", grupo: "Grupo 5" },
};

let ultimaPeticionEn = 0;
const MIN_MS_ENTRE_PETICIONES = 2100; // ~28/min, margen bajo el límite de 30/min free

async function esperarRateLimit() {
  const ahora = Date.now();
  const transcurrido = ahora - ultimaPeticionEn;
  if (transcurrido < MIN_MS_ENTRE_PETICIONES) {
    await new Promise((r) => setTimeout(r, MIN_MS_ENTRE_PETICIONES - transcurrido));
  }
  ultimaPeticionEn = Date.now();
}

async function peticionJson(url, { reintentos = 3 } = {}) {
  await esperarRateLimit();
  const resp = await fetch(url);
  if (resp.status === 429) {
    if (reintentos <= 0) throw new Error(`Rate limit persistente en ${url}`);
    await new Promise((r) => setTimeout(r, 15000));
    return peticionJson(url, { reintentos: reintentos - 1 });
  }
  if (!resp.ok) {
    throw new Error(`TheSportsDB respondió ${resp.status} para ${url}`);
  }
  return resp.json();
}

/**
 * Próximos partidos programados de una liga.
 * OJO: el plan free de TheSportsDB limita este endpoint a 1 evento por
 * petición (ver comentario de cabecera). Se deja exportada por si algún
 * caller la necesita puntualmente, pero import-partidos.mjs ya NO la usa
 * para el import principal — usa eventosTemporada() en su lugar.
 */
export async function eventosProximos(idLeague) {
  const data = await peticionJson(`${BASE_URL}/eventsnextleague.php?id=${idLeague}`);
  return data.events || [];
}

/**
 * Últimos partidos jugados de una liga.
 * Mismo aviso que eventosProximos: limitado a 1 evento en plan free.
 */
export async function eventosPasados(idLeague) {
  const data = await peticionJson(`${BASE_URL}/eventspastleague.php?id=${idLeague}`);
  return data.events || [];
}

/**
 * Temporada actual configurada para una liga (strCurrentSeason de
 * lookupleague.php). Se resuelve dinámicamente en vez de hardcodearla
 * porque distintas ligas pueden estar en temporadas distintas y ese
 * valor puede quedarse desactualizado en TheSportsDB para ligas menos
 * mantenidas (visto en pruebas: alguna liga devolvía "2019-2020").
 */
export async function temporadaActual(idLeague) {
  const data = await peticionJson(`${BASE_URL}/lookupleague.php?id=${idLeague}`);
  const liga = (data.leagues || [])[0];
  return liga?.strCurrentSeason || null;
}

/**
 * Todos los partidos de una liga en una temporada dada, en una sola
 * petición (eventsseason.php SÍ funciona sin recortar en el plan free,
 * a diferencia de eventsnextleague/eventspastleague). Esta es la vía
 * recomendada para traer el calendario completo de una liga.
 */
export async function eventosTemporada(idLeague, temporada) {
  const data = await peticionJson(
    `${BASE_URL}/eventsseason.php?id=${idLeague}&s=${encodeURIComponent(temporada)}`
  );
  return data.events || [];
}

/**
 * Busca el idLeague de una liga por nombre exacto de TheSportsDB.
 * Usa lookupleague.php iterando sobre un rango no es viable (no hay
 * endpoint de "search por nombre" fiable en el plan free), así que en su
 * lugar pedimos confirmación manual la primera vez: si no está en un
 * caché local, devolvemos null y lo dejamos registrado para revisión.
 */
export function resolverLigaConocida(clave) {
  return LIGAS_CONOCIDAS[clave] || null;
}

// Ya no quedan ligas pendientes de resolver por nombre: los 5 grupos de
// Segunda Federación se movieron a LIGAS_CONOCIDAS (ver arriba). Se deja
// el array vacío por compatibilidad, por si import-partidos.mjs lo importa.
export const LIGAS_A_RESOLVER = [];

/**
 * Verifica un idLeague candidato contra lookupleague.php y comprueba
 * que su nombre coincide (aproximadamente) con el esperado. Se usa para
 * los grupos de Segunda Federación no confirmados de antemano (ver
 * IDS_CANDIDATOS_SEGUNDA_FEDERACION): probamos un rango pequeño de IDs
 * candidatos y nos quedamos con el que encaje, en vez de arriesgarnos a
 * escribir partidos en la liga equivocada con un ID adivinado a ciegas.
 */
export async function verificarLiga(idLeague, fragmentoNombreEsperado) {
  const data = await peticionJson(`${BASE_URL}/lookupleague.php?id=${idLeague}`);
  const liga = (data.leagues || [])[0];
  if (!liga) return null;
  const coincide = liga.strLeague
    .toLowerCase()
    .includes(fragmentoNombreEsperado.toLowerCase());
  return coincide ? { idLeague, nombre: liga.strLeague } : null;
}

// NOTA (2026-09-01): los 5 grupos de Segunda Federación ya están
// confirmados y movidos a LIGAS_CONOCIDAS de forma fija. Se mantiene
// esta tabla solo por compatibilidad, con el fragmento corregido
// ("Federación" en vez de "RFEF", que nunca aparecía en strLeague y
// hacía que verificarLiga() descartara siempre los candidatos, aunque
// fueran correctos) por si algún caller todavía la usa como fallback.
export const IDS_CANDIDATOS_SEGUNDA_FEDERACION = {
  segunda_federacion_grupo_1: { candidatos: ["5087"], fragmento: "Segunda Federación Group 1" },
  segunda_federacion_grupo_2: { candidatos: ["5089"], fragmento: "Segunda Federación Group 2" },
  segunda_federacion_grupo_3: { candidatos: ["5090"], fragmento: "Segunda Federación Group 3" },
  segunda_federacion_grupo_4: { candidatos: ["5091"], fragmento: "Segunda Federación Group 4" },
  segunda_federacion_grupo_5: { candidatos: ["5092"], fragmento: "Segunda Federación Group 5" },
};
