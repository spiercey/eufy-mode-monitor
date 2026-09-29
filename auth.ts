/**
 * Interactive eufy sign-in.
 *
 * Prompts for the password (kept in memory only — never written to disk), completes any captcha / 2FA,
 * and saves the session to `.eufy-session.json`. After this, `npm run sync` and `npm run guard` work
 * without a password in `.env`.
 *
 * Re-run this any time the session expires (e.g. after a password change):
 *
 *   npm run auth
 */
import { createInterface } from "node:readline/promises";
import { loginClient } from "./_client.ts";

async function askLine(prompt: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(`${prompt}: `)).trim();
  } finally {
    rl.close();
  }
}

/** Read a secret without echoing it to the terminal. */
function askHidden(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    const { stdin, stdout } = process;
    if (!stdin.isTTY) {
      // Non-interactive fallback (e.g. piped input): read a line normally.
      const rl = createInterface({ input: stdin });
      rl.question(`${prompt}: `).then((a) => {
        rl.close();
        resolve(a.trim());
      });
      return;
    }
    stdout.write(`${prompt}: `);
    stdin.resume();
    stdin.setRawMode(true);
    let buf = "";
    const onData = (d: Buffer) => {
      const c = d.toString("utf8");
      if (c === "\r" || c === "\n" || c === "\u0004") {
        stdin.setRawMode(false);
        stdin.pause();
        stdin.removeListener("data", onData);
        stdout.write("\n");
        resolve(buf);
      } else if (c === "\u0003") {
        // Ctrl-C
        stdin.setRawMode(false);
        stdout.write("\n");
        process.exit(130);
      } else if (c === "\u007f" || c === "\b") {
        buf = buf.slice(0, -1);
      } else {
        buf += c;
      }
    };
    stdin.on("data", onData);
  });
}

async function main(): Promise<void> {
  const email = process.env.EUFY_EMAIL?.trim() || (await askLine("eufy email"));
  const password = await askHidden("eufy password");
  if (!password) {
    console.error("no password entered — aborting");
    process.exit(1);
  }

  const eufy = await loginClient({ email, password });
  console.log(`\nSigned in (region ${eufy.api.regionShard}). Session saved to .eufy-session.json.`);
  console.log("You can now run the sync without a password on disk:  npm run sync");
  await eufy.disconnect();
}

main().catch((e) => {
  console.error("FATAL", e instanceof Error ? e.message : String(e));
  process.exit(1);
});
