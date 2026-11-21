import { connect, type Socket } from "node:net";
import { connect as connectTls, type TLSSocket } from "node:tls";

import type { SocleStore } from "./store.ts";

export type SmtpSettings = {
  host: string;
  port: number;
  secure?: boolean;
  user?: string;
  password?: string;
  from: string;
  /** Seulement pour les essais locaux : ne pas activer en production. */
  rejectUnauthorized?: boolean;
};

export function smtpFromEnv(env: NodeJS.ProcessEnv = process.env): SmtpSettings | null {
  const host = env.SOCLE_SMTP_HOST?.trim();
  const from = env.SOCLE_SMTP_FROM?.trim();
  if (!host || !from) return null;
  const port = Number(env.SOCLE_SMTP_PORT ?? (env.SOCLE_SMTP_SECURE === "1" ? 465 : 587));
  if (!Number.isInteger(port) || port < 1) return null;
  return {
    host,
    port,
    secure: env.SOCLE_SMTP_SECURE === "1",
    user: env.SOCLE_SMTP_USER,
    password: env.SOCLE_SMTP_PASSWORD,
    from,
  };
}

function tlsOptions(settings: SmtpSettings): { servername: string; rejectUnauthorized: boolean } {
  return { servername: settings.host, rejectUnauthorized: settings.rejectUnauthorized !== false };
}

export async function sendSmtp(settings: SmtpSettings, to: string, subject: string, text: string): Promise<void> {
  let socket: Socket = settings.secure
    ? connectTls({ host: settings.host, port: settings.port, ...tlsOptions(settings) })
    : connect({ host: settings.host, port: settings.port });
  socket.setTimeout(5000);
  socket.on("timeout", () => socket.destroy(new Error("smtp muet")));
  let replies = replyReader(socket);
  try {
    await connected(socket, settings.secure === true);
    await expectCode(await replies.next(), 220);
    await writeLine(socket, "EHLO socle");
    const ehlo = await expectCode(await replies.next(), 250);
    // Port 587 typique : STARTTLS si le serveur l'annonce. Sans cette annonce, on
    // reste en clair (essais locaux). En production, le journal règle SOCLE_SMTP_SECURE=1
    // (port 465) ou un serveur qui propose STARTTLS.
    if (!settings.secure && /\bSTARTTLS\b/i.test(ehlo)) {
      await writeLine(socket, "STARTTLS");
      await expectCode(await replies.next(), 220);
      replies.stop();
      socket = await upgradeTls(socket, tlsOptions(settings));
      socket.setTimeout(5000);
      socket.on("timeout", () => socket.destroy(new Error("smtp muet")));
      replies = replyReader(socket);
      await writeLine(socket, "EHLO socle");
      await expectCode(await replies.next(), 250);
    }
    if (settings.user) {
      await writeLine(socket, "AUTH LOGIN");
      await expectCode(await replies.next(), 334);
      await writeLine(socket, Buffer.from(settings.user).toString("base64"));
      await expectCode(await replies.next(), 334);
      await writeLine(socket, Buffer.from(settings.password ?? "").toString("base64"));
      await expectCode(await replies.next(), 235);
    }
    await writeLine(socket, `MAIL FROM:<${settings.from}>`);
    await expectCode(await replies.next(), 250);
    await writeLine(socket, `RCPT TO:<${to}>`);
    await expectCode(await replies.next(), 250);
    await writeLine(socket, "DATA");
    await expectCode(await replies.next(), 354);
    const stuffed = text.replace(/\r?\n/g, "\r\n").split("\r\n")
      .map((line) => line.startsWith(".") ? `.${line}` : line)
      .join("\r\n");
    await writeLine(socket, [
      `From: ${settings.from}`,
      `To: ${to}`,
      `Subject: ${subject}`,
      "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=utf-8",
      "",
      stuffed,
      ".",
    ].join("\r\n"));
    await expectCode(await replies.next(), 250);
    await writeLine(socket, "QUIT");
  } finally {
    replies.stop();
    socket.end();
  }
}

function connected(socket: Socket, secure: boolean): Promise<void> {
  return new Promise((resolve, reject) => {
    const event = secure ? "secureConnect" : "connect";
    const timer = setTimeout(() => {
      socket.off(event, onReady);
      socket.off("error", onError);
      socket.destroy();
      reject(new Error("smtp muet"));
    }, 5000);
    const onReady = () => {
      clearTimeout(timer);
      socket.off("error", onError);
      resolve();
    };
    const onError = (error: Error) => {
      clearTimeout(timer);
      socket.off(event, onReady);
      reject(error);
    };
    socket.once(event, onReady);
    socket.once("error", onError);
  });
}

