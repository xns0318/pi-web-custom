import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, AssistantMessageEvent } from "@earendil-works/pi-ai";
import type { ModelIdentity } from "./types";

/** Capture the selected model once per provider call, not from mutable session/UI state. */
export function withModelIdentity(streamFunction: StreamFn): StreamFn {
  return async (model, context, options) => {
    const modelIdentity: ModelIdentity = {
      version: 1,
      selectedModelId: model.id,
      selectedProvider: model.provider,
    };
    // Keep our local annotation out of future provider payloads, including APIs
    // such as pi-messages that serialize the full context. Leave stored history intact.
    let changed = false;
    const messages = context.messages.map((message) => {
      if (message.role !== "assistant" || !("modelIdentity" in message)) return message;
      changed = true;
      const clean = { ...message } as AssistantMessage & { modelIdentity?: unknown };
      delete clean.modelIdentity;
      return clean;
    });
    // Keep the original SDK provider/auth/payload/retry/transport pipeline intact.
    const stream = await streamFunction(model, changed ? { ...context, messages } : context, options);
    const result = stream.result.bind(stream);
    const iterate = stream[Symbol.asyncIterator].bind(stream);
    const decorate = (message: AssistantMessage) => ({ ...message, modelIdentity });

    stream.result = async () => decorate(await result());
    stream[Symbol.asyncIterator] = async function* () {
      for await (const event of { [Symbol.asyncIterator]: iterate }) {
        // Decorate AFTER the SDK creates its frames (which whitelist metadata).
        // Never cache by object identity: some providers reuse mutable partials.
        const decorated: AssistantMessageEvent = event.type === "done"
          ? { ...event, message: decorate(event.message) }
          : event.type === "error"
            ? { ...event, error: decorate(event.error) }
            : { ...event, partial: decorate(event.partial) };
        yield decorated;
      }
    };
    return stream;
  };
}

export function installModelIdentityCapture(agent: { streamFunction?: StreamFn } | undefined): void {
  if (agent?.streamFunction) {
    agent.streamFunction = withModelIdentity(agent.streamFunction.bind(agent));
  }
}
