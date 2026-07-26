export type RenewalPacketRequirement = {
  id: string;
  name: string;
  requiredUnits: number;
  earnedUnits: number;
  rawEarned: number;
  excessUnits: number;
  remainingUnits: number | null;
  progressPercent: number | null;
  kind: "minimum" | "maximum" | "informational";
  relation: "independent" | "nested" | "overlapping";
  applicabilityStatus: "applies" | "not_applicable" | "needs_confirmation";
  isActive: boolean;
  conditionNote: string | null;
};

export type RenewalPacketTask = {
  id: string;
  title: string;
  kind: string;
  status: string;
  dueDate: string | null;
  completedAt: string | null;
  isPersonal: boolean;
};

export type RenewalPacketActivity = {
  id: string;
  title: string;
  provider: string;
  completionDate: string;
  totalUnits: number;
  allocatedUnits: number;
  categoryNames: string[];
  classificationStatus: "classified" | "needs_classification";
  evidenceStatus: string;
  evidenceReference: string | null;
  evidenceDeletionPendingCount: number;
};

export type RenewalPacketEvidence = {
  id: string;
  activityId: string;
  activityTitle: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  sha256: string;
  createdAt: string;
};

export type RenewalPacketData = {
  owner: {
    displayName: string;
    email: string;
  };
  credential: {
    credentialName: string;
    profession: string;
    jurisdiction: string;
    issuer: string;
    cycleStart: string;
    deadline: string;
    status: string;
    lifecycleKind: "renewal" | "compliance_period" | "automatic_renewal";
    totalRequired: number;
    totalLoggedUnits: number;
    totalExcessUnits: number;
    totalEarned: number;
    totalRemaining: number;
    unclassifiedUnits: number;
    unitLabel: string;
    submittedAt: string | null;
    confirmationNumber: string | null;
    submissionProof: string | null;
    submissionAttestationKind: string | null;
    acceptedAt: string | null;
    acceptanceReference: string | null;
    officialRecordAttestedAt: string | null;
  };
  source: {
    title: string | null;
    url: string | null;
    effectiveDate: string | null;
    lastVerifiedAt: string | null;
    reviewStatus: string;
    version: number | null;
  };
  requirements: RenewalPacketRequirement[];
  tasks: RenewalPacketTask[];
  activities: RenewalPacketActivity[];
  evidence: RenewalPacketEvidence[];
  generatedAt: string;
};

export const RENEWAL_PACKET_PRINT_SCRIPT =
  'document.getElementById("print-packet")?.addEventListener("click",()=>window.print());';

function escapeHtml(value: unknown) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function compactNumber(value: number) {
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 2,
  }).format(Number.isFinite(value) ? value : 0);
}

