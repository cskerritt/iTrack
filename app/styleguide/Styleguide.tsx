"use client";

import { useEffect, useState } from "react";
import { Button } from "../components/Button";
import { Icon } from "../components/Icon";
import { Modal } from "../components/Modal";

// The styleguide root is a page root like the app shell's: it carries
// data-app-root so an open dialog makes it inert (the Modal contract), and
// its samples are mounted with `&&`, never `? (`, so the handleSessionEnded
// guard in tests/app-source-guards.test.mjs does not count them as app
// dialogs. Later tasks append sections in this shape: Form (Task 7), Toast
// (Task 8), Instruments (Task 11), Empty states and errors (Task 12); Task 9
// swaps the <h1> for PageHeader.
export function Styleguide() {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [secondOpen, setSecondOpen] = useState(false);
  useEffect(() => {
    document.title = "Styleguide · iTrack";
  }, []);

  return (
    <div className="app-root" data-app-root>
      <main id="main-content" className="styleguide">
        <h1>Styleguide</h1>
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
      </main>
    </div>
  );
}
