/**
 * @file direct-auth.ts
 * @description Bypass SSO by loading CouchDB credentials from .env.local.
 *
 * Used when the Next-Auth SSO flow at web.budgetbakers.com is unavailable.
 * Credentials are obtained once by calling user.getUser from a browser session
 * and saved to .env.local (which is gitignored).
 *
 * Required vars in .env.local:
 *   COUCH_URL    — e.g. https://couch-prod-us-1.budgetbakers.com
 *   COUCH_DB     — e.g. bb-3d7250d4-...
 *   COUCH_LOGIN  — userId UUID
 *   COUCH_TOKEN  — replication token UUID
 *   COUCH_USER_ID — same as COUCH_LOGIN
 */

import fs from "fs";
import path from "path";
import type { LoginResult } from "./types.js";

function loadEnvFile(filePath: string): Record<string, string> {
  const content = fs.readFileSync(filePath, "utf8");
  const vars: Record<string, string> = {};
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    vars[trimmed.slice(0, eqIdx).trim()] = trimmed.slice(eqIdx + 1).trim();
  }
  return vars;
}

export function loadDirectCredentials(): LoginResult {
  const envPath = path.resolve(".env.local");
  if (!fs.existsSync(envPath)) {
    throw new Error(
      "--direct requires a .env.local file with COUCH_URL, COUCH_DB, COUCH_LOGIN, COUCH_TOKEN, COUCH_USER_ID"
    );
  }

  const env = loadEnvFile(envPath);
  const required = ["COUCH_URL", "COUCH_DB", "COUCH_LOGIN", "COUCH_TOKEN", "COUCH_USER_ID"];
  const missing = required.filter((k) => !env[k]?.trim());
  if (missing.length > 0) {
    throw new Error(`--direct: missing required vars in .env.local: ${missing.join(", ")}`);
  }

  return {
    sessionToken: "direct",
    userId: env["COUCH_USER_ID"],
    replication: {
      dbName: env["COUCH_DB"],
      url: env["COUCH_URL"],
      login: env["COUCH_LOGIN"],
      token: env["COUCH_TOKEN"],
      ownerId: env["COUCH_USER_ID"],
    },
  };
}
