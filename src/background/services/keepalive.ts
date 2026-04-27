import { refreshAccountInfo, refreshAccountInfoMap } from "~sync/account";

const KEEPALIVE_CONFIGS_KEY = "multipost_keepalive_configs";
const KEEPALIVE_RUNTIME_KEY = "multipost_keepalive_runtime";
const KEEPALIVE_ALARM_NAME = "multipost-keepalive";

const PLATFORM_TO_ACCOUNT_KEY: Record<string, string> = {
  DOUYIN: "douyin",
  WEIXIN_CHANNEL: "weixinchannel",
  REDNOTE: "rednote",
  BILIBILI: "bilibili",
  QIE: "qie",
  CHEJIAHAO: "chejiahao",
  DEWU: "dewu",
  YICHE: "yiche",
  SOHU: "sohu",
  NETEASE: "netease",
  ALIPAY: "alipay",
  YIDIAN: "yidian",
  PINDUODUO: "pinduoduo",
  VIVOVIDEO: "vivovideo",
  X: "x",
  TIKTOK: "tiktok",
  DOUYIN_VIDEO: "douyin",
  REDNOTE_VIDEO: "rednote",
  BILIBILI_VIDEO: "bilibili",
};

export interface KeepAliveConfig {
  accountId: string;
  accountName: string;
  platform: string;
  mainPage?: string;
  enabled: boolean;
  intervalMinutes: number;
  extensionAccountKey?: string | null;
}

export interface KeepAliveRuntimeState {
  running: boolean;
  lastStatus?: "idle" | "success" | "failed";
  lastMessage?: string;
  lastRunAt?: string;
  extensionAccountKey?: string | null;
  supported?: boolean;
}

let initialized = false;
const runningAccountIds = new Set<string>();

function resolveAccountKey(config: KeepAliveConfig) {
  const explicitKey = config.extensionAccountKey || undefined;
  if (explicitKey && refreshAccountInfoMap[explicitKey]) {
    return explicitKey;
  }

  const mappedKey = PLATFORM_TO_ACCOUNT_KEY[config.platform];
  if (mappedKey && refreshAccountInfoMap[mappedKey]) {
    return mappedKey;
  }

  return null;
}

function normalizeConfig(raw: Partial<KeepAliveConfig>): KeepAliveConfig | null {
  if (!raw?.accountId) {
    return null;
  }

  const intervalMinutes = Number(raw.intervalMinutes || 60);

  return {
    accountId: String(raw.accountId),
    accountName: String(raw.accountName || ""),
    platform: String(raw.platform || ""),
    mainPage: raw.mainPage ? String(raw.mainPage) : "",
    enabled: Boolean(raw.enabled),
    intervalMinutes: Number.isFinite(intervalMinutes) && intervalMinutes > 0 ? intervalMinutes : 60,
    extensionAccountKey: raw.extensionAccountKey ? String(raw.extensionAccountKey) : undefined,
  };
}

async function getStorageValue<T>(key: string, fallback: T): Promise<T> {
  const result = await chrome.storage.local.get(key);
  return (result?.[key] as T) ?? fallback;
}

async function setStorageValue<T>(key: string, value: T) {
  await chrome.storage.local.set({ [key]: value });
}

async function getConfigs(): Promise<Record<string, KeepAliveConfig>> {
  return getStorageValue<Record<string, KeepAliveConfig>>(KEEPALIVE_CONFIGS_KEY, {});
}

async function getRuntimeState(): Promise<Record<string, KeepAliveRuntimeState>> {
  return getStorageValue<Record<string, KeepAliveRuntimeState>>(KEEPALIVE_RUNTIME_KEY, {});
}

async function updateRuntimeState(accountId: string, patch: Partial<KeepAliveRuntimeState>) {
  const runtimeState = await getRuntimeState();
  runtimeState[accountId] = {
    ...(runtimeState[accountId] || { running: false, lastStatus: "idle" }),
    ...patch,
  };
  await setStorageValue(KEEPALIVE_RUNTIME_KEY, runtimeState);
  return runtimeState[accountId];
}

async function ensureKeepAliveAlarm() {
  if (!chrome.alarms) {
    return;
  }

  const configs = await getConfigs();
  const hasEnabledConfig = Object.values(configs).some((config) => config.enabled);
  if (!hasEnabledConfig) {
    await chrome.alarms.clear(KEEPALIVE_ALARM_NAME);
    return;
  }

  await chrome.alarms.create(KEEPALIVE_ALARM_NAME, {
    periodInMinutes: 1,
    delayInMinutes: 1,
  });
}

function buildStatusPayload(
  configs: Record<string, KeepAliveConfig>,
  runtimeState: Record<string, KeepAliveRuntimeState>,
) {
  const supportedAccountKeys = Object.keys(refreshAccountInfoMap);
  return {
    configs: Object.values(configs).map((config) => {
      const extensionAccountKey = resolveAccountKey(config);
      return {
        ...config,
        extensionAccountKey,
        supported: Boolean(extensionAccountKey),
      };
    }),
    runtimeState,
    supportedAccountKeys,
  };
}

