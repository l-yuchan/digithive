import { useEffect, useState } from "react";
import { z } from "zod";
import { getJson } from "../api";
import { PushPanel } from "../connections/PushPanel";

const ConnectionsSchema = z.object({ pushConfigured: z.boolean() });

/** The notifications part of the settings tab: whether this device may receive briefings. */
export function PushSection() {
  // The shared push panel needs the server's answer for "is push configured at all".
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    void getJson("/api/connections", ConnectionsSchema)
      .then((body) => {
        if (!cancelled) setConfigured(body.pushConfigured);
      })
      .catch((error: unknown) => {
        if (!cancelled) setLoadError(error instanceof Error ? error.message : String(error));
      });
    return () => {
      cancelled = true;
    };
  }, []);
  return (
    <div className="settings-part" data-testid="settings-push">
      {loadError !== null ? (
        <p className="error" role="alert">
          알림 설정을 불러오지 못했습니다: {loadError}
        </p>
      ) : null}
      <PushPanel configured={configured} busy={busy} onBusy={setBusy} onMessage={setMessage} />
      {message ? (
        <p className="run-meta" role="status">
          {message}
        </p>
      ) : null}
    </div>
  );
}