function writeLine(socket: Socket, line: string): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.write(`${line}\r\n`, (error) => error ? reject(error) : resolve());
  });
}

function replyReader(socket: Socket): { next: () => Promise<string>; stop: () => void } {
  let pending = "";
  const ready: string[] = [];
  let waiter: ((value: string) => void) | null = null;
  let rejecter: ((error: Error) => void) | null = null;
  let timer: NodeJS.Timeout | null = null;

  const arm = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => fail(new Error("smtp muet")), 5000);
  };
  const fail = (error: Error) => {
    if (timer) clearTimeout(timer);
    rejecter?.(error);
    waiter = null;
    rejecter = null;
  };
  const pushLine = (line: string) => {
    ready.push(line);
    if (!waiter) return;
    const end = ready.findIndex((item) => /^\d{3} /.test(item));
    if (end === -1) return;
    const lines = ready.splice(0, end + 1);
    const resolve = waiter;
    waiter = null;
    rejecter = null;
    if (timer) clearTimeout(timer);
    resolve(lines.join("\n"));
  };
  const onData = (chunk: Buffer) => {
    pending += chunk.toString("utf8");
    const parts = pending.split(/\r?\n/);
    pending = parts.pop() ?? "";
    for (const line of parts) if (line.length > 0) pushLine(line);
  };
  socket.on("data", onData);
  socket.on("error", fail);

  return {
    next: () => new Promise((resolve, reject) => {
      waiter = resolve;
      rejecter = reject;
      arm();
      const end = ready.findIndex((item) => /^\d{3} /.test(item));
      if (end === -1) return;
      const lines = ready.splice(0, end + 1);
      waiter = null;
      rejecter = null;
      if (timer) clearTimeout(timer);
      resolve(lines.join("\n"));
    }),
    stop: () => {
      socket.off("data", onData);
      socket.off("error", fail);
      if (timer) clearTimeout(timer);
    },
  };
}

function expectCode(reply: string, code: number): string {
  const last = reply.split("\n").at(-1) ?? "";
  if (!last.startsWith(String(code))) throw new Error("smtp refusé");
  return reply;
}

function upgradeTls(socket: Socket, options: { servername: string; rejectUnauthorized: boolean }): Promise<TLSSocket> {
  return new Promise((resolve, reject) => {
    const tlsSocket = connectTls({ socket, ...options }, () => resolve(tlsSocket));
    tlsSocket.once("error", reject);
  });
}


export const SMTP_STORE_KEY = "smtp:settings";

export type SmtpProvider = "hebergeur" | "gmail" | "outlook" | "personnalise";

export type SmtpPublic = {
  fournisseur: SmtpProvider;
  host: string;
  port: number;
  secure: boolean;
  user: string;
  from: string;
  motDePasseEnregistre: boolean;
  source: "enregistrement" | "environnement" | "absent";
};

const PROVIDERS: SmtpProvider[] = ["hebergeur", "gmail", "outlook", "personnalise"];

type StoredSmtp = {
  fournisseur?: string;
  host?: string;
  port?: number;
  secure?: boolean;
  user?: string;
  password?: string;
  from?: string;
};

export function isSmtpProvider(value: unknown): value is SmtpProvider {
  return typeof value === "string" && (PROVIDERS as string[]).includes(value);
}

function parseStored(raw: string | null): StoredSmtp | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as StoredSmtp;
    if (!parsed || typeof parsed !== "object") return null;
    return parsed;
  } catch {
    return null;
  }
}

