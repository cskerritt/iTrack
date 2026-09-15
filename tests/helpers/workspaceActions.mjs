// The workspace actions the build dispatches, in the order of the `case`
// labels of the `switch (action)` in app/api/workspace/route.ts.
//
// Two tests hold this list to the truth from opposite sides:
// - tests/app-source-guards.test.mjs proves it equals the `case "<name>":`
//   labels of whichever file under app/api/ throws `unsupported_action`;
// - tests/isolation.test.mjs proves the build dispatches every name and that
//   every name has a foreign-id probe (or is listed as having no id surface).
// Adding an action therefore means adding it here AND adding its probe row.
export const WORKSPACE_ACTIONS = [
  "createCredential",
  "updateCredential",
  "archiveCredential",
  "restoreCredential",
  "deleteCredential",
  "addActivity",
  "updateActivity",
  "archiveActivity",
  "restoreActivity",
  "addActivityAllocation",
  "updateActivityAllocationRequirements",
  "claimWeeklyQuest",
  "toggleTask",
  "createPersonalTask",
  "updatePersonalTask",
  "archivePersonalTask",
  "restorePersonalTask",
  "markSubmitted",
  "markRenewalAccepted",
  "updateRequirementApplicability",
  "saveDentalCheckpoint",
  "updateWeeklyGoal",
  "updateReminderPreferences",
  "savePushSubscription",
  "removePushSubscription",
  "sendTestPush",
  "setReminderState",
];
