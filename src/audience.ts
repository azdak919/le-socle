import type { SocleStore } from "./store.ts";

const TOKEN = /^[a-z0-9][a-z0-9-]{0,23}$/;
const BUILTIN = new Set(["article", "sport"]);
const WINDOW_MS = 5 * 60 * 1000;
const DEFAULT_CAP = 60;

const bursts = new Map<string, { count: number; at: number }>();

export function civilDate(now: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Toronto",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

export function resetBursts(): void {
  bursts.clear();
}

export async function allowName(store: SocleStore, name: string): Promise<void> {
  if (!TOKEN.test(name) || BUILTIN.has(name)) throw new AudienceError("nom refusé");
  await store.put("audience", `allowed:${name}`, "1");
}

export async function recordEvent(
  store: SocleStore,
  now: Date,
  name: string,
  contexte: string,
  cap = DEFAULT_CAP,
): Promise<void> {
  if (!TOKEN.test(name) || !TOKEN.test(contexte)) throw new AudienceError("demande refusée");
  if (!BUILTIN.has(name)) {
    const allowed = await store.get("audience", `allowed:${name}`);
    if (allowed !== "1") throw new AudienceError("nom refusé");
  }
  if (!takeBurst(`${name}:${contexte}`, now.getTime(), cap)) return;
  const day = civilDate(now);
  const key = `day:${day}:${name}:${contexte}`;
  const current = Number(await store.get("audience", key) ?? "0");
  await store.put("audience", key, String(current + 1));
  await rollup(store, day);
}

export async function totalsFor(store: SocleStore, now: Date): Promise<Array<{ name: string; contexte: string; count: number }>> {
  const day = civilDate(now);
  const rows = await store.list("audience");
  const totals = [];
  for (const row of rows) {
    if (!row.key.startsWith(`day:${day}:`)) continue;
    const [, , name, contexte] = row.key.split(":");
    if (!name || !contexte) continue;
    totals.push({ name, contexte, count: Number(row.value) });
  }
  totals.sort((a, b) => a.name.localeCompare(b.name) || a.contexte.localeCompare(b.contexte));
  return totals;
}

export class AudienceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AudienceError";
  }
}

function takeBurst(key: string, now: number, cap: number): boolean {
  for (const [stored, value] of bursts) {
    if (now - value.at > WINDOW_MS) bursts.delete(stored);
  }
  const current = bursts.get(key);
  if (!current || now - current.at > WINDOW_MS) {
    bursts.set(key, { count: 1, at: now });
    return true;
  }
  if (current.count >= cap) return false;
  current.count += 1;
  return true;
}

async function rollup(store: SocleStore, today: string): Promise<void> {
  const rows = await store.list("audience");
  for (const row of rows) {
    if (!row.key.startsWith("day:")) continue;
    const date = row.key.split(":")[1] ?? "";
    if (!date || ageDays(date, today) <= 90) continue;
    const parts = row.key.split(":");
    const name = parts[2] ?? "";
    const contexte = parts[3] ?? "";
    const weekKey = `week:${isoWeek(date)}:${name}:${contexte}`;
    const sum = Number(await store.get("audience", weekKey) ?? "0") + Number(row.value);
    await store.put("audience", weekKey, String(sum));
    await store.delete("audience", row.key);
  }
}

function ageDays(older: string, today: string): number {
  const start = Date.parse(`${older}T00:00:00Z`);
  const end = Date.parse(`${today}T00:00:00Z`);
  return Math.round((end - start) / 86_400_000);
}

function isoWeek(date: string): string {
  const [year, month, day] = date.split("-").map(Number);
  const utc = new Date(Date.UTC(year ?? 0, (month ?? 1) - 1, day ?? 1));
  const weekday = utc.getUTCDay() || 7;
  utc.setUTCDate(utc.getUTCDate() + 4 - weekday);
  const yearStart = new Date(Date.UTC(utc.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((utc.getTime() - yearStart.getTime()) / 86_400_000) + 1) / 7);
  return `${utc.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}
