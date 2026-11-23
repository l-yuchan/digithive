# Task 7 evidence

The model adapter is an OpenAI-compatible Chat Completions client on `ky`
(pinned 2.2.0) with no built-in retry, an explicit timeout, and Zod validation
of the response shape. Provider errors are typed: `http`, `timeout`,
`malformed`, `truncated`. A `finish_reason: "length"` response is a failure,
never a partial success, so the caller keeps the charge as unknown.

The tool loop is bounded: at most 6 model steps, 8 tool calls, one reserved
paid request per step. Each provider call first reserves a month-scoped
maximum (`prompt chars / 3` estimated input plus the output token cap) and then
settles with real usage; a response without `usage` settles to `unknown`
instead of free. Cancellation is checked before each step, so a cancelled Run
stops without another paid call. Tool arguments are parsed as JSON, validated
against the tool's Zod schema, and gated on a declared scope; unknown tools,
bad JSON, extra fields and missing scopes produce a `tool_error` message to the
model and never invoke a handler.

Context assembly bounds the injected source text and labels every source with
its id. Citations are filtered to the ids actually provided, so a model cannot
cite a source it was never given.

Verification: `bun run verify` = strict typecheck, bundle, 30 tests. Mutation
proof: removing the truncation guard turned the truncation test red and was
restored byte for byte.

Real-surface QA (fixture provider over real HTTP at 127.0.0.1:4318/v1, live
app DB, real reservations):
- `agent-tool-roundtrip`: two model calls. The first returned a `read_note` tool
  call, which was validated, executed once (`noteReads: ["release-notes"]`),
  and its result appeared in the second request; the final answer cited the note
  content. Both paid calls settled with real usage.
  See `provider-http.json`, `run.json`.
- `agent-malformed-and-disconnect`: a batch of three tool calls (unknown tool,
  truncated JSON, extra argument) executed zero handlers and was reported back
  to the model as three failures. A `length`-truncated response failed the Run
  with one unknown charge. No `tool_calls` row was written and no side effect
  occurred. See `failures.json`.

Adversarial classes probed: malformed provider output, unsupported tool name,
argument injection/extra fields, missing scope, truncated stream, disconnected
provider, stale state (double settle refused), and unpriced usage (unknown).
Prompt-injection-through-tool-output and worker restart behave at the executor
boundary and are exercised in Tasks 10/20. Cleanup: QA ports rebound, temporary
DBs removed (`cleanup.json`).

Known limits: no live provider account was called, so the real model's tool-use
fidelity, current DeepInfra pricing and Korean answer quality remain unverified
until Task 25 (which records `NEEDS_SETUP` if credentials are absent). The
worker does not yet dispatch `agent`-kind Runs to this executor; Task 8 wires
conversation Runs to it.
