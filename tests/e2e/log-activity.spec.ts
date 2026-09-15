// Replaces tests/rendered-html.test.mjs subtests: the draft-persistence and calendar pins of "ships the installable phone companion without caching private data", and the certificate-scanner pins of "keeps certificate OCR on-device and suggestions reviewable" (the rear-camera capture input, the "Start with the certificate" opener, and the record-saved-then-proof-uploaded order) — behaviour those pins encoded is asserted here against the running app. The typing regression below moved here verbatim from tests/e2e/log-activity-typing.spec.ts.
import { readFile } from "node:fs/promises";
import { expect, freshIdentity, test } from "./fixtures";

// app-ux-01 / architecture-M-01: the second keystroke in any log-activity
// field used to throw inside a deferred state updater and unmount the app.
// Typing two characters into each field, slowly enough for the draft-persist
// effect to schedule its timeouts between keys, is the exact reproduction.
// Read-only against the demo workspace: the sheet is never submitted.
test("typing two characters into every log-activity field does not crash the app", async ({ app, page }) => {
  await app.goto("/");
  // No identity header on localhost resolves to the demo user; a spec that
  // saved anything here would mutate the shared dev D1 for every later run.
  expect((await app.workspace()).user.isDemo).toBe(true);
  const sheet = await app.openLog();

  // Checked after every field so a crash is reported as the thrown error
  // rather than as the input that vanished with the unmounted sheet.
  const title = sheet.locator('input[name="title"]');
  await title.click();
  await title.pressSequentially("Et", { delay: 300 });
  app.expectNoErrors();
  await expect(title).toHaveValue("Et");

  const units = sheet.locator('input[name="totalUnits"]');
  await units.click();
  await units.pressSequentially("12", { delay: 300 });
  app.expectNoErrors();
  await expect(units).toHaveValue("12");

  const allocated = sheet.locator('input[name="allocatedUnits"]');
  await allocated.click();
  await allocated.fill("");
  await allocated.pressSequentially("11", { delay: 300 });
  app.expectNoErrors();
  await expect(allocated).toHaveValue("11");

  const provider = sheet.locator('input[name="provider"]');
  await provider.click();
  await provider.pressSequentially("NB", { delay: 300 });
  app.expectNoErrors();
  await expect(provider).toHaveValue("NB");

  // A date input takes whole values; two fills 300 ms apart hit the same
  // pending-lane path a second keystroke does.
  const completion = sheet.locator('input[name="completionDate"]');
  await completion.fill("2026-01-05");
  await page.waitForTimeout(300);
  await completion.fill("2026-01-06");
  app.expectNoErrors();
  await expect(completion).toHaveValue("2026-01-06");

  await expect(sheet).toBeVisible();
  await expect(page.locator("#main-content")).toBeVisible();
  app.expectNoErrors();
});

test("the completion date defaults to a calendar date", async ({ app }) => {
  // Task 11 sharpens this to the local date under a fixed clock.
  await app.goto("/");
  const sheet = await app.openLog();
  await expect(sheet.locator('input[name="completionDate"]')).toHaveValue(/^\d{4}-\d{2}-\d{2}$/);
  app.expectNoErrors();
});

