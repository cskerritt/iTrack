import {
  test as base,
  expect,
  devices,
  type BrowserContext,
  type Locator,
  type Page,
} from "@playwright/test";

// Shared fixtures for every spec under tests/e2e (spec §4 bullet 1,
// architecture-03).
//
// Identity. Under `npm run dev` there is no gateway: a request on localhost
// without an `oai-authenticated-user-email` header is the demo user
// (db/identity.ts resolveRequestIdentity), and a request carrying that header
// is whoever the header names — the gateway strips inbound `oai-*` headers
// only in production (deploy/railway/gateway.mjs). Dev D1/R2 state persists
// across runs (.wrangler/state/v3), so the demo workspace is READ-ONLY in
// every spec; a spec that saves anything declares
// `test.use({ identity: freshIdentity() })` and seeds through /api/workspace.
// The header rides on the `extraHTTPHeaders` option, so the stock `context`
// and `page` fixtures still build the context from the project's viewport,
// colour scheme and baseURL, and `context.request` carries the same header.

export type Identity = { email: string; fresh: boolean };

export type Workspace = {
  user: { email: string; isDemo?: boolean; draftStorageNamespace: string };
  credentials: Array<{
    id: string;
    credentialName: string;
    status: string;
    deadline: string;
    revision?: number;
    [k: string]: unknown;
  }>;
  archivedCredentials?: Array<{ id: string; credentialName: string }>;
  activities: Array<{
    id: string;
    title: string;
    revision: number;
    evidenceStatus?: "missing" | "attached" | "not_required";
    evidenceCount?: number;
  }>;
  reminderPreferences: {
    timeZone: string;
    pushHourLocal: number;
    leadDays: number[];
    inAppEnabled: boolean;
    pushEnabled: boolean;
  };
  activeCycleId?: string | null;
};

export type CustomCredentialPayload = {
  credentialName: string;
  profession: string;
  jurisdiction: string;
  issuer: string;
  totalRequired: number;
  unitLabel: string;
  cycleStart: string;
  deadline: string;
  categories: Array<{ name: string; requiredUnits: number }>;
};

export type ActivityPayload = {
  title: string;
  provider: string;
  completionDate: string;
  totalUnits: number;
  allocatedUnits: number;
  credentialId: string;
};

export type AppFixture = {
  goto(path: string): Promise<void>;
  errors: string[];
  expectNoErrors(): void;
  openLog(): Promise<Locator>;
  dialog(name: string): Locator;
  tab(name: "Home" | "Credentials" | "Activity log" | "Account"): Locator;
  workspace(): Promise<Workspace>;
  // The demo credential's id (asserts the identity is the demo one first).
  demoCredentialId(): Promise<string>;
  act<T = { ok: boolean; id: string }>(
    action: string,
    payload: Record<string, unknown>,
  ): Promise<T>;
  seedCredential(
    overrides?: Partial<CustomCredentialPayload>,
  ): Promise<{ id: string }>;
  seedActivity(
    credentialId: string,
    overrides?: Partial<ActivityPayload>,
  ): Promise<{ id: string }>;
};

const DEMO_IDENTITY: Identity = {
  email: "demo@local.license-lantern",
  fresh: false,
};

// A workspace nobody else writes to: worker index, time and a random suffix
// keep two runs (and the four projects, which each load a spec file
// separately) apart. Rows accumulate in the dev D1 file; that is the point.
export const freshIdentity = (): Identity => ({
  email: `e2e-${process.env.TEST_WORKER_INDEX ?? 0}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}@example.test`,
  fresh: true,
});

// The custom branch of createCredential (no ruleSetId): one "General"
// category equal to the total keeps the category-total check satisfied.
const CREDENTIAL_DEFAULTS: CustomCredentialPayload = {
  credentialName: "E2E custom credential",
  profession: "Counseling",
  jurisdiction: "Rhode Island",
  issuer: "E2E board",
  totalRequired: 10,
  unitLabel: "hours",
  cycleStart: "2026-01-01",
  deadline: "2027-12-31",
  categories: [{ name: "General", requiredUnits: 10 }],
};

// Inside the default cycle window above.
const ACTIVITY_DEFAULTS: Omit<ActivityPayload, "credentialId"> = {
  title: "E2E course",
  provider: "E2E provider",
  completionDate: "2026-06-02",
  totalUnits: 2,
  allocatedUnits: 2,
};

