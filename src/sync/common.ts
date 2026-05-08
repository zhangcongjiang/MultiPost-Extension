import { getAccountInfoFromPlatformInfo, getAccountInfoFromPlatformInfos } from "./account";
import { ArticleInfoMap } from "./article";
import { DynamicInfoMap } from "./dynamic";
import { getExtraConfigFromPlatformInfo, getExtraConfigFromPlatformInfos } from "./extraconfig";
import { PodcastInfoMap } from "./podcast";
import { VideoInfoMap } from "./video";

export interface SyncDataPlatform {
  name: string;
  injectUrl?: string;
  extraConfig?:
    | {
        customInjectUrls?: string[]; // Beta 功能，用于自定义注入 URL
      }
    | unknown;
}

export interface SyncData {
  platforms: SyncDataPlatform[];
  isAutoPublish: boolean;
  data: DynamicData | ArticleData | VideoData | PodcastData;
  origin?: DynamicData | ArticleData | VideoData | PodcastData; // Beta 功能，用于临时存储，发布时不需要提供该字段
}

export interface DynamicData {
  title: string;
  content: string;
  images: FileData[];
  videos: FileData[];
}

export interface PodcastData {
  title: string;
  description: string;
  audio: FileData;
}

export interface FileData {
  name: string;
  url: string;
  type?: string;
  size?: number;
}

export interface ArticleData {
  title: string;
  digest: string;
  cover: FileData;
  htmlContent: string;
  markdownContent: string;
  images?: FileData[]; // 发布时可不提供该字段
}

export interface VideoData {
  title: string;
  content: string;
  video: FileData;
  tags?: string[];
  cover?: FileData;
  verticalCover?: FileData;
  videoFile?: File; // 原始 File 对象，用于避免 blob URL 问题
  scheduledPublishTime?: number;
}

export interface PlatformInfo {
  type: "DYNAMIC" | "VIDEO" | "ARTICLE" | "PODCAST";
  name: string;
  homeUrl: string;
  faviconUrl?: string;
  iconifyIcon?: string;
  platformName: string;
  injectUrl: string;
  injectFunction: (data: SyncData) => Promise<void>;
  tags?: string[];
  accountKey: string;
  accountInfo?: AccountInfo;
  extraConfig?: unknown;
}

export interface PublishTabsResultItem {
  tab: chrome.tabs.Tab;
  platformInfo: SyncDataPlatform;
}

export interface PublishTabsResult {
  tabs: PublishTabsResultItem[];
  groupId?: number;
  groupTitle?: string;
  tabsWindowId?: number;
}

export interface AccountInfo {
  provider: string;
  accountId: string;
  username: string;
  description?: string;
  profileUrl?: string;
  avatarUrl?: string;
  extraData: unknown;
}

export const infoMap: Record<string, PlatformInfo> = {
  ...DynamicInfoMap,
  ...ArticleInfoMap,
  ...VideoInfoMap,
  ...PodcastInfoMap,
};

export async function getPlatformInfo(platform: string): Promise<PlatformInfo | null> {
  const platformInfo = infoMap[platform];
  if (platformInfo) {
    return await getExtraConfigFromPlatformInfo(await getAccountInfoFromPlatformInfo(platformInfo));
  }
  return null;
}

export function getRawPlatformInfo(platform: string): PlatformInfo | null {
  return infoMap[platform];
}

export async function getPlatformInfos(type?: "DYNAMIC" | "VIDEO" | "ARTICLE" | "PODCAST"): Promise<PlatformInfo[]> {
  const platformInfos: PlatformInfo[] = [];
  for (const info of Object.values(infoMap)) {
    if (type && info.type !== type) continue;
    platformInfos.push(info);
  }

  return await getExtraConfigFromPlatformInfos(await getAccountInfoFromPlatformInfos(platformInfos));
}