function completeSettings(row: StoredSmtp | SmtpSettings | null | undefined): SmtpSettings | null {
  if (!row) return null;
  const host = String(row.host ?? "").trim();
  const from = String(row.from ?? "").trim();
  const port = Number(row.port);
  if (!host || !from || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  const user = typeof row.user === "string" ? row.user.trim() : "";
  const password = typeof row.password === "string" ? row.password : "";
  return {
    host,
    port,
    secure: Boolean(row.secure),
    user: user || undefined,
    password: password || undefined,
    from,
  };
}

export async function smtpFromStore(store: SocleStore): Promise<SmtpSettings | null> {
  return completeSettings(parseStored(await store.get("auth", SMTP_STORE_KEY)));
}

/** Réglages enregistrés dans l’espace de rédaction, sinon ceux de l’environnement. */
export async function resolveSmtp(
  store: SocleStore,
  env: NodeJS.ProcessEnv = process.env,
): Promise<SmtpSettings | null> {
  return (await smtpFromStore(store)) ?? smtpFromEnv(env);
}

export async function readSmtpPublic(
  store: SocleStore,
  env: NodeJS.ProcessEnv = process.env,
): Promise<SmtpPublic> {
  const stored = parseStored(await store.get("auth", SMTP_STORE_KEY));
  if (stored && completeSettings(stored)) {
    return {
      fournisseur: isSmtpProvider(stored.fournisseur) ? stored.fournisseur : "personnalise",
      host: String(stored.host ?? "").trim(),
      port: Number(stored.port),
      secure: Boolean(stored.secure),
      user: String(stored.user ?? "").trim(),
      from: String(stored.from ?? "").trim(),
      motDePasseEnregistre: Boolean(stored.password),
      source: "enregistrement",
    };
  }
  const envSettings = smtpFromEnv(env);
  if (envSettings) {
    return {
      fournisseur: "personnalise",
      host: envSettings.host,
      port: envSettings.port,
      secure: Boolean(envSettings.secure),
      user: envSettings.user ?? "",
      from: envSettings.from,
      motDePasseEnregistre: Boolean(envSettings.password),
      source: "environnement",
    };
  }
  return {
    fournisseur: "hebergeur",
    host: "",
    port: 465,
    secure: true,
    user: "",
    from: "",
    motDePasseEnregistre: false,
    source: "absent",
  };
}

export async function saveSmtpSettings(
  store: SocleStore,
  body: Record<string, unknown>,
): Promise<SmtpPublic> {
  if (!isSmtpProvider(body.fournisseur)) throw new Error("demande refusée");
  const host = typeof body.host === "string" ? body.host.trim() : "";
  const from = typeof body.from === "string" ? body.from.trim() : "";
  const user = typeof body.user === "string" ? body.user.trim() : "";
  const port = Number(body.port);
  const secure = body.secure === true || body.secure === "1";
  const incomingPassword = typeof body.password === "string" ? body.password : "";
  if (!host || !from || !user || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("réglages incomplets");
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(from) || from.length > 200) throw new Error("demande refusée");
  const previous = parseStored(await store.get("auth", SMTP_STORE_KEY));
  const password = incomingPassword || previous?.password || "";
  if (!password) throw new Error("réglages incomplets");
  const stored: StoredSmtp = {
    fournisseur: body.fournisseur,
    host,
    port,
    secure,
    user,
    password,
    from,
  };
  await store.put("auth", SMTP_STORE_KEY, JSON.stringify(stored));
  return readSmtpPublic(store);
}

export async function clearSmtpSettings(store: SocleStore): Promise<SmtpPublic> {
  await store.delete("auth", SMTP_STORE_KEY);
  return readSmtpPublic(store);
}

/** Message d’erreur en français, sans secret ni détail technique brut. */
export function smtpErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : "";
  if (raw === "smtp muet") {
    return "Impossible de joindre le serveur d’envoi. Vérifiez l’hôte et le port.";
  }
  if (raw === "smtp refusé") {
    return "Le serveur d’envoi a refusé la connexion. Vérifiez l’identifiant, le mot de passe et le chiffrement (465 SSL ou 587 STARTTLS).";
  }
  if (raw === "smtp absent" || raw === "réglages incomplets") {
    return "L’envoi de courriel n’est pas réglé. Indiquez l’hôte, l’expéditeur, l’identifiant et le mot de passe.";
  }
  if (raw === "demande refusée") return "demande refusée";
  return "L’envoi a échoué. Vérifiez les réglages. Le mot de passe n’a pas été modifié à l’écran.";
}

export function smtpErrorCode(error: unknown): "smtp muet" | "smtp refusé" | "smtp absent" | "réglages incomplets" | "demande refusée" | "envoi échoué" {
  const raw = error instanceof Error ? error.message : "";
  if (raw === "smtp muet" || raw === "smtp refusé" || raw === "smtp absent" || raw === "réglages incomplets" || raw === "demande refusée") {
    return raw;
  }
  return "envoi échoué";
}
