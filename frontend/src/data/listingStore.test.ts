import { beforeEach, describe, expect, it } from "vitest";
import {
  createListingStore,
  createMemoryStorage,
  LISTINGS_STORAGE_KEY,
  type ListingStore,
  type MinimalStorage,
} from "./listingStore";
import { DEMO_LISTINGS } from "../domain/demoData";
import { makeInput } from "../testing/helpers";

let idCounter = 0;

function freshStore(): { store: ListingStore; storage: MinimalStorage } {
  const storage = createMemoryStorage();
  const store = createListingStore(storage, () => `gen-${++idCounter}`);
  return { store, storage };
}

beforeEach(() => {
  idCounter = 0;
});

describe("createListingStore — demo seed", () => {
  it("starts with the demo seed, every record marked demo", () => {
    const { store } = freshStore();
    const listings = store.getAll();
    expect(listings).toHaveLength(DEMO_LISTINGS.length);
    for (const listing of listings) {
      expect(listing.provenance).toBe("demo");
    }
  });

  it("hands out copies — mutating a returned listing does not corrupt the store", () => {
    const { store } = freshStore();
    const listing = { ...store.getAll()[0] }; // shallow mutable copy
    listing.title = "tampered";
    expect(store.get(listing.id)?.title).not.toBe("tampered");
  });

  it("finds records by id and returns null for unknown ids", () => {
    const { store } = freshStore();
    expect(store.get(DEMO_LISTINGS[0].id)?.title).toBe(
      DEMO_LISTINGS[0].title,
    );
    expect(store.get("no-such-id")).toBeNull();
  });
});

describe("createListingStore — create", () => {
  it("creates a listing with deterministic id and timestamps", () => {
    const { store } = freshStore();
    const created = store.create(makeInput({ title: "Test hay" }), "2026-10-24T09:00:00.000Z");
    expect(created.id).toBe("gen-1");
    expect(created.createdAt).toBe("2026-10-24T09:00:00.000Z");
    expect(created.updatedAt).toBe("2026-10-24T09:00:00.000Z");
    expect(created.provenance).toBe("demo");
    expect(created.title).toBe("Test hay");
    expect(store.get("gen-1")).not.toBeNull();
  });

  it("persists across store instances sharing storage", () => {
    const { store, storage } = freshStore();
    store.create(makeInput({ title: "Test hay" }), "2026-10-24T09:00:00.000Z");
    const second = createListingStore(storage, () => `gen-${++idCounter}`);
    expect(second.getAll()).toHaveLength(DEMO_LISTINGS.length + 1);
  });
});

describe("createListingStore — update and remove", () => {
  it("updates fields and changes updatedAt only", () => {
    const { store } = freshStore();
    const seedId = DEMO_LISTINGS[0].id;
    const updated = store.update(
      seedId,
      { title: "Renamed demo listing", status: "withdrawn" },
      "2026-10-24T12:00:00.000Z",
    );
    expect(updated?.title).toBe("Renamed demo listing");
    expect(updated?.status).toBe("withdrawn");
    expect(updated?.createdAt).toBe(DEMO_LISTINGS[0].createdAt);
    expect(updated?.updatedAt).toBe("2026-10-24T12:00:00.000Z");
  });

  it("returns null when updating an unknown id", () => {
    const { store } = freshStore();
    expect(store.update("no-such-id", { title: "x" })).toBeNull();
  });

  it("keeps provenance 'demo' after an update", () => {
    const { store } = freshStore();
    const updated = store.update(DEMO_LISTINGS[0].id, { title: "Renamed" });
    expect(updated?.provenance).toBe("demo");
  });

  it("removes existing records and reports misses", () => {
    const { store } = freshStore();
    expect(store.remove(DEMO_LISTINGS[0].id)).toBe(true);
    expect(store.get(DEMO_LISTINGS[0].id)).toBeNull();
    expect(store.remove(DEMO_LISTINGS[0].id)).toBe(false);
  });
});

describe("createListingStore — reset and corruption recovery", () => {
  it("resets modified data back to the demo seed", () => {
    const { store } = freshStore();
    store.create(makeInput());
    store.remove(DEMO_LISTINGS[0].id);
    store.resetToDemoSeed();
    expect(store.getAll()).toHaveLength(DEMO_LISTINGS.length);
    expect(store.get(DEMO_LISTINGS[0].id)).not.toBeNull();
  });

  it("recovers to the demo seed from corrupted local data", () => {
    const { store, storage } = freshStore();
    storage.setItem(LISTINGS_STORAGE_KEY, "{not json");
    expect(store.getAll()).toHaveLength(DEMO_LISTINGS.length);
  });

  it("recovers when stored records do not match the listing shape", () => {
    const { store, storage } = freshStore();
    storage.setItem(
      LISTINGS_STORAGE_KEY,
      JSON.stringify([{ nonsense: true }]),
    );
    expect(store.getAll()).toHaveLength(DEMO_LISTINGS.length);
  });
});