test.describe("as a new account", () => {
  test.use({ identity: freshIdentity() });

  test("a draft is saved in this browser, survives a reload, and saves as a record", async ({ page, app }) => {
    await app.seedCredential();
    await app.goto("/");
    let sheet = await app.openLog();
    await sheet.locator('input[name="title"]').fill("Draft course");
    // The note flips to "saving" as the draft changes and to "saved" 250 ms
    // later, once localStorage holds it.
    const note = sheet.getByRole("status").filter({ hasText: "in this browser" });
    await expect(note).toContainText("Saving in this browser");
    await expect(note).toContainText("Saved in this browser");

    // A fresh page load in the same browser context keeps localStorage, so
    // the sheet reopens on the draft.
    await app.goto("/");
    sheet = await app.openLog();
    await expect(sheet.locator('input[name="title"]')).toHaveValue("Draft course");
    await expect(
      sheet.getByRole("status").filter({ hasText: "in this browser" }),
    ).toContainText("Saved in this browser");

    await sheet.locator('input[name="totalUnits"]').fill("2");
    // Credits to apply follow the certificate amount until changed by hand.
    await expect(sheet.locator('input[name="allocatedUnits"]')).toHaveValue("2");
    await sheet.locator('input[name="completionDate"]').fill("2026-06-02");
    await sheet.getByRole("button", { name: "Save activity" }).click();
    await expect(sheet).toHaveCount(0);
    await expect(
      page.getByRole("region", { name: "Recent learning" }).getByText("Draft course"),
    ).toBeVisible();
    app.expectNoErrors();
  });

  test("a certificate photo is read on this device and uploads as proof only once the record is saved", async ({ page, app, context }) => {
    // The on-device reader loads its worker, core and English model from
    // /ocr/ on first use, so this test runs longer than a plain save.
    test.slow();
    await app.seedCredential();
    await app.goto("/");
    const sheet = await app.openLog();

    // The scanner opens the sheet, and "Take photo" is a file input that
    // asks for the rear camera and takes only the image types the reader
    // can read.
    await expect(sheet.getByText("Start with the certificate")).toBeVisible();
    const camera = sheet.locator('input[type="file"][capture="environment"]');
    await expect(camera).toBeAttached();
    await expect(camera).toHaveAttribute("accept", "image/jpeg,image/png,image/webp");

    // A real PNG (the app icon: no certificate text on it) through the
    // camera input. The reader runs on it here in the browser; the file
    // stays attached whatever it finds, and the fields and Save are held
    // until it finishes ("Reading certificate…").
    const photo = await readFile(new URL("../../public/icon-192.png", import.meta.url));
    const fetched: string[] = [];
    const recordFetch = (request: { url(): string }) => fetched.push(request.url());
    page.on("request", recordFetch);
    await camera.setInputFiles({ name: "certificate.png", mimeType: "image/png", buffer: photo });
    await expect(sheet.getByText("certificate.png")).toBeVisible();
    const status = sheet.locator(".capture-status");
    await expect(status).toBeVisible();
    const save = sheet.getByRole("button", { name: "Save activity" });
    await expect(save).toBeEnabled({ timeout: 90_000 });
    page.off("request", recordFetch);
    // The reader ran, not failed to start: the scan ends in a read phase,
    // and the photo is still attached.
    await expect(status).toHaveClass(/\b(?:manual|success)\b/);
    await expect(sheet.getByText("certificate.png")).toBeVisible();
    // On-device, as the sheet promises: the worker, a core and the English
    // model came from iTrack itself, and nothing left the origin meanwhile.
    const origin = new URL(page.url()).origin;
    expect(fetched.filter((url) => !url.startsWith(`${origin}/`))).toEqual([]);
    const paths = fetched.map((url) => new URL(url).pathname);
    expect(paths).toEqual(
      expect.arrayContaining(["/ocr/worker.min.js", "/ocr/lang/eng.traineddata.gz"]),
    );
    expect(paths.some((path) => /^\/ocr\/core\/tesseract-core-.*\.wasm\.js$/.test(path))).toBe(true);

    await sheet.locator('input[name="title"]').fill("Scanned course");
    await sheet.locator('input[name="totalUnits"]').fill("2");
    await expect(sheet.locator('input[name="allocatedUnits"]')).toHaveValue("2");
    await sheet.locator('input[name="completionDate"]').fill("2026-06-02");
    await expect(sheet.locator('input[name="evidenceStatus"][value="missing"]')).toBeChecked();

    // The order the sheet promises: the record is saved first, and the proof
    // is uploaded against the id that save returns.
    const writes: string[] = [];
    page.on("request", (request) => {
      if (request.method() !== "POST") return;
      const path = new URL(request.url()).pathname;
      if (path === "/api/workspace") writes.push(String(request.postDataJSON()?.action));
      else if (path === "/api/evidence") writes.push("evidence");
    });
    await save.click();
    await expect(sheet).toHaveCount(0);
    await expect(
      page.getByRole("status").filter({ hasText: "2 credits and proof saved." }),
    ).toBeVisible();
    expect(writes).toEqual(["addActivity", "evidence"]);

    // Saved as "Add later" (the default), then flipped to attached by the
    // upload that followed; the evidence API lists the photo under it.
    const saved = (await app.workspace()).activities.find(
      (activity) => activity.title === "Scanned course",
    );
    expect(saved?.evidenceStatus).toBe("attached");
    expect(saved?.evidenceCount).toBe(1);
    const listed = await context.request.get(
      `/api/evidence?activityId=${encodeURIComponent(saved!.id)}`,
      { headers: { accept: "application/json" } },
    );
    expect(listed.ok()).toBe(true);
    const { evidence } = (await listed.json()) as {
      evidence: Array<{ fileName: string; contentType: string; sizeBytes: number }>;
    };
    expect(evidence).toHaveLength(1);
    expect(evidence[0]).toMatchObject({
      fileName: "certificate.png",
      contentType: "image/png",
      sizeBytes: photo.byteLength,
    });

    // History shows the proof on file for the new record.
    await app.goto("/history");
    const records = page.getByRole("region", { name: "Completed activities" });
    await expect(records.getByText("Scanned course")).toBeVisible();
    await expect(records.getByText("1 on file")).toBeVisible();
    app.expectNoErrors();
  });
});
