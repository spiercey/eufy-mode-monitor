/**
 * Shared login helper: construct the client and drive captcha / 2FA to completion.
 *
 * First run must be interactive (captcha or 2FA is answered in this process). Later runs reuse
 * `.eufy-session.json` and skip that.
 *
 *   npm start
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
  const email = process.env.EUFY_EMAIL?.trim();
  const password = process.env.EUFY_PASSWORD;
  if (!email || !password) {
    throw new Error(
      "EUFY_EMAIL and EUFY_PASSWORD must be set. Copy .env.example to .env, then run: npm start",
    );
  }

  const eufy = new EufyMega({
    email,
    password,
    countryCode: process.env.EUFY_COUNTRY || "CA",
    store: new FileSessionStore(SESSION_FILE),
    // List-devices does not need push / MQTT / P2P. Leave them off so login cannot hang on FCM.
    autoRealtime: false,
    logger: process.env.EUFY_DEBUG ? new ConsoleLogger() : undefined,
    ...overrides,
  });

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
