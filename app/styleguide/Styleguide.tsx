"use client";

import { useState } from "react";
import { Button } from "../components/Button";
import { useToast } from "../components/Toast";
import { Icon } from "../components/Icon";
import { Modal } from "../components/Modal";
import { PageHeader } from "../components/PageHeader";
import {
  Checkbox,
  DateInput,
  ErrorSummary,
  Field,
  Select,
  TextInput,
} from "../components/Form";
import type { SelectOption } from "../lib/selectFilter";

// The styleguide root is a page root like the app shell's: it carries
// data-app-root so an open dialog makes it inert (the Modal contract), and
// its samples are mounted with `&&`, never `? (`, so the handleSessionEnded
// guard in tests/app-source-guards.test.mjs does not count them as app
// dialogs. Later tasks append sections in this shape: Form (Task 7), Toast
// (Task 8), Instruments (Task 11), Empty states and errors (Task 12); Task 9
// swaps the <h1> for PageHeader.
// Fourteen entries: past SEARCHABLE_OPTION_COUNT, so the Select grows its
// search input. Sample data for the styleguide only.
const PROFESSIONS: SelectOption[] = [
  { value: "counseling", label: "Counseling" },
  { value: "dentistry", label: "Dentistry" },
  { value: "ems", label: "Emergency medical services" },
  { value: "life-care-planning", label: "Life care planning" },
  { value: "nursing", label: "Nursing" },
  { value: "occupational-therapy", label: "Occupational therapy" },
  { value: "pharmacy", label: "Pharmacy" },
  { value: "physical-therapy", label: "Physical therapy" },
  { value: "psychology", label: "Psychology" },
  { value: "rehabilitation-counseling", label: "Rehabilitation counseling" },
  { value: "respiratory-therapy", label: "Respiratory therapy" },
  { value: "social-work", label: "Social work" },
  { value: "speech-language-pathology", label: "Speech-language pathology" },
  { value: "vocational-evaluation", label: "Vocational evaluation" },
];

export function Styleguide() {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [secondOpen, setSecondOpen] = useState(false);
  const [formErrors, setFormErrors] = useState<{ name?: string }>({});
  const toast = useToast();

  return (
    <div className="app-root" data-app-root>
      <main id="main-content" className="styleguide">
        <PageHeader title="Styleguide" documentTitle="Styleguide · iTrack" />
        <section aria-labelledby="sg-buttons">
          <h2 id="sg-buttons">Buttons</h2>
          <Button variant="primary">Primary</Button>
          <Button>Secondary</Button>
          <Button variant="quiet">Quiet</Button>
          <Button variant="destructive">Destructive</Button>
          <Button variant="primary" size="sm">
            Small
          </Button>
          <Button variant="primary" pending pendingLabel="Saving…">
            Save
          </Button>
          <Button disabled>Disabled</Button>
          <Button variant="primary" icon={<Icon name="plus" size={16} />}>
            Log activity
          </Button>
        </section>
        <section aria-labelledby="sg-modal">
          <h2 id="sg-modal">Modal</h2>
          <Button variant="primary" onClick={() => setDialogOpen(true)}>
            Open a dialog
          </Button>
          {dialogOpen && (
            <Modal
              title="Sample dialog"
              eyebrow="Styleguide"
              onClose={() => {
                setDialogOpen(false);
                setSecondOpen(false);
              }}
            >
              <form
                className="form-stack"
                onSubmit={(event) => event.preventDefault()}
              >
                <label className="field">
                  <span>Note</span>
                  <input name="note" type="text" autoFocus />
                </label>
                <div className="form-actions">
                  <Button onClick={() => setSecondOpen(true)}>
                    Open a second dialog
                  </Button>
                  <Button variant="quiet" onClick={() => setDialogOpen(false)}>
                    Cancel
                  </Button>
                </div>
              </form>
              {secondOpen && (
                <Modal title="Second dialog" onClose={() => setSecondOpen(false)}>
                  <p>Escape closes only this one.</p>
                </Modal>
              )}
            </Modal>
          )}
        </section>
        <section aria-labelledby="sg-form">
          <h2 id="sg-form">Form</h2>
          <form
            className="form-stack"
            noValidate
            onSubmit={(event) => {
              event.preventDefault();
              const name = String(
                new FormData(event.currentTarget).get("name") ?? "",
              ).trim();
              setFormErrors(name ? {} : { name: "Enter a name" });
            }}
          >
            <Field
              id="sg-name"
              label="Name"
              hint="As it appears on the certificate"
              error={formErrors.name}
            >
              <TextInput name="name" />
            </Field>
            <Field label="Completion date">
              <DateInput name="completionDate" defaultValue="2026-09-15" />
            </Field>
            <Field label="Profession">
              <Select
                name="profession"
                placeholder="Choose a profession"
                options={PROFESSIONS}
              />
            </Field>
            <Checkbox
              name="attest"
              label="I attest these dates are official"
              description="Required before a submission"
            />
            <ErrorSummary
              errors={
                formErrors.name
                  ? [{ fieldId: "sg-name", message: formErrors.name }]
                  : []
              }
            />
            <div className="form-actions">
              <Button type="submit" variant="primary">
                Save
              </Button>
            </div>
          </form>
        </section>
        <section aria-labelledby="sg-toast">
          <h2 id="sg-toast">Toast</h2>
          <Button onClick={() => toast.show({ message: "Sample notification" })}>
            Show a toast
          </Button>{" "}
          <Button
            onClick={() =>
              toast.show({
                message: "Sample action taken.",
                action: {
                  label: "Undo",
                  onClick: () => toast.show({ message: "Sample action undone." }),
                },
              })
            }
          >
            Show a toast with Undo
          </Button>
        </section>
      </main>
    </div>
  );
}