async function runKeepAliveJob(config: KeepAliveConfig, reason: "manual" | "alarm" = "alarm") {
  if (runningAccountIds.has(config.accountId)) {
    return {
      accountId: config.accountId,
      ok: false,
      skipped: true,
      message: "保活任务仍在执行中",
    };
  }

  const extensionAccountKey = resolveAccountKey(config);
  if (!extensionAccountKey) {
    await updateRuntimeState(config.accountId, {
      running: false,
      lastStatus: "failed",
      lastRunAt: new Date().toISOString(),
      lastMessage: "当前平台暂未接入插件静默保活",
      extensionAccountKey: null,
      supported: false,
    });
    return {
      accountId: config.accountId,
      ok: false,
      message: "当前平台暂未接入插件静默保活",
    };
  }

  runningAccountIds.add(config.accountId);
  await updateRuntimeState(config.accountId, {
    running: true,
    lastMessage: reason === "manual" ? "正在立即执行保活" : "正在执行定时保活",
    extensionAccountKey,
    supported: true,
  });

  try {
    const accountInfo = await refreshAccountInfo(extensionAccountKey);
    const success = Boolean(accountInfo);
    const finishedAt = new Date().toISOString();
    await updateRuntimeState(config.accountId, {
      running: false,
      lastStatus: success ? "success" : "failed",
      lastRunAt: finishedAt,
      lastMessage: success
        ? `保活完成，当前账号：${config.accountName || accountInfo.username || extensionAccountKey}`
        : "未获取到最新账号信息",
      extensionAccountKey,
      supported: true,
    });

    return {
      accountId: config.accountId,
      ok: success,
      message: success ? "保活完成" : "未获取到最新账号信息",
      accountInfo,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "保活执行失败";
    await updateRuntimeState(config.accountId, {
      running: false,
      lastStatus: "failed",
      lastRunAt: new Date().toISOString(),
      lastMessage: message,
      extensionAccountKey,
      supported: true,
    });
    return {
      accountId: config.accountId,
      ok: false,
      message,
    };
  } finally {
    runningAccountIds.delete(config.accountId);
  }
}

async function runDueKeepAliveJobs() {
  const configs = await getConfigs();
  const runtimeState = await getRuntimeState();
  const now = Date.now();

  for (const config of Object.values(configs)) {
    if (!config.enabled) {
      continue;
    }

    const state = runtimeState[config.accountId];
    if (state?.running || runningAccountIds.has(config.accountId)) {
      continue;
    }

    const lastRunAt = state?.lastRunAt ? new Date(state.lastRunAt).getTime() : 0;
    const intervalMs = Math.max(1, config.intervalMinutes) * 60 * 1000;
    const due = !lastRunAt || Number.isNaN(lastRunAt) || now - lastRunAt >= intervalMs;
    if (!due) {
      continue;
    }

    await runKeepAliveJob(config, "alarm");
  }
}

export async function syncKeepAliveConfigs(configs: Partial<KeepAliveConfig>[] = []) {
  const normalizedConfigs: Record<string, KeepAliveConfig> = {};

  for (const rawConfig of configs) {
    const config = normalizeConfig(rawConfig);
    if (!config) {
      continue;
    }
    normalizedConfigs[config.accountId] = config;
  }

  await setStorageValue(KEEPALIVE_CONFIGS_KEY, normalizedConfigs);

  const currentRuntime = await getRuntimeState();
  const nextRuntime: Record<string, KeepAliveRuntimeState> = {};
  for (const config of Object.values(normalizedConfigs)) {
    const existingState = currentRuntime[config.accountId];
    const extensionAccountKey = resolveAccountKey(config);
    nextRuntime[config.accountId] = {
      running: existingState?.running || false,
      lastStatus: existingState?.lastStatus || "idle",
      lastMessage: existingState?.lastMessage,
      lastRunAt: existingState?.lastRunAt,
      extensionAccountKey,
      supported: Boolean(extensionAccountKey),
    };
  }
  await setStorageValue(KEEPALIVE_RUNTIME_KEY, nextRuntime);

  await ensureKeepAliveAlarm();

  return buildStatusPayload(normalizedConfigs, nextRuntime);
}

export async function getKeepAliveStatus() {
  const configs = await getConfigs();
  const runtimeState = await getRuntimeState();
  return buildStatusPayload(configs, runtimeState);
}

export async function runKeepAliveNow(accountId: string) {
  const configs = await getConfigs();
  const config = configs[String(accountId)];

  if (!config) {
    throw new Error("未找到对应的保活配置");
  }

  const result = await runKeepAliveJob(config, "manual");
  const status = await getKeepAliveStatus();
  return {
    result,
    ...status,
  };
}

export function keepAliveMessageHandler(request, _sender, sendResponse) {
  if (request.action === "MULTIPOST_EXTENSION_SYNC_KEEPALIVE_CONFIGS") {
    syncKeepAliveConfigs(request.data?.configs || [])
      .then((status) => sendResponse(status))
      .catch((error) => sendResponse({ error: error instanceof Error ? error.message : "同步保活配置失败" }));
  }

  if (request.action === "MULTIPOST_EXTENSION_GET_KEEPALIVE_STATUS") {
    getKeepAliveStatus()
      .then((status) => sendResponse(status))
      .catch((error) => sendResponse({ error: error instanceof Error ? error.message : "读取保活状态失败" }));
  }

  if (request.action === "MULTIPOST_EXTENSION_RUN_KEEPALIVE_NOW") {
    runKeepAliveNow(String(request.data?.accountId || ""))
      .then((status) => sendResponse(status))
      .catch((error) => sendResponse({ error: error instanceof Error ? error.message : "执行保活失败" }));
  }
}

export function initKeepAliveService() {
  if (initialized) {
    return;
  }

  initialized = true;

  if (!chrome.alarms?.onAlarm) {
    console.warn("[keepalive] chrome.alarms API unavailable, keepalive scheduler disabled");
    return;
  }

  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === KEEPALIVE_ALARM_NAME) {
      void runDueKeepAliveJobs();
    }
  });

  chrome.runtime.onStartup.addListener(() => {
    void ensureKeepAliveAlarm();
  });

  void ensureKeepAliveAlarm();
}
