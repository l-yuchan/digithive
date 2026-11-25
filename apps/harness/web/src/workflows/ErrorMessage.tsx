export function ErrorMessage({
  title,
  error,
  testId,
}: {
  readonly title: string;
  readonly error: string;
  readonly testId?: string;
}) {
  return (
    <div className="error-card" role="alert" data-testid={testId}>
      <p className="error">{title}</p>
      <pre className="error-detail">{error}</pre>
    </div>
  );
}