function formatDate(value: string | null) {
  if (!value) return "Not recorded";
  const parsed = new Date(`${value.slice(0, 10)}T12:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) return value;
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(parsed);
}

function formatTimestamp(value: string) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
    timeZone: "UTC",
  }).format(parsed);
}

function formatFileSize(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 KB";
  if (bytes < 1_048_576) {
    return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  }
  return `${(bytes / 1_048_576).toFixed(1)} MB`;
}

function words(value: string) {
  return value
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function safeSourceUrl(value: string | null) {
  if (!value) return null;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" ? parsed.href : null;
  } catch {
    return null;
  }
}

function evidenceHref(id: string) {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      id,
    )
  ) {
    return null;
  }
  return `/api/evidence/${encodeURIComponent(id)}/download`;
}

function requirementStatus(requirement: RenewalPacketRequirement) {
  if (requirement.applicabilityStatus === "needs_confirmation") {
    return { label: "Confirm applicability", tone: "review" };
  }
  if (
    !requirement.isActive ||
    requirement.applicabilityStatus === "not_applicable"
  ) {
    return { label: "Not applicable", tone: "muted" };
  }
  if (requirement.kind === "informational") {
    return { label: "Tracked condition", tone: "muted" };
  }
  if (requirement.kind === "maximum") {
    return {
      label:
        requirement.excessUnits > 0
          ? `${compactNumber(requirement.excessUnits)} over cap`
          : "Within cap",
      tone: requirement.excessUnits > 0 ? "review" : "complete",
    };
  }
  if ((requirement.remainingUnits ?? 0) <= 0) {
    return { label: "Complete", tone: "complete" };
  }
  return {
    label: `${compactNumber(requirement.remainingUnits ?? 0)} remaining`,
    tone: "review",
  };
}

function readinessIssues(data: RenewalPacketData) {
  const issues: string[] = [];
  const { credential } = data;
  if (credential.totalRemaining > 0) {
    issues.push(
      `${compactNumber(credential.totalRemaining)} ${credential.unitLabel} remain toward the overall total.`,
    );
  }
  if (credential.unclassifiedUnits > 0) {
    issues.push(
      `${compactNumber(credential.unclassifiedUnits)} ${credential.unitLabel} need classification before they can count.`,
    );
  }
  const openMinimums = data.requirements.filter(
    (requirement) =>
      requirement.isActive &&
      requirement.applicabilityStatus === "applies" &&
      requirement.kind === "minimum" &&
      (requirement.remainingUnits ?? 0) > 0,
  );
  if (openMinimums.length) {
    issues.push(
      `${openMinimums.length} active ${
        openMinimums.length === 1 ? "minimum is" : "minimums are"
      } incomplete.`,
    );
  }
  const unresolvedConditions = data.requirements.filter(
    (requirement) =>
      requirement.applicabilityStatus === "needs_confirmation",
  ).length;
  if (unresolvedConditions) {
    issues.push(
      `${unresolvedConditions} conditional ${
        unresolvedConditions === 1 ? "requirement needs" : "requirements need"
      } an applicability decision.`,
    );
  }
  const pendingTasks = data.tasks.filter(
    (task) => task.status !== "completed",
  ).length;
  if (pendingTasks) {
    issues.push(
      `${pendingTasks} checklist ${pendingTasks === 1 ? "task is" : "tasks are"} still open.`,
    );
  }
  const missingProof = data.activities.filter(
    (activity) => activity.evidenceStatus === "missing",
  ).length;
  if (missingProof) {
    issues.push(
      `${missingProof} ${
        missingProof === 1 ? "activity is" : "activities are"
      } marked as missing proof.`,
    );
  }
  const pendingProofRemoval = data.activities.filter(
    (activity) => activity.evidenceDeletionPendingCount > 0,
  ).length;
  if (pendingProofRemoval) {
    issues.push(
      `${pendingProofRemoval} ${
        pendingProofRemoval === 1 ? "activity has" : "activities have"
      } proof removal in progress.`,
    );
  }
  return issues;
}

function renderRequirements(data: RenewalPacketData) {
  if (!data.requirements.length) {
    return '<p class="empty">No separate requirement categories are recorded for this credential.</p>';
  }
  return data.requirements
    .map((requirement) => {
      const status = requirementStatus(requirement);
      const amount =
        requirement.kind === "informational"
          ? "Condition"
          : requirement.kind === "maximum"
            ? `${compactNumber(requirement.earnedUnits)} / ${compactNumber(
                requirement.requiredUnits,
              )} ${data.credential.unitLabel} cap`
            : `${compactNumber(requirement.earnedUnits)} / ${compactNumber(
                requirement.requiredUnits,
              )} ${data.credential.unitLabel}`;
      return `
        <article class="requirement-row" data-requirement-id="${escapeHtml(
          requirement.id,
        )}">
          <div>
            <h3>${escapeHtml(requirement.name)}</h3>
            <p>${escapeHtml(amount)} · ${escapeHtml(words(requirement.relation))}</p>
            ${
              requirement.conditionNote
                ? `<small>${escapeHtml(requirement.conditionNote)}</small>`
                : ""
            }
          </div>
          <span class="status ${status.tone}">${escapeHtml(status.label)}</span>
        </article>`;
    })
    .join("");
}

function renderActivities(data: RenewalPacketData) {
  if (!data.activities.length) {
    return '<p class="empty">No active learning records are allocated to this cycle.</p>';
  }
  return data.activities
    .map((activity) => {
      const classified = activity.classificationStatus === "classified";
      const proofLabel =
        activity.evidenceStatus === "attached"
          ? "Proof attached"
          : activity.evidenceStatus === "not_required"
            ? "Proof not required"
            : "Proof missing";
      return `
        <article class="activity-card" data-activity-id="${escapeHtml(
          activity.id,
        )}">
          <div class="activity-heading">
            <div>
              <h3>${escapeHtml(activity.title)}</h3>
              <p>${escapeHtml(activity.provider || "Provider not recorded")} · ${escapeHtml(
                formatDate(activity.completionDate),
              )}</p>
            </div>
            <div class="activity-amount">
              <strong>${escapeHtml(
                compactNumber(activity.allocatedUnits),
              )} ${escapeHtml(data.credential.unitLabel)}</strong>
              <small>allocated to this cycle</small>
            </div>
          </div>
          <div class="tag-row">
            <span class="status ${classified ? "complete" : "review"}">${
              classified ? "Classification complete" : "Needs classification"
            }</span>
            <span class="status ${
              activity.evidenceStatus === "missing" ? "review" : "muted"
            }">${escapeHtml(proofLabel)}</span>
            ${
              activity.evidenceDeletionPendingCount > 0
                ? '<span class="status review">Proof removal pending</span>'
                : ""
            }
          </div>
          <p class="activity-tags"><b>Requirement tags:</b> ${escapeHtml(
            activity.categoryNames.length
              ? activity.categoryNames.join(" · ")
              : "No category tags",
          )}</p>
          ${
            activity.evidenceReference
              ? `<p class="reference"><b>Proof reference:</b> ${escapeHtml(
                  activity.evidenceReference,
                )}</p>`
              : ""
          }
          ${
            activity.totalUnits !== activity.allocatedUnits
              ? `<small>${escapeHtml(
                  compactNumber(activity.totalUnits),
                )} total activity units; ${escapeHtml(
                  compactNumber(activity.allocatedUnits),
                )} allocated to this credential.</small>`
              : ""
          }
        </article>`;
    })
    .join("");
}

function renderTasks(data: RenewalPacketData) {
  if (!data.tasks.length) {
    return '<p class="empty">No checklist tasks are recorded for this cycle.</p>';
  }
  return data.tasks
    .map(
      (task) => `
        <article class="task-row" data-task-id="${escapeHtml(task.id)}">
          <span class="check" aria-hidden="true">${
            task.status === "completed" ? "✓" : "○"
          }</span>
          <div>
            <h3>${escapeHtml(task.title)}</h3>
            <p>${escapeHtml(words(task.kind))}${
              task.isPersonal ? " · Personal" : ""
            }${
              task.dueDate
                ? ` · Due ${escapeHtml(formatDate(task.dueDate))}`
                : ""
            }${
              task.completedAt
                ? ` · Completed ${escapeHtml(formatDate(task.completedAt))}`
                : ""
            }</p>
          </div>
          <span class="status ${
            task.status === "completed" ? "complete" : "review"
          }">${task.status === "completed" ? "Complete" : "Open"}</span>
        </article>`,
    )
    .join("");
}

function renderEvidence(data: RenewalPacketData) {
  if (!data.evidence.length) {
    return '<p class="empty">No uploaded evidence files are attached to this cycle.</p>';
  }
  return data.evidence
    .map((file) => {
      const href = evidenceHref(file.id);
      return `
        <article class="evidence-row" data-evidence-id="${escapeHtml(file.id)}">
          <div>
            <h3>${escapeHtml(file.fileName)}</h3>
            <p>${escapeHtml(file.activityTitle)} · ${escapeHtml(
              formatFileSize(file.sizeBytes),
            )} · ${escapeHtml(file.contentType)} · Added ${escapeHtml(
              formatDate(file.createdAt),
            )}</p>
            <small>SHA-256: ${escapeHtml(file.sha256)}</small>
          </div>
          ${
            href
              ? `<a href="${escapeHtml(
                  href,
                )}" target="_blank" rel="noopener noreferrer">Open private file (new tab)</a>`
              : '<span class="status review">Invalid file link</span>'
          }
        </article>`;
    })
    .join("");
}

export function credentialPacketFilename(
  credentialName: string,
  deadline: string,
) {
  const safeName =
    credentialName
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 72) || "credential";
  const safeDeadline = /^\d{4}-\d{2}-\d{2}$/.test(deadline)
    ? deadline
    : "cycle";
  return `credential-packet-${safeName}-${safeDeadline}.html`;
}

export function renderRenewalPacket(data: RenewalPacketData) {
  const issues = readinessIssues(data);
  const sourceUrl = safeSourceUrl(data.source.url);
  const completedTasks = data.tasks.filter(
    (task) => task.status === "completed",
  ).length;
  const title = `${data.credential.credentialName} credential packet`;
  const isCompliancePeriod =
    data.credential.lifecycleKind === "compliance_period";
  const isAutomaticRenewal =
    data.credential.lifecycleKind === "automatic_renewal";
  const lifecycleLabel =
    data.credential.status === "renewed"
      ? isCompliancePeriod
        ? "Compliance period completed"
        : isAutomaticRenewal
          ? "Automatic-renewal cycle completed"
          : "Acceptance / completion recorded"
      : data.credential.status === "submitted"
        ? isCompliancePeriod
          ? "Compliance checkpoint recorded"
          : isAutomaticRenewal
            ? "Dashboard checkpoint recorded"
            : "Submission recorded"
        : isCompliancePeriod
          ? "Active compliance period"
          : "Active cycle";
  const checkpointTitle = isCompliancePeriod
    ? "Compliance checkpoint"
    : isAutomaticRenewal
      ? "Dashboard checkpoint"
      : "Submission";
  const completionTitle = isCompliancePeriod
    ? "Period completion"
    : isAutomaticRenewal
      ? "Automatic renewal / completion"
      : "Acceptance / completion";
  const totalProgressPercent =
    data.credential.totalRequired > 0
      ? Math.min(
          100,
          Math.round(
            (data.credential.totalEarned /
              data.credential.totalRequired) *
              100,
          ),
        )
      : 100;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="license-lantern-packet-version" content="1">
  <title>${escapeHtml(title)}</title>
  <style>
    :root {
      color-scheme: light;
      --ink: #173c32;
      --muted: #65746f;
      --line: #d9e1dc;
      --paper: #ffffff;
      --wash: #f4f8f5;
      --green: #2f745d;
      --green-soft: #e2f3e9;
      --amber: #8c6418;
      --amber-soft: #fff1cf;
    }
    * { box-sizing: border-box; }
    html { background: #e8eeea; }
    body {
      max-width: 920px;
      margin: 24px auto;
      background: var(--paper);
      color: var(--ink);
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      font-size: 14px;
      line-height: 1.45;
    }
    main { padding: 42px 48px 54px; }
    h1, h2, h3, p { margin-top: 0; }
    h1 { max-width: 680px; margin-bottom: 8px; font-family: Georgia, serif; font-size: 38px; line-height: 1.08; }
    h2 { margin-bottom: 14px; font-family: Georgia, serif; font-size: 24px; font-weight: 600; }
    h3 { margin-bottom: 3px; font-size: 14px; }
    p { color: var(--muted); }
    a { color: var(--green); font-weight: 750; text-underline-offset: 3px; }
    button {
      min-height: 44px;
      border: 0;
      border-radius: 10px;
      background: var(--ink);
      color: #fff;
      cursor: pointer;
      font: inherit;
      font-weight: 800;
      padding: 10px 14px;
    }
    small { display: block; color: var(--muted); overflow-wrap: anywhere; }
    .topbar {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 20px;
      border-bottom: 1px solid var(--line);
      padding-bottom: 18px;
    }
    .brand { color: var(--green); font-size: 12px; font-weight: 900; letter-spacing: .11em; text-transform: uppercase; }
    .generated { margin: 0; font-size: 12px; text-align: right; }
    .screen-toolbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 14px;
      margin-bottom: 24px;
      border: 1px solid var(--line);
      border-radius: 12px;
      background: var(--wash);
      padding: 10px 12px;
    }
    .hero { padding: 38px 0 24px; }
    .eyebrow { margin-bottom: 8px; color: var(--green); font-size: 11px; font-weight: 850; letter-spacing: .08em; text-transform: uppercase; }
    .hero > p { max-width: 690px; margin-bottom: 18px; font-size: 15px; }
    .status {
      display: inline-flex;
      align-items: center;
      width: fit-content;
      border-radius: 999px;
      padding: 4px 8px;
      font-size: 11px;
      font-weight: 800;
    }
    .status.complete { background: var(--green-soft); color: var(--green); }
    .status.review { background: var(--amber-soft); color: var(--amber); }
    .status.muted { background: #edf1ee; color: #596760; }
    .summary-grid {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 10px;
      margin: 0;
    }
    .summary-grid > div {
      min-width: 0;
      border: 1px solid var(--line);
      border-radius: 12px;
      background: var(--wash);
      padding: 13px;
    }
    .summary-grid small { margin-top: 3px; font-size: 10px; }
    dt { margin-bottom: 4px; color: var(--muted); font-size: 10px; font-weight: 800; letter-spacing: .05em; text-transform: uppercase; }
    dd { margin: 0; font-size: 15px; font-weight: 800; overflow-wrap: anywhere; }
    section { border-top: 1px solid var(--line); padding: 28px 0 4px; }
    .readiness {
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(240px, .72fr);
      gap: 24px;
      border: 1px solid ${issues.length ? "#e8cf98" : "#bcd9ca"};
      border-radius: 15px;
      background: ${issues.length ? "#fffaf0" : "#f2faf5"};
      padding: 20px;
    }
    .readiness h2 { margin-bottom: 6px; }
    .readiness p { margin-bottom: 0; }
    .issue-list { margin: 0; padding-left: 19px; color: var(--muted); }
    .issue-list li + li { margin-top: 5px; }
    .requirement-row, .task-row, .evidence-row {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      align-items: center;
      gap: 18px;
      border-top: 1px solid var(--line);
      padding: 13px 0;
      break-inside: avoid;
    }
    .requirement-row:first-child, .task-row:first-child, .evidence-row:first-child { border-top: 0; }
    .requirement-row p, .task-row p, .evidence-row p { margin-bottom: 0; font-size: 12px; }
    .activity-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
    .activity-card {
      border: 1px solid var(--line);
      border-radius: 12px;
      padding: 15px;
      break-inside: avoid;
    }
    .activity-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
    .activity-heading p { margin-bottom: 0; font-size: 12px; }
    .activity-heading > strong { flex: 0 0 auto; color: var(--green); }
    .activity-amount { flex: 0 0 auto; text-align: right; }
    .activity-amount strong, .activity-amount small { display: block; }
    .activity-amount strong { color: var(--green); }
    .activity-amount small { margin-top: 2px; font-size: 10px; }
    .tag-row { display: flex; flex-wrap: wrap; gap: 5px; margin: 12px 0 8px; }
    .activity-tags, .reference { margin-bottom: 5px; font-size: 12px; }
    .task-row { grid-template-columns: 28px minmax(0, 1fr) auto; }
    .check {
      display: grid;
      place-items: center;
      width: 25px;
      height: 25px;
      border: 1px solid var(--line);
      border-radius: 7px;
      color: var(--green);
      font-weight: 900;
    }
    .evidence-row small { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 10px; }
    .history-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
    .history-card { border: 1px solid var(--line); border-radius: 12px; padding: 15px; break-inside: avoid; }
    .history-card p { margin-bottom: 5px; }
    .empty { border: 1px dashed var(--line); border-radius: 12px; padding: 15px; }
    .source-card { border: 1px solid var(--line); border-radius: 12px; background: var(--wash); padding: 17px; }
    .source-card p:last-child { margin-bottom: 0; }
    .notice { margin: 24px 0 0; border-left: 4px solid #d5a748; background: #fff9eb; padding: 13px 15px; color: #635634; }
    footer { margin-top: 30px; border-top: 1px solid var(--line); padding-top: 16px; color: var(--muted); font-size: 11px; }
    @media (max-width: 680px) {
      body { margin: 0; }
      main { padding: 28px 20px 38px; }
      h1 { font-size: 32px; }
      .topbar, .activity-heading { align-items: flex-start; flex-direction: column; }
      .activity-amount { text-align: left; }
      .generated { text-align: left; }
      .summary-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .readiness, .activity-grid, .history-grid { grid-template-columns: 1fr; }
      .requirement-row, .task-row, .evidence-row { align-items: flex-start; }
    }
    @media print {
      @page { size: Letter; margin: 14mm; }
      html, body { background: #fff; }
      body { max-width: none; margin: 0; }
      main { padding: 0; }
      .screen-toolbar { display: none; }
      a { color: inherit; }
      .source-card, .readiness, .summary-grid > div { print-color-adjust: exact; -webkit-print-color-adjust: exact; }
      section { break-before: auto; }
    }
  </style>
</head>
<body>
  <main>
    <nav class="screen-toolbar" aria-label="Packet actions">
      <a href="/">← Back to License Lantern</a>
      <button id="print-packet" type="button">Print / Save as PDF</button>
    </nav>
    <header class="topbar">
      <div class="brand">License Lantern · Credential packet</div>
      <p class="generated">Generated ${escapeHtml(formatTimestamp(data.generatedAt))}<br>Private record for ${escapeHtml(data.owner.displayName)}</p>
    </header>

    <div class="hero">
      <p class="eyebrow">${escapeHtml(lifecycleLabel)}</p>
      <h1>${escapeHtml(data.credential.credentialName)}</h1>
      <p>${escapeHtml(data.credential.profession)} · ${escapeHtml(
        data.credential.jurisdiction,
      )} · ${escapeHtml(data.credential.issuer)}</p>
      <span class="status ${issues.length ? "review" : "complete"}">${
        issues.length ? "Tracked gaps remain" : "Tracked records complete"
      }</span>
    </div>

    <dl class="summary-grid" id="credential-summary">
      <div><dt>Cycle</dt><dd>${escapeHtml(
        formatDate(data.credential.cycleStart),
      )} – ${escapeHtml(formatDate(data.credential.deadline))}</dd></div>
      <div><dt>Counted</dt><dd>${escapeHtml(
        compactNumber(data.credential.totalEarned),
      )} / ${escapeHtml(compactNumber(data.credential.totalRequired))} ${escapeHtml(
        data.credential.unitLabel,
      )}</dd><small>${escapeHtml(
        compactNumber(data.credential.totalLoggedUnits),
      )} logged · ${escapeHtml(
        compactNumber(data.credential.totalExcessUnits),
      )} cap-excluded</small></div>
      <div><dt>Checklist</dt><dd>${completedTasks} / ${
        data.tasks.length
      } complete</dd></div>
      <div><dt>Evidence files</dt><dd>${data.evidence.length}</dd></div>
    </dl>

    <section
      id="tracked-readiness"
      aria-labelledby="readiness-title"
      data-total-logged="${escapeHtml(data.credential.totalLoggedUnits)}"
      data-total-counted="${escapeHtml(data.credential.totalEarned)}"
      data-total-excluded="${escapeHtml(data.credential.totalExcessUnits)}"
      data-total-unclassified="${escapeHtml(
        data.credential.unclassifiedUnits,
      )}"
      data-total-remaining="${escapeHtml(data.credential.totalRemaining)}"
      data-progress-percent="${escapeHtml(totalProgressPercent)}"
    >
      <div class="readiness" id="needs-attention">
        <div>
          <p class="eyebrow">Preflight snapshot</p>
          <h2 id="readiness-title">${
            issues.length ? "Review tracked gaps" : "No open tracking flags"
          }</h2>
          <p>${
            issues.length
              ? "Resolve or consciously verify these items against the official record or portal."
              : "Recorded totals, active minimums, checklist tasks, classifications, and proof flags show no open tracking items."
          }</p>
        </div>
        ${
          issues.length
            ? `<ul class="issue-list">${issues
                .map((issue) => `<li>${escapeHtml(issue)}</li>`)
                .join("")}</ul>`
            : '<span class="status complete">No open tracking flags</span>'
        }
      </div>
    </section>

    <section id="requirement-ledger" aria-labelledby="requirements-title">
      <p class="eyebrow">Requirement progress</p>
      <h2 id="requirements-title">Credits and conditions</h2>
      <div>${renderRequirements(data)}</div>
      ${
        data.credential.totalExcessUnits > 0
          ? `<p class="reference">Overall counted credit applies category caps across activities. Individual requirement rows show their own category-specific progress.</p>`
          : ""
      }
    </section>

    <section id="activity-ledger" aria-labelledby="activities-title">
      <p class="eyebrow">Cycle record</p>
      <h2 id="activities-title">Learning activities</h2>
      <div class="activity-grid">${renderActivities(data)}</div>
    </section>

    <section id="renewal-checklist" aria-labelledby="checklist-title">
      <p class="eyebrow">Cycle checklist</p>
      <h2 id="checklist-title">Tracked tasks</h2>
      <div>${renderTasks(data)}</div>
    </section>

    <section id="renewal-lifecycle" aria-labelledby="history-title">
      <p class="eyebrow">Lifecycle record</p>
      <h2 id="history-title">Checkpoint and completion</h2>
      <div class="history-grid">
        <article class="history-card">
          <h3>${escapeHtml(checkpointTitle)}</h3>
          <p><b>Recorded date:</b> ${escapeHtml(
            formatDate(data.credential.submittedAt),
          )}</p>
          <p><b>Confirmation:</b> ${escapeHtml(
            data.credential.confirmationNumber || "Not recorded",
          )}</p>
          <p><b>Proof reference:</b> ${escapeHtml(
            data.credential.submissionProof || "Not recorded",
          )}</p>
          <p><b>Attestation:</b> ${escapeHtml(
            data.credential.submissionAttestationKind
              ? words(data.credential.submissionAttestationKind)
              : "Not recorded",
          )}</p>
        </article>
        <article class="history-card">
          <h3>${escapeHtml(completionTitle)}</h3>
          <p><b>Date:</b> ${escapeHtml(
            formatDate(data.credential.acceptedAt),
          )}</p>
          <p><b>Reference:</b> ${escapeHtml(
            data.credential.acceptanceReference || "Not recorded",
          )}</p>
          <p><b>Official-record attested:</b> ${escapeHtml(
            formatDate(data.credential.officialRecordAttestedAt),
          )}</p>
        </article>
      </div>
    </section>

    <section id="evidence-inventory" aria-labelledby="evidence-title">
      <p class="eyebrow">Private evidence inventory</p>
      <h2 id="evidence-title">Attached files</h2>
      <p>Files are inventoried here rather than embedded. Opening one rechecks the signed-in owner.</p>
      <div>${renderEvidence(data)}</div>
    </section>

    <section id="sources-and-disclaimer" aria-labelledby="source-title">
      <p class="eyebrow">Rule provenance</p>
      <h2 id="source-title">Official-source snapshot</h2>
      <div class="source-card">
        <h3>${escapeHtml(data.source.title || "Custom credential plan")}</h3>
        <p>Review status: ${escapeHtml(words(data.source.reviewStatus))}${
          data.source.version !== null
            ? ` · Template version ${escapeHtml(data.source.version)}`
            : ""
        }</p>
        <p>Effective date: ${escapeHtml(
          formatDate(data.source.effectiveDate),
        )} · Last reviewed: ${escapeHtml(
          formatDate(data.source.lastVerifiedAt),
        )}</p>
        ${
          sourceUrl
            ? `<a href="${escapeHtml(
                sourceUrl,
                )}" target="_blank" rel="noopener noreferrer">Open official source (new tab)</a>`
            : "<p>No official source link is attached to this custom plan.</p>"
        }
      </div>
    </section>

    <p class="notice"><b>Final verification required.</b> This packet summarizes the private record in License Lantern. It does not replace the issuing authority’s current rules, official record or portal, audit instructions, or proof of completion or acceptance.</p>
    <footer>
      Account: ${escapeHtml(data.owner.email)} · Use your browser’s Print command to save this credential packet as a PDF. Private evidence links require the signed-in owner.
    </footer>
  </main>
  <script>${RENEWAL_PACKET_PRINT_SCRIPT}</script>
