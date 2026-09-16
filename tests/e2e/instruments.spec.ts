import { expect, freshIdentity, test } from "./fixtures";

// spec §5.1 instruments, a11y-11: the hero ring counts credits and draws its
// check when complete, every check-in carries its urgency as text (not only
// as a dot colour), the timeline lists every open deadline as a 44px marker,
// and the styleguide shows every ring state with a numeric value. Everything
// here seeds under a throwaway identity: the demo workspace is read-only.
// Each seeding test gets its OWN identity (a describe-level `test.use`, as
// home.spec's "Log credits" does): a file-level identity is shared by every
// test in the file, and the first test's overdue credential would then fill
// the second test's three visible check-in rows with overdue rows, hiding the
// "Due soon" one behind "View all".
test.use({ identity: freshIdentity() });

const isoDaysFromToday = (days: number) =>
  new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

test.describe("complete ring and overdue check-in", () => {
  test.use({ identity: freshIdentity() });

  test("an over-counted credential shows a complete ring with its check and complete (never overflow) bars, and a past deadline a text-bearing Overdue pill (a11y-11)", async ({ page, app }) => {
    // A deadline three days ago: an active cycle whose deadline has passed still
    // activates its check-in (app/lib/reminders.ts reminderActivationDate) with
    // urgency "overdue". The activity date must sit inside the cycle window
    // (route.ts rejects one outside it), hence 30 days back. 12 hours against
    // a 10-hour total: the credential is over-earned, the good outcome for the
    // hero bar and every minimum row (plan decision 9).
    const { id } = await app.seedCredential({
      credentialName: "E2E instruments",
      cycleStart: isoDaysFromToday(-400),
      deadline: isoDaysFromToday(-3),
    });
    await app.seedActivity(id, {
      totalUnits: 12,
      allocatedUnits: 12,
      completionDate: isoDaysFromToday(-30),
    });
    await app.goto("/");
    const ring = page.getByRole("progressbar", {
      name: "E2E instruments: 12 of 10 hours counted",
    });
    await expect(ring).toHaveAttribute("data-state", "complete");
    await expect(ring).toHaveAttribute("aria-valuenow", "100");
    await expect(ring.locator(".cycle-ring-check")).toHaveCount(1);
    // Only a capped (maximum) bar overflows into the overdue ink. An uncapped
    // bar past required is complete and paints in the same complete ink as
    // the ring's arc — the hero credits bar and the Overall row alike, while
    // aria-valuenow stays clamped at the total.
    const arcInk = await ring
      .locator(".cycle-ring-arc")
      .evaluate((node) => getComputedStyle(node).stroke);
    for (const name of [
      "E2E instruments: 12 of 10 hours",
      "Overall: 12 of 10 hours",
    ]) {
      const bar = page.getByRole("progressbar", { name, exact: true });
      await expect(bar).toHaveAttribute("data-state", "complete");
      await expect(bar).not.toHaveAttribute("data-overflow", "true");
      await expect(bar).toHaveAttribute("aria-valuenow", "10");
      expect(
        await bar
          .locator(".credit-bar-fill")
          .evaluate((node) => getComputedStyle(node).backgroundColor),
      ).toBe(arcInk);
    }
    await expect(page.getByText("Needs attention")).toBeVisible();
    const pill = page.locator(".reminder-list article.overdue .status-pill").first();
    await expect(pill).toHaveText("Overdue");
    // The state is a visible word on the row, never a dot's colour alone
    // (a11y-11, WCAG 1.4.1); the compact dot is a styleguide sample only.
    await expect(pill).toBeVisible();
    await expect(pill).not.toHaveAttribute("data-compact", "true");
    app.expectNoErrors();
  });
});

test.describe("timeline marker and due-soon check-in", () => {
  test.use({ identity: freshIdentity() });

  test("the timeline lists the seeded deadline as a 44px marker and opens it; the check-in reads Due soon", async ({ page, app }) => {
    // 60 days out: inside the 90-day lead window (check-in "soon") and inside
    // the timeline's twelve-month window.
    const { id } = await app.seedCredential({
      credentialName: "E2E timeline",
      cycleStart: isoDaysFromToday(-30),
      deadline: isoDaysFromToday(60),
    });
    await app.goto("/");
    await expect(
      page.locator(".reminder-list article.soon .status-pill").first(),
    ).toHaveText("Due soon");
    const marker = page
      .getByRole("list", { name: "Deadlines in the next twelve months" })
      .getByRole("button", { name: /E2E timeline/ });
    await expect(marker).toBeVisible();
    // spec §5.1 DeadlineTimeline: "hover/focus reveals" — the tooltip is
    // visibility:hidden until the marker is hovered or keyboard-focused
    // (`.deadline-timeline-hit:hover + .deadline-timeline-tip`,
    // `:focus-visible + …`). getByRole skips hidden elements, so toBeHidden()
    // holds whether the tip is unmatched or visibility:hidden.
    const tip = page.getByRole("tooltip", { name: /E2E timeline/ });
    await expect(tip).toBeHidden();
    await marker.hover();
    await expect(tip).toBeVisible();
    await page.mouse.move(2, 2);
    await expect(tip).toBeHidden();
    // Keyboard: a Tab round trip is what makes :focus-visible apply (as Task 7
    // Step 5 notes) — focus() alone would not show the ring or the tip.
    await marker.focus();
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Tab");
    await expect(marker).toBeFocused();
    await expect(tip).toBeVisible();
    const box = await marker.boundingBox();
    expect(box?.width).toBeGreaterThanOrEqual(44);
    expect(box?.height).toBeGreaterThanOrEqual(44);
    await marker.click();
    await expect(page).toHaveURL(new RegExp(`/credentials/${id}$`));
    app.expectNoErrors();
  });
});

test("the styleguide renders every ring state with a numeric value", async ({ page, app }) => {
  await app.goto("/styleguide");
  const rings = page.locator(".cycle-ring");
  await expect(rings).toHaveCount(4);
  for (const ring of await rings.all()) {
    await expect(ring).toHaveAttribute("aria-valuenow", /^\d+$/);
  }
  await expect(page.locator('.cycle-ring[data-state="complete"] .cycle-ring-check')).toHaveCount(1);
  // The over-the-cap sample is the only overflow bar on the page; the
  // over-earned sample (48 of 40, no cap) turns complete on its own and
  // never overflows — the count would read 2 if an uncapped bar did.
  await expect(page.locator('.credit-bar[data-overflow="true"]')).toHaveCount(1);
  await expect(
    page.getByRole("progressbar", { name: "Sample bar: over the cap" }),
  ).toHaveAttribute("data-overflow", "true");
  const overEarned = page.getByRole("progressbar", {
    name: "Sample bar: over-earned",
  });
  await expect(overEarned).toHaveAttribute("data-state", "complete");
  await expect(overEarned).not.toHaveAttribute("data-overflow", "true");
  app.expectNoErrors();
});
