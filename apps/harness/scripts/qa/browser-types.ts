export type Locator = {
  fill(value: string | undefined): Promise<void>;
  click(): Promise<void>;
};
export type Page = {
  resolveSessionId(): Promise<string>;
  evaluate<T, A = undefined>(callback: (argument: A) => T, argument?: A): Promise<Awaited<T>>;
  goto(url: string, options: { waitUntil: "load" }): Promise<unknown>;
  reload(options: { waitUntil: "load" }): Promise<unknown>;
  locator(selector: string): Locator;
  screenshot(): Promise<Uint8Array>;
  cdp: { send(method: string, parameters: unknown, sessionId: string): Promise<unknown> };
};
export type NetworkSnoop = {
  waitFor(match: Record<string, unknown>, options: { timeoutMs: number }): Promise<unknown>;
  dispose(): void;
};
export type Routes = {
  route(
    pattern: string,
    handler: (route: {
      fulfill(options: { status: number; body: string }): Promise<unknown>;
    }) => Promise<unknown>,
  ): Promise<void>;
  dispose(): Promise<void>;
};
export type Browser = { newTab(url: string): Promise<Page>; close(): Promise<void> };
export type OmowrightApi = {
  connectPipe(options: {
    browserPath: string;
    browserArgs: readonly string[];
    storageRoot: string;
  }): Promise<Browser>;
  createNetworkSnoop(page: Page, options: { maxBodyBytes: number }): NetworkSnoop;
  emulate(page: Page, device: string | null): Promise<void>;
  createRoutes(page: Page): Routes;
};
export type OmowrightModule = { loadOmowright(): Promise<{ omowright: OmowrightApi }> };
