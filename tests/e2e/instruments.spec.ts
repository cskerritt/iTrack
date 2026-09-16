import type { Locator } from "@playwright/test";
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

type Box = { x: number; y: number; width: number; height: number };
const boxOf = async (locator: Locator): Promise<Box> => {
  const box = await locator.boundingBox();
  expect(box, "the element must be laid out").not.toBeNull();
  return box as Box;
};
const intersects = (a: Box, b: Box) =>
  a.x < b.x + b.width &&
  b.x < a.x + a.width &&
  a.y < b.y + b.height &&
  b.y < a.y + a.height;
const contains = (outer: Box, inner: Box) =>
  inner.x >= outer.x &&
  inner.y >= outer.y &&
  inner.x + inner.width <= outer.x + outer.width &&
  inner.y + inner.height <= outer.y + outer.height;

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
    // The value text speaks for the CYCLE, not the ring: the credits are
    // complete (full arc, check), the renewal is three days overdue, and
    // "100%, renewed" — STATE_LABELS.complete is the cycle-based pill word —
    // would tell a screen-reader user the licence is renewed while the same
    // hero shows an overdue pill and a "days overdue" countdown
    // (app/lib/instruments.ts ringStateOf, the Task 10 amendment; WCAG 4.1.2).
    await expect(ring).toHaveAttribute("aria-valuetext", "100%, overdue");
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
    // The timeline's decorative "today" flag has a band of its own — beside
    // the top of the dashed line, below the marker dates — so a deadline near
    // today (three days back here: the ordinary state of any overdue
    // credential in the first half of a month, at every viewport) never
    // overprints the marker's name or date, and the flag itself stays inside
    // the plot.
    const plot = await boxOf(page.locator(".deadline-timeline-plot svg"));
    const todayLabel = await boxOf(
      page.locator(".deadline-timeline-today-label"),
    );
    expect(contains(plot, todayLabel)).toBe(true);
    const markerLabels = page.locator(
      ".deadline-timeline-marker-name, .deadline-timeline-marker-date",
    );
    await expect(markerLabels).toHaveCount(2);
    for (const label of await markerLabels.all()) {
      const box = await boxOf(label);
      expect(contains(plot, box)).toBe(true);
      expect(intersects(todayLabel, box)).toBe(false);
    }
    app.expectNoErrors();
  });
});

