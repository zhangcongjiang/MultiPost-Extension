import type { AccountInfo } from "~sync/common";

const WEIXIN_CHANNEL_HOME_URL = "https://channels.weixin.qq.com/platform";

const JSON_ENDPOINTS = [
  "https://channels.weixin.qq.com/cgi-bin/mmfinderassistant-bin/auth/auth_data",
  "https://channels.weixin.qq.com/cgi-bin/mmfinderassistant-bin/auth/get_auth_data",
  "https://channels.weixin.qq.com/cgi-bin/mmfinderassistant-bin/auth/get_user_info",
  "https://channels.weixin.qq.com/cgi-bin/mmfinderassistant-bin/finder/account_info",
];

const LOGIN_PAGE_PATTERNS = [/扫码登录/, /请使用微信扫码/, /登录视频号助手/, /login/i];

const ACCOUNT_ID_KEYS = [
  "finderUserName",
  "finderUsername",
  "userName",
  "username",
  "accountId",
  "account_id",
  "id",
  "user_id",
  "alias",
  "uniqId",
  "uniq_id",
];

const USERNAME_KEYS = ["nickname", "nickName", "finderNickname", "finderNickName"];

const DESCRIPTION_KEYS = ["signature", "desc", "description", "intro", "bio"];

const AVATAR_KEYS = ["avatarUrl", "avatar", "headImgUrl", "headimgurl", "headImg", "headimg", "head_url", "headUrl"];

function decodeEscapedString(value: string) {
  try {
    return JSON.parse(`"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`);
  } catch {
    return value;
  }
}

function stripWrappingQuotes(value: string) {
  return value.replace(/^['"]|['"]$/g, "").trim();
}

function pickStringDeep(input: unknown, keys: string[], depth = 0): string {
  if (!input || depth > 5) {
    return "";
  }

  if (Array.isArray(input)) {
    for (const item of input) {
      const value = pickStringDeep(item, keys, depth + 1);
      if (value) {
        return value;
      }
    }
    return "";
  }

  if (typeof input !== "object") {
    return "";
  }

  const record = input as Record<string, unknown>;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      return String(value);
    }
  }

  for (const value of Object.values(record)) {
    const nested = pickStringDeep(value, keys, depth + 1);
    if (nested) {
      return nested;
    }
  }

  return "";
}

function normalizeAccountInfo(payload: unknown): AccountInfo | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const accountId = pickStringDeep(payload, ACCOUNT_ID_KEYS);
  const username = pickStringDeep(payload, USERNAME_KEYS);
  const description = pickStringDeep(payload, DESCRIPTION_KEYS);
  const avatarUrl = pickStringDeep(payload, AVATAR_KEYS);

  if (!accountId && !username && !avatarUrl) {
    return null;
  }

  return {
    provider: "weixinchannel",
    accountId: accountId || username || "unknown",
    username: username || "视频号用户",
    description,
    profileUrl: WEIXIN_CHANNEL_HOME_URL,
    avatarUrl,
    extraData: payload,
  };
}

async function fetchJsonAccountInfo(url: string): Promise<AccountInfo | null> {
  const response = await fetch(url, {
    method: "GET",
    headers: {
      Accept: "application/json, text/plain, */*",
      "Content-Type": "application/json",
    },
    credentials: "include",
  });

  if (!response.ok) {
    throw new Error(`HTTP错误，状态码: ${response.status}`);
  }

  const payload = await response.json();
  return normalizeAccountInfo(payload);
}

function extractValueFromHtml(html: string, keys: string[]) {
  for (const key of keys) {
    const patterns = [
      new RegExp(`"${key}"\\s*:\\s*"([^"]+)"`, "i"),
      new RegExp(`'${key}'\\s*:\\s*'([^']+)'`, "i"),
      new RegExp(`${key}\\s*[:=]\\s*"([^"]+)"`, "i"),
      new RegExp(`${key}\\s*[:=]\\s*'([^']+)'`, "i"),
    ];

    for (const pattern of patterns) {
      const match = html.match(pattern);
      if (match?.[1]) {
        return decodeEscapedString(stripWrappingQuotes(match[1]));
      }
    }
  }

  return "";
}

async function fetchHtmlAccountInfo(): Promise<AccountInfo | null> {
  const response = await fetch(WEIXIN_CHANNEL_HOME_URL, {
    method: "GET",
    headers: {
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    },
    credentials: "include",
  });

  if (!response.ok) {
    throw new Error(`HTTP错误，状态码: ${response.status}`);
  }

  const html = await response.text();

  if (LOGIN_PAGE_PATTERNS.some((pattern) => pattern.test(html))) {
    return null;
  }

  const accountId = extractValueFromHtml(html, ACCOUNT_ID_KEYS);
  const username = extractValueFromHtml(html, USERNAME_KEYS);
  const description = extractValueFromHtml(html, DESCRIPTION_KEYS);
  const avatarUrl = extractValueFromHtml(html, AVATAR_KEYS);

  if (!accountId && !username && !avatarUrl) {
    return {
      provider: "weixinchannel",
      accountId: "unknown",
      username: "视频号用户",
      description: "",
      profileUrl: WEIXIN_CHANNEL_HOME_URL,
      avatarUrl: "",
      extraData: {
        source: "html",
        matched: false,
      },
    };
  }

  return {
    provider: "weixinchannel",
    accountId: accountId || username || "unknown",
    username: username || "视频号用户",
    description,
    profileUrl: WEIXIN_CHANNEL_HOME_URL,
    avatarUrl,
    extraData: {
      source: "html",
      accountId,
      username,
      description,
      avatarUrl,
    },
  };
}

export async function getWeixinChannelAccountInfo(): Promise<AccountInfo | null> {
  for (const url of JSON_ENDPOINTS) {
    try {
      const accountInfo = await fetchJsonAccountInfo(url);
      if (accountInfo) {
        return accountInfo;
      }
    } catch (error) {
      console.warn("视频号账号接口请求失败:", url, error);
    }
  }

  try {
    return await fetchHtmlAccountInfo();
  } catch (error) {
    console.error("获取视频号账户信息失败:", error);
    return null;
  }
}
