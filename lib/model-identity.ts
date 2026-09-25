import type { AssistantMessage } from "./types";

function rawId(value: unknown): string | null {
  // Validate, but never strip namespaces, change case, or substitute nicknames.
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

export function getMessageModelIdentity(message: Pick<AssistantMessage, "modelIdentity" | "responseModel">) {
  return {
    selectedModelId: message.modelIdentity?.version === 1
      ? rawId(message.modelIdentity.selectedModelId)
      : null,
    responseModelId: rawId(message.responseModel),
  };
}
