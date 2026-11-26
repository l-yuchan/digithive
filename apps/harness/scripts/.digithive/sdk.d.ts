/**
 * Type-only stand-in for the generated script SDK in `scripts/.digithive/sdk.ts`.
 *
 * The real module is written at startup and is never tracked, so a fresh checkout has
 * nothing there for typecheck and lint to read. TypeScript takes the exact `.ts` over
 * this file whenever the generated module exists, so this shape is what a checkout
 * without one is checked against.
 */
export declare const sdk: {
  readonly context: () => Promise<{
    readonly runId: string;
    readonly workflowTitle: string | null;
    readonly params: Record<string, unknown>;
  }>;
  readonly memory: { readonly recall: (query: string) => Promise<unknown> };
};
export default sdk;
