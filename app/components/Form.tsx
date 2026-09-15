"use client";

import {
  createContext,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
  type MouseEvent,
  type ReactNode,
} from "react";
import { ISO_DATE_PATTERN } from "../lib/dates";
import {
  SEARCHABLE_OPTION_COUNT,
  countOptions,
  filterOptions,
  type SelectGroup,
  type SelectOption,
} from "../lib/selectFilter";

// Form primitives (spec §5.2). One field shape for the whole app: a Field
// renders the label, hint and inline error and hands its control the ids they
// need — the label's `for` target, `aria-describedby` (hint, then error) and
// `aria-invalid` — through context, so a control never guesses at markup.
// Errors are announced once, by ErrorSummary (role="alert", focused on
// arrival); FieldError is plain text linked by aria-describedby (a11y-09).
// Colour and the boundary/ring live in app/styles/primitives.css FORM: every
// control is 1px --line-strong on --card with the one 3px --focus-ring
// (a11y-05, a11y-06).

type FieldWiring = { id: string; describedBy?: string; invalid: boolean };

const FieldContext = createContext<FieldWiring | null>(null);

const classes = (...names: Array<string | undefined | false>) =>
  names.filter(Boolean).join(" ");

// The attributes a control inherits from the Field around it. Callers spread
// their own props after these, so an explicit aria-* wins. An explicit id
// belongs on the Field, which forwards it here, so the label's `for` stays
// right; an id set on the control itself would detach it from its label.
// Every control also marks itself `data-autofocus` when it is given
// autoFocus: React never emits an `autofocus` attribute, and the Modal's
// initial-focus query looks for this marker.
function useFieldProps(autoFocus: boolean | undefined) {
  const field = useContext(FieldContext);
  return {
    id: field?.id,
    "aria-describedby": field?.describedBy,
    "aria-invalid": field?.invalid || undefined,
    autoFocus,
    "data-autofocus": autoFocus ? "" : undefined,
  };
}

