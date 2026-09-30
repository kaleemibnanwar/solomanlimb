// JSON-file backed replacement for the SQLite/drizzle recipe store used by
// the in-app Octopus Studio bridge. Same exported surface as
// src/main/octolimb_recipes.ts, so bridge.ts ports over unchanged.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export type RecipeStep = { tool: string; args: Record<string, unknown> };

export type OctoLimbRecipe = {
  fingerprint: string;
  domain: string;
  instruction: string;
  steps: RecipeStep[];
  successCount: number;
  failureCount: number;
};

export type RecipeSummary = {
  fingerprint: string;
  instruction: string;
  successCount: number;
  failureCount: number;
  lastUsedAt: Date | null;
};

type StoredRecipe = OctoLimbRecipe & { lastUsedAt: string | null; updatedAt: string };

function recipesFile(): string {
  const home = process.env.OCTOLIMB_HOME || path.join(homedir(), ".octolimb");
  return path.join(home, "recipes.json");
}

let cache: StoredRecipe[] | null = null;

function load(): StoredRecipe[] {
  if (cache) return cache;
  try {
    const raw = readFileSync(recipesFile(), "utf8");
    const parsed = JSON.parse(raw) as { recipes?: StoredRecipe[] };
    cache = Array.isArray(parsed.recipes) ? parsed.recipes : [];
  } catch {
    cache = [];
  }
  return cache;
}

function persist(): void {
  if (!cache) return;
  const file = recipesFile();
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify({ recipes: cache }, null, 2));
  renameSync(tmp, file);
}

export function computeFingerprint(instruction: string, domain: string): string {
  const normalized = `${instruction.trim().toLowerCase().replace(/\s+/g, " ")}|${domain.trim().toLowerCase()}`;
  return createHash("sha256").update(normalized).digest("hex").slice(0, 32);
}

export function getRecipeByFingerprint(fingerprint: string): OctoLimbRecipe | undefined {
  const row = load().find((recipe) => recipe.fingerprint === fingerprint);
  if (!row) return undefined;
  return {
    fingerprint: row.fingerprint,
    domain: row.domain,
    instruction: row.instruction,
    steps: row.steps,
    successCount: row.successCount,
    failureCount: row.failureCount,
  };
}

function normalizeDomain(domain: string): string {
  return domain.trim().toLowerCase();
}

const MAX_RECIPES_PER_DOMAIN = 20;

export function listRecipesForDomain(domain: string): RecipeSummary[] {
  const normalizedDomain = normalizeDomain(domain);
  return load()
    .filter((recipe) => normalizeDomain(recipe.domain) === normalizedDomain)
    .sort(
      (a, b) =>
        b.successCount - a.successCount ||
        (b.lastUsedAt ?? "").localeCompare(a.lastUsedAt ?? ""),
    )
    .slice(0, MAX_RECIPES_PER_DOMAIN)
    .map((recipe) => ({
      fingerprint: recipe.fingerprint,
      instruction: recipe.instruction,
      successCount: recipe.successCount,
      failureCount: recipe.failureCount,
      lastUsedAt: recipe.lastUsedAt ? new Date(recipe.lastUsedAt) : null,
    }));
}

export function upsertRecipe(params: {
  instruction: string;
  domain: string;
  steps: RecipeStep[];
}): string {
  const fingerprint = computeFingerprint(params.instruction, params.domain);
  const all = load();
  const now = new Date().toISOString();
  const index = all.findIndex((recipe) => recipe.fingerprint === fingerprint);

  if (index >= 0) {
    all[index] = {
      ...all[index],
      steps: params.steps,
      successCount: 1,
      failureCount: 0,
      lastUsedAt: now,
      updatedAt: now,
    };
  } else {
    all.push({
      fingerprint,
      domain: params.domain,
      instruction: params.instruction,
      steps: params.steps,
      successCount: 1,
      failureCount: 0,
      lastUsedAt: now,
      updatedAt: now,
    });
  }

  persist();
  return fingerprint;
}

export function recordRecipeOutcome(fingerprint: string, success: boolean): void {
  const row = load().find((recipe) => recipe.fingerprint === fingerprint);
  if (!row) return;
  const now = new Date().toISOString();
  row.successCount = success ? row.successCount + 1 : row.successCount;
  row.failureCount = success ? row.failureCount : row.failureCount + 1;
  row.lastUsedAt = now;
  row.updatedAt = now;
  persist();
}
