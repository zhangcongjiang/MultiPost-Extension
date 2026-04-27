import { Storage } from "@plasmohq/storage";

const storage = new Storage({ area: "local" });

export const trustDomainMessageHandler = async (request, _sender, sendResponse) => {
  // 获取信任域名列表
  if (request.action === "MULTIPOST_EXTENSION_GET_TRUSTED_DOMAINS") {
    const trustedDomains = (await storage.get<Array<{ id: string; domain: string }>>("trustedDomains")) || [];
    return sendResponse({ trustedDomains });
  }

  // 删除特定信任域名
  if (request.action === "MULTIPOST_EXTENSION_DELETE_TRUSTED_DOMAIN") {
    const { domainId } = request.data;

    if (!domainId) {
      return sendResponse({ success: false, message: "缺少域名ID" });
    }

    const trustedDomains = (await storage.get<Array<{ id: string; domain: string }>>("trustedDomains")) || [];
    const updatedDomains = trustedDomains.filter((item) => item.id !== domainId);

    await storage.set("trustedDomains", updatedDomains);
    return sendResponse({ success: true, trustedDomains: updatedDomains });
  }

  if (request.action === "MULTIPOST_EXTENSION_REQUEST_TRUST_DOMAIN") {
    // Trust domain is now managed by hardcoded whitelist in extension.ts
    // Always return trusted: true here since the content script already handles the check
    return sendResponse({ trusted: true });
  }
};