function buildApp(page: Page, context: BrowserContext): AppFixture {
  const errors: string[] = [];
  // A render-time throw is uncaught in production (pageerror); under
  // `npm run dev` vinext's recovery boundary catches it and React reports it
  // through console.error. Collect both so a crash is named as the thrown
  // error rather than as the control that vanished with the unmounted tree.
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    const text = message.text();
    if (message.type() === "error" && /^(?:[A-Z]\w*)?Error\b/.test(text)) {
      errors.push(text.split("\n")[0]);
    }
  });

  const act = async <T = { ok: boolean; id: string }>(
    action: string,
    payload: Record<string, unknown>,
  ): Promise<T> => {
    // context.request sends `content-type: application/json` for object
    // data and neither Origin nor sec-fetch-site, so the worker's
    // same-origin check on POST /api/workspace is satisfied.
    const response = await context.request.post("/api/workspace", {
      data: { action, payload },
    });
    if (!response.ok()) {
      throw new Error(
        `${action}: ${response.status()} ${await response.text()}`,
      );
    }
    return (await response.json()) as T;
  };

  const readWorkspace = async (): Promise<Workspace> => {
    const response = await context.request.get("/api/workspace", {
      headers: { accept: "application/json" },
    });
    if (!response.ok()) {
      throw new Error(
        `GET /api/workspace: ${response.status()} ${await response.text()}`,
      );
    }
    return (await response.json()) as Workspace;
  };

  return {
    errors,
    async goto(path) {
      await page.goto(path);
      // The shell is server-rendered before React hydrates, so an early
      // click is lost. The placeholder is swapped out only after the client
      // has hydrated and fetched the workspace; wait for that first.
      await expect(
        page.locator('[aria-busy="true"][aria-label="Loading iTrack"]'),
      ).toHaveCount(0, { timeout: 30_000 });
    },
    expectNoErrors() {
      expect(errors, errors.join("\n")).toEqual([]);
    },
    async openLog() {
      // ≥ 821px: the rail's "Log activity" (Home's desktop-only "Log completed
      // learning" call to action also matches, hence .first()); ≤ 820px: the
      // bottom nav's button labelled "Log activity". getByRole skips whichever
      // is display:none. The regex is unchanged: both labels still exist.
      await page
        .getByRole("button", {
          name: /^(Log activity|Log completed learning)$/,
        })
        .first()
        .click();
      const sheet = page.getByRole("dialog", {
        name: "Log completed learning",
      });
      await expect(sheet).toBeVisible();
      return sheet;
    },
    dialog(name) {
      return page.getByRole("dialog", { name });
    },
    tab(name) {
      // Both the rail and the bottom nav are labelled "Primary navigation";
      // only the one that is not display:none at the current viewport is
      // matched. Tabs are links (spec §5.1). The phone's third link shows
      // "Activity" but is named "Activity log" (aria-label), so one name
      // serves both viewports.
      return page
        .getByRole("navigation", { name: "Primary navigation" })
        .getByRole("link", { name, exact: true });
    },
    async workspace() {
      return readWorkspace();
    },
    async demoCredentialId() {
      // The demo workspace is read-only in every spec; a spec that reached
      // here under a fresh identity would be auditing an empty workspace.
      const current = await readWorkspace();
      expect(
        current.user.isDemo,
        "the demo identity is read-only; seed under freshIdentity() instead",
      ).toBe(true);
      expect(
        current.credentials.length,
        "the demo seed has a credential",
      ).toBeGreaterThan(0);
      return current.credentials[0].id;
    },
    act,
    async seedCredential(overrides = {}) {
      const result = await act("createCredential", {
        ...CREDENTIAL_DEFAULTS,
        ...overrides,
      });
      return { id: result.id };
    },
    async seedActivity(credentialId, overrides = {}) {
      const result = await act("addActivity", {
        ...ACTIVITY_DEFAULTS,
        credentialId,
        ...overrides,
      });
      return { id: result.id };
    },
  };
}

export const test = base.extend<{ identity: Identity; app: AppFixture }>({
  identity: [DEMO_IDENTITY, { option: true }],
  // The callback is named `provide`, not Playwright's conventional `use`:
  // eslint-config-next's react-hooks/rules-of-hooks reads a bare `use(...)`
  // call as the React hook and fails `npm run lint`.
  extraHTTPHeaders: async ({ identity }, provide) => {
    await provide(
      identity.fresh
        ? { "oai-authenticated-user-email": identity.email }
        : undefined,
    );
  },
  app: async ({ page, context }, provide) => {
    await provide(buildApp(page, context));
  },
});

export { expect, devices };
