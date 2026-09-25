# Per-message model identity

Open **Model details** below an assistant message's model label. In Simplified
Chinese the two rows are exactly:

```text
所选模型 ID：xxx
服务端返回 ID：yyy
```

The existing friendly model label is unchanged. These rows show raw IDs: they
never substitute a configured nickname, remove a provider namespace, or change
case. The disclosure supports keyboard/touch interaction and all three UI
languages. Long values wrap instead of extending beyond the viewport.

## Meaning and limitations

- **Selected model ID** is a snapshot of the model passed to the agent's stream
  function for that particular provider call. Changing the current model does
  not relabel previous replies. It is the selection, **not** a claim that an
  extension, sampling override, or gateway did not rewrite the outgoing payload.
- **Server-returned ID** is the provider response's reported model value. It is
  recorded even when equal to the selected ID. If multiple nonempty IDs occur
  during a stream, the last reported value wins. Missing/non-string values and
  empty strings do not erase an earlier value.
- This is **self-reported provider/gateway metadata**, not verification of the
  underlying model. A gateway may return an alias, omit the value, or misreport it.
- Missing values show **Not recorded / 未记录 / 未記錄**. In particular, old
  messages are not backfilled from `message.model` or the current selection.
  Old `responseModel` values that were actually recorded remain displayable.
- While streaming, a value can remain unrecorded until a later response event.
  Errors/aborts preserve metadata already received. Requests failing before the
  SDK produces a message may have no recorded selection.
- The feature does not rewrite existing sessions, make verification requests,
  change provider routing/transports, or change Token/cost accounting.

## Capture and persistence

`lib/model-identity-capture.ts` wraps each Web agent's existing SDK
`streamFunction`, retaining its auth, payload hooks, retry policy and transport.
It snapshots `{ version: 1, selectedModelId, selectedProvider }` in
`message.modelIdentity` before asynchronous request preparation. Streaming events
and `.result()` both carry the snapshot. Provider-owned messages are not mutated,
and mutable provider partials are not cached by identity. The local selection
annotation is stripped from subsequent provider-bound context copies (including
Pi Messages' full-context payload), without mutating stored history.

The SDK's native `message.responseModel` carries the raw returned ID. Agent-core
retains the additional selection metadata; the SDK session manager stores the
entire assistant message in JSONL. Web normalization/history readers already
preserve it. Thus live SSE, reconciliation, refresh, server restart, branches,
and forks can retain the same per-message values.

### Pinned SDK compatibility patch

Stock `@earendil-works/pi-ai@0.85.1` does not retain every response model:
Chat Completions only records a differing ID, Anthropic overwrites `model`, and
Responses omits its reported model entirely. A frontend-only change cannot
recover that data.

`bin/prepare-model-identity.mjs`, run by `npm ci`/`npm install`'s `postinstall`,
applies the small metadata-only transformations in
`bin/model-identity-patches.json`:

| Adapter | Raw field captured |
| --- | --- |
| OpenAI Chat Completions and compatible gateways | `chunk.model` |
| Anthropic Messages | `message_start.message.model` |
| OpenAI Responses / Azure Responses / Codex Responses | `event.response.model` |
| Google Generative AI / Vertex | `chunk.modelVersion` |

Codex SSE and WebSocket use the same Responses handler; no transport is forced.
Other/custom adapters can display an existing native `responseModel`, but this
patch adds no capture for Bedrock, Mistral Conversations, or Pi Messages. A missing
returned value remains unrecorded; the requested model is never substituted.
Anthropic's existing accounting/fallback `model` behavior is deliberately retained.

Both the application's direct SDK dependency and any nested SDK copy used by
`pi-coding-agent` / `pi-agent-core` are discovered. The lockfile can install two
identical `pi-ai` copies; patching only the top-level one is insufficient for RPC.
All copies' versions and original SHA-256 hashes are validated before any file is
written. Exact already-patched files are accepted, so installation is idempotent.
Unexpected versions/content fail installation rather than being patched loosely.
Future SDK upgrades must explicitly review/update this compatibility patch.

If lifecycle scripts were disabled, prepare dependencies manually **in an inactive,
independent installation**, before running/building the application:

```bash
node bin/prepare-terminal.js
node bin/prepare-model-identity.mjs
node bin/prepare-model-identity.mjs --check
```

Do not edit a running service's `node_modules` or share dependency directories with
it. This feature does not upgrade the SDK or the v0.9.1 application baseline.

## Validation

```bash
node bin/prepare-model-identity.mjs --check
node --experimental-strip-types --test lib/model-identity*.test.mjs components/MessageView.test.mjs
node_modules/.bin/tsc --noEmit
npm run lint
npm test
# Requires a free .next/dev directory; launches its own isolated Turbopack server.
node e2e/model-identity.mjs
```

Provider tests use synthetic HTTP/SSE data and a loopback WebSocket server, not
paid APIs. They cover equal/different/missing/invalid IDs, terminal-only values,
errors, incomplete streams, model switching, interleaved calls, persistence,
legacy messages and strict patch guards. The browser harness uses disposable
HOME/agent/session directories, no production credentials, and no inherited
provider proxy settings. It checks live SDK → RPC → SSE → UI data and actual JSONL
readback/restart, desktop/mobile, keyboard operation and localized raw IDs.

An optional **synthetic-only** preview can be started in a separate checkout:

```bash
MODEL_IDENTITY_PREVIEW=1 MODEL_IDENTITY_PREVIEW_PORT=30144 node e2e/model-identity.mjs
```

It prints a loopback URL, uses mock models, and stays running until Ctrl+C. It
never reuses an existing dev lock or targets another Pi Web service.
