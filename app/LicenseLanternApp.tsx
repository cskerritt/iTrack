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
  cycleMonths: number;
  status: "active" | "submitted" | "renewed";
  seriesId?: string | null;
  previousCredentialId?: string | null;
  submittedAt?: string | null;
  confirmationNumber?: string | null;
  acceptedAt?: string | null;
  acceptanceReference?: string | null;
  nextCredentialId?: string | null;
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

type ActivityAllocation = {
  id: string;
  credentialId: string;
  credentialName: string;
  requirementId?: string | null;
  categoryName?: string | null;
  allocatedUnits: number;
};

type Activity = {
  id: string;
  title: string;
  provider?: string | null;
  completionDate: string;
  totalUnits: number;
  evidenceStatus: "missing" | "attached" | "not_required";
  evidenceCount: number;
  credentialId?: string | null;
  credentialName?: string | null;
  requirementId?: string | null;
  categoryName?: string | null;
  allocatedUnits: number;
  allocations?: ActivityAllocation[];
};

type EvidenceFile = {
  id: string;
  activityId: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  sha256: string;
  createdAt: string;
  downloadUrl: string;
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
  reminderPreferences: {
    inAppEnabled: boolean;
    leadDays: number[];
    timeZone: string;
  };
  reminders: Reminder[];
};

type Reminder = {
  key: string;
  credentialId: string;
  credentialName: string;
  kind: "task" | "deadline" | "acceptance";
  title: string;
  body: string;
  scheduledFor: string;
  urgency: "overdue" | "today" | "soon";
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
  return Math.ceil((deadline.getTime() - today.getTime()) / 86_400_000);
}

