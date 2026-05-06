const PUBLISH_AUTO_CLOSE_RETRY_ALARM_PREFIX = "multipost-publish-auto-close-retry:";
const PUBLISH_AUTO_CLOSE_ORPHAN_SWEEP_ALARM = "multipost-publish-auto-close-orphan-sweep";
const PUBLISH_AUTO_CLOSE_RETRY_SECONDS = 15;
const PUBLISH_AUTO_CLOSE_ORPHAN_SWEEP_MINUTES = 5;
const PUBLISH_AUTO_CLOSE_STORAGE_KEY = "multipost_publish_auto_close_sessions";
const PUBLISH_AUTO_CLOSE_ALARM_PREFIX = "multipost-publish-auto-close:";

interface PublishAutoCloseSession {
  sessionId: string;
  windowId?: number;
  tabsWindowId?: number;
  tabIds: number[];
  groupId?: number;
  groupTitle?: string;
  closeTabs: boolean;
  closeWindow: boolean;
  executeAt: number;
}

let initialized = false;

async function getSessions(): Promise<Record<string, PublishAutoCloseSession>> {
  const result = await chrome.storage.local.get(PUBLISH_AUTO_CLOSE_STORAGE_KEY);
  return (result?.[PUBLISH_AUTO_CLOSE_STORAGE_KEY] as Record<string, PublishAutoCloseSession>) || {};
}

async function setSessions(sessions: Record<string, PublishAutoCloseSession>) {
  await chrome.storage.local.set({ [PUBLISH_AUTO_CLOSE_STORAGE_KEY]: sessions });
}

async function saveSession(session: PublishAutoCloseSession) {
  const sessions = await getSessions();
  sessions[session.sessionId] = session;
  await setSessions(sessions);
}

async function removeSession(sessionId: string) {
  const sessions = await getSessions();
  if (sessions[sessionId]) {
    delete sessions[sessionId];
    await setSessions(sessions);
  }
}

function buildAlarmName(sessionId: string) {
  return `${PUBLISH_AUTO_CLOSE_ALARM_PREFIX}${sessionId}`;
}

async function clearSessionAlarm(sessionId: string) {
  await chrome.alarms.clear(buildAlarmName(sessionId));
}

async function closeTabs(tabIds: number[]) {
  const existingTabIds = (
    await Promise.all(
      tabIds.map(async (tabId) => {
        try {
          await chrome.tabs.get(tabId);
          return tabId;
        } catch {
          return null;
        }
      }),
    )
  ).filter((tabId): tabId is number => typeof tabId === "number");

  if (existingTabIds.length > 0) {
    await chrome.tabs.remove(existingTabIds).catch(() => undefined);
  }
}

async function findTabsByGroupIds(groupIds: number[]) {
  const existingGroupIds = groupIds.filter((groupId) => Number.isInteger(groupId) && groupId >= 0);
  const tabs = await Promise.all(
    existingGroupIds.map(async (groupId) => {
      try {
        return await chrome.tabs.query({ groupId });
      } catch {
        return [];
      }
    }),
  );

  return tabs.flat();
}

async function findTabsByGroupTitle(groupTitle?: string, windowId?: number) {
  if (!groupTitle) {
    return [];
  }

  try {
    const groups = await chrome.tabGroups.query(typeof windowId === "number" ? { windowId } : {});
    const matchedGroups = groups.filter((group) => group.title === groupTitle);
    if (matchedGroups.length === 0) {
      return [];
    }

    const tabs = await Promise.all(
      matchedGroups
        .map((group) => group.id)
        .filter((groupId): groupId is number => typeof groupId === "number" && groupId >= 0)
        .map(async (groupId) => chrome.tabs.query({ groupId })),
    );

    return tabs.flat();
  } catch {
    return [];
  }
}

async function closeResidualGroupTabs(session: PublishAutoCloseSession) {
  const candidateTabs = [
    ...(await findTabsByGroupIds(typeof session.groupId === "number" ? [session.groupId] : [])),
    ...(await findTabsByGroupTitle(session.groupTitle, session.tabsWindowId)),
  ];

  const uniqueTabIds = Array.from(
    new Set(candidateTabs.map((tab) => tab.id).filter((tabId): tabId is number => typeof tabId === "number")),
  );

  if (uniqueTabIds.length > 0) {
    await chrome.tabs.remove(uniqueTabIds).catch(() => undefined);
  }
}

async function closeWindow(windowId?: number) {
  if (typeof windowId !== "number") {
    return;
  }

  try {
    await chrome.windows.get(windowId);
    await chrome.windows.remove(windowId);
  } catch {
    // window 可能已被用户手动关闭
  }
}

