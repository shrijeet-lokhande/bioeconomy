/**
 * Demo listing store: the only data layer behind the listing workflow.
 *
 * Honesty rules:
 * - It is NOT a backend and must never be described as one. It keeps demo
 *   records in the browser (localStorage) so the Phase 1 workflow behaves
 *   realistically.
 * - Every record it hands out is marked provenance "demo".
 *
 * Seam for the future API: the ListingStore interface is deliberately
 * CRUD-shaped. When Roadmap Phase 2 delivers the FastAPI endpoints, an
 * http-backed implementation of this same interface replaces the demo one
 * without touching pages.
 */

import { DEMO_LISTINGS } from "../domain/demoData";
import type { BiomassListing, ListingInput, Provenance } from "../domain/types";

export const LISTINGS_STORAGE_KEY = "bioeconomy.demo-listings.v1";

export type MinimalStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export interface ListingStore {
  getAll(): readonly BiomassListing[];
  get(id: string): BiomassListing | null;
  create(input: ListingInput, nowIso?: string): BiomassListing;
  update(
    id: string,
    patch: Partial<ListingInput>,
    nowIso?: string,
  ): BiomassListing | null;
  remove(id: string): boolean;
  /** Restores the original demo seed (for the reset control in the UI). */
  resetToDemoSeed(): void;
}

export function createMemoryStorage(): MinimalStorage {
  const map = new Map<string, string>();
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, String(value));
    },
    removeItem: (key) => {
      map.delete(key);
    },
  };
}

function defaultStorage(): MinimalStorage {
  if (typeof window !== "undefined" && window.localStorage) {
    return window.localStorage;
  }
  return createMemoryStorage();
}

function defaultGenerateId(): string {
  if (
    typeof crypto !== "undefined" &&
    typeof crypto.randomUUID === "function"
  ) {
    return crypto.randomUUID();
  }
  return `demo-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
}

function demoSeed(): BiomassListing[] {
  return DEMO_LISTINGS.map((listing) => ({ ...listing }));
}

/**
 * Loads stored listings. Corrupted or unreadable local data resets to the
 * demo seed (with a console warning) rather than crashing the UI.
 */
function load(storage: MinimalStorage): BiomassListing[] {
  const raw = storage.getItem(LISTINGS_STORAGE_KEY);
  if (raw === null) return demoSeed();
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      throw new Error("Expected an array of listings.");
    }
    for (const item of parsed) {
      const candidate = item as Partial<BiomassListing> | null;
      if (
        candidate === null ||
        typeof candidate !== "object" ||
        typeof candidate.id !== "string" ||
        typeof candidate.title !== "string" ||
        candidate.provenance !== "demo"
      ) {
        throw new Error("Stored record does not match the listing shape.");
      }
    }
    return parsed as BiomassListing[];
  } catch (error) {
    console.warn(
      "Demo listing store: local data was unreadable, resetting to demo seed.",
      error,
    );
    return demoSeed();
  }
}

export function createListingStore(
  storage: MinimalStorage = defaultStorage(),
  generateId: () => string = defaultGenerateId,
): ListingStore {
  const provenance: Provenance = "demo";

  const persist = (listings: readonly BiomassListing[]): void => {
    storage.setItem(LISTINGS_STORAGE_KEY, JSON.stringify(listings));
  };

  const getAll = (): readonly BiomassListing[] => load(storage);

  const create = (
    input: ListingInput,
    nowIso?: string,
  ): BiomassListing => {
    const now = nowIso ?? new Date().toISOString();
    const listing: BiomassListing = { ...input, id: generateId(), createdAt: now, updatedAt: now, provenance };
    persist([...getAll(), listing]);
    return listing;
  };

  const update = (
    id: string,
    patch: Partial<ListingInput>,
    nowIso?: string,
  ): BiomassListing | null => {
    const now = nowIso ?? new Date().toISOString();
    const listings = getAll();
    const index = listings.findIndex((listing) => listing.id === id);
    if (index === -1) return null;
    const updated: BiomassListing = {
      ...listings[index],
      ...patch,
      id: listings[index].id,
      createdAt: listings[index].createdAt,
      updatedAt: now,
      provenance,
    };
    const next = [...listings];
    next[index] = updated;
    persist(next);
    return updated;
  };

  const remove = (id: string): boolean => {
    const listings = getAll();
    const next = listings.filter((listing) => listing.id !== id);
    if (next.length === listings.length) return false;
    persist(next);
    return true;
  };

  return {
    getAll,
    get: (id) => getAll().find((listing) => listing.id === id) ?? null,
    create,
    update,
    remove,
    resetToDemoSeed: () => persist(demoSeed()),
  };
}
