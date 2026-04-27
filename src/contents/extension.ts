import { Storage } from "@plasmohq/storage";
import type { PlasmoCSConfig } from "plasmo";
import type { ExtensionExternalRequest, ExtensionExternalResponse } from "~types/external";

export const config: PlasmoCSConfig = {
  matches: ["<all_urls>"],
  run_at: "document_start",
};

const storage = new Storage({ area: "local" });
const ALLOWED_ORIGINS = ["localhost", "127.0.0.1"];

function getRightAction(action: string) {
  if (action.startsWith("MUTLIPOST")) {
    return action.replace(/^MUTLIPOST/, "MULTIPOST");
  }
  return action;
}

function errorResponse<T>(request: ExtensionExternalRequest<T>, code: number, message: string) {
  return {
    type: "response",
    traceId: request.traceId,
    action: request.action,
    code,
    message,
    data: null,
  } as ExtensionExternalResponse<null>;
}

async function isOriginTrusted(origin: string): Promise<boolean> {
  try {
    const url = new URL(origin);
    if (ALLOWED_ORIGINS.includes(url.hostname)) {
      return true;
    }

    const trustedDomains = (await storage.get<Array<{ id: string; domain: string }>>("trustedDomains")) || [];
    return trustedDomains.some(({ domain }) => {
      if (!domain) {
        return false;
      }

      try {
        const trustedUrl = new URL(domain);
        return trustedUrl.origin === url.origin || trustedUrl.hostname === url.hostname;
      } catch {
        return domain === url.origin || domain === url.hostname;
      }
    });
  } catch {
    return false;
  }
}

function replyToPage<T>(event: MessageEvent, payload: ExtensionExternalResponse<T | null>) {
  if (!event.source || typeof (event.source as Window).postMessage !== "function") {
    return;
  }

  (event.source as Window).postMessage(payload, event.origin || "*");
}

window.addEventListener("message", async (event) => {
  const request: ExtensionExternalRequest<unknown> = event.data;
  const action = getRightAction(request.action || "");

  if (request.type !== "request" || !action.startsWith("MULTIPOST")) {
    return;
  }

  const isTrusted = await isOriginTrusted(event.origin);
  if (action === "MULTIPOST_EXTENSION_REQUEST_TRUST_DOMAIN") {
    replyToPage(event, successResponse(request, { trusted: isTrusted }));
    return;
  }

  if (action === "MULTIPOST_EXTENSION_CHECK_SERVICE_STATUS") {
    defaultHandler(request, event);
    return;
  }

  if (!isTrusted) {
    replyToPage(event, errorResponse(request, 403, "Untrusted origin"));
    return;
  }

  defaultHandler(request, event);
});

function defaultHandler<T>(request: ExtensionExternalRequest<T>, event: MessageEvent) {
  const newRequest = {
    ...request,
    action: getRightAction(request.action),
  };

  chrome.runtime
    .sendMessage(newRequest)
    .then((response) => {
      replyToPage(event, successResponse(request, response));
    })
    .catch((error) => {
      replyToPage(
        event,
        errorResponse(request, 500, error instanceof Error ? error.message : "Extension bridge error"),
      );
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