</body>
</html>`;
}

export function renderRenewalPacketError(
  title: string,
  message: string,
) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex, noarchive">
  <title>${escapeHtml(title)} · License Lantern</title>
  <style>
    :root { color-scheme: light; }
    * { box-sizing: border-box; }
    body {
      display: grid;
      min-height: 100vh;
      margin: 0;
      background: #edf3ef;
      color: #173c32;
      font-family: Inter, ui-sans-serif, system-ui, sans-serif;
      place-items: center;
      padding: 24px;
    }
    main {
      width: min(100%, 520px);
      border: 1px solid #d4dfd8;
      border-radius: 18px;
      background: #fff;
      box-shadow: 0 18px 50px rgba(23, 60, 50, .1);
      padding: 34px;
    }
    .brand { color: #2f745d; font-size: 11px; font-weight: 900; letter-spacing: .1em; text-transform: uppercase; }
    h1 { margin: 12px 0 8px; font-family: Georgia, serif; font-size: 32px; }
    p { margin: 0; color: #68766f; line-height: 1.55; }
    nav { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 24px; }
    a {
      display: inline-flex;
      align-items: center;
      min-height: 44px;
      border: 1px solid #cbd9d1;
      border-radius: 10px;
      color: #2f745d;
      font-weight: 800;
      padding: 9px 13px;
      text-decoration: none;
    }
    a.primary { border-color: #173c32; background: #173c32; color: #fff; }
  </style>
</head>
<body>
  <main>
    <div class="brand">License Lantern</div>
    <h1>${escapeHtml(title)}</h1>
    <p>${escapeHtml(message)}</p>
    <nav aria-label="Recovery actions">
      <a class="primary" href="">Try again</a>
      <a href="/">Back to License Lantern</a>
    </nav>
  </main>
</body>
</html>`;
}
