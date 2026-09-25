// Synthetic protocol fixtures only. No real credentials, sessions, or provider calls.
export const fixtureText = "Synthetic model identity reply.";
export const fixtureUsage = { input_tokens: 7, output_tokens: 3, total_tokens: 10 };

export function responseEvents(model, terminal = "completed") {
  const response = {
    id: "resp_fixture", object: "response", status: "in_progress",
    ...(model === undefined ? {} : { model }), output: [],
  };
  const item = { id: "msg_fixture", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: fixtureText, annotations: [] }] };
  return [
    { type: "response.created", response },
    { type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } },
    { type: "response.content_part.added", item_id: item.id, output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } },
    { type: "response.output_text.delta", item_id: item.id, output_index: 0, content_index: 0, delta: fixtureText },
    { type: "response.output_text.done", item_id: item.id, output_index: 0, content_index: 0, text: fixtureText },
    { type: "response.output_item.done", output_index: 0, item },
    { type: `response.${terminal}`, response: {
      ...response, status: terminal, output: [item], usage: fixtureUsage,
      ...(terminal === "incomplete" ? { incomplete_details: { reason: "max_output_tokens" } } : {}),
      ...(terminal === "failed" ? { error: { code: "server_error", message: "Fixture failure" } } : {}),
    } },
  ];
}

export function completionEvents(model) {
  const common = { id: "chat_fixture", object: "chat.completion.chunk", ...(model === undefined ? {} : { model }) };
  return [
    { ...common, choices: [{ index: 0, delta: { role: "assistant", content: fixtureText }, finish_reason: null }] },
    { ...common, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 } },
  ];
}

export function anthropicEvents(model) {
  return [
    { type: "message_start", message: { id: "msg_fixture", type: "message", role: "assistant", content: [], ...(model === undefined ? {} : { model }), usage: { input_tokens: 7, output_tokens: 0 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: fixtureText } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } },
    { type: "message_stop" },
  ];
}

export function googleEvents(model) {
  return [{
    responseId: "google_fixture", ...(model === undefined ? {} : { modelVersion: model }),
    candidates: [{ index: 0, content: { role: "model", parts: [{ text: fixtureText }] }, finishReason: "STOP" }],
    usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 3, totalTokenCount: 10 },
  }];
}

export const sseEvent = (event) => `${event.type ? `event: ${event.type}\n` : ""}data: ${JSON.stringify(event)}\n\n`;
export const sseBody = (events) => events.map(sseEvent).join("");
export const fixtureModel = (api, baseUrl = "http://127.0.0.1:1") => ({
  id: "selected-alias", name: "Friendly model nickname", provider: "fixture", api, baseUrl,
  reasoning: false, input: ["text"], contextWindow: 16384, maxTokens: 1024,
  cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
});
// The Codex adapter decodes this local fixture's account claim; no signed token is used.
export const fixtureCodexKey = `fixture.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fixture-account" } })).toString("base64url")}.fixture`;
