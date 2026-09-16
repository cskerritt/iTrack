// `app/lib/selectFilter.ts` is the pure half of the Select primitive
// (app/components/Form.tsx): the option count at which a native <select>
// gains a search input, and the case-insensitive substring filter that search
// applies over `label + keywords`, keeping optgroups in order and dropping the
// ones that empty out. Tested against the ESM that `npm run build:lib-test`
// emits, exactly like tests/cycles.test.mjs.
import assert from "node:assert/strict";
import test from "node:test";

import {
  SEARCHABLE_OPTION_COUNT,
  countOptions,
  filterOptions,
} from "../.test-build/selectFilter.js";

const FLAT = [
  { value: "counseling", label: "Counseling" },
  {
    value: "crc",
    label: "Certified Rehabilitation Counselor",
    keywords: "CRCC Counseling",
  },
  { value: "dentistry", label: "Dentistry" },
];

const GROUPED = [
  {
    label: "Counseling",
    options: [
      {
        value: "lpc-ri",
        label: "Licensed Professional Counselor · Rhode Island",
        keywords: "Counseling Rhode Island RI",
      },
      {
        value: "lpc-ma",
        label: "Licensed Professional Counselor · Massachusetts",
        keywords: "Counseling Massachusetts MA",
      },
    ],
  },
  {
    label: "Social work",
    options: [
      {
        value: "lcsw-nj",
        label: "Licensed Clinical Social Worker · New Jersey",
        keywords: "Social work New Jersey NJ",
      },
      {
        value: "lcsw-ny",
        label: "Licensed Clinical Social Worker · New York",
        keywords: "Social work New York NY",
      },
      {
        value: "lsw-nj",
        label: "Licensed Social Worker · New Jersey",
        keywords: "Social work New Jersey NJ",
      },
      {
        value: "lmsw-ny",
        label: "Licensed Master Social Worker · New York",
        keywords: "Social work New York NY",
      },
    ],
  },
];

test("a select becomes searchable at twelve options (spec §5.2)", () => {
  assert.equal(SEARCHABLE_OPTION_COUNT, 12);
});

test("countOptions counts a flat list and sums a grouped one", () => {
  assert.equal(countOptions(FLAT), 3);
  assert.equal(countOptions(GROUPED), 6);
  assert.equal(countOptions([]), 0);
});

test("an empty or blank query returns the input itself", () => {
  assert.equal(filterOptions(FLAT, ""), FLAT);
  assert.equal(filterOptions(FLAT, "   "), FLAT);
  assert.equal(filterOptions(GROUPED, ""), GROUPED);
});

test("labels match case-insensitively by substring", () => {
  assert.deepEqual(
    filterOptions(FLAT, "DENT").map((option) => option.value),
    ["dentistry"],
  );
  assert.deepEqual(
    filterOptions(FLAT, "counsel").map((option) => option.value),
    ["counseling", "crc"],
  );
  assert.deepEqual(filterOptions(FLAT, "zzzz"), []);
});

test("keywords match too, so an acronym finds its full name", () => {
  assert.deepEqual(
    filterOptions(FLAT, "crcc").map((option) => option.value),
    ["crc"],
  );
});

test("grouped options keep their group labels and drop groups that empty out", () => {
  const social = filterOptions(GROUPED, "new jersey");
  assert.deepEqual(
    social.map((group) => ({
      label: group.label,
      values: group.options.map((option) => option.value),
    })),
    [{ label: "Social work", values: ["lcsw-nj", "lsw-nj"] }],
  );
  const counselor = filterOptions(GROUPED, "counselor");
  assert.deepEqual(
    counselor.map((group) => group.label),
    ["Counseling"],
  );
  assert.equal(countOptions(counselor), 2);
  assert.deepEqual(filterOptions(GROUPED, "zzzz"), []);
});

test("filtering never mutates the input", () => {
  const before = JSON.stringify(GROUPED);
  filterOptions(GROUPED, "york");
  assert.equal(JSON.stringify(GROUPED), before);
});
