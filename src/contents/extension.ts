import type { PlasmoCSConfig } from "plasmo";
import type { ExtensionExternalRequest, ExtensionExternalResponse } from "~types/external";

export const config: PlasmoCSConfig = {
  matches: ["<all_urls>"],
  run_at: "document_start",
};

// Hardcoded whitelist: only local development origins are trusted
const ALLOWED_ORIGINS = ["localhost", "127.0.0.1"];

function getRightAction(action: string) {
  if (action.startsWith("MUTLIPOST")) {
    return action.replace(/^MUTLIPOST/, "MULTIPOST");
  }
  return action;
}

function isOriginTrusted(origin: string): boolean {
  return ALLOWED_ORIGINS.some((allowed) => origin === allowed);
}

window.addEventListener("message", async (event) => {
  const request: ExtensionExternalRequest<unknown> = event.data;

  if (request.type !== "request" || !getRightAction(request.action).startsWith("MULTIPOST")) {
    return;
  }

  // 验证来源是否可信
  const isTrusted = isOriginTrusted(new URL(event.origin).hostname);
  if (!isTrusted) {
    event.source.postMessage({
      type: "response",
      traceId: request.traceId,
      action: request.action,
      code: 403,
      message: "Untrusted origin",
      data: null,
    } as ExtensionExternalResponse<null>);
    return;
  }

  defaultHandler(request, event);
});

function defaultHandler<T>(request: ExtensionExternalRequest<T>, event: MessageEvent) {
  const newRequest = {
    ...request,
    action: getRightAction(request.action),
  };

  chrome.runtime.sendMessage(newRequest).then((response) => {
    event.source.postMessage(successResponse(request, response));
  });
}

function successResponse<T>(request: ExtensionExternalRequest<T>, data: T) {
  return {
    type: "response",
    traceId: request.traceId,
    action: request.action,
    code: 0,
    message: "success",
    data,
  } as ExtensionExternalResponse<T>;
}
