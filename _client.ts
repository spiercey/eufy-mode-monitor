/**
 * Shared login helper.
 *
 * Two modes:
 *  - Password present (from `npm run auth`, or EUFY_PASSWORD in .env): full interactive login, driving
 *    captcha / 2FA to completion. The SDK saves the session to `.eufy-session.json`.
 *  - Password absent: run entirely off the saved session — no password is read or needed. If the saved
 *    session is missing/expired, it throws asking you to run `npm run auth`.
 *
 * This lets the sync run with no password on disk: sign in once with `npm run auth`, then only the
 * session token lives in `.eufy-session.json`.
 */
import { writeFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import {
  ConsoleLogger,
  EufyMega,
  FileSessionStore,
  LoginStatus,
  type EufyMegaOptions,
} from "@mega-yfue/eufy-sdk";

const SESSION_FILE = path.join(import.meta.dirname, ".eufy-session.json");
const CAPTCHA_FILE = path.join(import.meta.dirname, ".eufy-captcha.png");

export async function loginClient(overrides: Partial<EufyMegaOptions> = {}): Promise<EufyMega> {
  const email = (overrides.email ?? process.env.EUFY_EMAIL)?.trim();
  const password = overrides.password ?? process.env.EUFY_PASSWORD;
  if (!email) {
    throw new Error("EUFY_EMAIL must be set. Copy .env.example to .env.");
  }

  const eufy = new EufyMega({
    email,
    password: password ?? "",
    countryCode: process.env.EUFY_COUNTRY || "CA",
    store: new FileSessionStore(SESSION_FILE),
    // List-devices does not need push / MQTT / P2P. Leave them off so login cannot hang on FCM.
    autoRealtime: false,
    logger: process.env.EUFY_DEBUG ? new ConsoleLogger() : undefined,
    ...overrides,
  });

  // Password-less mode: rely on the saved session written by `npm run auth`. The password is never
  // read here, so it need not live on disk. (With no password the SDK also won't auto-reauth — it
  // reports the session as expired instead, which is what we want.)
  if (!password) {
    const hydrated = !!(eufy.api as unknown as { auth?: unknown }).auth;
    if (hydrated) {
      const r = await eufy.login();
      if (r.status === LoginStatus.Ok) return eufy;
    }
    throw new Error(
      "No usable eufy session and EUFY_PASSWORD is not set. Run `npm run auth` to sign in once " +
        "(your password is used only in memory and never written to disk).",
    );
  }

  // Password mode (initial sign-in / re-auth): interactive captcha + 2FA.
  let r = await eufy.login();
  while (r.status !== LoginStatus.Ok) {
    if (r.status === LoginStatus.Captcha) {
      writeFileSync(CAPTCHA_FILE, Buffer.from(r.image.replace(/^data:image\/\w+;base64,/, ""), "base64"));
      r = await eufy.solveCaptcha(await ask(`captcha required — open ${CAPTCHA_FILE} and type the characters`));
    } else if (r.status === LoginStatus.TwoFactor) {
      r = await eufy.submitVerifyCode(await ask(`2FA code sent (${r.method}) — enter it`));
    } else {
      throw new Error(`unexpected login status: ${JSON.stringify(r)}`);
    }
  }
  return eufy;
}

async function ask(prompt: string): Promise<string> {
  if (!process.stdin.isTTY) {
    throw new Error(
      `${prompt}: run this in an interactive terminal (later runs reuse ${SESSION_FILE})`,
    );
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(`${prompt}: `)).trim();
  } finally {
    rl.close();
  }
}
