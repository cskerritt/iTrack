"use client";

import {
  FormEvent,
  ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";

type Requirement = {
  id: string;
  name: string;
  requiredUnits: number;
  earnedUnits: number;
};

type RenewalTask = {
  id: string;
  title: string;
  kind: string;
  status: "pending" | "completed";
  dueDate?: string | null;
};

type Credential = {
  id: string;
  credentialName: string;
  profession: string;
  jurisdiction: string;
  issuer?: string | null;
  cycleStart: string;
  deadline: string;
  totalRequired: number;
  unitLabel: string;
  status: "active" | "submitted" | "renewed";
  submittedAt?: string | null;
  confirmationNumber?: string | null;
  sourceUrl?: string | null;
  sourceTitle?: string | null;
  ruleReviewStatus?: string | null;
  totalEarned: number;
  requirements: Requirement[];
  tasks: RenewalTask[];
};

type CatalogCategory = {
  id: string;
  name: string;
  requiredUnits: number;
};

type CatalogRule = {
  id: string;
  profession: string;
  credentialName: string;
  jurisdiction: string;
  issuer: string;
  totalUnits: number;
  unitLabel: string;
  cycleMonths: number;
  sourceUrl?: string | null;
  sourceTitle?: string | null;
  effectiveDate?: string | null;
  lastVerifiedAt?: string | null;
  reviewStatus?: string | null;
  categories: CatalogCategory[];
};

type Activity = {
  id: string;
  title: string;
  provider?: string | null;
  completionDate: string;
  totalUnits: number;
  evidenceStatus: "missing" | "attached" | "not_required";
  credentialName?: string | null;
  categoryName?: string | null;
  allocatedUnits: number;
};

type Badge = {
  id: string;
  name: string;
  description: string;
  earnedAt?: string | null;
  earned?: boolean;
};

type Workspace = {
  user: {
    displayName: string;
    email: string;
    isDemo?: boolean;
  };
  profile: {
    xp: number;
    weekActions: number;
    weeklyGoal: number;
    badges: Badge[];
  };
  catalog: CatalogRule[];
  credentials: Credential[];
  activities: Activity[];
};

type ViewName = "today" | "credentials" | "records" | "account";
type ToastState = {
  message: string;
  undo?: () => void;
};

const todayIso = () => new Date().toISOString().slice(0, 10);

const nextYearIso = () => {
  const date = new Date();
  date.setFullYear(date.getFullYear() + 1);
  return date.toISOString().slice(0, 10);
};

const yearAgoIso = () => {
  const date = new Date();
  date.setFullYear(date.getFullYear() - 1);
  return date.toISOString().slice(0, 10);
};

function formatDate(value?: string | null, options?: Intl.DateTimeFormatOptions) {
  if (!value) return "Not set";
  const parsed = new Date(`${value.slice(0, 10)}T12:00:00`);
  if (Number.isNaN(parsed.getTime())) return value;
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    ...options,
  }).format(parsed);
}

function daysUntil(value: string) {
  const deadline = new Date(`${value.slice(0, 10)}T23:59:59`);
  const today = new Date();
  return Math.max(
    0,
    Math.ceil((deadline.getTime() - today.getTime()) / 86_400_000),
  );
}

