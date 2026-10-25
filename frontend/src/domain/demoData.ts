/**
 * Hard-coded demo seed data for the listing workflow.
 *
 * These are fictional example records created to exercise the interface.
 * They must never be presented as verified real-world supply (docs/
 * PRODUCT_SPEC.md). Every record is marked provenance: "demo".
 *
 * When the real API exists (Roadmap Phase 2) this seed is only used to
 * populate the demo store on first run.
 */

import type { BiomassListing } from "./types";

const DEMO_NOTE = "Demo-only example. Not real-world supply.";

export const DEMO_LISTINGS: readonly BiomassListing[] = [
  {
    id: "demo-woodchips-spruce",
    title: "Wood chips — spruce, screened",
    biomassType: "Wood chips",
    quantityValue: 12,
    quantityUnit: "t",
    quality: null,
    location: "Kainuu forest holding (demo location)",
    status: "available",
    notes: DEMO_NOTE,
    createdAt: "2026-10-18T09:00:00.000Z",
    updatedAt: "2026-10-20T10:30:00.000Z",
    provenance: "demo",
  },
  {
    id: "demo-straw-wheat",
    title: "Straw — wheat bales (store)",
    biomassType: "Straw",
    quantityValue: 1500,
    quantityUnit: "kg",
    quality: "Stored under cover; condition unverified",
    location: "Ostrobothnia farm field (demo location)",
    status: "available",
    notes: DEMO_NOTE,
    createdAt: "2026-10-15T14:20:00.000Z",
    updatedAt: "2026-10-19T08:15:00.000Z",
    provenance: "demo",
  },
  {
    id: "demo-forest-residue-mixed",
    title: "Mixed forest residue — tops and branches",
    biomassType: "Mixed forest residue",
    quantityValue: 30,
    quantityUnit: "t",
    quality: null,
    location: "Central Finland (demo location)",
    status: "reserved",
    notes: DEMO_NOTE,
    createdAt: "2026-10-10T11:45:00.000Z",
    updatedAt: "2026-10-21T16:00:00.000Z",
    provenance: "demo",
  },
  {
    id: "demo-prunings-orchard",
    title: "Orchard prunings — chipped",
    biomassType: "Prunings",
    quantityValue: 15,
    quantityUnit: "m3",
    quality: "Volume only; moisture content not recorded",
    location: "Southwest orchard block (demo location)",
    status: "available",
    notes: DEMO_NOTE,
    createdAt: "2026-10-12T09:10:00.000Z",
    updatedAt: "2026-10-12T09:10:00.000Z",
    provenance: "demo",
  },
  {
    id: "demo-presscake-rapeseed",
    title: "Rapeseed press cake — from local pressing",
    biomassType: "Press cake",
    quantityValue: 850,
    quantityUnit: "kg",
    quality: "Batch residue; composition not analysed",
    location: "Pressing coop, Savonia (demo location)",
    status: "withdrawn",
    notes: DEMO_NOTE,
    createdAt: "2026-09-28T13:00:00.000Z",
    updatedAt: "2026-10-08T09:45:00.000Z",
    provenance: "demo",
  },
  {
    id: "demo-willow-unknown",
    title: "Willow chips — quantity not yet measured",
    biomassType: "Wood chips",
    quantityValue: null,
    quantityUnit: null,
    quality: null,
    location: "Energy-willow plantation (demo location)",
    status: "reserved",
    notes: DEMO_NOTE,
    createdAt: "2026-10-16T10:00:00.000Z",
    updatedAt: "2026-10-17T12:00:00.000Z",
    provenance: "demo",
  },
];
