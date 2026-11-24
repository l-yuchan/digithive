import { useState } from "react";
import { postJson } from "../api";

export function Login({ onDone }: { onDone: () => void }) {
  const [passphrase, setPassphrase] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (passphrase.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      await postJson("/api/login", { passphrase });
      onDone();
    } catch {
      setError("패스프레이즈가 올바르지 않습니다.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login">
      <h1>digithive</h1>
      <p className="login-hint">패스프레이즈를 입력하세요.</p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <input
          type="password"
          data-testid="passphrase"
          value={passphrase}
          autoFocus
          onChange={(event) => setPassphrase(event.target.value)}
          placeholder="패스프레이즈"
        />
        <button className="primary" type="submit" data-testid="login-submit" disabled={busy}>
          들어가기
        </button>
      </form>
      {error ? (
        <p className="error" role="alert" data-testid="login-error">
          {error}
        </p>
      ) : null}
    </div>
  );
}
