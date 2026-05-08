import { getAllAccountInfo } from "~sync/account";
import {
  type PublishTabsResultItem,
  // injectScriptsToTabs,
  type SyncData,
  createTabsForPlatforms,
  getPlatformInfos,
} from "~sync/common";
import QuantumEntanglementKeepAlive from "../utils/keep-alive";
import { linkExtensionMessageHandler, starter } from "./services/api";
import { initKeepAliveService, keepAliveMessageHandler } from "./services/keepalive";
import { initPublishAutoCloseService, publishAutoCloseMessageHandler } from "./services/publish-auto-close";
import {
  addTabsManagerMessages,
  tabsManagerHandleTabRemoved,
  tabsManagerHandleTabUpdated,
  tabsManagerMessageHandler,
} from "./services/tabs";
import { trustDomainMessageHandler } from "./services/trust-domain";

chrome.runtime.onInstalled.addListener((object) => {
  if (object.reason === chrome.runtime.OnInstalledReason.INSTALL) {
    chrome.tabs.create({ url: "https://multipost.app/on-install" });
  }
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false });
});

// Listen Message || 监听消息 || START
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  defaultMessageHandler(request, sender, sendResponse);
  tabsManagerMessageHandler(request, sender, sendResponse);
  trustDomainMessageHandler(request, sender, sendResponse);
  linkExtensionMessageHandler(request, sender, sendResponse);
  keepAliveMessageHandler(request, sender, sendResponse);
  publishAutoCloseMessageHandler(request, sender, sendResponse);
  return true;
});
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  tabsManagerHandleTabUpdated(tabId, changeInfo, tab);
});
chrome.tabs.onRemoved.addListener((tabId) => {
  tabsManagerHandleTabRemoved(tabId);
});
// Listen Message || 监听消息 || END

// Message Handler || 消息处理器 || START
interface PublishSession {
  syncData: SyncData;
  popupWindowId?: number;
}

const publishSessions = new Map<number, PublishSession>();
let isPublishInProgress = false;

function getSenderWindowId(sender: chrome.runtime.MessageSender): number | undefined {
  return sender.tab?.windowId;
}

const defaultMessageHandler = (request, sender, sendResponse) => {
  if (request.action === "MULTIPOST_EXTENSION_CHECK_SERVICE_STATUS") {
    sendResponse({ extensionId: chrome.runtime.id });
  }
  if (request.action === "MULTIPOST_EXTENSION_PUBLISH") {
    if (isPublishInProgress) {
      console.warn("发布任务正在执行中，拒绝新的发布请求");
      sendResponse({ error: "PUBLISH_IN_PROGRESS", message: "发布任务正在执行中，请稍后重试" });
      return;
    }
    isPublishInProgress = true;
    const data = request.data as SyncData;
    (async () => {
      try {
        const popupWindow = await chrome.windows.create({
          url: chrome.runtime.getURL("tabs/publish.html"),
          type: "popup",
          width: 800,
          height: 600,
        });
        if (popupWindow.id) {
          publishSessions.set(popupWindow.id, { syncData: data, popupWindowId: popupWindow.id });
        }
        sendResponse({ ok: true });
      } catch (error) {
        console.error("创建发布窗口失败:", error);
        isPublishInProgress = false;
        sendResponse({ error: "CREATE_WINDOW_FAILED", message: "创建发布窗口失败" });
      }
    })();
  }
  if (request.action === "MULTIPOST_EXTENSION_PLATFORMS") {
    getPlatformInfos().then((platforms) => {
      sendResponse({ platforms });
    });
  }
  if (request.action === "MULTIPOST_EXTENSION_GET_ACCOUNT_INFOS") {
    getAllAccountInfo().then((accountInfo) => {
      sendResponse({ accountInfo });
    });
  }
  if (request.action === "MULTIPOST_EXTENSION_OPEN_OPTIONS") {
    chrome.runtime.openOptionsPage();
    sendResponse({ extensionId: chrome.runtime.id });
  }
  if (request.action === "MULTIPOST_EXTENSION_REFRESH_ACCOUNT_INFOS") {
    chrome.windows.create({
      url: chrome.runtime.getURL("tabs/refresh-accounts.html"),
      type: "popup",
      width: 800,
      height: 600,
      focused: request.data.isFocused || false,
    });
  }
  if (request.action === "MULTIPOST_EXTENSION_PUBLISH_REQUEST_SYNC_DATA") {
    const windowId = getSenderWindowId(sender);
    const session = windowId ? publishSessions.get(windowId) : undefined;
    sendResponse({ syncData: session?.syncData || null });
  }
  if (request.action === "MULTIPOST_EXTENSION_PUBLISH_NOW") {
    const data = request.data as SyncData;
    const windowId = getSenderWindowId(sender);
    const session = windowId ? publishSessions.get(windowId) : undefined;

    (async () => {
      try {
        if (!Array.isArray(data?.platforms) || data.platforms.length === 0) {
          sendResponse({
            tabs: [],
            publishWindowId: session?.popupWindowId,
            groupId: undefined,
            groupTitle: undefined,
            tabsWindowId: undefined,
          });
          return;
        }

        // 找到主窗口，确保所有标签页创建在同一个普通窗口中
        const windows = await chrome.windows.getAll();
        const mainWindow =
          windows.find((w) => w.type === "normal" && w.focused) || windows.find((w) => w.type === "normal");
        const targetWindowId = mainWindow?.id;

        const publishTabsResult = await createTabsForPlatforms(data, targetWindowId);

        addTabsManagerMessages({
          syncData: data,
          tabs: publishTabsResult.tabs.map((t: PublishTabsResultItem) => ({
            tab: t.tab,
            platformInfo: t.platformInfo,
          })),
        });

        if (session?.popupWindowId) {
          await chrome.windows.update(session.popupWindowId, { focused: true });
        }

        sendResponse({
          tabs: publishTabsResult.tabs.map((t: PublishTabsResultItem) => ({
            tab: t.tab,
            platformInfo: t.platformInfo,
          })),
          publishWindowId: session?.popupWindowId,
          groupId: publishTabsResult.groupId,
          groupTitle: publishTabsResult.groupTitle,
          tabsWindowId: publishTabsResult.tabsWindowId,
        });
      } catch (error) {
        console.error("创建标签页或分组时出错:", error);
        sendResponse({
          tabs: [],
          publishWindowId: session?.popupWindowId,
        });
      } finally {
        isPublishInProgress = false;
      }
    })();
  }
};
starter(1000 * 30);
initKeepAliveService();
initPublishAutoCloseService();
// Message Handler || 消息处理器 || END

chrome.windows.onRemoved.addListener((windowId) => {
  if (publishSessions.has(windowId)) {
    isPublishInProgress = false;
  }
  publishSessions.delete(windowId);
});

// Keep Alive || 保活机制 || START
const quantumKeepAlive = new QuantumEntanglementKeepAlive();
quantumKeepAlive.startEntanglementProcess();
// Keep Alive || 保活机制 || END
