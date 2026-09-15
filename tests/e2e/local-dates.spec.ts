import { expect, freshIdentity, test } from "./fixtures";

// critic-01: the app's "today" was the UTC date, so every default date input
// disagreed with the phone's own calendar after ~8 pm in the Americas, and
// nothing ever captured the device's zone (every account is seeded with the
// literal 'UTC'). A fresh account in New York at 22:30 on 9 September
// (02:30Z on the 10th) must see the 9th in the log sheet, and one tap on the
// offer banner must persist America/New_York as the reminder zone.
//
// A fresh identity: the tap writes reminder_preferences, and the demo
// identity is read-only in every spec.
test.use({ identity: freshIdentity(), timezoneId: "America/New_York" });

test("default dates are local and one tap adopts the device time zone", async ({ app, page }) => {
  await app.seedCredential();
  // Fixed wall clock for the page only; the server keeps real time (no server
  // write compares a date to "today" except the snooze check).
  await page.clock.setFixedTime(new Date("2026-09-10T02:30:00Z"));
  await app.goto("/");
  expect(
    await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone),
    "the context fixture must apply timezoneId (spread contextOptions in browser.newContext)",
  ).toBe("America/New_York");

  const sheet = await app.openLog();
  await expect(sheet.locator('input[name="completionDate"]')).toHaveValue("2026-09-09");
  await page.keyboard.press("Escape");
  await expect(sheet).toBeHidden();

  const adopt = page.getByRole("button", { name: "Use America/New_York" });
  await expect(adopt).toBeVisible();
  await adopt.click();
  await expect(page.locator(".zone-banner")).toHaveCount(0);

  await app.goto("/profile");
  await expect(page.getByText("Times use America/New_York.")).toBeVisible();
  expect((await app.workspace()).reminderPreferences.timeZone).toBe("America/New_York");
  app.expectNoErrors();
});
