import { useState } from "react";
import { AccountsPanel } from "../connections/AccountsPanel";

/** The accounts part of the settings tab: what the 연결 tab used to show for accounts. */
export function AccountsSection() {
  // A key remounts the accounts panel after the panel reports a change, so its own
  // reading is the one on screen; the side-effect never runs during render.
  const [revision, setRevision] = useState(0);
  return (
    <div className="settings-part" data-testid="settings-accounts">
      <AccountsPanel key={revision} onChanged={() => setRevision((value) => value + 1)} />
    </div>
  );
}