function addDaysIso(value: string, days: number) {
  const date = new Date(`${value.slice(0, 10)}T12:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function addMonthsIso(value: string, months: number) {
  const date = new Date(`${value.slice(0, 10)}T12:00:00.000Z`);
  const targetDay = date.getUTCDate();
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() + months);
  const lastDay = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0),
  ).getUTCDate();
  date.setUTCDate(Math.min(targetDay, lastDay));
  return date.toISOString().slice(0, 10);
}

function allocationsFor(activity: Activity): ActivityAllocation[] {
  if (activity.allocations?.length) return activity.allocations;
  if (!activity.credentialId || !activity.credentialName) return [];
  return [
    {
      id: `${activity.id}:${activity.credentialId}`,
      credentialId: activity.credentialId,
      credentialName: activity.credentialName,
      requirementId: activity.requirementId,
      categoryName: activity.categoryName,
      allocatedUnits: activity.allocatedUnits,
    },
  ];
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
  if (credential.status === "renewed")
    return "Review the preserved record for this completed cycle";
  if (credential.status === "submitted")
    return "Record acceptance when your renewal is approved";

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
  const [acceptanceOpen, setAcceptanceOpen] = useState(false);
  const [remindersOpen, setRemindersOpen] = useState(false);
  const [allocationActivity, setAllocationActivity] =
    useState<Activity | null>(null);
  const [allocationCredentialId, setAllocationCredentialId] = useState("");
  const [evidenceActivity, setEvidenceActivity] = useState<Activity | null>(
    null,
  );
  const [evidenceFiles, setEvidenceFiles] = useState<EvidenceFile[]>([]);
  const [evidencePending, setEvidencePending] = useState(false);
  const [customCredential, setCustomCredential] = useState(false);
  const [selectedRuleId, setSelectedRuleId] = useState("");
  const [catalogQuery, setCatalogQuery] = useState("");
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
      setAcceptanceOpen(false);
      setRemindersOpen(false);
      setAllocationActivity(null);
      setEvidenceActivity(null);
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

  const catalogMatches = useMemo(() => {
    if (!workspace) return [];
    const query = catalogQuery.trim().toLowerCase();
    if (!query) return workspace.catalog;
    return workspace.catalog.filter((rule) =>
      [
        rule.profession,
        rule.credentialName,
        rule.jurisdiction,
        rule.issuer,
      ]
        .join(" ")
        .toLowerCase()
        .includes(query),
    );
  }, [catalogQuery, workspace]);

  const eligibleAllocationCredentials = useMemo(() => {
    if (!workspace || !allocationActivity) return [];
    const existingIds = new Set(
      allocationsFor(allocationActivity).map(
        (allocation) => allocation.credentialId,
      ),
    );
    return workspace.credentials.filter(
      (credential) =>
        credential.status !== "renewed" && !existingIds.has(credential.id),
    );
  }, [allocationActivity, workspace]);

  const allocationCredential =
    eligibleAllocationCredentials.find(
      (credential) => credential.id === allocationCredentialId,
    ) ??
    eligibleAllocationCredentials[0] ??
    null;

  const activityCredentials =
    workspace?.credentials.filter(
      (credential) => credential.status !== "renewed",
    ) ?? [];
  const activityCredential =
    activityCredentials.find(
      (credential) => credential.id === selectedCredentialId,
    ) ??
    activityCredentials[0] ??
    null;

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
        id?: string;
      };
      if (!response.ok) {
        throw new Error(result.error || "That update didn’t save.");
      }
      await loadWorkspace();
      setToast({ message: successMessage });
      return result;
    } catch (actionError) {
      setError(
        actionError instanceof Error
          ? actionError.message
          : "That update didn’t save.",
      );
      return null;
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
    const evidenceFile = form.get("evidenceFile");
    const hasEvidenceFile =
      evidenceFile instanceof File && evidenceFile.size > 0;
    const result = await runAction(
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
    if (result?.id && hasEvidenceFile) {
      const uploaded = await uploadEvidence(result.id, evidenceFile);
      if (!uploaded) {
        setActivityOpen(false);
        formElement.reset();
        setToast({
          message:
            "Activity saved, but the proof file did not upload. You can add it from Records.",
        });
        return;
      }
      setToast({
        message: `${compactNumber(totalUnits)} ${
          totalUnits === 1 ? "credit" : "credits"
        } and proof saved.`,
      });
    }
    if (result) {
      setActivityOpen(false);
      formElement.reset();
    }
  }

  async function uploadEvidence(activityId: string, file: File) {
    setEvidencePending(true);
    setError("");
    try {
      const payload = new FormData();
      payload.set("activityId", activityId);
      payload.set("file", file);
      const response = await fetch("/api/evidence", {
        method: "POST",
        body: payload,
      });
      const result = (await response.json()) as {
        evidence?: EvidenceFile;
        error?: string;
      };
      if (!response.ok || !result.evidence) {
        throw new Error(result.error || "The proof file did not upload.");
      }
      await loadWorkspace();
      setEvidenceFiles((current) => [result.evidence!, ...current]);
      return true;
    } catch (uploadError) {
      setError(
        uploadError instanceof Error
          ? uploadError.message
          : "The proof file did not upload.",
      );
      return false;
    } finally {
      setEvidencePending(false);
    }
  }

  async function openEvidence(activity: Activity) {
    setEvidenceActivity(activity);
    setEvidenceFiles([]);
    setEvidencePending(true);
    setError("");
    try {
      const response = await fetch(
        `/api/evidence?activityId=${encodeURIComponent(activity.id)}`,
        { headers: { accept: "application/json" }, cache: "no-store" },
      );
      const result = (await response.json()) as {
        evidence?: EvidenceFile[];
        error?: string;
      };
      if (!response.ok) {
        throw new Error(result.error || "The proof files could not be loaded.");
      }
      setEvidenceFiles(result.evidence ?? []);
    } catch (evidenceError) {
      setError(
        evidenceError instanceof Error
          ? evidenceError.message
          : "The proof files could not be loaded.",
      );
    } finally {
      setEvidencePending(false);
    }
  }

  async function handleEvidenceUpload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!evidenceActivity) return;
    const form = new FormData(event.currentTarget);
    const file = form.get("file");
    if (!(file instanceof File) || file.size === 0) {
      setError("Choose a PDF or image to upload.");
      return;
    }
    const uploaded = await uploadEvidence(evidenceActivity.id, file);
    if (uploaded) {
      event.currentTarget.reset();
      setToast({ message: "Proof saved securely." });
    }
  }

  async function deleteEvidence(evidence: EvidenceFile) {
    setEvidencePending(true);
    setError("");
    try {
      const response = await fetch(
        `/api/evidence/${encodeURIComponent(evidence.id)}`,
        { method: "DELETE" },
      );
      const result = (await response.json()) as { error?: string };
      if (!response.ok) {
        throw new Error(result.error || "The proof file could not be removed.");
      }
      setEvidenceFiles((current) =>
        current.filter((item) => item.id !== evidence.id),
      );
      await loadWorkspace();
      setToast({ message: "Proof removed." });
    } catch (deleteError) {
      setError(
        deleteError instanceof Error
          ? deleteError.message
          : "The proof file could not be removed.",
      );
    } finally {
      setEvidencePending(false);
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
      setCatalogQuery("");
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

  async function handleAcceptance(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedCredential) return;
    const form = new FormData(event.currentTarget);
    const result = await runAction(
      "markRenewalAccepted",
      {
        credentialId: selectedCredential.id,
        acceptedAt: String(form.get("acceptedAt") ?? ""),
        reference: String(form.get("reference") ?? ""),
        nextCycleStart: String(form.get("nextCycleStart") ?? ""),
        nextDeadline: String(form.get("nextDeadline") ?? ""),
      },
      "Renewal accepted. Your next cycle is ready.",
    );
    if (result) {
      setAcceptanceOpen(false);
      if (result.id) setSelectedCredentialId(result.id);
    }
  }

  async function handleReminderPreferences(
    event: FormEvent<HTMLFormElement>,
  ) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const leadDays = form
      .getAll("leadDays")
      .map((value) => Number(value))
      .filter((value) => Number.isInteger(value) && value >= 0);
    const result = await runAction(
      "updateReminderPreferences",
      {
        inAppEnabled: form.get("inAppEnabled") === "on",
        leadDays,
        timeZone: String(form.get("timeZone") ?? "UTC"),
      },
      "Reminder check-ins updated.",
    );
    if (result) setRemindersOpen(false);
  }

  async function setReminderState(
    reminder: Reminder,
    status: "dismissed" | "snoozed",
  ) {
    await runAction(
      "setReminderState",
      {
        reminderKey: reminder.key,
        credentialId: reminder.credentialId,
        status,
        snoozedUntil:
          status === "snoozed" ? addDaysIso(todayIso(), 7) : null,
      },
      status === "snoozed"
        ? "Reminder snoozed for one week."
        : "Reminder dismissed for this cycle.",
    );
  }

  async function handleAllocation(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!allocationActivity) return;
    const form = new FormData(event.currentTarget);
    const allocatedUnits = Number(form.get("allocatedUnits"));
    const result = await runAction(
      "addActivityAllocation",
      {
        activityId: allocationActivity.id,
        credentialId: String(form.get("credentialId") ?? ""),
        requirementId: String(form.get("requirementId") ?? "") || null,
        allocatedUnits,
      },
      `Activity applied to another credential.`,
    );
    if (result) {
      setAllocationActivity(null);
      setAllocationCredentialId("");
    }
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
              onAccept={() => setAcceptanceOpen(true)}
              onReminders={() => setRemindersOpen(true)}
              onReminderState={(reminder, status) =>
                void setReminderState(reminder, status)
              }
              onToggleTask={toggleTask}
            />
          ) : view === "credentials" ? (
            <CredentialsView
              credentials={workspace.credentials}
              selectedId={selectedCredential?.id ?? ""}
              onSelect={(id) => setSelectedCredentialId(id)}
              onAdd={() => setCredentialOpen(true)}
              onSubmit={() => setSubmissionOpen(true)}
              onAccept={() => setAcceptanceOpen(true)}
              onReminders={() => setRemindersOpen(true)}
            />
          ) : view === "records" ? (
            <RecordsView
              activities={workspace.activities}
              credentials={workspace.credentials}
              onAdd={() => setActivityOpen(true)}
              onEvidence={(activity) => void openEvidence(activity)}
              onAllocate={(activity) => {
                const existingIds = new Set(
                  allocationsFor(activity).map(
                    (allocation) => allocation.credentialId,
                  ),
                );
                const firstEligible = workspace.credentials.find(
                  (credential) =>
                    credential.status !== "renewed" &&
                    !existingIds.has(credential.id),
                );
                setAllocationCredentialId(firstEligible?.id ?? "");
                setAllocationActivity(activity);
              }}
            />
          ) : (
            <AccountView
              workspace={workspace}
              onReminders={() => setRemindersOpen(true)}
            />
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
          {activityCredentials.length === 0 ? (
            <EmptyModalState
              title="Add an active credential first"
              body="Credits need an open renewal cycle so License Lantern knows where to count them."
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
                  value={activityCredential?.id ?? ""}
                  required
                  onChange={(event) =>
                    setSelectedCredentialId(event.currentTarget.value)
                  }
                >
                  {activityCredentials.map((credential) => (
                    <option key={credential.id} value={credential.id}>
                      {credential.credentialName} · {credential.jurisdiction}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>Category</span>
                <select
                  key={activityCredential?.id}
                  name="requirementId"
                  defaultValue=""
                >
                  <option value="">General / decide later</option>
                  {(activityCredential?.requirements ?? []).map((requirement) => (
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
                <legend>Proof requirement</legend>
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
              <label className="field file-field">
                <span>Certificate or proof <em>Optional</em></span>
                <input
                  name="evidenceFile"
                  type="file"
                  accept=".pdf,image/jpeg,image/png,image/webp"
                />
                <small>PDF, JPEG, PNG, or WebP · up to 10 MB</small>
              </label>
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
                  <span>Find a credential template</span>
                  <input
                    autoFocus
                    type="search"
                    value={catalogQuery}
                    onChange={(event) =>
                      setCatalogQuery(event.currentTarget.value)
                    }
                    placeholder="Search profession, license, or state"
                  />
                  <small>
                    {workspace.catalog.length} researched starting templates ·
                    custom plans are always available
                  </small>
                </label>
                <label className="field">
                  <span>Profession, credential, and state</span>
                  <select
                    name="ruleSetId"
                    value={selectedRuleId}
                    onChange={(event) => {
                      setSelectedRuleId(event.currentTarget.value)
                      setCatalogQuery("");
                    }}
                    required
                  >
                    <option value="">Choose a rule template</option>
                    {catalogMatches.map((rule) => (
                      <option key={rule.id} value={rule.id}>
                        {rule.credentialName} · {rule.jurisdiction}
                      </option>
                    ))}
                    {catalogMatches.length === 0 ? (
                      <option value="" disabled>
                        No matching template — enter your own
                      </option>
                    ) : null}
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

      {acceptanceOpen &&
      selectedCredential?.status === "submitted" ? (
        <Modal
          title="Close this renewal cycle"
          eyebrow="Acceptance received"
          onClose={() => setAcceptanceOpen(false)}
        >
          <form className="form-stack" onSubmit={handleAcceptance}>
            <div className="celebration-panel">
              <span className="celebration-mark" aria-hidden="true">
                ✓
              </span>
              <div>
                <strong>Your renewed license starts a clean cycle</strong>
                <p>
                  The completed cycle stays in history. Credits, checked tasks,
                  and submission records will not be copied forward.
                </p>
              </div>
            </div>
            <div className="form-grid">
              <label className="field">
                <span>Accepted or renewed date</span>
                <input
                  autoFocus
                  name="acceptedAt"
                  type="date"
                  defaultValue={todayIso()}
                  min={selectedCredential.submittedAt?.slice(0, 10)}
                  required
                />
              </label>
              <label className="field">
                <span>Decision or license reference <em>Optional</em></span>
                <input name="reference" placeholder="e.g., license receipt ID" />
              </label>
            </div>
            <div className="cycle-rollover">
              <span className="section-kicker">Next renewal cycle</span>
              <p>Confirm the dates shown by your issuing organization.</p>
              <div className="form-grid">
                <label className="field">
                  <span>New cycle starts</span>
                  <input
                    name="nextCycleStart"
                    type="date"
                    defaultValue={addDaysIso(selectedCredential.deadline, 1)}
                    required
                  />
                </label>
                <label className="field">
                  <span>Next renewal deadline</span>
                  <input
                    name="nextDeadline"
                    type="date"
                    defaultValue={addMonthsIso(
                      selectedCredential.deadline,
                      selectedCredential.cycleMonths || 12,
                    )}
                    required
                  />
                </label>
              </div>
            </div>
            <div className="advisory-note">
              <span aria-hidden="true">i</span>
              <p>
                Requirements are copied as a starting snapshot. Review the
                current official rules before relying on the new plan.
              </p>
            </div>
            <div className="form-actions">
              <button
                className="button button-ghost"
                type="button"
                onClick={() => setAcceptanceOpen(false)}
              >
                Not yet
              </button>
              <button
                className="button button-primary"
                type="submit"
                disabled={pending}
              >
                {pending ? "Creating next cycle…" : "Mark accepted & continue"}
              </button>
            </div>
          </form>
        </Modal>
      ) : null}

      {remindersOpen && workspace ? (
        <Modal
          title="Renewal check-ins"
          eyebrow="Reminder preferences"
          onClose={() => setRemindersOpen(false)}
        >
          <form className="form-stack" onSubmit={handleReminderPreferences}>
            <label className="switch-row">
              <span>
                <strong>Show in-app reminders</strong>
                <small>
                  See upcoming tasks and submission follow-ups on Today.
                </small>
              </span>
              <input
                name="inAppEnabled"
                type="checkbox"
                defaultChecked={workspace.reminderPreferences.inAppEnabled}
              />
            </label>
            <fieldset className="check-grid">
              <legend>Remind me before a due date</legend>
              {[90, 30, 7, 1].map((days) => (
                <label key={days}>
                  <input
                    name="leadDays"
                    type="checkbox"
                    value={days}
                    defaultChecked={workspace.reminderPreferences.leadDays.includes(
                      days,
                    )}
                  />
                  <span>
                    {days} {days === 1 ? "day" : "days"}
                  </span>
                </label>
              ))}
            </fieldset>
            <label className="field">
              <span>Time zone</span>
              <input
                name="timeZone"
                defaultValue={workspace.reminderPreferences.timeZone}
                placeholder="America/New_York"
                required
              />
              <small>Use an IANA zone such as America/New_York.</small>
            </label>
            <div className="advisory-note">
              <span aria-hidden="true">i</span>
              <p>
                This release provides reliable in-app check-ins. Email and push
                delivery will be added after explicit opt-in and delivery
                verification.
              </p>
            </div>
            <div className="form-actions">
              <button
                className="button button-ghost"
                type="button"
                onClick={() => setRemindersOpen(false)}
              >
                Cancel
              </button>
              <button
                className="button button-primary"
                type="submit"
                disabled={pending}
              >
                {pending ? "Saving…" : "Save reminders"}
              </button>
            </div>
          </form>
        </Modal>
      ) : null}

      {allocationActivity && workspace ? (
        <Modal
          title="Reuse completed learning"
          eyebrow={allocationActivity.title}
          onClose={() => setAllocationActivity(null)}
        >
          {eligibleAllocationCredentials.length ? (
            <form className="form-stack" onSubmit={handleAllocation}>
              <div className="advisory-note">
                <span aria-hidden="true">i</span>
                <p>
                  One course may count toward more than one credential. Confirm
                  eligibility with each issuing organization.
                </p>
              </div>
              <label className="field">
                <span>Also apply to</span>
                <select
                  name="credentialId"
                  value={allocationCredential?.id ?? ""}
                  onChange={(event) =>
                    setAllocationCredentialId(event.currentTarget.value)
                  }
                  required
                >
                  {eligibleAllocationCredentials.map((credential) => (
                    <option key={credential.id} value={credential.id}>
                      {credential.credentialName} · {credential.jurisdiction}
                    </option>
                  ))}
                </select>
              </label>
              <div className="form-grid">
                <label className="field">
                  <span>Category</span>
                  <select
                    key={allocationCredential?.id}
                    name="requirementId"
                    defaultValue=""
                  >
                    <option value="">General / decide later</option>
                    {allocationCredential?.requirements.map((requirement) => (
                      <option key={requirement.id} value={requirement.id}>
                        {requirement.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  <span>Credits to apply</span>
                  <input
                    name="allocatedUnits"
                    type="number"
                    min="0.1"
                    max={allocationActivity.totalUnits}
                    step="0.1"
                    defaultValue={allocationActivity.totalUnits}
                    required
                  />
                </label>
              </div>
              <div className="form-actions">
                <button
                  className="button button-ghost"
                  type="button"
                  onClick={() => setAllocationActivity(null)}
                >
                  Cancel
                </button>
                <button
                  className="button button-primary"
                  type="submit"
                  disabled={pending}
                >
                  {pending ? "Applying…" : "Apply to credential"}
                </button>
              </div>
            </form>
          ) : (
            <EmptyModalState
              title="No other eligible credential"
              body="Add another active credential, or this activity is already applied everywhere it can be."
              action="Close"
              onAction={() => setAllocationActivity(null)}
            />
          )}
        </Modal>
      ) : null}

      {evidenceActivity ? (
        <Modal
          title="Proof and certificates"
          eyebrow={evidenceActivity.title}
          onClose={() => setEvidenceActivity(null)}
        >
          <div className="form-stack">
            <form className="evidence-upload" onSubmit={handleEvidenceUpload}>
              <label className="field file-field">
                <span>Add a proof file</span>
                <input
                  name="file"
                  type="file"
                  accept=".pdf,image/jpeg,image/png,image/webp"
                  required
                />
                <small>
                  Private to your account · PDF, JPEG, PNG, or WebP · up to 10 MB
                </small>
              </label>
              <button
                className="button button-primary"
                type="submit"
                disabled={evidencePending}
              >
                {evidencePending ? "Saving…" : "Upload proof"}
              </button>
            </form>
            <div className="evidence-file-list" aria-live="polite">
              {evidencePending && evidenceFiles.length === 0 ? (
                <p className="form-hint">Loading proof files…</p>
              ) : evidenceFiles.length ? (
                evidenceFiles.map((evidence) => (
                  <article key={evidence.id}>
                    <div>
                      <strong>{evidence.fileName}</strong>
                      <small>
                        {(evidence.sizeBytes / 1_048_576).toFixed(1)} MB · saved{" "}
                        {formatDate(evidence.createdAt)}
                      </small>
                    </div>
                    <div className="evidence-file-actions">
                      <a
                        className="button button-outline button-compact"
                        href={evidence.downloadUrl}
                      >
                        Download
                      </a>
                      <button
                        className="button button-ghost button-compact"
                        type="button"
                        disabled={evidencePending}
                        onClick={() => void deleteEvidence(evidence)}
                      >
                        Remove
                      </button>
                    </div>
                  </article>
                ))
              ) : (
                <div className="evidence-empty">
                  <strong>No proof uploaded yet</strong>
                  <p>
                    Add the completion certificate, receipt, or attendance
                    record above.
                  </p>
                </div>
              )}
            </div>
          </div>
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
  onAccept,
  onReminders,
  onReminderState,
  onToggleTask,
}: {
  workspace: Workspace;
  credential: Credential | null;
  onAddActivity: () => void;
  onAddCredential: () => void;
  onViewCredentials: () => void;
  onViewRecords: () => void;
  onSubmit: () => void;
  onAccept: () => void;
  onReminders: () => void;
  onReminderState: (
    reminder: Reminder,
    status: "dismissed" | "snoozed",
  ) => void;
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
      allocationsFor(activity).some(
        (allocation) => allocation.credentialId === credential.id,
      ) &&
      activity.evidenceStatus === "missing",
  ).length;
  const deadlineDays = daysUntil(credential.deadline);
  const visibleReminders = workspace.reminders;

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
              <strong>{Math.abs(deadlineDays)}</strong>
              <span>
                {deadlineDays < 0 ? "days overdue" : "days to renewal"}
              </span>
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

      {visibleReminders.length ? (
        <section className="reminder-inbox" aria-labelledby="reminder-title">
          <div className="reminder-inbox-heading">
            <div>
              <span className="section-kicker">Needs attention</span>
              <h2 id="reminder-title">
                {visibleReminders.length === 1
                  ? "One timely check-in"
                  : `${visibleReminders.length} timely check-ins`}
              </h2>
            </div>
            <button className="text-button" type="button" onClick={onReminders}>
              Settings
            </button>
          </div>
          <div className="reminder-list">
            {visibleReminders.slice(0, 3).map((reminder) => (
              <article className={reminder.urgency} key={reminder.key}>
                <span className="reminder-dot" aria-hidden="true" />
                <div>
                  <strong>{reminder.title}</strong>
                  <p>{reminder.body}</p>
                </div>
                <div>
                  <button
                    type="button"
                    onClick={() => onReminderState(reminder, "snoozed")}
                  >
                    Snooze 7 days
                  </button>
                  <button
                    type="button"
                    onClick={() => onReminderState(reminder, "dismissed")}
                  >
                    Dismiss
                  </button>
                </div>
              </article>
            ))}
          </div>
        </section>
      ) : null}

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
            credential.status === "renewed"
              ? onViewCredentials
              : credential.status === "submitted"
                ? onAccept
                : remaining > 0
              ? onAddActivity
                  : onSubmit
          }
        >
          {credential.status === "renewed"
            ? "View cycle history"
            : credential.status === "submitted"
              ? "Record acceptance"
              : remaining > 0
            ? "Add completed learning"
                : "Review submission"}
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
            onClick={
              credential.status === "renewed"
                ? onViewRecords
                : onAddActivity
            }
          >
            {credential.status === "renewed"
              ? "View preserved records"
              : "Log an activity"}{" "}
            <span aria-hidden="true">
              {credential.status === "renewed" ? "→" : "＋"}
            </span>
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
                } ${credential.status === "renewed" ? "locked" : ""}`}
                key={task.id}
              >
                <input
                  type="checkbox"
                  checked={task.status === "completed"}
                  disabled={credential.status === "renewed"}
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
                        : credential.status === "renewed"
                          ? "Preserved in cycle history"
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
          ) : credential.status === "submitted" ? (
            <div className="submitted-note submitted-note-action">
              <span>
                Submitted {formatDate(credential.submittedAt)}
                {credential.confirmationNumber
                  ? ` · ${credential.confirmationNumber}`
                  : ""}
              </span>
              <button type="button" onClick={onAccept}>
                Record acceptance →
              </button>
            </div>
          ) : (
            <div className="submitted-note">
              Renewed {formatDate(credential.acceptedAt)}
              {credential.acceptanceReference
                ? ` · ${credential.acceptanceReference}`
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
                      {allocationsFor(activity).length
                        ? ` · ${allocationsFor(activity).length} ${
                            allocationsFor(activity).length === 1
                              ? "credential"
                              : "credentials"
                          }`
                        : ""}
                    </p>
                  </div>
                  <span className="credit-value">
                    +{compactNumber(activity.totalUnits)}
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
  onAccept,
  onReminders,
}: {
  credentials: Credential[];
  selectedId: string;
  onSelect: (id: string) => void;
  onAdd: () => void;
  onSubmit: () => void;
  onAccept: () => void;
  onReminders: () => void;
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
                  <small>
                    {credential.jurisdiction} ·{" "}
                    {credential.status === "renewed" ? "history" : credential.status}
                  </small>
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
            {selected.status !== "renewed" ? (
              <button
                className="reminder-setting-link"
                type="button"
                onClick={onReminders}
              >
                ◷ Configure renewal check-ins
              </button>
            ) : null}
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
                <span>
                  {daysUntil(selected.deadline) < 0
                    ? "Past deadline"
                    : "Time left"}
                </span>
                <strong>{Math.abs(daysUntil(selected.deadline))}</strong>
                <small>
                  {daysUntil(selected.deadline) < 0
                    ? "days overdue"
                    : "days"}
                </small>
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
            ) : selected.status === "submitted" ? (
              <div className="detail-footer submitted-footer">
                <div>
                  <strong>Renewal submitted {formatDate(selected.submittedAt)}</strong>
                  <p>
                    {selected.confirmationNumber
                      ? `Confirmation: ${selected.confirmationNumber}`
                      : "No confirmation number recorded."}
                  </p>
                </div>
                <button
                  className="button button-primary"
                  type="button"
                  onClick={onAccept}
                >
                  Record acceptance
                </button>
              </div>
            ) : (
              <div className="detail-footer submitted-footer">
                <div>
                  <strong>Renewed {formatDate(selected.acceptedAt)}</strong>
                  <p>
                    {selected.acceptanceReference
                      ? `Reference: ${selected.acceptanceReference}`
                      : "This completed cycle is preserved in history."}
                  </p>
                </div>
                <span className="verified-chip">Historical cycle</span>
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
  onEvidence,
  onAllocate,
}: {
  activities: Activity[];
  credentials: Credential[];
  onAdd: () => void;
  onEvidence: (activity: Activity) => void;
  onAllocate: (activity: Activity) => void;
}) {
  const total = activities.reduce(
    (sum, activity) =>
      sum +
      allocationsFor(activity).reduce(
        (allocationSum, allocation) =>
          allocationSum + allocation.allocatedUnits,
        0,
      ),
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
          <small>credits across recorded cycles</small>
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
            <article
              className="records-table"
              key={`${activity.id}:${activity.credentialId ?? "unassigned"}:${
                activity.requirementId ?? "general"
              }`}
            >
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
                {allocationsFor(activity).length ? (
                  <span className="allocation-stack">
                    {allocationsFor(activity).map((allocation) => (
                      <span key={allocation.id}>
                        {allocation.credentialName}
                        <small>
                          {allocation.categoryName ?? "General"} ·{" "}
                          {compactNumber(allocation.allocatedUnits)}
                        </small>
                      </span>
                    ))}
                  </span>
                ) : (
                  "Unassigned"
                )}
                {credentials.some(
                  (credential) =>
                    credential.status !== "renewed" &&
                    !allocationsFor(activity).some(
                      (allocation) =>
                        allocation.credentialId === credential.id,
                    ),
                ) ? (
                  <button
                    className="proof-action allocation-action"
                    type="button"
                    onClick={() => onAllocate(activity)}
                  >
                    ＋ Use for another
                  </button>
                ) : null}
              </span>
              <span className="proof-cell">
                <span className={`proof-label ${activity.evidenceStatus}`}>
                  {activity.evidenceStatus === "attached"
                    ? `${activity.evidenceCount || 1} on file`
                    : activity.evidenceStatus === "missing"
                      ? "Add later"
                      : "Not required"}
                </span>
                {activity.evidenceStatus !== "not_required" ? (
                  <button
                    className="proof-action"
                    type="button"
                    onClick={() => onEvidence(activity)}
                  >
                    {activity.evidenceCount ? "Manage" : "Upload"}
                  </button>
                ) : null}
              </span>
              <strong className="record-credit">
                {compactNumber(activity.totalUnits)}
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

function AccountView({
  workspace,
  onReminders,
}: {
  workspace: Workspace;
  onReminders: () => void;
}) {
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
        <section className="card reminder-settings-card">
          <span className="section-kicker">Renewal check-ins</span>
          <h2>
            {workspace.reminderPreferences.inAppEnabled
              ? "In-app reminders are on."
              : "In-app reminders are paused."}
          </h2>
          <p>
            {workspace.reminderPreferences.leadDays.length
              ? `Check-ins are scheduled ${workspace.reminderPreferences.leadDays.join(
                  ", ",
                )} days before due dates.`
              : "Choose when upcoming due dates should appear on Today."}
          </p>
          <button
            className="button button-outline"
            type="button"
            onClick={onReminders}
          >
            Manage reminders
          </button>
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
