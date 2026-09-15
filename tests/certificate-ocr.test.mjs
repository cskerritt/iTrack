// The certificate reader's field extraction is pure — OCR text in, field
// suggestions out — so it is tested here against the tsc output rather than
// through the built worker. `npm run build:lib-test` compiles
// app/lib/certificateOcr.ts into .test-build/; the tesseract.js import only
// happens inside scanCertificateImage, which this suite never calls.
import assert from "node:assert/strict";
import test from "node:test";

import { extractCertificateSuggestions } from "../.test-build/certificateOcr.js";

test("extractCertificateSuggestions reads labelled certificate lines", () => {
  assert.deepEqual(
    extractCertificateSuggestions(
      [
        "Course Title: Trauma-Informed Practice",
        "Provider: State Medical Society",
        "Completion Date: July 24, 2026",
        "3.5 CME credits",
      ].join("\n"),
    ),
    {
      title: "Trauma-Informed Practice",
      provider: "State Medical Society",
      completionDate: "2026-07-24",
      credits: 3.5,
    },
  );
});

test("extractCertificateSuggestions accepts alternative labels and numeric dates", () => {
  assert.deepEqual(
    extractCertificateSuggestions(
      [
        "Program: Patient Safety Essentials",
        "Issued by: Clinical Learning Institute",
        "Completed on: 7/22/2026",
        "CEUs: 2",
      ].join("\n"),
    ),
    {
      title: "Patient Safety Essentials",
      provider: "Clinical Learning Institute",
      completionDate: "2026-07-22",
      credits: 2,
    },
  );
});

test("extractCertificateSuggestions suggests nothing for empty text", () => {
  assert.deepEqual(extractCertificateSuggestions(""), {});
  assert.deepEqual(extractCertificateSuggestions("\n   \n"), {});
});
