import test from "node:test";
import assert from "node:assert/strict";

import {
  buildSeasonPatchRows,
  dedupeAvailabilityRows,
  normalizeCasablancaPayload,
  normalizeHuettenholidayPayload,
  normalizeHutReservationPayload,
} from "../lib/normalize.mjs";

test("normalizeHutReservationPayload maps closed/open days to inferred availability", () => {
  const payload = {
    hutId: 366,
    checkedAt: "2026-02-09T20:00:00Z",
    allDays: [
      { date: "2026-06-01T00:00:00.000Z", hutStatus: "OPEN" },
      { date: "2026-06-02T00:00:00.000Z", hutStatus: "CLOSED" },
    ],
  };

  const rows = normalizeHutReservationPayload(payload, { "366": "braunschweiger-huette" });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].hut_id, "braunschweiger-huette");
  assert.equal(rows[0].status, "available");
  assert.equal(rows[0].confidence, "inferred");
  assert.equal(rows[1].status, "closed");
});

test("normalizeHutReservationPayload uses exact freeBeds when available", () => {
  const payload = {
    hutId: 366,
    checkedAt: "2026-02-09T20:00:00Z",
    allDays: [
      {
        date: "2026-06-10T00:00:00.000Z",
        hutStatus: "SERVICED",
        freeBeds: 23,
      },
      {
        date: "2026-06-11T00:00:00.000Z",
        hutStatus: "SERVICED",
        freeBeds: 0,
      },
    ],
  };

  const rows = normalizeHutReservationPayload(payload, { "366": "braunschweiger-huette" });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].available_beds, 23);
  assert.equal(rows[0].status, "available");
  assert.equal(rows[0].confidence, "exact");
  assert.equal(rows[1].available_beds, 0);
  assert.equal(rows[1].status, "unavailable");
  assert.equal(rows[1].confidence, "exact");
});

test("normalizeHutReservationPayload sums freeBedsPerCategory when freeBeds is missing", () => {
  const payload = {
    hutId: 366,
    checkedAt: "2026-02-09T20:00:00Z",
    allDays: [
      {
        date: "2026-06-12T00:00:00.000Z",
        hutStatus: "SERVICED",
        freeBedsPerCategory: [
          { totalFreePlaces: 2 },
          { totalFreePlaces: 3 },
        ],
      },
    ],
  };

  const rows = normalizeHutReservationPayload(payload, { "366": "braunschweiger-huette" });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].available_beds, 5);
  assert.equal(rows[0].status, "available");
  assert.equal(rows[0].confidence, "exact");
});

test("normalizeHutReservationPayload sums object-shaped freeBedsPerCategory", () => {
  const payload = {
    hutId: 366,
    checkedAt: "2026-02-09T20:00:00Z",
    allDays: [
      {
        date: "2026-06-14T00:00:00.000Z",
        hutStatus: "SERVICED",
        freeBedsPerCategory: {
          "348": 2,
          "529": 3,
        },
      },
    ],
  };

  const rows = normalizeHutReservationPayload(payload, { "366": "braunschweiger-huette" });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].available_beds, 5);
  assert.equal(rows[0].status, "available");
  assert.equal(rows[0].confidence, "exact");
});

test("normalizeHutReservationPayload treats FULL percentage as unavailable", () => {
  const payload = {
    hutId: 366,
    checkedAt: "2026-02-09T20:00:00Z",
    allDays: [
      {
        date: "2026-06-13T00:00:00.000Z",
        hutStatus: "SERVICED",
        percentage: "FULL",
      },
    ],
  };

  const rows = normalizeHutReservationPayload(payload, { "366": "braunschweiger-huette" });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].available_beds, null);
  assert.equal(rows[0].status, "unavailable");
  assert.equal(rows[0].confidence, "inferred");
});

test("normalizeHuettenholidayPayload keeps exact bed counts", () => {
  const payload = {
    scrapedAt: "2026-02-09T20:00:00Z",
    cabins: [
      {
        id: 27,
        availability: [
          {
            date: "2026-06-10T00:00:00.000000Z",
            totalPlaces: 120,
            availablePlaces: 9,
          },
        ],
      },
    ],
  };

  const rows = normalizeHuettenholidayPayload(payload, { "27": "kemptner-huette" });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, "available");
  assert.equal(rows[0].available_beds, 9);
  assert.equal(rows[0].confidence, "exact");
});

test("normalizeCasablancaPayload maps resort to canonical hut id", () => {
  const payload = [
    {
      date: "2026-06-15",
      availableBeds: 0,
      isAvailable: false,
      checkedAt: "2026-02-09T20:00:00Z",
    },
    {
      date: "2026-06-16",
      availableBeds: 5,
      isAvailable: true,
      checkedAt: "2026-02-09T20:00:05Z",
    },
  ];

  const rows = normalizeCasablancaPayload(payload, { A_6511_SKIHU: "skihutte-zams" }, "A_6511_SKIHU");
  assert.equal(rows.length, 2);
  assert.equal(rows[0].hut_id, "skihutte-zams");
  assert.equal(rows[0].status, "unavailable");
  assert.equal(rows[1].status, "available");
});

test("dedupeAvailabilityRows keeps the latest row for each hut/date", () => {
  const rows = [
    {
      hut_id: "h1",
      date: "2026-06-01",
      available_beds: 1,
      status: "available",
      confidence: "exact",
      source: "test",
      checked_at: "2026-02-09T10:00:00Z",
    },
    {
      hut_id: "h1",
      date: "2026-06-01",
      available_beds: 4,
      status: "available",
      confidence: "exact",
      source: "test",
      checked_at: "2026-02-09T12:00:00Z",
    },
  ];

  const deduped = dedupeAvailabilityRows(rows);
  assert.equal(deduped.length, 1);
  assert.equal(deduped[0].available_beds, 4);
});

test("buildSeasonPatchRows derives season bounds from non-closed days", () => {
  const rows = [
    {
      hut_id: "ohrs-477",
      date: "2026-05-16",
      status: "closed",
      checked_at: "2026-03-27T16:20:00Z",
    },
    {
      hut_id: "ohrs-477",
      date: "2026-05-17",
      status: "available",
      checked_at: "2026-03-27T16:21:00Z",
    },
    {
      hut_id: "ohrs-477",
      date: "2026-09-30",
      status: "unavailable",
      checked_at: "2026-03-27T16:22:00Z",
    },
    {
      hut_id: "ohrs-477",
      date: "2026-10-01",
      status: "closed",
      checked_at: "2026-03-27T16:23:00Z",
    },
  ];

  const seasonRows = buildSeasonPatchRows(rows);
  assert.deepEqual(seasonRows, [
    {
      id: "ohrs-477",
      season_open: "2026-05-17",
      season_close: "2026-09-30",
      season_checked_at: "2026-03-27T16:23:00.000Z",
    },
  ]);
});