async function executeSession(sessionId: string) {
  try {
    const sessions = await getSessions();
    const session = sessions[sessionId];
    if (!session) {
      return;
    }

    console.log(
      "[publish-auto-close] 执行自动关闭, sessionId:",
      sessionId,
      "closeTabs:",
      session.closeTabs,
      "closeWindow:",
      session.closeWindow,
    );

    if (session.closeTabs) {
      await closeTabs(session.tabIds);
      await closeResidualGroupTabs(session);
    }

    if (session.closeWindow) {
      await closeWindow(session.windowId);
    }

    const stillHasTabs = await checkSessionStillHasTabs(session);
    const stillHasWindow = await checkSessionStillHasWindow(session);

    if (stillHasTabs || stillHasWindow) {
      console.warn("[publish-auto-close] 息屏或操作被阻断，15秒后重试, sessionId:", sessionId);
      await clearSessionAlarm(sessionId);
      await chrome.alarms.create(`${PUBLISH_AUTO_CLOSE_RETRY_ALARM_PREFIX}${sessionId}`, {
        delayInMinutes: PUBLISH_AUTO_CLOSE_RETRY_SECONDS / 60,
      });
      return;
    }

    await clearSessionAlarm(sessionId);
    await removeSession(sessionId);
    console.log("[publish-auto-close] 自动关闭完成，已清理会话", sessionId);
  } catch (error) {
    console.error("[publish-auto-close] 执行自动关闭时出错:", error);
    try {
      const retryAlarmName = `${PUBLISH_AUTO_CLOSE_RETRY_ALARM_PREFIX}${sessionId}`;
      await chrome.alarms.create(retryAlarmName, {
        delayInMinutes: PUBLISH_AUTO_CLOSE_RETRY_SECONDS / 60,
      });
    } catch {
      // ignore
    }
  }
}

async function checkSessionStillHasTabs(session: PublishAutoCloseSession): Promise<boolean> {
  for (const tabId of session.tabIds) {
    try {
      await chrome.tabs.get(tabId);
      return true;
    } catch {
      // tab closed
    }
  }

  if (typeof session.groupId === "number" && session.groupId >= 0) {
    try {
      const groupTabs = await chrome.tabs.query({ groupId: session.groupId });
      if (groupTabs.length > 0) return true;
    } catch {
      // group gone
    }
  }

  if (session.groupTitle) {
    try {
      const groups = await chrome.tabGroups.query(
        typeof session.tabsWindowId === "number" ? { windowId: session.tabsWindowId } : {},
      );
      const matchedGroups = groups.filter((g) => g.title === session.groupTitle);
      for (const g of matchedGroups) {
        if (typeof g.id === "number" && g.id >= 0) {
          const groupTabs = await chrome.tabs.query({ groupId: g.id });
          if (groupTabs.length > 0) return true;
        }
      }
    } catch {
      // ignore
    }
  }

  return false;
}

async function checkSessionStillHasWindow(session: PublishAutoCloseSession): Promise<boolean> {
  if (typeof session.windowId !== "number") return false;
  try {
    await chrome.windows.get(session.windowId);
    return true;
  } catch {
    return false;
  }
}

async function scanAndCleanupOrphanedGroups() {
  try {
    const sessions = await getSessions();
    const existingGroupTitles = new Set<string>();
    for (const s of Object.values(sessions)) {
      if (s.groupTitle) existingGroupTitles.add(s.groupTitle);
    }

    const allGroups = await chrome.tabGroups.query({});
    const astraGroups = allGroups.filter((g) => g.title?.startsWith("Astra-"));

    for (const group of astraGroups) {
      if (group.title && existingGroupTitles.has(group.title)) continue;

      console.log("[publish-auto-close] 发现孤立分组，清理:", group.title);
      if (typeof group.id === "number" && group.id >= 0) {
        const tabs = await chrome.tabs.query({ groupId: group.id });
        const tabIds = tabs.map((t) => t.id).filter((id): id is number => typeof id === "number");
        if (tabIds.length > 0) {
          await chrome.tabs.remove(tabIds).catch(() => undefined);
        }
      }
    }

    const sessionsToRetry: string[] = [];
    for (const [sessionId, session] of Object.entries(sessions)) {
      const hasTabs = await checkSessionStillHasTabs(session);
      const hasWindow = await checkSessionStillHasWindow(session);
      if (!hasTabs && !hasWindow) {
        await clearSessionAlarm(sessionId);
        await removeSession(sessionId);
        console.log("[publish-auto-close] 孤立会话已清理:", sessionId);
      } else if (hasTabs || hasWindow) {
        sessionsToRetry.push(sessionId);
      }
    }

    for (const sessionId of sessionsToRetry) {
      if (sessions[sessionId]) {
        await clearSessionAlarm(sessionId);
        await chrome.alarms.create(`${PUBLISH_AUTO_CLOSE_RETRY_ALARM_PREFIX}${sessionId}`, {
          delayInMinutes: PUBLISH_AUTO_CLOSE_RETRY_SECONDS / 60,
        });
      }
    }
  } catch (error) {
    console.error("[publish-auto-close] 孤立分组扫描出错:", error);
  }
}

