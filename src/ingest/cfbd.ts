/**
 * Typed CFBD client with on-disk caching and rate limiting.
 *
 * Every response is cached as raw JSON under cfbd_cache/ keyed by endpoint+params,
 * so re-running ingestion costs nothing and the expensive per-team game pull is a
 * one-time spend. Delete a cache file to force a refetch of just that call.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  CfbdDraftPick,
  CfbdGamePlayers,
  CfbdPortalEntry,
  CfbdRecruit,
  CfbdRosterPlayer,
  CfbdSeasonStat,
  CfbdTeam,
  CfbdUsage,
} from './types.ts';

const BASE_URL = 'https://api.collegefootballdata.com';
const CACHE_DIR = 'cfbd_cache';

/** Delay between uncached requests. The per-team game pull is ~770 calls. */
const RATE_LIMIT_MS = 250;

/**
 * The legacy pipeline hardcoded this key in gather_rb_data.py and the notebook.
 * Per CLAUDE.md that key is already effectively committed; the point of reading
 * from the environment here is to avoid adding a third copy, not to rotate it.
 */
function apiKey(): string {
  const key = process.env['CFBD_API_KEY'];
  if (!key) {
    throw new Error(
      'CFBD_API_KEY is not set. Export it before running ingestion (see .env.example).',
    );
  }
  return key;
}

let cacheDirReady = false;
async function ensureCacheDir(): Promise<void> {
  if (cacheDirReady) return;
  await mkdir(CACHE_DIR, { recursive: true });
  cacheDirReady = true;
}

function cacheKey(path: string, params: Record<string, string | number>): string {
  const parts = Object.entries(params)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}-${v}`);
  const slug = [path.replace(/\//g, '_').replace(/^_/, ''), ...parts]
    .join('__')
    // Team names contain spaces, ampersands, apostrophes (Texas A&M, Hawai'i).
    .replace(/[^A-Za-z0-9_.-]/g, '-');
  return `${slug}.json`;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

let lastRequestAt = 0;
async function throttle(): Promise<void> {
  const elapsed = Date.now() - lastRequestAt;
  if (elapsed < RATE_LIMIT_MS) await sleep(RATE_LIMIT_MS - elapsed);
  lastRequestAt = Date.now();
}

export interface FetchStats {
  cached: number;
  fetched: number;
  failed: number;
}

export const stats: FetchStats = { cached: 0, fetched: 0, failed: 0 };

/**
 * GET an endpoint, preferring the disk cache.
 *
 * Retries transient failures (429/5xx/network) with backoff. A 4xx other than 429
 * is not retried — it means the request itself is wrong, so failing loudly beats
 * silently caching an error.
 */
async function get<T>(
  path: string,
  params: Record<string, string | number> = {},
): Promise<T[]> {
  await ensureCacheDir();
  const file = join(CACHE_DIR, cacheKey(path, params));

  try {
    const cached = await readFile(file, 'utf8');
    stats.cached++;
    return JSON.parse(cached) as T[];
  } catch {
    // Cache miss — fall through to the network.
  }

  const query = new URLSearchParams(
    Object.entries(params).map(([k, v]) => [k, String(v)]),
  );
  const url = `${BASE_URL}${path}?${query}`;

  const MAX_ATTEMPTS = 4;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    await throttle();
    try {
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${apiKey()}` },
      });

      if (!response.ok) {
        const retryable = response.status === 429 || response.status >= 500;
        if (!retryable) {
          throw new Error(`${response.status} ${response.statusText} for ${path}`);
        }
        if (attempt === MAX_ATTEMPTS) {
          throw new Error(
            `${response.status} after ${MAX_ATTEMPTS} attempts for ${path}`,
          );
        }
        await sleep(RATE_LIMIT_MS * 4 * attempt);
        continue;
      }

      const body = (await response.json()) as T[];
      // The endpoints used here all return arrays; anything else means the shape
      // changed and downstream .map/.filter would fail confusingly.
      if (!Array.isArray(body)) {
        throw new Error(`Expected an array from ${path}, got ${typeof body}`);
      }
      await writeFile(file, JSON.stringify(body));
      stats.fetched++;
      return body;
    } catch (error) {
      if (attempt === MAX_ATTEMPTS) {
        stats.failed++;
        throw error;
      }
      await sleep(RATE_LIMIT_MS * 4 * attempt);
    }
  }

  throw new Error(`unreachable: retry loop exited for ${path}`);
}

// ---------------------------------------------------------------------------
// Endpoint wrappers
// ---------------------------------------------------------------------------

export const getRecruits = (year: number): Promise<CfbdRecruit[]> =>
  get<CfbdRecruit>('/recruiting/players', {
    year,
    classification: 'HighSchool',
  });

export const getPortal = (year: number): Promise<CfbdPortalEntry[]> =>
  get<CfbdPortalEntry>('/player/portal', { year });

export const getRoster = (year: number): Promise<CfbdRosterPlayer[]> =>
  get<CfbdRosterPlayer>('/roster', { year });

export const getUsage = (year: number): Promise<CfbdUsage[]> =>
  get<CfbdUsage>('/player/usage', { year });

export const getSeasonStats = (
  year: number,
  category: string,
): Promise<CfbdSeasonStat[]> =>
  get<CfbdSeasonStat>('/stats/player/season', { year, category });

export const getDraftPicks = (year: number): Promise<CfbdDraftPick[]> =>
  get<CfbdDraftPick>('/draft/picks', { year });

export const getTeams = (year: number): Promise<CfbdTeam[]> =>
  get<CfbdTeam>('/teams/fbs', { year });

export const getGamePlayers = (
  year: number,
  team: string,
): Promise<CfbdGamePlayers[]> =>
  get<CfbdGamePlayers>('/games/players', { year, team });
