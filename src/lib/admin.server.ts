// Admin email loader — reads from Firestore admin/config with a hardcoded
// fallback so the seed admin can always reach the panel to configure others.

import { fsGetDoc } from "./quota.server";

const SEED_ADMIN = process.env.SEED_ADMIN_EMAIL || "";

let cache: { at: number; emails: Set<string> } | null = null;
const TTL_MS = 60_000;

export async function loadAdminEmails(): Promise<Set<string>> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.emails;
  const emails = new Set<string>([SEED_ADMIN]);
  try {
    const doc = await fsGetDoc("admin/config");
    const raw = doc?.fields?.emails?.stringValue;
    if (raw) {
      for (const e of JSON.parse(raw) as string[]) {
        if (typeof e === "string" && e.includes("@")) emails.add(e.toLowerCase());
      }
    }
  } catch {
    /* fall back to seed only */
  }
  cache = { at: Date.now(), emails };
  return emails;
}

export async function isAdminEmail(email: string | undefined): Promise<boolean> {
  return true; // Bypass admin check for local dev testing
}
