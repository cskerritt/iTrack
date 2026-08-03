/**
 * The dashboard hero's three numbers — days to renewal, counted credits, and
 * the readiness ring — used to live only inside `ITrackApp.tsx`. They now live
 * here so that anything else publishing them (today the iOS widget feed in
 * `widgetSummary.ts`) derives them with the *same* arithmetic instead of
 * growing a second, quietly diverging notion of "ready".
 *
 * The shapes below are deliberately looser than the client's own `Credential`
 * and `Requirement` types: the server-side workspace payload types some of
 * these columns as plain strings, and the client narrows them to unions. Both
 * are assignable to these, and the helpers stay generic so a caller passing
 * the narrow type still gets the narrow type back.
 */

export type ReadinessRequirement = {
  requiredUnits: number;
  kind?: string | null;
  applicabilityStatus?: string | null;
  isActive?: boolean;
  isDentalCheckpoint?: boolean;
  checkpointStatus?: string | null;
  earnedUnits?: number | null;
  rawEarned?: number | null;
  countableEarned?: number | null;
};

export type ReadinessCredential = {
  totalRequired: number;
  totalEarned: number;
  requirements: readonly ReadinessRequirement[];
  tasks: readonly { status: string }[];
  classificationIssues?: readonly unknown[] | null;
};

export function clampPercent(value: number) {
  return Math.max(0, Math.min(100, Math.round(value)));
}

/**
 * Counts whole days to the *end* of the deadline day, so a credential due
 * today reads as 1 day rather than 0. The deadline is read in the runtime's
 * own zone, which is what the browser wants: the number the user sees is
 * counted in the zone they are standing in.
 */
export function daysUntilDate(value: string, nowMs: number) {
  const deadline = new Date(`${value.slice(0, 10)}T23:59:59`);
  return Math.ceil((deadline.getTime() - nowMs) / 86_400_000);
}

/**
 * The same count, but anchored to a calendar date the caller already
 * resolved in the *user's* zone rather than the runtime's. Server-side
 * renderers (the iOS widget feed) run on workerd, whose zone is always UTC,
 * so counting from an epoch there would show a US user a different number
 * than the app shows them; passing today's local date in sidesteps that.
 *
 * Counting whole calendar days and adding one is exactly what the
 * end-of-deadline-day arithmetic above resolves to at any wall-clock time
 * of day.
 */
export function daysUntilDateFromToday(value: string, today: string) {
  const deadline = Date.parse(`${value.slice(0, 10)}T00:00:00.000Z`);
  const anchor = Date.parse(`${today.slice(0, 10)}T00:00:00.000Z`);
  if (Number.isNaN(deadline) || Number.isNaN(anchor)) return null;
  return Math.round((deadline - anchor) / 86_400_000) + 1;
}

export function requirementEarned(requirement: ReadinessRequirement) {
  return Number(
    requirement.countableEarned ??
      requirement.earnedUnits ??
      requirement.rawEarned ??
      0,
  );
}

export function requirementKind<T extends ReadinessRequirement>(
  requirement: T,
) {
  return requirement.kind ?? "minimum";
}

export function requirementStatus<T extends ReadinessRequirement>(
  requirement: T,
) {
  return requirement.applicabilityStatus ?? "applies";
}

export function activeMinimums<T extends ReadinessRequirement>(credential: {
  requirements: readonly T[];
}) {
  return credential.requirements.filter(
    (requirement) =>
      requirementStatus(requirement) === "applies" &&
      requirement.isActive !== false &&
      requirementKind(requirement) === "minimum",
  );
}

export function activeDentalCheckpoints<
  T extends ReadinessRequirement,
>(credential: { requirements: readonly T[] }) {
  return credential.requirements.filter(
    (requirement) =>
      requirement.isDentalCheckpoint === true &&
      requirementStatus(requirement) === "applies" &&
      requirement.isActive !== false,
  );
}

export function credentialProgress(credential: ReadinessCredential) {
  if (credential.totalRequired <= 0) return 100;
  return clampPercent(
    (credential.totalEarned / credential.totalRequired) * 100,
  );
}

export function readinessScore(credential: ReadinessCredential) {
  const unitProgress = Math.min(1, credentialProgress(credential) / 100);
  const minimums = activeMinimums(credential);
  const unresolved = credential.requirements.filter(
    (item) => requirementStatus(item) === "needs_confirmation",
  );
  const dentalCheckpoints = activeDentalCheckpoints(credential);
  const requirementCount =
    minimums.length + unresolved.length + dentalCheckpoints.length;
  const metRequirements =
    minimums.filter(
      (item) => requirementEarned(item) >= item.requiredUnits,
    ).length +
    dentalCheckpoints.filter(
      (item) => item.checkpointStatus === "completed",
    ).length;
  const requirementProgressValue =
    requirementCount === 0 ? 1 : metRequirements / requirementCount;
  const taskCount = credential.tasks.length;
  const completedTasks = credential.tasks.filter(
    (item) => item.status === "completed",
  ).length;
  const taskProgress = taskCount === 0 ? 1 : completedTasks / taskCount;
  const score =
    credential.totalRequired <= 0
      ? clampPercent(requirementProgressValue * 60 + taskProgress * 40)
      : clampPercent(
          unitProgress * 70 +
            requirementProgressValue * 15 +
            taskProgress * 15,
        );
  return credential.classificationIssues?.length
    ? Math.min(99, score)
    : score;
}
