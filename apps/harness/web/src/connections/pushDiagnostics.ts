/** Helpers for the browser push setup flow: activation waiting, diagnostics, subscription reuse. */

export interface PushErrorDetails {
  name: string;
  message: string;
  stack: string | null;
  cause: string | null;
}

export interface BrowserInfo {
  userAgent: string;
  platform: string;
  languages: string;
  secureContext: boolean;
  href: string;
}

export interface NavigatorView {
  readonly userAgent: string;
  readonly platform: string;
  readonly languages: readonly string[];
}

export interface WorkerView {
  readonly state: string;
  addEventListener(type: "statechange", listener: () => void): void;
  removeEventListener(type: "statechange", listener: () => void): void;
}

export interface WorkerControllerView {
  readonly state: string;
}

export interface RegistrationView {
  readonly scope: string;
  readonly installing: WorkerView | null;
  readonly waiting: WorkerView | null;
  readonly active: WorkerView | null;
}

export interface WorkerSnapshot {
  registration: boolean;
  scope: string | null;
  installing: string | null;
  waiting: string | null;
  active: string | null;
  controller: string | null;
}

export interface SubscriptionLike {
  toJSON(): unknown;
}

export interface PushManagerView<Subscription extends SubscriptionLike> {
  getSubscription(): Promise<Subscription | null>;
  subscribe(options: PushSubscriptionOptionsInit): Promise<Subscription>;
}

export class ServiceWorkerActivationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ServiceWorkerActivationError";
  }
}

function toText(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  if (typeof value === "symbol") return value.toString();
  if (typeof value === "function") return `[function ${value.name || "anonymous"}]`;
  return Object.prototype.toString.call(value);
}

function describeCause(cause: unknown): string | null {
  if (cause === undefined || cause === null) return null;
  if (cause instanceof Error) return `${cause.name}: ${cause.message}`;
  if (typeof cause === "string") return cause;
  try {
    return JSON.stringify(cause) ?? toText(cause);
  } catch {
    return toText(cause);
  }
}

export function describeError(error: unknown): PushErrorDetails {
  if (error === null || typeof error !== "object") {
    return { name: typeof error, message: toText(error), stack: null, cause: null };
  }
  const record: { name?: unknown; message?: unknown; stack?: unknown; cause?: unknown } = error;
  return {
    name: typeof record.name === "string" ? record.name : "Error",
    message: typeof record.message === "string" ? record.message : toText(error),
    stack: typeof record.stack === "string" ? record.stack : null,
    cause: describeCause(record.cause),
  };
}

export function describeBrowserInfo(
  nav: NavigatorView = navigator,
  href: string = window.location.href,
  secureContext: boolean = window.isSecureContext,
): BrowserInfo {
  return {
    userAgent: nav.userAgent,
    platform: nav.platform,
    languages: nav.languages.join(", "),
    secureContext,
    href,
  };
}

export function describeWorkers(
  registration: RegistrationView | null,
  controller: WorkerControllerView | null,
): WorkerSnapshot {
  return {
    registration: registration !== null,
    scope: registration?.scope ?? null,
    installing: registration?.installing?.state ?? null,
    waiting: registration?.waiting?.state ?? null,
    active: registration?.active?.state ?? null,
    controller: controller?.state ?? null,
  };
}

/**
 * Resolves once the registration has an activated worker. `register()` only starts installation, so
 * subscribing immediately can hit a registration whose worker is still installing or activating.
 */
export function waitForActiveWorker<Registration extends RegistrationView>(
  registration: Registration,
  timeoutMs = 15_000,
): Promise<Registration> {
  const worker =
    registration.active?.state === "activating"
      ? registration.active
      : (registration.installing ?? registration.waiting ?? registration.active);
  if (worker === null) {
    return Promise.reject(
      new ServiceWorkerActivationError(
        "서비스 워커가 등록되지 않았습니다 (installing/waiting/active 없음)",
      ),
    );
  }
  if (registration.active?.state === "activated") return Promise.resolve(registration);

  return new Promise<Registration>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      finish(() =>
        reject(
          new ServiceWorkerActivationError(
            `서비스 워커 활성화 대기 시간 초과 (마지막 상태: ${worker.state})`,
          ),
        ),
      );
    }, timeoutMs);
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.removeEventListener("statechange", onChange);
      action();
    };
    const onChange = () => {
      if (worker.state === "activated") {
        finish(() => resolve(registration));
      } else if (worker.state === "redundant") {
        finish(() =>
          reject(
            new ServiceWorkerActivationError(
              "서비스 워커가 redundant 상태가 되어 활성화에 실패했습니다",
            ),
          ),
        );
      }
    };
    worker.addEventListener("statechange", onChange);
    onChange();
  });
}

/** Reuses an existing push subscription so repeat clicks do not create extra subscriptions. */
export async function resolvePushSubscription<Subscription extends SubscriptionLike>(
  pushManager: PushManagerView<Subscription>,
  options: PushSubscriptionOptionsInit,
): Promise<{ subscription: Subscription; reused: boolean }> {
  const existing = await pushManager.getSubscription();
  if (existing !== null) return { subscription: existing, reused: true };
  return { subscription: await pushManager.subscribe(options), reused: false };
}