// Inject || 注入 || START
export async function createTabsForPlatforms(data: SyncData, targetWindowId?: number): Promise<PublishTabsResult> {
  const tabs: PublishTabsResultItem[] = [];
  let groupId: number | undefined;
  let groupTitle: string | undefined;
  let tabsWindowId: number | undefined;

  const registerPublishTab = async (tab: chrome.tabs.Tab, platformInfo: SyncDataPlatform) => {
    try {
      await injectScriptsToTabs([{ tab, platformInfo }], data);
      tabs.push({
        tab,
        platformInfo,
      });
      tabsWindowId ??= tab.windowId;

      if (!groupId) {
        groupId = await chrome.tabs.group({ tabIds: [tab.id!] });
        groupTitle = `Astra-${new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}`;
        await chrome.tabGroups.update(groupId, {
          color: "blue",
          title: groupTitle,
        });
      } else {
        await chrome.tabs.group({ tabIds: [tab.id!], groupId });
      }
    } catch (error) {
      console.error(`注册发布标签页失败 (tab: ${tab.id}, platform: ${platformInfo.name}):`, error);
      // 仍然尝试记录 tab 和分组，最佳努力
      tabs.push({ tab, platformInfo });
      tabsWindowId ??= tab.windowId;
      if (groupId && tab.id) {
        try {
          await chrome.tabs.group({ tabIds: [tab.id!], groupId });
        } catch {
          // 分组也失败则放弃
        }
      }
    }
  };

  for (const info of data.platforms) {
    let tab: chrome.tabs.Tab | null = null;
    if (info) {
      const extraConfig = info.extraConfig as { customInjectUrls?: string[] };
      if (extraConfig?.customInjectUrls && extraConfig.customInjectUrls.length > 0) {
        for (const url of extraConfig.customInjectUrls) {
          tab = await chrome.tabs.create({ url, windowId: targetWindowId });
          info.injectUrl = url;
          // 等待标签页加载完成，增加超时机制
          await new Promise<void>((resolve) => {
            const timeout = setTimeout(() => {
              console.warn(`Tab ${tab?.id} loading timed out after 30s`);
              resolve();
            }, 30000);

            chrome.tabs.onUpdated.addListener(function listener(tabId, info) {
              if (tabId === tab!.id && info.status === "complete") {
                clearTimeout(timeout);
                chrome.tabs.onUpdated.removeListener(listener);
                resolve();
              }
            });
          });

          if (tab) {
            await registerPublishTab(tab, info);
            await new Promise((resolve) => setTimeout(resolve, 3000));
          }
        }
      } else {
        if (info.injectUrl) {
          tab = await chrome.tabs.create({ url: info.injectUrl, windowId: targetWindowId });
        } else {
          const platformInfo = infoMap[info.name];
          if (platformInfo) {
            tab = await chrome.tabs.create({ url: platformInfo.injectUrl, windowId: targetWindowId });
          }
        }
        if (tab) {
          // 等待标签页加载完成，增加超时机制
          await new Promise<void>((resolve) => {
            const timeout = setTimeout(() => {
              console.warn(`Tab ${tab?.id} loading timed out after 30s`);
              resolve();
            }, 30000);

            chrome.tabs.onUpdated.addListener(function listener(tabId, info) {
              if (tabId === tab!.id && info.status === "complete") {
                clearTimeout(timeout);
                chrome.tabs.onUpdated.removeListener(listener);
                resolve();
              }
            });
          });
          await registerPublishTab(tab, info);
          await new Promise((resolve) => setTimeout(resolve, 3000));
        }
      }
    }
  }

  // 所有标签页创建完成后，激活最后一个标签页
  const lastTab = tabs[tabs.length - 1];
  if (lastTab?.tab?.id) {
    try {
      await chrome.tabs.update(lastTab.tab.id, { active: true });
    } catch {
      // 标签页可能已关闭
    }
  }

  return {
    tabs,
    groupId,
    groupTitle,
    tabsWindowId,
  };
}

export async function injectScriptsToTabs(
  tabs: { tab: chrome.tabs.Tab; platformInfo: SyncDataPlatform }[],
  data: SyncData,
) {
  for (const t of tabs) {
    const tab = t.tab;
    const platform = t.platformInfo;
    if (tab.id) {
      // 先检查 Tab 是否已经加载完成，是则直接注入，否则注册监听器
      try {
        const currentTab = await chrome.tabs.get(tab.id);
        if (currentTab.status === "complete") {
          const info = await getPlatformInfo(platform.name);
          if (info) {
            await chrome.scripting.executeScript({
              target: { tabId: tab.id },
              func: info.injectFunction,
              args: [data],
            });
          }
          continue;
        }
      } catch {
        // Tab 可能已关闭
        continue;
      }

      // Tab 还在加载中，等待完成后注入
      chrome.tabs.onUpdated.addListener(function listener(tabId, info) {
        if (tabId === tab.id && info.status === "complete") {
          chrome.tabs.onUpdated.removeListener(listener);
          getPlatformInfo(platform.name).then((info) => {
            if (info) {
              chrome.scripting.executeScript({
                target: { tabId: tab.id },
                func: info.injectFunction,
                args: [data],
              });
            }
          });
        }
      });
    }
  }
}
// Inject || 注入 || END
