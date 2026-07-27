import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "./schema";

export function getD1(): D1Database {
  if (!env.DB) {
    throw new Error(
      "Cloudflare D1 binding `DB` is unavailable. Check the d1_databases binding in vite.config.ts.",
    );
  }

  return env.DB;
}

export function getEvidenceBucket(): R2Bucket {
  if (!env.EVIDENCE) {
    throw new Error(
      "Cloudflare R2 binding `EVIDENCE` is unavailable. Check the r2_buckets binding in vite.config.ts.",
    );
  }

  return env.EVIDENCE;
}

export function getDb() {
  return drizzle(getD1(), { schema });
}
