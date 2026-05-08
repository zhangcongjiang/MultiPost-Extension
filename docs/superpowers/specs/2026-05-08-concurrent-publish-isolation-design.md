# Concurrent Publish Isolation Design

## Problem

When two auto-publish tasks trigger simultaneously, one task's tabs fail to get the `Astra-xxx` tab group identifier. This causes:

1. Ungrouped tabs that cannot be managed or closed by the auto-close service
2. The auto-close service (`publish-auto-close.ts`) may match wrong groups by title, closing tabs from the wrong task
3. No error handling means a single tab failure prevents all subsequent tabs from being grouped

### Root Causes

| # | Cause | Impact |
|---|-------|--------|
| 1 | `chrome.tabs.create()` doesn't specify `windowId` | Tabs may be created in the wrong window (e.g., another task's popup) |
| 2 | `chrome.tabs.update(tab.id!, { active: true })` runs after each tab | Changes focus window, affecting the other task's `chrome.tabs.create` |
| 3 | `registerPublishTab` has no try-catch | A single tab's failure prevents subsequent tabs from being grouped or recorded |
| 4 | Group title `Astra-HH:mm:ss` lacks uniqueness | Two tasks triggered in the same second produce identical titles; auto-close may close wrong tabs |
| 5 | Inconsistent tab registration order | `customInjectUrls` branch calls `registerPublishTab` before waiting for load; `else` branch calls it before the load-wait block |

## Design

**Strategy**: Window-level isolation — each `createTabsForPlatforms` call locks a target window, all operations are scoped to that window, and single-tab failures don't block other tabs from being grouped.

### Changes

#### 1. Add `windowId` parameter to `createTabsForPlatforms`

```typescript
export async function createTabsForPlatforms(
  data: SyncData,
  windowId?: number,        // NEW: target window for all tabs
): Promise<PublishTabsResult>
```

All `chrome.tabs.create({ url })` calls become `chrome.tabs.create({ url, windowId })` when `windowId` is provided.

#### 2. Remove per-tab activation from `registerPublishTab`

Move `chrome.tabs.update(tab.id!, { active: true })` out of `registerPublishTab`. Instead, after all tabs are created and grouped, activate only the last tab once.

**Rationale**: Per-tab activation causes focus-window switching between tasks, which is the primary source of the race condition.

#### 3. Add try-catch to `registerPublishTab`

Wrap the body of `registerPublishTab` in try-catch. On failure:
- Log the error
- Still push the tab to the `tabs` array (so it's tracked for auto-close)
- Still attempt to group the tab (best-effort)

This ensures a single platform's failure doesn't cascade to ungrouped tabs for all subsequent platforms.

#### 4. Add unique suffix to group title

```typescript
const suffix = Math.random().toString(36).slice(2, 6);
groupTitle = `Astra-${new Date().toLocaleTimeString("zh-CN", {
  hour: "2-digit", minute: "2-digit", second: "2-digit"
})}-${suffix}`;
// Example: Astra-10:30:15-a3f7
```

4-character base-36 suffix gives ~1.68M possible values — collision probability is negligible.

#### 5. Determine `windowId` in the `PUBLISH_NOW` handler

In `src/background/index.ts`, before calling `createTabsForPlatforms`, find the main (non-popup) window:

```typescript
const windows = await chrome.windows.getAll();
const mainWindow = windows.find(w => w.type === "normal" && w.focused)
  || windows.find(w => w.type === "normal");
const targetWindowId = mainWindow?.id;
const publishTabsResult = await createTabsForPlatforms(data, targetWindowId);
```

#### 6. Normalize tab registration order

Currently the two branches have inconsistent ordering:

- `customInjectUrls` branch: wait for load → `registerPublishTab` → sleep 3s
- `else` branch: `registerPublishTab` → wait for load → sleep 3s

Normalize both to: **wait for load → `registerPublishTab` → sleep 3s**. This is the correct order because `registerPublishTab` calls `injectScriptsToTabs`, which registers a listener for `tabs.onUpdated` with `status === "complete"`. If the tab is already complete, the injection won't fire. Waiting first ensures the tab has loaded and the injection has been set up.

### Data Flow (After Fix)

```
Task A & Task B trigger simultaneously
         |                    |
         v                    v
Find mainWindow (same window)
         |                    |
         v                    v
createTabsForPlatforms(A, mainWindow.id)   createTabsForPlatforms(B, mainWindow.id)
  tab1 → create in mainWindow               tab1 → create in mainWindow
  tab1 → group as Astra-10:30:15-a3f7       tab1 → group as Astra-10:30:16-b2e9
  tab2 → create in mainWindow               tab2 → create in mainWindow
  tab2 → add to group Astra-10:30:15-a3f7   tab2 → add to group Astra-10:30:16-b2e9
         |                    |
         v                    v
Auto-close: matched by unique groupTitle, no cross-closing
```

### Files Changed

| File | Change |
|------|--------|
| `src/sync/common.ts` | Add `windowId` param, add try-catch, remove per-tab activation, add unique suffix, normalize registration order |
| `src/background/index.ts` | Find main window, pass `windowId` to `createTabsForPlatforms`, activate last tab after creation |

### Not Changed

- `publish-auto-close.ts` — No changes needed; the unique group title fix resolves its cross-matching issue
- `tabs.ts` — No changes needed; it just stores whatever `createTabsForPlatforms` returns
- Frontend auto-publish stores — No changes needed; they already use fire-and-forget pattern