async function scheduleSession(rawSession: Partial<PublishAutoCloseSession>) {
  const sessionId = String(rawSession.sessionId || "");
  if (!sessionId) {
    throw new Error("缺少自动关闭会话ID");
  }

  const executeAt = Number(rawSession.executeAt || 0);
  if (!Number.isFinite(executeAt) || executeAt <= Date.now()) {
    throw new Error("自动关闭执行时间无效");
  }

  const session: PublishAutoCloseSession = {
    sessionId,
    windowId: typeof rawSession.windowId === "number" ? rawSession.windowId : undefined,
    tabsWindowId: typeof rawSession.tabsWindowId === "number" ? rawSession.tabsWindowId : undefined,
    tabIds: Array.isArray(rawSession.tabIds)
      ? rawSession.tabIds.filter((tabId): tabId is number => Number.isInteger(tabId) && tabId > 0)
      : [],
    groupId: typeof rawSession.groupId === "number" ? rawSession.groupId : undefined,
    groupTitle: typeof rawSession.groupTitle === "string" ? rawSession.groupTitle : undefined,
    closeTabs: Boolean(rawSession.closeTabs),
    closeWindow: rawSession.closeWindow !== false,
    executeAt,
  };

  await saveSession(session);
  await clearSessionAlarm(sessionId);
  await chrome.alarms.create(buildAlarmName(sessionId), {
    when: executeAt,
  });

  return session;
}

async function cancelSession(sessionId: string) {
  if (!sessionId) {
    return;
  }
  await clearSessionAlarm(sessionId);
  await removeSession(sessionId);
}

export function publishAutoCloseMessageHandler(request, _sender, sendResponse) {
  if (request.action === "MULTIPOST_EXTENSION_REGISTER_PUBLISH_AUTO_CLOSE") {
    scheduleSession(request.data || {})
      .then((session) => sendResponse({ ok: true, session }))
      .catch((error) =>
        sendResponse({ ok: false, error: error instanceof Error ? error.message : "注册自动关闭失败" }),
      );
  }

  if (request.action === "MULTIPOST_EXTENSION_CANCEL_PUBLISH_AUTO_CLOSE") {
    cancelSession(String(request.data?.sessionId || ""))
      .then(() => sendResponse({ ok: true }))
      .catch((error) =>
        sendResponse({ ok: false, error: error instanceof Error ? error.message : "取消自动关闭失败" }),
      );
  }
}

export function initPublishAutoCloseService() {
  if (initialized) {
    return;
  }

  initialized = true;

  if (!chrome.alarms?.onAlarm) {
    console.warn("[publish-auto-close] chrome.alarms API unavailable");
    return;
  }

  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name.startsWith(PUBLISH_AUTO_CLOSE_RETRY_ALARM_PREFIX)) {
      const sessionId = alarm.name.slice(PUBLISH_AUTO_CLOSE_RETRY_ALARM_PREFIX.length);
      void executeSession(sessionId);
      return;
    }

    if (alarm.name === PUBLISH_AUTO_CLOSE_ORPHAN_SWEEP_ALARM) {
      void scanAndCleanupOrphanedGroups();
      return;
    }

    if (alarm.name.startsWith(PUBLISH_AUTO_CLOSE_ALARM_PREFIX)) {
      const sessionId = alarm.name.slice(PUBLISH_AUTO_CLOSE_ALARM_PREFIX.length);
      void executeSession(sessionId);
    }
  });

  chrome.alarms.create(PUBLISH_AUTO_CLOSE_ORPHAN_SWEEP_ALARM, {
    delayInMinutes: PUBLISH_AUTO_CLOSE_ORPHAN_SWEEP_MINUTES,
    periodInMinutes: PUBLISH_AUTO_CLOSE_ORPHAN_SWEEP_MINUTES,
  });

  void scanAndCleanupOrphanedGroups();
}
