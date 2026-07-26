export const EXPANDED_CERTIFICATION_RULE_SET_PREFIXES = [
  "ima-",
  "acfe-",
  "iia-",
  "irs-",
  "nasaa-",
  "nmls-",
  "finra-",
  "cfainstitute-",
  "acams-",
  "aba-",
  "ascm-",
  "asq-",
  "bcsp-",
  "gbci-",
  "icf-",
  "internachi-",
  "ifma-",
  "atd-",
  "giac-",
  "iapp-",
  "ace-",
  "ancc-",
  "aacn-",
  "nbcot-",
  "bacb-",
  "nbcc-",
  "ccmc-",
  "aapc-",
  "ahima-",
  "ascp-",
  "nbrc-",
  "ardms-",
  "aama-",
  "nahq-",
] as const;

export function isExpandedCertificationRuleSetId(
  ruleSetId: string | null | undefined,
) {
  return Boolean(
    ruleSetId &&
      EXPANDED_CERTIFICATION_RULE_SET_PREFIXES.some((prefix) =>
        ruleSetId.startsWith(prefix),
      ),
  );
}