export function Field({
  id: explicitId,
  label,
  hint,
  error,
  optional = false,
  children,
}: {
  id?: string;
  label: string;
  hint?: string;
  error?: string;
  optional?: boolean;
  children: ReactNode;
}) {
  const generatedId = useId();
  const id = explicitId ?? generatedId;
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy =
    [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(" ") ||
    undefined;
  return (
    <div className={error ? "field field-invalid" : "field"}>
      <label className="field-label" htmlFor={id}>
        {label}
        {optional ? <span className="field-optional">Optional</span> : null}
      </label>
      <FieldContext value={{ id, describedBy, invalid: Boolean(error) }}>
        {children}
      </FieldContext>
      {hint ? (
        <small className="field-hint" id={hintId}>
          {hint}
        </small>
      ) : null}
      {error ? <FieldError id={errorId}>{error}</FieldError> : null}
    </div>
  );
}

export function TextInput({
  className,
  autoFocus,
  ...props
}: ComponentPropsWithoutRef<"input">) {
  const wiring = useFieldProps(autoFocus);
  return (
    <input
      type="text"
      {...wiring}
      {...props}
      className={classes("field-control", className)}
    />
  );
}

export type DateInputProps = Omit<ComponentPropsWithoutRef<"input">, "type"> & {
  onValueChange?: (iso: string) => void;
};

// Local-date aware by construction: a native date control shows the user's
// own calendar format and always hands back YYYY-MM-DD, the shape every
// date in the workspace is stored in (app/lib/dates.ts ISO_DATE_PATTERN).
export function DateInput({
  className,
  autoFocus,
  onChange,
  onValueChange,
  value,
  defaultValue,
  ...props
}: DateInputProps) {
  const wiring = useFieldProps(autoFocus);
  useEffect(() => {
    if (process.env.NODE_ENV === "production") return;
    for (const candidate of [value, defaultValue]) {
      if (candidate === undefined || candidate === "") continue;
      if (!ISO_DATE_PATTERN.test(String(candidate))) {
        console.error(
          `DateInput expects an ISO calendar date (YYYY-MM-DD), got ${JSON.stringify(candidate)}`,
        );
      }
    }
  }, [value, defaultValue]);
  return (
    <input
      type="date"
      {...wiring}
      value={value}
      defaultValue={defaultValue}
      onChange={(event) => {
        onChange?.(event);
        onValueChange?.(event.currentTarget.value);
      }}
      {...props}
      className={classes("field-control", "field-control-mono", className)}
    />
  );
}

export type SelectProps = Omit<ComponentPropsWithoutRef<"select">, "children"> & {
  options: SelectOption[] | SelectGroup[];
  placeholder?: string;
  // Defaults to `countOptions(options) >= SEARCHABLE_OPTION_COUNT`.
  searchable?: boolean;
  searchLabel?: string;
  searchPlaceholder?: string;
  // Controlled search text; absent, the primitive owns it.
  query?: string;
  onQueryChange?: (query: string) => void;
};

// A native <select> — role combobox, name/required/FormData and the phone's
// own picker intact — that grows a search input in front of it once it holds
// SEARCHABLE_OPTION_COUNT options. The search narrows the options in place
// and reports the count in a polite live region; the choice belongs to the
// caller, which clears it when the query changes if that is what it wants.
export function Select({
  options,
  placeholder,
  searchable,
  searchLabel,
  searchPlaceholder,
  query: controlledQuery,
  onQueryChange,
  className,
  autoFocus,
  id,
  ...props
}: SelectProps) {
  const field = useContext(FieldContext);
  const generatedId = useId();
  const selectId = id ?? field?.id ?? generatedId;
  const [ownQuery, setOwnQuery] = useState("");
  const query = controlledQuery ?? ownQuery;
  const withSearch = searchable ?? countOptions(options) >= SEARCHABLE_OPTION_COUNT;
  const visible = withSearch ? filterOptions(options, query) : options;
  const visibleCount = countOptions(visible);
  const entries: Array<SelectOption | SelectGroup> = visible;
  // In a searchable select the SEARCH input is what autoFocus lands on.
  const wiring = useFieldProps(withSearch ? undefined : autoFocus);

  const select = (
    <select
      {...wiring}
      {...props}
      id={selectId}
      className={classes("field-control", className)}
    >
      {placeholder !== undefined ? <option value="">{placeholder}</option> : null}
      {entries.map((entry) =>
        "options" in entry ? (
          <optgroup key={entry.label} label={entry.label}>
            {entry.options.map((option) => (
              <option key={option.value} value={option.value} disabled={option.disabled}>
                {option.label}
              </option>
            ))}
          </optgroup>
        ) : (
          <option key={entry.value} value={entry.value} disabled={entry.disabled}>
            {entry.label}
          </option>
        ),
      )}
    </select>
  );

  if (!withSearch) return select;
  return (
    <div className="select-search">
      <input
        type="search"
        className="field-control"
        aria-label={searchLabel ?? "Search options"}
        aria-controls={selectId}
        aria-describedby={field?.describedBy}
        placeholder={searchPlaceholder}
        value={query}
        autoFocus={autoFocus}
        data-autofocus={autoFocus ? "" : undefined}
        onChange={(event) => {
          const next = event.currentTarget.value;
          setOwnQuery(next);
          onQueryChange?.(next);
        }}
      />
      {select}
      <small className="select-search-count" aria-live="polite">
        {visibleCount} {visibleCount === 1 ? "match" : "matches"}
      </small>
    </div>
  );
}

export type CheckboxProps = Omit<ComponentPropsWithoutRef<"input">, "type"> & {
  label: ReactNode;
  description?: ReactNode;
};

// A visible native checkbox (accent-color, no opacity-0 proxy): the platform
// draws its state, so forced colours keep it legible by construction
// (a11y-M-01). `className` dresses the row, the input keeps its own class.
export function Checkbox({
  label,
  description,
  id,
  autoFocus,
  className,
  ...input
}: CheckboxProps) {
  const generatedId = useId();
  const inputId = id ?? generatedId;
  return (
    <label className={classes("checkbox", className)} htmlFor={inputId}>
      <input
        type="checkbox"
        autoFocus={autoFocus}
        data-autofocus={autoFocus ? "" : undefined}
        {...input}
        id={inputId}
      />
      <span>
        <span className="checkbox-label">{label}</span>
        {description ? (
          <span className="checkbox-description">{description}</span>
        ) : null}
      </span>
    </label>
  );
}

// Inline, linked by aria-describedby from the Field — deliberately NOT a live
// region: one alert per field would announce repeatedly and out of order.
export function FieldError({ id, children }: { id?: string; children: ReactNode }) {
  return (
    <small className="field-error" id={id}>
      {children}
    </small>
  );
}

export type ErrorSummaryEntry = { fieldId?: string; message: string };

// The persistent error summary: rendered only while there are errors, so an
// empty alert never shadows another one in the same dialog; it takes focus
// and scrolls into view when its messages change, because a phone sheet is
// usually already scrolled to the submit row that produced them. Entries with
// a fieldId link to the field (looked up by id — useId() values are not
// selector-safe). It stays until its owner clears the errors; nothing here
// auto-dismisses.
export function ErrorSummary({
  title,
  errors,
}: {
  title?: string;
  errors: ReadonlyArray<ErrorSummaryEntry>;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const announcement = errors.map((entry) => entry.message).join("\n");

  useEffect(() => {
    if (!announcement) return;
    const node = ref.current;
    if (!node) return;
    node.scrollIntoView({ block: "center" });
    node.focus({ preventScroll: true });
  }, [announcement]);

  if (errors.length === 0) return null;

  const focusField =
    (fieldId: string) => (event: MouseEvent<HTMLAnchorElement>) => {
      const target = document.getElementById(fieldId);
      if (!target) return;
      event.preventDefault();
      target.focus();
    };

  return (
    <div className="error-summary" role="alert" tabIndex={-1} ref={ref}>
      <strong>{title ?? "Check the form"}</strong>
      <ul>
        {errors.map((entry, index) => (
          <li key={`${entry.fieldId ?? ""}:${index}`}>
            {entry.fieldId ? (
              <a href={`#${entry.fieldId}`} onClick={focusField(entry.fieldId)}>
                {entry.message}
              </a>
            ) : (
              entry.message
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

// The seven `<ModalError title message />` sites in app/ITrackApp.tsx keep
// their shape; this is the same summary with one entry and no field link.
export function ModalError({ title, message }: { title: string; message: string }) {
  return <ErrorSummary title={title} errors={[{ message }]} />;
}
