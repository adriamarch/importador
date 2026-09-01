// Cliente mínimo de TheSportsDB (API gratuita, key pública "123").
// Ver documentación: https://www.thesportsdb.com/documentation
//
// Límites del plan gratuito relevantes aquí:
//  - 30 peticiones/minuto (429 si se supera; ver esperar() más abajo).
//  - eventsnextleague.php / eventspastleague.php: 1 petición de "limit"
//    por liga (free), devuelve las próximas/últimas ~15 según la API.
//  - search_all_leagues.php: limitado a 10 resultados en el plan free,
//    así que NO lo usamos para resolver ligas (ver resolverLigaPorNombre).

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
  primera_federacion_grupo_1: { idLeague: "5086", nombre: "Spanish Primera RFEF Group 1", grupo: "Grupo 1" },
  primera_federacion_grupo_2: { idLeague: "5088", nombre: "Spanish Primera RFEF Group 2", grupo: "Grupo 2" },
};

// Nombres a buscar para los 5 grupos de Segunda Federación, no
// confirmados aún por ID. Se resuelven por nombre en resolverLigasPendientes().
export const LIGAS_A_RESOLVER = [
  { clave: "segunda_federacion_grupo_1", nombreBusqueda: "Segunda RFEF Group 1", grupo: "Grupo 1" },
  { clave: "segunda_federacion_grupo_2", nombreBusqueda: "Segunda RFEF Group 2", grupo: "Grupo 2" },
  { clave: "segunda_federacion_grupo_3", nombreBusqueda: "Segunda RFEF Group 3", grupo: "Grupo 3" },
  { clave: "segunda_federacion_grupo_4", nombreBusqueda: "Segunda RFEF Group 4", grupo: "Grupo 4" },
  { clave: "segunda_federacion_grupo_5", nombreBusqueda: "Segunda RFEF Group 5", grupo: "Grupo 5" },
];

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

/** Próximos partidos programados de una liga (hasta ~15 en plan free). */
export async function eventosProximos(idLeague) {
  const data = await peticionJson(`${BASE_URL}/eventsnextleague.php?id=${idLeague}`);
  return data.events || [];
}

/** Últimos partidos jugados de una liga (hasta ~15 en plan free). */
export async function eventosPasados(idLeague) {
  const data = await peticionJson(`${BASE_URL}/eventspastleague.php?id=${idLeague}`);
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

// IDs candidatos a probar para los grupos de Segunda Federación que no
// se pudieron confirmar de antemano (ver conversación de configuración).
// El script los verifica uno a uno con verificarLiga() al arrancar.
export const IDS_CANDIDATOS_SEGUNDA_FEDERACION = {
  segunda_federacion_grupo_1: { candidatos: ["5087"], fragmento: "Segunda RFEF Group 1" },
  segunda_federacion_grupo_2: { candidatos: ["5089"], fragmento: "Segunda RFEF Group 2" },
  segunda_federacion_grupo_3: { candidatos: ["5090", "5092", "5093"], fragmento: "Segunda RFEF Group 3" },
  segunda_federacion_grupo_4: { candidatos: ["5091"], fragmento: "Segunda RFEF Group 4" },
  segunda_federacion_grupo_5: { candidatos: ["5092", "5090", "5093"], fragmento: "Segunda RFEF Group 5" },
};
