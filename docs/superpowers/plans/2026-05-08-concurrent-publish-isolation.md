# Concurrent Publish Isolation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the concurrent publish bug where two simultaneous auto-publish tasks cause one task's tabs to lose their `Astra-xxx` tab group identifier.

**Architecture:** Window-level isolation — each `createTabsForPlatforms` call receives a target `windowId`, all tab creation is scoped to that window, per-tab activation is deferred to eliminate focus-switching races, group titles get unique suffixes, and individual tab failures are caught to prevent cascade.

**Tech Stack:** TypeScript, Chrome Extension MV3 APIs (`chrome.tabs`, `chrome.tabGroups`, `chrome.windows`)

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `src/sync/common.ts` | Modify | Core fix: add `windowId` param, try-catch, unique suffix, normalized order, deferred activation |
| `src/background/index.ts` | Modify | Find main window, pass `windowId` to `createTabsForPlatforms`, activate last tab |

---

### Task 1: Add `windowId` parameter and fix `registerPublishTab` in `common.ts`

**Files:**
- Modify: `src/sync/common.ts:132-157`

- [ ] **Step 1: Update function signature and `registerPublishTab`**

Replace lines 132–157 of `src/sync/common.ts` with the following. This adds `windowId` param, wraps `registerPublishTab` in try-catch, removes per-tab activation, and adds unique suffix to group title.

```typescript
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
        const suffix = Math.random().toString(36).slice(2, 6);
        groupTitle = `Astra-${new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}-${suffix}`;
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
```

- [ ] **Step 2: Verify the change compiles**

Run: `cd f:\workspace\astra_manage\MultiPost-Extension && npx tsc --noEmit --pretty 2>&1 | head -30`

Expected: No errors related to `createTabsForPlatforms` signature. There may be existing errors unrelated to this change.

- [ ] **Step 3: Commit**

```bash
git add src/sync/common.ts
git commit -m "fix: add windowId param, try-catch, unique suffix to registerPublishTab"
```

---

### Task 2: Fix `customInjectUrls` branch — pass `windowId` and normalize order

**Files:**
- Modify: `src/sync/common.ts:159-187` (the `customInjectUrls` branch inside the `for` loop)

- [ ] **Step 1: Update the `customInjectUrls` branch**

Replace lines 159–187 (from `for (const info of data.platforms)` through the end of the `customInjectUrls` block) with:

```typescript
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
```

Key changes: `chrome.tabs.create({ url })` → `chrome.tabs.create({ url, windowId: targetWindowId })`. The order is already correct (wait → register → sleep).

- [ ] **Step 2: Verify the change compiles**

Run: `cd f:\workspace\astra_manage\MultiPost-Extension && npx tsc --noEmit --pretty 2>&1 | head -30`

- [ ] **Step 3: Commit**

```bash
git add src/sync/common.ts
git commit -m "fix: pass windowId in customInjectUrls branch"
```

---

### Task 3: Fix `else` branch — pass `windowId`, normalize order, add deferred activation

**Files:**
- Modify: `src/sync/common.ts:188-227` (the `else` branch and the return statement)

- [ ] **Step 1: Update the `else` branch and add deferred last-tab activation**

Replace lines 188–227 (from `} else {` through the closing `}` of `createTabsForPlatforms`) with:

```typescript
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
```

Key changes:
- `chrome.tabs.create({ url })` → `chrome.tabs.create({ url, windowId: targetWindowId })` (3 calls)
- Reordered: wait for load → `registerPublishTab` → sleep 3s (was: register → wait → sleep)
- Added deferred last-tab activation after all tabs are created

- [ ] **Step 2: Verify the full `createTabsForPlatforms` function compiles**

Run: `cd f:\workspace\astra_manage\MultiPost-Extension && npx tsc --noEmit --pretty 2>&1 | head -30`

- [ ] **Step 3: Commit**

```bash
git add src/sync/common.ts
git commit -m "fix: pass windowId, normalize order, defer activation in else branch"
```

---

### Task 4: Update `PUBLISH_NOW` handler in `background/index.ts`

**Files:**
- Modify: `src/background/index.ts:104-153`

- [ ] **Step 1: Find main window and pass `windowId` to `createTabsForPlatforms`**

Replace lines 108–153 (the async IIFE inside the `PUBLISH_NOW` handler) with:

```typescript
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
          windows.find((w) => w.type === "normal" && w.focused) ||
          windows.find((w) => w.type === "normal");
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
      }
    })();
```

Key changes:
- Added `chrome.windows.getAll()` to find the main window
- Pass `targetWindowId` as second argument to `createTabsForPlatforms(data, targetWindowId)`
- Everything else stays the same

- [ ] **Step 2: Verify compilation**

Run: `cd f:\workspace\astra_manage\MultiPost-Extension && npx tsc --noEmit --pretty 2>&1 | head -30`

- [ ] **Step 3: Commit**

```bash
git add src/background/index.ts
git commit -m "fix: find main window and pass windowId for concurrent publish isolation"
```

---

### Task 5: Run Biome lint and format

**Files:**
- May modify: `src/sync/common.ts`, `src/background/index.ts`

- [ ] **Step 1: Run linter**

Run: `cd f:\workspace\astra_manage\MultiPost-Extension && pnpm lint 2>&1 | tail -20`

- [ ] **Step 2: Auto-fix any issues**

Run: `cd f:\workspace\astra_manage\MultiPost-Extension && pnpm lint:fix && pnpm format`

- [ ] **Step 3: Verify still compiles after lint fixes**

Run: `cd f:\workspace\astra_manage\MultiPost-Extension && npx tsc --noEmit --pretty 2>&1 | head -30`

- [ ] **Step 4: Commit lint fixes if any**

```bash
git add -A
git commit -m "style: lint and format fixes"
```

---

### Task 6: Manual smoke test

**Files:** None

- [ ] **Step 1: Start dev server**

Run: `cd f:\workspace\astra_manage\MultiPost-Extension && pnpm dev`

- [ ] **Step 2: Load extension in Chrome**

Load the unpacked extension from the `dist/` directory.

- [ ] **Step 3: Test single publish**

From the frontend, trigger a single publish to one platform. Verify:
- Tab opens in the correct window
- Tab gets grouped with `Astra-HH:mm:ss-xxxx` title
- Auto-close works correctly

- [ ] **Step 4: Test concurrent publish**

Trigger two publishes simultaneously (e.g., article + dynamic). Verify:
- Both sets of tabs open in the main window
- Each set gets its own unique `Astra-xxx-xxxx` group
- Groups have different suffixes
- Auto-close for each task only closes its own group's tabs
