// The pure half of the Select primitive (app/components/Form.tsx): a native
// <select> gains a search input once it holds this many options, and the
// search narrows the options by case-insensitive substring over
// `label + keywords`. No DOM, no React, no imports — node:test drives it
// through `npm run build:lib-test` (tests/select-filter.test.mjs).

export type SelectOption = {
  value: string;
  label: string;
  disabled?: boolean;
  // Extra words the search may match that the label does not show — an
  // acronym, an issuer, a state code.
  keywords?: string;
};

export type SelectGroup = { label: string; options: SelectOption[] };

// spec §5.2: "Select with search for ≥ 12 options".
export const SEARCHABLE_OPTION_COUNT = 12;

function isGrouped<T extends SelectOption>(
  options: T[] | Array<{ label: string; options: T[] }>,
): options is Array<{ label: string; options: T[] }> {
  const first = options[0];
  return first !== undefined && "options" in first;
}

export function countOptions(options: SelectOption[] | SelectGroup[]): number {
  if (isGrouped(options)) {
    return options.reduce((total, group) => total + group.options.length, 0);
  }
  return options.length;
}

function matches(option: SelectOption, needle: string): boolean {
  return `${option.label} ${option.keywords ?? ""}`
    .toLowerCase()
    .includes(needle);
}

// An empty (or blank) query returns the input itself, so a caller can compare
// by identity; otherwise a new array of the matching options, with groups
// kept in order and dropped once nothing in them matches.
export function filterOptions<T extends SelectOption>(
  options: T[] | Array<{ label: string; options: T[] }>,
  query: string,
): typeof options {
  const needle = query.trim().toLowerCase();
  if (!needle) return options;
  if (isGrouped(options)) {
    return options
      .map((group) => ({
        label: group.label,
        options: group.options.filter((option) => matches(option, needle)),
      }))
      .filter((group) => group.options.length > 0);
  }
  return options.filter((option) => matches(option, needle));
}
