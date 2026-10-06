// Cliente D1 para el importador (wrangler d1 execute --remote --json).
// Mismo mecanismo que worker-secondary/sync/d1-client.mjs.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const execFileAsync = promisify(execFile);
const DB_NAME = process.env.D1_DATABASE_NAME || "elotrofutbol";
const ES_WINDOWS = process.platform === "win32";
const NPX_CMD = ES_WINDOWS ? "npx.cmd" : "npx";
const D1_TIMEOUT_MS = Number(process.env.D1_TIMEOUT_MS || 180000);

const citarWin = (arg) => `"${String(arg).replace(/"/g, '""')}"`;

async function wrangler(extra) {
  const args = ["wrangler", "d1", "execute", DB_NAME, "--remote", ...extra, "--json"];
  const opts = { maxBuffer: 200 * 1024 * 1024, windowsHide: true, timeout: D1_TIMEOUT_MS };
  try {
    const { stdout } = ES_WINDOWS
      ? await execFileAsync([NPX_CMD, ...args.map(citarWin)].join(" "), { ...opts, shell: true })
      : await execFileAsync(NPX_CMD, args, opts);
    const data = JSON.parse(stdout);
    if (!Array.isArray(data) || !data[0]) throw new Error("Respuesta inesperada de Wrangler:\n" + stdout);
    return data;
  } catch (error) {
    throw new Error(`Wrangler no pudo ejecutar la consulta D1: ${error.message}\n${error.stderr || ""}\n${error.stdout || ""}`);
  }
}

/** Una sentencia (SELECT o escritura). Devuelve las filas. */
export async function ejecutarD1(sql) {
  const data = await wrangler(["--command", sql]);
  return data[0].results || [];
}

/** Varias sentencias de escritura en UNA sola llamada de wrangler (--file). */
export async function ejecutarD1Lote(sentencias) {
  if (!sentencias.length) return;
  const dir = await mkdtemp(path.join(tmpdir(), "importador-"));
  const archivo = path.join(dir, "lote.sql");
  try {
    await writeFile(archivo, sentencias.join("\n") + "\n", "utf8");
    await wrangler(["--file", archivo]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export function escaparValorD1(value) {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "NULL";
  if (typeof value === "boolean") return value ? "1" : "0";
  return "'" + String(value).replace(/'/g, "''") + "'";
}