function compactNumber(value: number) {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function clampPercent(value: number) {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function firstName(displayName: string) {
  const candidate = displayName.includes("@")
    ? displayName.split("@")[0]
    : displayName.split(/\s+/)[0];
  return candidate || "there";
}

function credentialProgress(credential: Credential) {
  if (credential.totalRequired <= 0) return 100;
  return clampPercent(
    (credential.totalEarned / credential.totalRequired) * 100,
  );
}

function readinessScore(credential: Credential) {
  const unitProgress = Math.min(1, credentialProgress(credential) / 100);
  const requirementCount = credential.requirements.length;
  const metRequirements = credential.requirements.filter(
    (item) => item.earnedUnits >= item.requiredUnits,
  ).length;
  const requirementProgressValue =
    requirementCount === 0 ? 1 : metRequirements / requirementCount;
  const taskCount = credential.tasks.length;
  const completedTasks = credential.tasks.filter(
    (item) => item.status === "completed",
  ).length;
  const taskProgress = taskCount === 0 ? 1 : completedTasks / taskCount;
  return clampPercent(
    unitProgress * 70 + requirementProgressValue * 15 + taskProgress * 15,
  );
}

function bestNextAction(credential: Credential) {
  const missingRequirement = credential.requirements
    .filter((item) => item.earnedUnits < item.requiredUnits)
    .sort(
      (a, b) =>
        b.requiredUnits -
        b.earnedUnits -
        (a.requiredUnits - a.earnedUnits),
    )[0];

  if (missingRequirement) {
    const left =
      missingRequirement.requiredUnits - missingRequirement.earnedUnits;
    return `Complete ${compactNumber(left)} more ${missingRequirement.name} ${
      left === 1 ? credential.unitLabel.replace(/s$/, "") : credential.unitLabel
    }`;
  }

  const openTask = credential.tasks.find((task) => task.status !== "completed");
  if (openTask) return openTask.title;
  if (credential.status === "active") return "Review and submit your renewal";
  return "Keep your confirmation with this cycle";
}

export function LicenseLanternApp() {
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [view, setView] = useState<ViewName>("today");
  const [selectedCredentialId, setSelectedCredentialId] = useState("");
  const [activityOpen, setActivityOpen] = useState(false);
  const [credentialOpen, setCredentialOpen] = useState(false);
  const [submissionOpen, setSubmissionOpen] = useState(false);
  const [customCredential, setCustomCredential] = useState(false);
  const [selectedRuleId, setSelectedRuleId] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [toast, setToast] = useState<ToastState | null>(null);

  const loadWorkspace = useCallback(async () => {
    try {
      const response = await fetch("/api/workspace", {
        headers: { accept: "application/json" },
        cache: "no-store",
      });
      const data = (await response.json()) as Workspace & { error?: string };
      if (!response.ok) {
        throw new Error(data.error || "We couldn’t load your renewal workspace.");
      }
      setWorkspace(data);
      setError("");
      setSelectedCredentialId((current) => {
        if (
          current &&
          data.credentials.some((credential) => credential.id === current)
        ) {
          return current;
        }
        return [...data.credentials].sort(
          (a, b) =>
            new Date(a.deadline).getTime() - new Date(b.deadline).getTime(),
        )[0]?.id ?? "";
      });
    } catch (loadError) {
      setError(
        loadError instanceof Error
          ? loadError.message
          : "We couldn’t load your renewal workspace.",
      );
    }
  }, []);

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      void loadWorkspace();
    }, 0);
    return () => window.clearTimeout(timeout);
  }, [loadWorkspace]);

  useEffect(() => {
    if (!toast) return;
    const timeout = window.setTimeout(() => setToast(null), 6000);
    return () => window.clearTimeout(timeout);
  }, [toast]);

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setActivityOpen(false);
      setCredentialOpen(false);
      setSubmissionOpen(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, []);

  const selectedCredential = useMemo(() => {
    if (!workspace) return null;
    return (
      workspace.credentials.find(
        (credential) => credential.id === selectedCredentialId,
      ) ??
      workspace.credentials[0] ??
      null
    );
  }, [selectedCredentialId, workspace]);

  const selectedRule = useMemo(
    () =>
      workspace?.catalog.find((rule) => rule.id === selectedRuleId) ?? null,
    [selectedRuleId, workspace],
  );

  async function runAction(
    action: string,
    payload: Record<string, unknown>,
    successMessage: string,
  ) {
    setPending(true);
    setError("");
    try {
      const response = await fetch("/api/workspace", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, payload }),
      });
      const result = (await response.json()) as {
        ok?: boolean;
        error?: string;
      };
      if (!response.ok) {
        throw new Error(result.error || "That update didn’t save.");
      }
      await loadWorkspace();
      setToast({ message: successMessage });
      return true;
    } catch (actionError) {
      setError(
        actionError instanceof Error
          ? actionError.message
          : "That update didn’t save.",
      );
      return false;
    } finally {
      setPending(false);
    }
  }

  async function handleActivitySubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const credentialId = String(form.get("credentialId") ?? "");
    const totalUnits = Number(form.get("totalUnits"));
    const success = await runAction(
      "addActivity",
      {
        title: String(form.get("title") ?? ""),
        provider: String(form.get("provider") ?? ""),
        completionDate: String(form.get("completionDate") ?? ""),
        totalUnits,
        credentialId,
        requirementId: String(form.get("requirementId") ?? "") || null,
        allocatedUnits: totalUnits,
        evidenceStatus: String(form.get("evidenceStatus") ?? "missing"),
      },
      `${compactNumber(totalUnits)} ${
        totalUnits === 1 ? "credit" : "credits"
      } added to your record.`,
    );
    if (success) {
      setActivityOpen(false);
      formElement.reset();
    }
  }

  async function handleCredentialSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const rule =
      workspace?.catalog.find(
        (item) => item.id === String(form.get("ruleSetId") ?? ""),
      ) ?? null;
    const customCategoryUnits = Number(form.get("categoryUnits") ?? 0);
    const categories = customCredential
      ? customCategoryUnits > 0
        ? [
            {
              name: String(form.get("categoryName") ?? "General"),
              requiredUnits: customCategoryUnits,
            },
          ]
        : []
      : (rule?.categories ?? []).map((category) => ({
          name: category.name,
          requiredUnits: category.requiredUnits,
        }));
    const totalRequired = customCredential
      ? Number(form.get("totalRequired") ?? 0)
      : (rule?.totalUnits ?? 0);

    const success = await runAction(
      "createCredential",
      {
        ruleSetId: rule?.id ?? null,
        credentialName: customCredential
          ? String(form.get("credentialName") ?? "")
          : (rule?.credentialName ?? ""),
        profession: customCredential
          ? String(form.get("profession") ?? "")
          : (rule?.profession ?? ""),
        jurisdiction: customCredential
          ? String(form.get("jurisdiction") ?? "")
          : (rule?.jurisdiction ?? ""),
        issuer: customCredential
          ? String(form.get("issuer") ?? "")
          : (rule?.issuer ?? ""),
        cycleStart: String(form.get("cycleStart") ?? ""),
        deadline: String(form.get("deadline") ?? ""),
        totalRequired,
        unitLabel: customCredential
          ? String(form.get("unitLabel") ?? "hours")
          : (rule?.unitLabel ?? "hours"),
        categories,
      },
      "Credential added. Your renewal plan is ready.",
    );

    if (success) {
      setCredentialOpen(false);
      setSelectedRuleId("");
      setCustomCredential(false);
    }
  }

  async function handleSubmission(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedCredential) return;
    const form = new FormData(event.currentTarget);
    const success = await runAction(
      "markSubmitted",
      {
        credentialId: selectedCredential.id,
        submissionDate: String(form.get("submissionDate") ?? ""),
        confirmationNumber: String(form.get("confirmationNumber") ?? ""),
      },
      "Submission logged. Keep the confirmation until your renewal is accepted.",
    );
    if (success) setSubmissionOpen(false);
  }

  async function toggleTask(task: RenewalTask) {
    const completed = task.status !== "completed";
    const success = await runAction(
      "toggleTask",
      { taskId: task.id, completed },
      completed ? "Task checked off." : "Task reopened.",
    );
    if (success) {
      setToast({
        message: completed ? "Task checked off." : "Task reopened.",
        undo: () => {
          void runAction(
            "toggleTask",
            { taskId: task.id, completed: !completed },
            "Change undone.",
          );
        },
      });
    }
  }

  const userName = workspace?.user.displayName ?? "Professional";

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>
      <DesktopSidebar
        view={view}
        onView={setView}
        onAdd={() => setActivityOpen(true)}
        hasCredential={Boolean(selectedCredential)}
      />

      <div className="app-stage">
        <header className="mobile-header">
          <Brand />
          <button
            className="avatar-button"
            type="button"
            aria-label="Open account"
            onClick={() => setView("account")}
          >
            {firstName(userName).slice(0, 1).toUpperCase()}
          </button>
        </header>

        <main id="main-content" className="main-content">
          {error ? (
            <div className="error-banner" role="alert">
              <div>
                <strong>Something needs attention</strong>
                <span>{error}</span>
              </div>
              <button type="button" onClick={() => void loadWorkspace()}>
                Try again
              </button>
            </div>
          ) : null}

          {!workspace ? (
            <LoadingDashboard />
          ) : view === "today" ? (
            <TodayView
              workspace={workspace}
              credential={selectedCredential}
              onAddActivity={() => setActivityOpen(true)}
              onAddCredential={() => setCredentialOpen(true)}
              onViewCredentials={() => setView("credentials")}
              onViewRecords={() => setView("records")}
              onSubmit={() => setSubmissionOpen(true)}
              onToggleTask={toggleTask}
            />
          ) : view === "credentials" ? (
            <CredentialsView
              credentials={workspace.credentials}
              selectedId={selectedCredential?.id ?? ""}
              onSelect={(id) => setSelectedCredentialId(id)}
              onAdd={() => setCredentialOpen(true)}
              onSubmit={() => setSubmissionOpen(true)}
            />
          ) : view === "records" ? (
            <RecordsView
              activities={workspace.activities}
              credentials={workspace.credentials}
              onAdd={() => setActivityOpen(true)}
            />
          ) : (
            <AccountView workspace={workspace} />
          )}
        </main>
      </div>

      <MobileNavigation
        view={view}
        onView={setView}
        onAdd={() => setActivityOpen(true)}
        hasCredential={Boolean(selectedCredential)}
      />

      {activityOpen && workspace ? (
        <Modal
          title="Log completed learning"
          eyebrow="Quick add"
          onClose={() => setActivityOpen(false)}
        >
          {workspace.credentials.length === 0 ? (
            <EmptyModalState
              title="Add a credential first"
              body="Credits need a renewal cycle so License Lantern knows where to count them."
              action="Set up credential"
              onAction={() => {
                setActivityOpen(false);
                setCredentialOpen(true);
              }}
            />
          ) : (
            <form className="form-stack" onSubmit={handleActivitySubmit}>
              <label className="field">
                <span>Course, conference, or activity</span>
                <input
                  autoFocus
                  name="title"
                  placeholder="e.g., Ethics in clinical practice"
                  required
                />
              </label>
              <div className="form-grid">
                <label className="field">
                  <span>Completion date</span>
                  <input
                    name="completionDate"
                    type="date"
                    defaultValue={todayIso()}
                    required
                  />
                </label>
                <label className="field">
                  <span>Credits earned</span>
                  <input
                    name="totalUnits"
                    type="number"
                    min="0.1"
                    step="0.1"
                    inputMode="decimal"
                    placeholder="1.0"
                    required
                  />
                </label>
              </div>
              <label className="field">
                <span>Apply to credential</span>
                <select
                  name="credentialId"
                  defaultValue={selectedCredential?.id}
                  required
                  onChange={(event) =>
                    setSelectedCredentialId(event.currentTarget.value)
                  }
                >
                  {workspace.credentials.map((credential) => (
                    <option key={credential.id} value={credential.id}>
                      {credential.credentialName} · {credential.jurisdiction}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>Category</span>
                <select name="requirementId" defaultValue="">
                  <option value="">General / decide later</option>
                  {(workspace.credentials.find(
                    (credential) => credential.id === selectedCredentialId,
                  )?.requirements ??
                    selectedCredential?.requirements ??
                    []).map((requirement) => (
                    <option key={requirement.id} value={requirement.id}>
                      {requirement.name}
                    </option>
                  ))}
                </select>
                <small>
                  Unsure? Save it as General and review the category later.
                </small>
              </label>
              <label className="field">
                <span>Provider or organizer <em>Optional</em></span>
                <input
                  name="provider"
                  placeholder="Organization or conference name"
                />
              </label>
              <fieldset className="segmented-field">
                <legend>Proof status</legend>
                <label>
                  <input
                    type="radio"
                    name="evidenceStatus"
                    value="attached"
                  />
                  <span>Proof on file</span>
                </label>
                <label>
                  <input
                    type="radio"
                    name="evidenceStatus"
                    value="missing"
                    defaultChecked
                  />
                  <span>Add later</span>
                </label>
                <label>
                  <input
                    type="radio"
                    name="evidenceStatus"
                    value="not_required"
                  />
                  <span>Not required</span>
                </label>
              </fieldset>
              <div className="form-actions">
                <button
                  className="button button-ghost"
                  type="button"
                  onClick={() => setActivityOpen(false)}
                >
                  Cancel
                </button>
                <button
                  className="button button-primary"
                  type="submit"
                  disabled={pending}
                >
                  {pending ? "Saving…" : "Save activity"}
                </button>
              </div>
            </form>
          )}
        </Modal>
      ) : null}

      {credentialOpen && workspace ? (
        <Modal
          title="Set up a credential"
          eyebrow="Renewal plan"
          onClose={() => setCredentialOpen(false)}
        >
          <form className="form-stack" onSubmit={handleCredentialSubmit}>
            <div className="mode-switch" aria-label="Credential setup mode">
              <button
                className={!customCredential ? "active" : ""}
                type="button"
                aria-pressed={!customCredential}
                onClick={() => setCustomCredential(false)}
              >
                Use source-linked template
              </button>
              <button
                className={customCredential ? "active" : ""}
                type="button"
                aria-pressed={customCredential}
                onClick={() => setCustomCredential(true)}
              >
                Enter my own
              </button>
            </div>

            {customCredential ? (
              <>
                <div className="form-grid">
                  <label className="field">
                    <span>Profession</span>
                    <input name="profession" required placeholder="Nurse" />
                  </label>
                  <label className="field">
                    <span>State or jurisdiction</span>
                    <input name="jurisdiction" required placeholder="PA" />
                  </label>
                </div>
                <label className="field">
                  <span>Credential or license</span>
                  <input
                    autoFocus
                    name="credentialName"
                    required
                    placeholder="Registered Nurse"
                  />
                </label>
                <label className="field">
                  <span>Issuing organization <em>Optional</em></span>
                  <input name="issuer" placeholder="State licensing board" />
                </label>
                <div className="form-grid form-grid-three">
                  <label className="field">
                    <span>Total required</span>
                    <input
                      name="totalRequired"
                      type="number"
                      min="0"
                      step="0.1"
                      inputMode="decimal"
                      required
                    />
                  </label>
                  <label className="field">
                    <span>Unit label</span>
                    <input name="unitLabel" defaultValue="hours" required />
                  </label>
                  <label className="field">
                    <span>Special category</span>
                    <input name="categoryName" defaultValue="Ethics" />
                  </label>
                </div>
                <label className="field">
                  <span>Special-category minimum</span>
                  <input
                    name="categoryUnits"
                    type="number"
                    min="0"
                    step="0.1"
                    inputMode="decimal"
                    defaultValue="0"
                  />
                </label>
              </>
            ) : (
              <>
                <label className="field">
                  <span>Profession, credential, and state</span>
                  <select
                    autoFocus
                    name="ruleSetId"
                    value={selectedRuleId}
                    onChange={(event) =>
                      setSelectedRuleId(event.currentTarget.value)
                    }
                    required
                  >
                    <option value="">Choose a rule template</option>
                    {workspace.catalog.map((rule) => (
                      <option key={rule.id} value={rule.id}>
                        {rule.credentialName} · {rule.jurisdiction}
                      </option>
                    ))}
                  </select>
                </label>
                {selectedRule ? (
                  <div className="source-card">
                    <div className="source-card-top">
                      <span className="verified-chip">
                        {selectedRule.reviewStatus === "verified"
                          ? "Source-linked"
                          : "Source-linked · check conditions"}
                      </span>
                      <span>
                        Reviewed{" "}
                        {formatDate(selectedRule.lastVerifiedAt, {
                          month: "short",
                          year: "numeric",
                        })}
                      </span>
                    </div>
                    <strong>
                      {compactNumber(selectedRule.totalUnits)}{" "}
                      {selectedRule.unitLabel} every{" "}
                      {selectedRule.cycleMonths / 12}{" "}
                      {selectedRule.cycleMonths === 12 ? "year" : "years"}
                    </strong>
                    <p>
                      {selectedRule.categories
                        .map(
                          (category) =>
                            `${compactNumber(category.requiredUnits)} ${
                              category.name
                            }`,
                        )
                        .join(" · ") || "No special minimums in this template"}
                    </p>
                    {selectedRule.sourceTitle ? (
                      <p className="source-caution">
                        {selectedRule.sourceTitle}
                      </p>
                    ) : null}
                    {selectedRule.sourceUrl ? (
                      <a
                        href={selectedRule.sourceUrl}
                        target="_blank"
                        rel="noreferrer"
                      >
                        Review official source ↗
                      </a>
                    ) : null}
                  </div>
                ) : (
                  <p className="form-hint">
                    Templates include the official source and review date. You
                    can edit dates before saving.
                  </p>
                )}
              </>
            )}

            <div className="form-grid">
              <label className="field">
                <span>Cycle started</span>
                <input
                  name="cycleStart"
                  type="date"
                  defaultValue={yearAgoIso()}
                  required
                />
              </label>
              <label className="field">
                <span>Renewal deadline</span>
                <input
                  name="deadline"
                  type="date"
                  defaultValue={nextYearIso()}
                  required
                />
              </label>
            </div>

            <div className="advisory-note">
              <span aria-hidden="true">i</span>
              <p>
                Confirm dates and requirements with your licensing board.
                License Lantern helps organize your records; it does not replace board
                guidance.
              </p>
            </div>

            <div className="form-actions">
              <button
                className="button button-ghost"
                type="button"
                onClick={() => setCredentialOpen(false)}
              >
                Cancel
              </button>
              <button
                className="button button-primary"
                type="submit"
                disabled={pending}
              >
                {pending ? "Building plan…" : "Create renewal plan"}
              </button>
            </div>
          </form>
        </Modal>
      ) : null}

      {submissionOpen && selectedCredential ? (
        <Modal
          title="Log your submission"
          eyebrow="Renewal milestone"
          onClose={() => setSubmissionOpen(false)}
        >
          <form className="form-stack" onSubmit={handleSubmission}>
            <div className="celebration-panel">
              <span className="celebration-mark" aria-hidden="true">
                ✓
              </span>
              <div>
                <strong>One last record for your future self</strong>
                <p>
                  Logging the date and confirmation keeps “credits earned”
                  separate from “renewal submitted.”
                </p>
              </div>
            </div>
            <label className="field">
              <span>Submission date</span>
              <input
                autoFocus
                name="submissionDate"
                type="date"
                defaultValue={todayIso()}
                required
              />
            </label>
            <label className="field">
              <span>Confirmation or receipt number <em>Optional</em></span>
              <input
                name="confirmationNumber"
                placeholder="e.g., RNL-2048-194"
              />
            </label>
            <div className="advisory-note">
              <span aria-hidden="true">i</span>
              <p>
                This records what you submitted. Mark the cycle renewed only
                after the issuing organization confirms acceptance.
              </p>
            </div>
            <div className="form-actions">
              <button
                className="button button-ghost"
                type="button"
                onClick={() => setSubmissionOpen(false)}
              >
                Not yet
              </button>
              <button
                className="button button-primary"
                type="submit"
                disabled={pending}
              >
                {pending ? "Saving…" : "Mark submitted"}
              </button>
            </div>
          </form>
        </Modal>
      ) : null}

      {toast ? (
        <div className="toast" role="status" aria-live="polite">
          <span>{toast.message}</span>
          {toast.undo ? (
            <button
              type="button"
              onClick={() => {
                toast.undo?.();
                setToast(null);
              }}
            >
              Undo
            </button>
          ) : null}
          <button
            className="toast-close"
            type="button"
            aria-label="Dismiss notification"
            onClick={() => setToast(null)}
          >
            ×
          </button>
        </div>
      ) : null}
    </div>
  );
}

function Brand() {
  return (
    <div className="brand" aria-label="License Lantern">
      <span className="brand-mark" aria-hidden="true">
        L
      </span>
      <span>License Lantern</span>
    </div>
  );
}

function DesktopSidebar({
  view,
  onView,
  onAdd,
  hasCredential,
}: {
  view: ViewName;
  onView: (view: ViewName) => void;
  onAdd: () => void;
  hasCredential: boolean;
}) {
  return (
    <aside className="desktop-sidebar">
      <Brand />
      <nav aria-label="Primary navigation">
        <NavButton
          active={view === "today"}
          label="Today"
          symbol="⌂"
          onClick={() => onView("today")}
        />
        <NavButton
          active={view === "credentials"}
          label="Credentials"
          symbol="▣"
          onClick={() => onView("credentials")}
        />
        <NavButton
          active={view === "records"}
          label="Records"
          symbol="≡"
          onClick={() => onView("records")}
        />
        <NavButton
          active={view === "account"}
          label="Account"
          symbol="○"
          onClick={() => onView("account")}
        />
      </nav>
      <button
        className="sidebar-add"
        type="button"
        onClick={onAdd}
        disabled={!hasCredential}
      >
        <span aria-hidden="true">＋</span>
        Log activity
      </button>
      <div className="sidebar-coach">
        <span>Weekly rhythm</span>
        <strong>Small updates. Calm renewals.</strong>
        <p>Log proof while it’s easy to find.</p>
      </div>
    </aside>
  );
}

function MobileNavigation({
  view,
  onView,
  onAdd,
  hasCredential,
}: {
  view: ViewName;
  onView: (view: ViewName) => void;
  onAdd: () => void;
  hasCredential: boolean;
}) {
  return (
    <nav className="mobile-nav" aria-label="Primary navigation">
      <NavButton
        active={view === "today"}
        label="Today"
        symbol="⌂"
        onClick={() => onView("today")}
      />
      <NavButton
        active={view === "credentials"}
        label="Licenses"
        symbol="▣"
        onClick={() => onView("credentials")}
      />
      <button
        className="mobile-add"
        type="button"
        aria-label="Log completed learning"
        onClick={onAdd}
        disabled={!hasCredential}
      >
        +
      </button>
      <NavButton
        active={view === "records"}
        label="Records"
        symbol="≡"
        onClick={() => onView("records")}
      />
      <NavButton
        active={view === "account"}
        label="Account"
        symbol="○"
        onClick={() => onView("account")}
      />
    </nav>
  );
}

function NavButton({
  active,
  label,
  symbol,
  onClick,
}: {
  active: boolean;
  label: string;
  symbol: string;
  onClick: () => void;
}) {
  return (
    <button
      className={`nav-button ${active ? "active" : ""}`}
      type="button"
      aria-current={active ? "page" : undefined}
      onClick={onClick}
    >
      <span className="nav-symbol" aria-hidden="true">
        {symbol}
      </span>
      <span>{label}</span>
    </button>
  );
}

function TodayView({
  workspace,
  credential,
  onAddActivity,
  onAddCredential,
  onViewCredentials,
  onViewRecords,
  onSubmit,
  onToggleTask,
}: {
  workspace: Workspace;
  credential: Credential | null;
  onAddActivity: () => void;
  onAddCredential: () => void;
  onViewCredentials: () => void;
  onViewRecords: () => void;
  onSubmit: () => void;
  onToggleTask: (task: RenewalTask) => void;
}) {
  if (!credential) {
    return (
      <div className="view-stack">
        <PageGreeting
          eyebrow="Your renewal companion"
          title={`Welcome, ${firstName(workspace.user.displayName)}.`}
          body="Let’s turn your license requirements into a clear, manageable plan."
        />
        <section className="onboarding-hero">
          <div className="onboarding-copy">
            <span className="section-kicker">Start in about 2 minutes</span>
            <h2>Tell us what you renew. We’ll map the path.</h2>
            <p>
              Choose a source-linked rule template or enter your own
              requirements. You can change everything later.
            </p>
            <button
              className="button button-light"
              type="button"
              onClick={onAddCredential}
            >
              Set up my first credential
              <span aria-hidden="true">→</span>
            </button>
          </div>
          <ol className="onboarding-steps">
            <li>
              <span>1</span>
              <div>
                <strong>Choose credential + state</strong>
                <p>Match a template or create a custom plan.</p>
              </div>
            </li>
            <li>
              <span>2</span>
              <div>
                <strong>Confirm your renewal dates</strong>
                <p>We organize credits around your real cycle.</p>
              </div>
            </li>
            <li>
              <span>3</span>
              <div>
                <strong>Log learning as you go</strong>
                <p>See what’s done and what deserves attention.</p>
              </div>
            </li>
          </ol>
        </section>
        <section className="trust-strip" aria-label="License Lantern principles">
          <div>
            <span className="trust-mark">✓</span>
            <p><strong>Source-linked rules</strong> with review dates</p>
          </div>
          <div>
            <span className="trust-mark">✓</span>
            <p><strong>Your activity history</strong> kept cycle by cycle</p>
          </div>
          <div>
            <span className="trust-mark">✓</span>
            <p><strong>Submission stays separate</strong> from credits earned</p>
          </div>
        </section>
      </div>
    );
  }

  const progress = credentialProgress(credential);
  const readiness = readinessScore(credential);
  const remaining = Math.max(
    0,
    credential.totalRequired - credential.totalEarned,
  );
  const missingEvidence = workspace.activities.filter(
    (activity) =>
      activity.credentialName === credential.credentialName &&
      activity.evidenceStatus === "missing",
  ).length;

  return (
    <div className="view-stack">
      <PageGreeting
        eyebrow={
          workspace.user.isDemo
            ? "Private preview workspace"
            : "Your renewal companion"
        }
        title={`Good ${dayPart()}, ${firstName(workspace.user.displayName)}.`}
        body="Here’s the clearest next step toward a calm renewal."
        action={
          <button
            className="button button-primary desktop-only"
            type="button"
            onClick={onAddActivity}
          >
            <span aria-hidden="true">＋</span>
            Log completed learning
          </button>
        }
      />

      <section className="renewal-hero" aria-labelledby="renewal-heading">
        <div className="renewal-hero-main">
          <div className="renewal-identity">
            <div>
              <span className="status-pill">
                <span aria-hidden="true" />
                {credential.status === "active"
                  ? "Active renewal cycle"
                  : credential.status === "submitted"
                    ? "Submitted"
                    : "Renewed"}
              </span>
              <h2 id="renewal-heading">{credential.credentialName}</h2>
              <p>
                {credential.jurisdiction}
                {credential.issuer ? ` · ${credential.issuer}` : ""}
              </p>
            </div>
            <button
              className="text-button"
              type="button"
              onClick={onViewCredentials}
            >
              View plan <span aria-hidden="true">→</span>
            </button>
          </div>

          <div className="deadline-row">
            <div className="deadline-number">
              <strong>{daysUntil(credential.deadline)}</strong>
              <span>days to renewal</span>
            </div>
            <div className="deadline-detail">
              <span>Due {formatDate(credential.deadline)}</span>
              <div className="progress-track progress-track-light">
                <span style={{ width: `${progress}%` }} />
              </div>
              <p>
                <strong>
                  {compactNumber(credential.totalEarned)} of{" "}
                  {compactNumber(credential.totalRequired)}
                </strong>{" "}
                {credential.unitLabel} documented
              </p>
            </div>
          </div>
        </div>

        <div className="readiness-panel">
          <span className="section-kicker section-kicker-light">
            Renewal readiness
          </span>
          <div
            className="readiness-ring"
            style={{ "--score": readiness } as React.CSSProperties}
            aria-label={`${readiness}% renewal readiness`}
          >
            <span>
              <strong>{readiness}%</strong>
              <small>ready</small>
            </span>
          </div>
          <p>
            Based on documented units, category minimums, and checklist steps.
          </p>
        </div>
      </section>

      <section className="next-action-card">
        <span className="next-action-icon" aria-hidden="true">
          ↗
        </span>
        <div>
          <span className="section-kicker">Best next action</span>
          <h2>{bestNextAction(credential)}</h2>
          <p>
            {remaining > 0
              ? `${compactNumber(remaining)} ${credential.unitLabel} remain overall.`
              : "Your overall credit total is met. Finish the remaining checks before submitting."}
          </p>
        </div>
        <button
          className="button button-dark"
          type="button"
          onClick={
            remaining > 0
              ? onAddActivity
              : credential.status === "active"
                ? onSubmit
                : onViewCredentials
          }
        >
          {remaining > 0
            ? "Add completed learning"
            : credential.status === "active"
              ? "Review submission"
              : "View confirmation"}
        </button>
      </section>

      <div className="dashboard-grid">
        <section className="card progress-card" aria-labelledby="progress-title">
          <div className="card-heading">
            <div>
              <span className="section-kicker">Requirements</span>
              <h2 id="progress-title">Credit progress</h2>
            </div>
            <span className="card-summary">{progress}% documented</span>
          </div>
          <div className="requirement-list">
            <ProgressRow
              name="Overall"
              earned={credential.totalEarned}
              required={credential.totalRequired}
              unit={credential.unitLabel}
            />
            {credential.requirements.map((requirement) => (
              <ProgressRow
                key={requirement.id}
                name={requirement.name}
                earned={requirement.earnedUnits}
                required={requirement.requiredUnits}
                unit={credential.unitLabel}
              />
            ))}
          </div>
          <button
            className="card-link"
            type="button"
            onClick={onAddActivity}
          >
            Log an activity <span aria-hidden="true">＋</span>
          </button>
        </section>

        <section className="card coach-card" aria-labelledby="momentum-title">
          <div className="card-heading">
            <div>
              <span className="section-kicker">Momentum</span>
              <h2 id="momentum-title">This week</h2>
            </div>
            <span className="xp-chip">{workspace.profile.xp} XP</span>
          </div>
          <div className="week-dots" aria-label={`${workspace.profile.weekActions} of ${workspace.profile.weeklyGoal} meaningful updates this week`}>
            {Array.from({ length: workspace.profile.weeklyGoal }, (_, index) => (
              <span
                key={index}
                className={
                  index < workspace.profile.weekActions ? "complete" : ""
                }
                aria-hidden="true"
              >
                {index < workspace.profile.weekActions ? "✓" : index + 1}
              </span>
            ))}
          </div>
          <h3>
            {workspace.profile.weekActions >= workspace.profile.weeklyGoal
              ? "Weekly rhythm complete"
              : "One useful update at a time"}
          </h3>
          <p>
            {workspace.profile.weekActions >= workspace.profile.weeklyGoal
              ? "You kept your renewal record current this week."
              : `${Math.max(
                  0,
                  workspace.profile.weeklyGoal -
                    workspace.profile.weekActions,
                )} meaningful ${
                  workspace.profile.weeklyGoal -
                    workspace.profile.weekActions ===
                  1
                    ? "update"
                    : "updates"
                } to your weekly rhythm.`}
          </p>
          <div className="mini-badges">
            {workspace.profile.badges.slice(0, 3).map((badge) => (
              <span
                key={badge.id}
                className={badge.earned || badge.earnedAt ? "earned" : ""}
                title={badge.description}
              >
                {badge.name}
              </span>
            ))}
          </div>
        </section>

        <section className="card checklist-card" aria-labelledby="checklist-title">
          <div className="card-heading">
            <div>
              <span className="section-kicker">Renewal checklist</span>
              <h2 id="checklist-title">Packet readiness</h2>
            </div>
            <span className="card-summary">
              {
                credential.tasks.filter((task) => task.status === "completed")
                  .length
              }
              /{credential.tasks.length} done
            </span>
          </div>
          <div className="task-list">
            {credential.tasks.map((task) => (
              <label
                className={`task-row ${
                  task.status === "completed" ? "completed" : ""
                }`}
                key={task.id}
              >
                <input
                  type="checkbox"
                  checked={task.status === "completed"}
                  onChange={() => onToggleTask(task)}
                />
                <span className="custom-check" aria-hidden="true">
                  ✓
                </span>
                <span>
                  <strong>{task.title}</strong>
                  <small>
                    {task.kind === "evidence"
                      ? `${missingEvidence} records still need proof`
                      : task.dueDate
                        ? `Due ${formatDate(task.dueDate)}`
                        : "You can undo this anytime"}
                  </small>
                </span>
              </label>
            ))}
          </div>
          {credential.status === "active" ? (
            <button className="card-link" type="button" onClick={onSubmit}>
              Log renewal submission <span aria-hidden="true">→</span>
            </button>
          ) : (
            <div className="submitted-note">
              Submitted {formatDate(credential.submittedAt)}
              {credential.confirmationNumber
                ? ` · ${credential.confirmationNumber}`
                : ""}
            </div>
          )}
        </section>

        <section className="card recent-card" aria-labelledby="recent-title">
          <div className="card-heading">
            <div>
              <span className="section-kicker">Your records</span>
              <h2 id="recent-title">Recent learning</h2>
            </div>
            <button className="text-button" type="button" onClick={onViewRecords}>
              See all
            </button>
          </div>
          {workspace.activities.length ? (
            <div className="recent-list">
              {workspace.activities.slice(0, 3).map((activity) => (
                <article key={activity.id}>
                  <span
                    className={`evidence-mark ${activity.evidenceStatus}`}
                    aria-hidden="true"
                  >
                    {activity.evidenceStatus === "attached"
                      ? "✓"
                      : activity.evidenceStatus === "missing"
                        ? "!"
                        : "—"}
                  </span>
                  <div>
                    <strong>{activity.title}</strong>
                    <p>
                      {formatDate(activity.completionDate, {
                        month: "short",
                        day: "numeric",
                      })}
                      {activity.categoryName
                        ? ` · ${activity.categoryName}`
                        : " · General"}
                    </p>
                  </div>
                  <span className="credit-value">
                    +{compactNumber(activity.allocatedUnits)}
                  </span>
                </article>
              ))}
            </div>
          ) : (
            <EmptyInline
              title="No learning logged yet"
              body="Your first record will appear here."
              action="Add one"
              onAction={onAddActivity}
            />
          )}
        </section>
      </div>
    </div>
  );
}

function CredentialsView({
  credentials,
  selectedId,
  onSelect,
  onAdd,
  onSubmit,
}: {
  credentials: Credential[];
  selectedId: string;
  onSelect: (id: string) => void;
  onAdd: () => void;
  onSubmit: () => void;
}) {
  const selected =
    credentials.find((credential) => credential.id === selectedId) ??
    credentials[0];
  return (
    <div className="view-stack">
      <PageGreeting
        eyebrow="Credentials"
        title="Every renewal, one clear place."
        body="Requirements, sources, cycles, and submission status stay connected."
        action={
          <button className="button button-primary" type="button" onClick={onAdd}>
            <span aria-hidden="true">＋</span>
            Add credential
          </button>
        }
      />
      {selected ? (
        <div className="credentials-layout">
          <aside className="credential-picker" aria-label="Your credentials">
            {credentials.map((credential) => (
              <button
                key={credential.id}
                className={credential.id === selected.id ? "active" : ""}
                type="button"
                onClick={() => onSelect(credential.id)}
              >
                <span>
                  <strong>{credential.credentialName}</strong>
                  <small>{credential.jurisdiction}</small>
                </span>
                <span className="picker-progress">
                  {credentialProgress(credential)}%
                </span>
              </button>
            ))}
            <button className="add-picker" type="button" onClick={onAdd}>
              ＋ Add another credential
            </button>
          </aside>
          <section className="credential-detail">
            <div className="credential-detail-header">
              <div>
                <span className="status-pill status-pill-dark">
                  {selected.status}
                </span>
                <h2>{selected.credentialName}</h2>
                <p>
                  {selected.jurisdiction}
                  {selected.issuer ? ` · ${selected.issuer}` : ""}
                </p>
              </div>
              <div className="deadline-chip">
                <span>Renew by</span>
                <strong>{formatDate(selected.deadline)}</strong>
              </div>
            </div>
            <div className="detail-stats">
              <div>
                <span>Documented</span>
                <strong>
                  {compactNumber(selected.totalEarned)} /{" "}
                  {compactNumber(selected.totalRequired)}
                </strong>
                <small>{selected.unitLabel}</small>
              </div>
              <div>
                <span>Readiness</span>
                <strong>{readinessScore(selected)}%</strong>
                <small>credits + checklist</small>
              </div>
              <div>
                <span>Time left</span>
                <strong>{daysUntil(selected.deadline)}</strong>
                <small>days</small>
              </div>
            </div>
            <div className="detail-section">
              <div className="card-heading">
                <div>
                  <span className="section-kicker">Requirements</span>
                  <h3>Category minimums</h3>
                </div>
              </div>
              <ProgressRow
                name="Overall"
                earned={selected.totalEarned}
                required={selected.totalRequired}
                unit={selected.unitLabel}
              />
              {selected.requirements.map((requirement) => (
                <ProgressRow
                  key={requirement.id}
                  name={requirement.name}
                  earned={requirement.earnedUnits}
                  required={requirement.requiredUnits}
                  unit={selected.unitLabel}
                />
              ))}
            </div>
            <div className="detail-section source-detail">
              <span className="section-kicker">Rule source</span>
              <h3>
                {selected.ruleReviewStatus === "custom"
                  ? "Custom requirements"
                  : "Source-linked template"}
              </h3>
              <p>
                Confirm requirements and dates with the issuing organization,
                especially when rules or your license status change.
              </p>
              {selected.sourceUrl ? (
                <a
                  className="button button-outline"
                  href={selected.sourceUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  Open official guidance ↗
                </a>
              ) : (
                <span className="custom-rule-label">
                  Entered manually · no official source attached
                </span>
              )}
            </div>
            {selected.status === "active" ? (
              <div className="detail-footer">
                <div>
                  <strong>Finished your board submission?</strong>
                  <p>Log it separately from completed learning.</p>
                </div>
                <button
                  className="button button-primary"
                  type="button"
                  onClick={onSubmit}
                >
                  Log submission
                </button>
              </div>
            ) : (
              <div className="detail-footer submitted-footer">
                <div>
                  <strong>Renewal submitted {formatDate(selected.submittedAt)}</strong>
                  <p>
                    {selected.confirmationNumber
                      ? `Confirmation: ${selected.confirmationNumber}`
                      : "No confirmation number recorded."}
                  </p>
                </div>
                <span className="verified-chip">Submission logged</span>
              </div>
            )}
          </section>
        </div>
      ) : (
        <EmptyPage
          title="Add your first credential"
          body="Choose a source-linked rule template or make a custom plan from your licensing information."
          action="Set up credential"
          onAction={onAdd}
        />
      )}
    </div>
  );
}

function RecordsView({
  activities,
  credentials,
  onAdd,
}: {
  activities: Activity[];
  credentials: Credential[];
  onAdd: () => void;
}) {
  const total = activities.reduce(
    (sum, activity) => sum + activity.allocatedUnits,
    0,
  );
  const missingProof = activities.filter(
    (activity) => activity.evidenceStatus === "missing",
  ).length;
  return (
    <div className="view-stack">
      <PageGreeting
        eyebrow="Activity record"
        title="Your learning, organized as you go."
        body="Credits earned and proof status stay visible before renewal season."
        action={
          <button className="button button-primary" type="button" onClick={onAdd}>
            <span aria-hidden="true">＋</span>
            Log activity
          </button>
        }
      />
      <section className="record-summary">
        <div>
          <span>Total allocated</span>
          <strong>{compactNumber(total)}</strong>
          <small>credits across active cycles</small>
        </div>
        <div>
          <span>Activities</span>
          <strong>{activities.length}</strong>
          <small>completed learning records</small>
        </div>
        <div>
          <span>Proof to add</span>
          <strong>{missingProof}</strong>
          <small>{missingProof ? "worth reviewing" : "all clear"}</small>
        </div>
        <a
          className={`button button-outline ${
            credentials.length === 0 ? "disabled" : ""
          }`}
          href={credentials.length ? "/api/export" : undefined}
          aria-disabled={credentials.length === 0}
        >
          Export CSV ↓
        </a>
      </section>
      {activities.length ? (
        <section className="records-card" aria-label="Completed activities">
          <div className="records-table records-table-head" aria-hidden="true">
            <span>Activity</span>
            <span>Credential</span>
            <span>Proof</span>
            <span>Credits</span>
          </div>
          {activities.map((activity) => (
            <article className="records-table" key={activity.id}>
              <div className="record-title">
                <span
                  className={`evidence-mark ${activity.evidenceStatus}`}
                  aria-hidden="true"
                >
                  {activity.evidenceStatus === "attached"
                    ? "✓"
                    : activity.evidenceStatus === "missing"
                      ? "!"
                      : "—"}
                </span>
                <span>
                  <strong>{activity.title}</strong>
                  <small>
                    {formatDate(activity.completionDate)}
                    {activity.provider ? ` · ${activity.provider}` : ""}
                  </small>
                </span>
              </div>
              <span>
                {activity.credentialName ?? "Unassigned"}
                <small>{activity.categoryName ?? "General"}</small>
              </span>
              <span className={`proof-label ${activity.evidenceStatus}`}>
                {activity.evidenceStatus === "attached"
                  ? "On file"
                  : activity.evidenceStatus === "missing"
                    ? "Add later"
                    : "Not required"}
              </span>
              <strong className="record-credit">
                {compactNumber(activity.allocatedUnits)}
              </strong>
            </article>
          ))}
        </section>
      ) : (
        <EmptyPage
          title="Your learning record starts here"
          body="Log a course, conference, webinar, or other completed activity in under a minute."
          action="Log first activity"
          onAction={onAdd}
        />
      )}
    </div>
  );
}

function AccountView({ workspace }: { workspace: Workspace }) {
  return (
    <div className="view-stack">
      <PageGreeting
        eyebrow="Account"
        title="A renewal system that stays yours."
        body="Your identity, momentum, and product safeguards in one place."
      />
      <div className="account-grid">
        <section className="card account-profile">
          <span className="account-avatar">
            {firstName(workspace.user.displayName).slice(0, 1).toUpperCase()}
          </span>
          <div>
            <span className="section-kicker">Signed in as</span>
            <h2>{workspace.user.displayName}</h2>
            <p>{workspace.user.email}</p>
          </div>
          {workspace.user.isDemo ? (
            <span className="demo-label">Local preview</span>
          ) : (
            <a
              className="button button-outline"
              href="/signout-with-chatgpt?return_to=%2F"
            >
              Sign out
            </a>
          )}
        </section>
        <section className="card account-momentum">
          <span className="section-kicker">Meaningful momentum</span>
          <h2>{workspace.profile.xp} XP earned</h2>
          <p>
            License Lantern rewards real compliance work—not opening the app or
            protecting a fragile daily streak.
          </p>
          <div className="badge-grid">
            {workspace.profile.badges.map((badge) => (
              <article
                className={badge.earned || badge.earnedAt ? "earned" : ""}
                key={badge.id}
              >
                <span aria-hidden="true">
                  {badge.earned || badge.earnedAt ? "◆" : "◇"}
                </span>
                <div>
                  <strong>{badge.name}</strong>
                  <small>{badge.description}</small>
                </div>
              </article>
            ))}
          </div>
        </section>
        <section className="card compliance-card">
          <span className="section-kicker">A careful boundary</span>
          <h2>Organizer, not licensing authority.</h2>
          <p>
            License Lantern helps you track information and prepare for renewal. It
            does not determine course eligibility, guarantee board acceptance,
            or replace official instructions.
          </p>
          <ul>
            <li>Rule templates show their official source.</li>
            <li>Custom plans remain clearly labeled.</li>
            <li>Credits, proof, submission, and acceptance stay distinct.</li>
          </ul>
        </section>
      </div>
    </div>
  );
}

function ProgressRow({
  name,
  earned,
  required,
  unit,
}: {
  name: string;
  earned: number;
  required: number;
  unit: string;
}) {
  const progress =
    required <= 0 ? 100 : clampPercent((earned / required) * 100);
  const met = earned >= required;
  return (
    <div className="progress-row">
      <div className="progress-label">
        <span>
          <strong>{name}</strong>
          {met ? <small className="met-label">Minimum met</small> : null}
        </span>
        <span>
          <strong>
            {compactNumber(earned)} / {compactNumber(required)}
          </strong>{" "}
          {unit}
        </span>
      </div>
      <div
        className={`progress-track ${met ? "met" : ""}`}
        role="progressbar"
        aria-label={`${name}: ${compactNumber(earned)} of ${compactNumber(
          required,
        )} ${unit}`}
        aria-valuemin={0}
        aria-valuemax={required}
        aria-valuenow={Math.min(earned, required)}
      >
        <span style={{ width: `${progress}%` }} />
      </div>
    </div>
  );
}

function PageGreeting({
  eyebrow,
  title,
  body,
  action,
}: {
  eyebrow: string;
  title: string;
  body: string;
  action?: ReactNode;
}) {
  return (
    <header className="page-greeting">
      <div>
        <span className="page-eyebrow">{eyebrow}</span>
        <h1>{title}</h1>
        <p>{body}</p>
      </div>
      {action}
    </header>
  );
}

function Modal({
  title,
  eyebrow,
  children,
  onClose,
}: {
  title: string;
  eyebrow: string;
  children: ReactNode;
  onClose: () => void;
}) {
  return (
    <div className="modal-backdrop">
      <section
        className="modal-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="modal-title"
      >
        <header className="modal-header">
          <div>
            <span className="section-kicker">{eyebrow}</span>
            <h2 id="modal-title">{title}</h2>
          </div>
          <button
            className="modal-close"
            type="button"
            aria-label="Close dialog"
            onClick={onClose}
          >
            ×
          </button>
        </header>
        <div className="modal-body">{children}</div>
      </section>
    </div>
  );
}

function EmptyInline({
  title,
  body,
  action,
  onAction,
}: {
  title: string;
  body: string;
  action: string;
  onAction: () => void;
}) {
  return (
    <div className="empty-inline">
      <span aria-hidden="true">＋</span>
      <div>
        <strong>{title}</strong>
        <p>{body}</p>
      </div>
      <button type="button" onClick={onAction}>
        {action}
      </button>
    </div>
  );
}

function EmptyPage({
  title,
  body,
  action,
  onAction,
}: {
  title: string;
  body: string;
  action: string;
  onAction: () => void;
}) {
  return (
    <section className="empty-page">
      <span className="empty-page-mark" aria-hidden="true">
        L
      </span>
      <span className="section-kicker">Ready when you are</span>
      <h2>{title}</h2>
      <p>{body}</p>
      <button className="button button-primary" type="button" onClick={onAction}>
        {action}
      </button>
    </section>
  );
}

function EmptyModalState({
  title,
  body,
  action,
  onAction,
}: {
  title: string;
  body: string;
  action: string;
  onAction: () => void;
}) {
  return (
    <div className="empty-modal">
      <span aria-hidden="true">＋</span>
      <h3>{title}</h3>
      <p>{body}</p>
      <button className="button button-primary" type="button" onClick={onAction}>
        {action}
      </button>
    </div>
  );
}

function LoadingDashboard() {
  return (
    <div className="view-stack" aria-busy="true" aria-label="Loading License Lantern">
      <div className="loading-heading">
        <span />
        <strong />
        <small />
      </div>
      <div className="loading-hero">
        <span />
        <span />
        <span />
      </div>
      <div className="loading-grid">
        <span />
        <span />
        <span />
        <span />
      </div>
      <p className="sr-only" role="status">
        Loading your renewal workspace
      </p>
    </div>
  );
}

function dayPart() {
  const hour = new Date().getHours();
  if (hour < 12) return "morning";
  if (hour < 18) return "afternoon";
  return "evening";
}
