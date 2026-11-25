export function reportAsync(promise: Promise<unknown>, report: (error: unknown) => void): void {
  promise.catch(report);
}
