// Cliente D1 para el importador de TheSportsDB.
// Copia deliberada del mismo mecanismo que ya usa worker-secondary/sync/d1-client.mjs
// (wrangler d1 execute --remote --json), para no introducir una segunda
// forma de hablar con D1 con comportamiento distinto. Ver ese archivo si
// hace falta tocar el mecanismo de invocación de Wrangler en sí.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const DB_NAME = process.env.D1_DATABASE_NAME || "elotrofutbol";
const ES_WINDOWS = process.platform === "win32";
const NPX_CMD = ES_WINDOWS ? "npx.cmd" : "npx";
const D1_TIMEOUT_MS = Number(process.env.D1_TIMEOUT_MS || 120000);

function citarArgumentoWindows(arg) {
  return `"${String(arg).replace(/"/g, '""')}"`;
}

/**
 * Ejecuta SQL contra D1 remoto (sirve tanto para SELECT como para
 * INSERT/UPDATE: wrangler d1 execute --json devuelve igualmente un array
 * con "results" y "meta", vacío en el caso de escrituras sin RETURNING).
 */
export async function ejecutarD1(sql) {
  const args = ["wrangler", "d1", "execute", DB_NAME, "--remote", "--command", sql, "--json"];

  try {
    let stdout;
    if (ES_WINDOWS) {
      const comando = [NPX_CMD, ...args.map(citarArgumentoWindows)].join(" ");
      ({ stdout } = await execFileAsync(comando, {
        shell: true,
        maxBuffer: 200 * 1024 * 1024,
        windowsHide: true,
        timeout: D1_TIMEOUT_MS,
      }));
    } else {
      ({ stdout } = await execFileAsync(NPX_CMD, args, {
        maxBuffer: 200 * 1024 * 1024,
        windowsHide: true,
        timeout: D1_TIMEOUT_MS,
      }));
    }

    const data = JSON.parse(stdout);
    if (!Array.isArray(data) || !data[0]) {
      throw new Error("Respuesta inesperada de Wrangler:\n" + stdout);
    }
    return data[0].results || [];
  } catch (error) {
    const stderr = error.stderr || "";
    const stdout = error.stdout || "";
    throw new Error(`Wrangler no pudo ejecutar la consulta D1: ${error.message}\n${stderr}\n${stdout}`);
  }
}

export function escaparValorD1(value) {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "1" : "0";
  return "'" + String(value).replace(/'/g, "''") + "'";
}
