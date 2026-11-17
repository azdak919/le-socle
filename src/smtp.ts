import { connect, type Socket } from "node:net";
import { connect as connectTls } from "node:tls";

export type SmtpSettings = {
  host: string;
  port: number;
  secure?: boolean;
  user?: string;
  password?: string;
  from: string;
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

export async function sendSmtp(settings: SmtpSettings, to: string, subject: string, text: string): Promise<void> {
  const socket = settings.secure
    ? connectTls({ host: settings.host, port: settings.port, servername: settings.host })
    : connect({ host: settings.host, port: settings.port });
  socket.setTimeout(5000);
  socket.on("timeout", () => socket.destroy(new Error("smtp muet")));
  const replies = replyReader(socket);
  try {
    await connected(socket, settings.secure === true);
    await expectCode(await replies.next(), 220);
    await writeLine(socket, "EHLO socle");
    await expectCode(await replies.next(), 250);
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

function expectCode(reply: string, code: number): void {
  const last = reply.split("\n").at(-1) ?? "";
  if (!last.startsWith(String(code))) throw new Error("smtp refusé");
}
