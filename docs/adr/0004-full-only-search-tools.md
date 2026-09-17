# Expose search tools only in the Full preset

For normal Pi Web sessions, `web_search` and `url_context` are Full-only extension
tools. Default, Read-only, and Chat only must not expose their schemas or active
tool prompt snippets. Other extension tools retain their existing behavior.
`url_context` additionally requires the `google-generative-ai` API/provider,
matching pi-web-search's Gemini-only check. Full never creates tools that are not
registered by an installed/enabled extension.

The preset arrays and version-1 `pi-web:tool-selection` entries remain builtin-only
(see [0002](0002-chat-only-tool-selection.md)). Search names must not be inserted
into `PRESET_FULL`: that would change preset inference and persisted validation.
Legacy sessions infer their initial selection from the SDK's active builtins.
Subagents keep their profile/resourceSnapshot policy, independent of Web presets.

`lib/search-tool-policy.ts` wraps the normal session's final
`setActiveToolsByName` operation before extensions are bound. SDK registry
refreshes and extension `setActiveTools` calls use that same setter. Filtering only
`withExtensionTools` would be insufficient: session/model events and dynamic
registration could enable search again. The selected preset, rather than an
extension's proposed tool list, determines whether search is allowed.

Model and tree changes reconcile only the registered search tools, so Full can
activate URL Context when switching to Gemini even if it was previously absent.
This reconciliation does not reactivate ordinary extensions that intentionally
turned themselves off. Both RPC reload and extension-command reload preserve the
selection and pass through the same final policy. SDK setters rebuild the prompt;
Pi Web does not edit prompt strings or provider payloads to hide tool names.

Tests cover the pure policy and real SDK startup, model events, both reload paths,
dynamic registration, transitions, absent packages, and unaffected profile-based
wrappers. Deployment also checks the Web APIs and actual provider requests.

This is a tool exposure policy, not a security sandbox or a network prohibition.
Default still has `bash`, and installed extensions execute with host permissions.