test.describe("hero ring across a credential switch", () => {
  test.use({ identity: freshIdentity() });

  test("switching the hero to a credits-complete credential mounts its ring fresh: the check does not replay as a completion", async ({ page, app }) => {
    // The hero is the soonest live deadline (app/lib/cycles.ts activeCycleId):
    // an empty credential 60 days out. Behind it waits a fully counted one,
    // 200 days out — an open, on-track cycle whose ring is complete by credits.
    const { id: completeId } = await app.seedCredential({
      credentialName: "E2E switch complete",
      cycleStart: isoDaysFromToday(-165),
      deadline: isoDaysFromToday(200),
    });
    await app.seedActivity(completeId, {
      totalUnits: 10,
      allocatedUnits: 10,
      completionDate: isoDaysFromToday(-30),
    });
    await app.seedCredential({
      credentialName: "E2E switch incomplete",
      cycleStart: isoDaysFromToday(-30),
      deadline: isoDaysFromToday(60),
    });
    await app.goto("/");
    const ring = page.locator(".readiness-panel .cycle-ring");
    await expect(ring).toHaveAttribute(
      "aria-label",
      "E2E switch incomplete: 0 of 10 hours counted",
    );
    await expect(ring).toHaveAttribute("data-state", "due-soon");
    await expect(ring).toHaveAttribute("aria-valuetext", "0%, due soon");
    // The Log sheet's "Apply to credential" re-points the app-wide selection
    // while Home stays mounted beneath the sheet — the one place the hero
    // changes credential without Home unmounting.
    const sheet = await app.openLog();
    await sheet.locator('select[name="credentialId"]').selectOption(completeId);
    await expect(ring).toHaveAttribute(
      "aria-label",
      "E2E switch complete: 10 of 10 hours counted",
    );
    await expect(ring).toHaveAttribute("data-state", "complete");
    await expect(ring.locator(".cycle-ring-check")).toHaveCount(1);
    // A credits-complete ring on an open cycle reads the cycle's word.
    await expect(ring).toHaveAttribute("aria-valuetext", "100%, on track");
    // Decision 5: the check draws only when a value crosses complete after
    // mount. A different credential is a fresh mount (the hero ring is keyed
    // on the credential id), so the switch is no completion moment — its
    // check is simply there, never replayed as though a requirement had just
    // been met. The layout effect runs in the same commit as the new label,
    // so once the label has changed the attribute's absence is final.
    expect(await ring.getAttribute("data-motion")).toBeNull();
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
    // Nothing counted, 60 days out: the ring's numeral and its cycle agree.
    await expect(
      page.getByRole("progressbar", {
        name: "E2E timeline: 0 of 10 hours counted",
      }),
    ).toHaveAttribute("aria-valuetext", "0%, due soon");
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

test.describe("timeline tooltip and label near the axis end", () => {
  test.use({ identity: freshIdentity() });

  test("a deadline late in the window hangs its tooltip and label from the marker's own side: Home never scrolls sideways and the revealed tip stays on screen", async ({ page, app }) => {
    // 330 days out lands at ~92% of the axis — the ordinary state of a
    // freshly renewed annual credential, not an edge case. A hidden tooltip
    // still counts toward the page's scrollable overflow, so a tip centred on
    // that marker gave Home a horizontal scrollbar with nothing hovered, and
    // the revealed tip ran off the viewport's right edge. The long name is
    // the widest tip a real credential produces.
    await app.seedCredential({
      credentialName: "Certified Rehabilitation Counselor Supervisor",
      cycleStart: isoDaysFromToday(-35),
      deadline: isoDaysFromToday(330),
    });
    await app.goto("/");
    const viewportWidth = page.viewportSize()?.width ?? 0;
    const sidewaysOverflow = () =>
      page.evaluate(
        () =>
          document.documentElement.scrollWidth -
          document.documentElement.clientWidth,
      );
    expect(await sidewaysOverflow()).toBeLessThanOrEqual(0);
    const marker = page
      .getByRole("list", { name: "Deadlines in the next twelve months" })
      .getByRole("button", {
        name: /Certified Rehabilitation Counselor Supervisor/,
      });
    await expect(marker.locator("..")).toHaveAttribute("data-edge", "end");
    // The decorative name above the marker ends at the marker, so the SVG
    // (which clips) shows the whole name rather than its first half.
    const name = page.locator(".deadline-timeline-marker-name", {
      hasText: "Certified Rehabilitation Counselor Supervisor",
    });
    await expect(name).toHaveAttribute("text-anchor", "end");
    const svgBox = await page.locator(".deadline-timeline-plot svg").boundingBox();
    const nameBox = await name.boundingBox();
    expect(nameBox?.x).toBeGreaterThanOrEqual(svgBox?.x ?? Infinity);
    expect((nameBox?.x ?? Infinity) + (nameBox?.width ?? 0)).toBeLessThanOrEqual(
      (svgBox?.x ?? 0) + (svgBox?.width ?? 0),
    );
    const tip = page.getByRole("tooltip", {
      name: /Certified Rehabilitation Counselor Supervisor/,
    });
    await expect(tip).toBeHidden();
    const expectTipOnScreen = async () => {
      await expect(tip).toBeVisible();
      const box = await tip.boundingBox();
      expect(box?.x).toBeGreaterThanOrEqual(0);
      expect((box?.x ?? Infinity) + (box?.width ?? 0)).toBeLessThanOrEqual(
        viewportWidth,
      );
      // Wrapped, not cut: every line of text is laid out inside the box.
      expect(
        await tip.evaluate((node) => node.scrollWidth <= node.clientWidth + 1),
      ).toBe(true);
      expect(await sidewaysOverflow()).toBeLessThanOrEqual(0);
    };
    await marker.hover();
    await expectTipOnScreen();
    await page.mouse.move(2, 2);
    await expect(tip).toBeHidden();
    await marker.focus();
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Tab");
    await expect(marker).toBeFocused();
    await expectTipOnScreen();
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
  // The sample's fixed today (2026-09-15) makes the timeline's edge logic
  // deterministic: LCSW (Nov 30) sits in the axis's first third and hangs its
  // tooltip and label from the marker's right; CRC (Feb 1) sits in the middle
  // third and stays centred; CLCP (2028) is beyond the window.
  const items = page.locator(".deadline-timeline-list > li");
  await expect(items).toHaveCount(2);
  await expect(items.filter({ has: page.getByRole("button", { name: /^LCSW/ }) })).toHaveAttribute("data-edge", "start");
  await expect(page.locator('.deadline-timeline-list > li:not([data-edge])')).toHaveCount(1);
  await expect(page.locator('.deadline-timeline-list > li[data-edge="end"]')).toHaveCount(0);
  app.expectNoErrors();
});

test("the completion moment is real motion or none: under prefers-reduced-motion the check's animation and the arc's transition are none, not a frozen keyframe", async ({ page, app }) => {
  // The styleguide's 40px ring mounts complete, so it carries no data-motion
  // (decision 5: the check draws only when a value crosses 1 after mount) —
  // setting the attribute here is the completion moment without a workspace.
  await app.goto("/styleguide");
  const ring = page.locator('.cycle-ring[data-state="complete"]');
  await expect(ring).toHaveCount(1);
  expect(await ring.getAttribute("data-motion")).toBeNull();
  const check = ring.locator(".cycle-ring-check");
  const arc = ring.locator(".cycle-ring-arc");
  const animationName = () =>
    check.evaluate((node) => getComputedStyle(node).animationName);
  const transitionProperty = () =>
    arc.evaluate((node) => getComputedStyle(node).transitionProperty);
  expect(await animationName()).toBe("none");
  await ring.evaluate((node) => node.setAttribute("data-motion", "complete"));
  expect(await animationName()).toBe("cycle-ring-check-draw");
  expect(await transitionProperty()).toBe("stroke-dasharray");
  // Reduced motion: the moment is switched OFF, not frozen. A rule that
  // merely lost to `.cycle-ring[data-motion="complete"] .cycle-ring-check`
  // on specificity left the keyframes running for the global freeze's
  // 0.01ms; `animation: none` leaves the check fully drawn (no dash offset).
  await page.emulateMedia({ reducedMotion: "reduce" });
  expect(await animationName()).toBe("none");
  expect(await transitionProperty()).toBe("none");
  expect(
    await check.evaluate((node) => getComputedStyle(node).strokeDashoffset),
  ).toBe("0px");
  await page.emulateMedia({ reducedMotion: "no-preference" });
  expect(await animationName()).toBe("cycle-ring-check-draw");
  expect(await transitionProperty()).toBe("stroke-dasharray");
  app.expectNoErrors();
});
