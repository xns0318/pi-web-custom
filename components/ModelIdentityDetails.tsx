"use client";

import { useI18n } from "@/hooks/useI18n";
import { getMessageModelIdentity } from "@/lib/model-identity";
import type { AssistantMessage } from "@/lib/types";

export function ModelIdentityDetails({ message }: { message: AssistantMessage }) {
  const { t } = useI18n();
  const { selectedModelId, responseModelId } = getMessageModelIdentity(message);
  const missing = t("chat.modelIdNotRecorded");
  return (
    <details className="message-model-details">
      <summary>{t("chat.modelDetails")}</summary>
      <div className="message-model-details-body">
        <div className="message-model-id" data-model-id="selected">
          {t("chat.selectedModelId", { id: selectedModelId ?? missing })}
        </div>
        <div className="message-model-id" data-model-id="response">
          {t("chat.responseModelId", { id: responseModelId ?? missing })}
        </div>
        <div className="message-model-details-note">{t("chat.modelIdCaveat")}</div>
      </div>
    </details>
  );
}
