import { describe, expect, test } from "bun:test";
import {
  describeBrowserInfo,
  describeError,
  describeWorkers,
  resolvePushSubscription,
  ServiceWorkerActivationError,
  waitForActiveWorker,
  type PushManagerView,
  type RegistrationView,
  type WorkerView,
} from "../web/src/connections/pushDiagnostics";

class FakeWorker implements WorkerView {
  state: string;
  private listeners: Array<() => void> = [];

  constructor(state: string) {
    this.state = state;
  }

  addEventListener(_type: "statechange", listener: () => void): void {
    this.listeners.push(listener);
  }

  removeEventListener(_type: "statechange", listener: () => void): void {
    this.listeners = this.listeners.filter((existing) => existing !== listener);
  }

  setState(state: string): void {
    this.state = state;
    this.listeners.forEach((listener) => listener());
  }

  listenerCount(): number {
    return this.listeners.length;
  }
}

async function captureFailure(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
    return null;
  } catch (error) {
    return error;
  }
}

function registration(overrides: Partial<RegistrationView> = {}): RegistrationView {
  return {
    scope: "https://digithive.example/",
    installing: null,
    waiting: null,
    active: null,
    ...overrides,
  };
}

describe("describeError", () => {
  test("keeps name, message, stack and cause", () => {
    const error = new Error("outer", { cause: new Error("inner") });
    const details = describeError(error);
    expect(details).toMatchObject({
      name: "Error",
      message: "outer",
      cause: "Error: inner",
    });
    expect(typeof details.stack).toBe("string");
  });

  test("reads DOMException fields", () => {
    const details = describeError(
      new DOMException("Error retrieving push subscription", "AbortError"),
    );
    expect(details.name).toBe("AbortError");
    expect(details.message).toBe("Error retrieving push subscription");
  });

  test("handles non-error values", () => {
    expect(describeError("boom")).toEqual({
      name: "string",
      message: "boom",
      stack: null,
      cause: null,
    });
  });
});

describe("describeWorkers", () => {
  test("reports lifecycle states and controller", () => {
    const snapshot = describeWorkers(
      registration({
        installing: new FakeWorker("installing"),
        waiting: null,
        active: new FakeWorker("activating"),
      }),
      new FakeWorker("activated"),
    );
    expect(snapshot).toEqual({
      registration: true,
      scope: "https://digithive.example/",
      installing: "installing",
      waiting: null,
      active: "activating",
      controller: "activated",
    });
  });

  test("marks unknown before registration", () => {
    expect(describeWorkers(null, null)).toEqual({
      registration: false,
      scope: null,
      installing: null,
      waiting: null,
      active: null,
      controller: null,
    });
  });
});

describe("describeBrowserInfo", () => {
  test("collects browser details from the supplied environment", () => {
    expect(
      describeBrowserInfo(
        { userAgent: "Firefox/140", platform: "Linux", languages: ["ko-KR", "en-US"] },
        "https://digithive.example/app2/",
        true,
      ),
    ).toEqual({
      userAgent: "Firefox/140",
      platform: "Linux",
      languages: "ko-KR, en-US",
      secureContext: true,
      href: "https://digithive.example/app2/",
    });
  });
});

describe("waitForActiveWorker", () => {
  test("resolves immediately when the worker is already activated", async () => {
    const worker = new FakeWorker("activated");
    const activeRegistration = registration({ active: worker });
    expect(await waitForActiveWorker(activeRegistration)).toBe(activeRegistration);
    expect(worker.listenerCount()).toBe(0);
  });

  test("waits for an installing worker to activate", async () => {
    const worker = new FakeWorker("installing");
    const pendingRegistration = registration({ installing: worker });
    const pending = waitForActiveWorker(pendingRegistration, 1_000);
    worker.setState("installed");
    worker.setState("activating");
    worker.setState("activated");
    expect(await pending).toBe(pendingRegistration);
    expect(worker.listenerCount()).toBe(0);
  });

  test("waits on the active worker while it is activating instead of a pending update", async () => {
    const active = new FakeWorker("activating");
    const installing = new FakeWorker("installed");
    const pendingRegistration = registration({ active, installing });
    const pending = waitForActiveWorker(pendingRegistration, 1_000);
    active.setState("activated");
    expect(await pending).toBe(pendingRegistration);
    expect(installing.listenerCount()).toBe(0);
  });

  test("rejects a redundant worker", async () => {
    const worker = new FakeWorker("installing");
    const pending = waitForActiveWorker(registration({ installing: worker }), 1_000);
    worker.setState("redundant");
    expect(await captureFailure(pending)).toBeInstanceOf(ServiceWorkerActivationError);
  });

  test("rejects with a timeout when activation stalls", async () => {
    const worker = new FakeWorker("installing");
    const failure = await captureFailure(
      waitForActiveWorker(registration({ installing: worker }), 5),
    );
    expect(failure).toBeInstanceOf(ServiceWorkerActivationError);
    expect(failure instanceof Error ? failure.message : "").toContain("활성화 대기 시간 초과");
    expect(worker.listenerCount()).toBe(0);
  });

  test("rejects when the registration has no worker", async () => {
    expect(await captureFailure(waitForActiveWorker(registration(), 5))).toBeInstanceOf(
      ServiceWorkerActivationError,
    );
  });
});

describe("resolvePushSubscription", () => {
  type FakeSubscription = { endpoint: string; toJSON: () => unknown };

  test("reuses an existing subscription without subscribing again", async () => {
    const existing: FakeSubscription = {
      endpoint: "https://push.example/1",
      toJSON: () => ({ endpoint: "https://push.example/1" }),
    };
    const manager: PushManagerView<FakeSubscription> = {
      getSubscription: async () => existing,
      subscribe: async () => {
        throw new Error("subscribe must not be called when a subscription exists");
      },
    };

    const result = await resolvePushSubscription(manager, { userVisibleOnly: true });
    expect(result.reused).toBe(true);
    expect(result.subscription).toBe(existing);
  });

  test("subscribes when no subscription exists", async () => {
    const created: FakeSubscription = {
      endpoint: "https://push.example/2",
      toJSON: () => ({ endpoint: "https://push.example/2" }),
    };
    const manager: PushManagerView<FakeSubscription> = {
      getSubscription: async () => null,
      subscribe: async (options) => {
        expect(options.userVisibleOnly).toBe(true);
        return created;
      },
    };

    const result = await resolvePushSubscription(manager, { userVisibleOnly: true });
    expect(result.reused).toBe(false);
    expect(result.subscription).toBe(created);
  });
});
