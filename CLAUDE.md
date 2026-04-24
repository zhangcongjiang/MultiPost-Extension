# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

MultiPost is a Chrome browser extension (Manifest V3) that enables one-click content publishing to 30+ social media platforms. Built with the Plasmo framework, it supports Dynamic (short posts), Article (long-form), Video, and Podcast content types across platforms like Bilibili, Douyin, X/Twitter, Xiaohongshu, Weibo, Zhihu, Instagram, and more.

## Development Commands

```bash
pnpm dev          # Start dev server with hot reload ( Plasmo dev )
pnpm build        # Production build + package ( plasmo build && plasmo package )
pnpm lint         # Run Biome linter ( NOT ESLint )
pnpm lint:fix     # Auto-fix Biome issues
pnpm format       # Format code with Biome
```

**Important**: Do not run `pnpm build` for testing during development. Use `pnpm dev` instead.

There are no automated tests in this project.

## Code Style & Linting

- **Linter/Formatter**: Biome (v1.9+), NOT ESLint — config in `biome.json`
- **Indentation**: 2 spaces, LF line endings, 120 char line width
- **Trailing commas**: always
- **Import organization**: auto-enabled via Biome
- **Commit messages**: Conventional commits enforced via commitlint (`feat`, `fix`, `refactor`, `chore`, `docs` only)
- **Pre-commit**: lint-staged runs Biome on staged files (via husky)

## Path Aliases

TypeScript path alias `~*` maps to `./src/*` (configured in `tsconfig.json`). Use `~sync/common` instead of relative paths like `../../sync/common`.

## Architecture

### Two-World Content Script Pattern

Plasmo content scripts run in an **isolated world** by default, which cannot access page JavaScript (e.g., React internals, CodeMirror instances). Some platforms require interacting with the page's JS runtime. For these cases:

- **`src/contents/helper.ts`** runs in `world: "MAIN"` — has direct access to page DOM/JS. It listens for `window.postMessage` events (e.g., `BILIBILI_DYNAMIC_UPLOAD_IMAGES`, `BLUESKY_IMAGE_UPLOAD`) and performs operations that need page-world access.
- **`src/contents/extension.ts`** runs in the default isolated world — bridges external `window.postMessage` from web pages to `chrome.runtime.sendMessage`.

The inject function (in `src/sync/dynamic/*.ts`) runs via `chrome.scripting.executeScript`, which executes in the isolated world. When it needs page-world access, it posts messages that the MAIN-world helper picks up.

### External Communication Flow

Web apps (like the Astra frontend) communicate with the extension through a request/response pattern:

1. Web app sends `window.postMessage` with `ExtensionExternalRequest { type: "request", traceId, action, data }`
2. Content script (`src/contents/extension.ts`) validates origin against trusted domains (stored in `@plasmohq/storage` under key `trustedDomains`)
3. Forwards to background via `chrome.runtime.sendMessage`
4. Background routes by action and returns response
5. Content script posts `ExtensionExternalResponse { type: "response", traceId, action, code, message, data }` back

Trusted domains support wildcards (e.g., `*.example.com`). Default: `multipost.app`. Some actions like `MULTIPOST_EXTENSION_REQUEST_TRUST_DOMAIN` bypass the trust check.

### Background Script Message Actions

`src/background/index.ts` routes these primary actions:

| Action | Purpose |
|--------|---------|
| `MULTIPOST_EXTENSION_CHECK_SERVICE_STATUS` | Returns extension ID |
| `MULTIPOST_EXTENSION_PUBLISH` | Opens publish popup window with SyncData |
| `MULTIPOST_EXTENSION_PUBLISH_NOW` | Creates tabs per platform, injects scripts, groups tabs |
| `MULTIPOST_EXTENSION_PLATFORMS` | Returns all available PlatformInfo objects |
| `MULTIPOST_EXTENSION_GET_ACCOUNT_INFOS` | Returns cached account info for all platforms |
| `MULTIPOST_EXTENSION_REFRESH_ACCOUNT_INFOS` | Opens refresh-accounts popup |
| `MULTIPOST_EXTENSION_PUBLISH_REQUEST_SYNC_DATA` | Returns current SyncData |
| `MULTIPOST_EXTENSION_LINK_EXTENSION` | Opens link-extension confirmation popup |

Tab management actions (`src/background/services/tabs.ts`) handle reload/re-injection for publish tabs.

### Core Data Flow: Publishing

1. `SyncData` contains `platforms[]` (list of `SyncDataPlatform`), `isAutoPublish` flag, and content `data`
2. `createTabsForPlatforms()` creates a Chrome tab for each platform's `injectUrl`, groups them with `chrome.tabs.group`
3. After tab loads, `chrome.scripting.executeScript` injects the platform's `injectFunction` with the SyncData
4. The inject function uses DOM manipulation (MutationObserver, event dispatch) to fill forms and optionally auto-click publish

### Platform Registration (InfoMaps)

All platforms are registered in four maps that merge into a single `infoMap` (`src/sync/common.ts`):

- `DynamicInfoMap` (`src/sync/dynamic.ts`) — 28+ platforms
- `ArticleInfoMap` (`src/sync/article.ts`)
- `VideoInfoMap` (`src/sync/video.ts`)
- `PodcastInfoMap` (`src/sync/podcast.ts`)

Each `PlatformInfo` entry has: `type`, `name` (unique key like `DYNAMIC_BILIBILI`), `homeUrl`, `injectUrl`, `injectFunction`, `accountKey`, `tags` (`["CN"]` or `["International"]`), and optional `faviconUrl`/`iconifyIcon`.

Platform names follow the pattern: `{TYPE}_{PLATFORM}` (e.g., `VIDEO_YOUTUBE`, `ARTICLE_CSDN`).

### Storage Keys

All persistent state uses `@plasmohq/storage` with `area: "local"`:

| Key | Content |
|-----|---------|
| `trustedDomains` | `Array<{ id, domain }>` — domains allowed to postMessage to extension |
| `multipost_account_info` | `Record<string, AccountInfo>` — cached per-platform account data |
| `multipost_extra_config` | `Record<string, unknown>` — per-platform extra config (e.g., `customInjectUrls`) |
| `apiKey` | API key for multipost.app backend |
| `extensionClientId` | Client ID assigned by multipost.app backend |

### Service Worker Keep-Alive

Chrome MV3 service workers suspend after ~30s. The extension uses `QuantumEntanglementKeepAlive` (`src/utils/keep-alive.ts`) which writes to `chrome.storage.local` every 1337ms to prevent suspension.

### Backend Communication

`src/background/services/api.ts` handles periodic pings to `multipost.app/api/extension/ping` (every 30s via `starter()`). The ping sends extension version, client ID, and optionally platform infos. Responses can trigger actions like `NEW_TASK` or `NEW_CLIENT`.

### Content Scraping

`src/contents/scraper.ts` provides article scraping from web pages. Platform-specific scrapers in `src/contents/scraper/` handle CSDN, Zhihu, WeChat, Juejin, and Jianshu. Falls back to `@mozilla/readability` for generic pages. Triggered by `MULTIPOST_EXTENSION_REQUEST_SCRAPER_START` message.

## Adding a New Platform

1. Create handler file in the appropriate directory (`src/sync/dynamic/`, `src/sync/article/`, `src/sync/video/`, or `src/sync/podcast/`)
2. Export an async `injectFunction(data: SyncData)` that uses `waitForElement` + DOM manipulation to fill the platform's publishing form
3. For image/video uploads that need page-world access: add a message handler in `src/contents/helper.ts` (MAIN world) and post to it from the inject function
4. Add entry to the corresponding InfoMap with key format `{TYPE}_{PLATFORM}`
5. If the platform needs login detection: add account getter in `src/sync/account/` and register in `refreshAccountInfoMap` (`src/sync/account.ts`)
6. Add i18n keys in `locales/zh_CN/messages.json` (and `locales/en/messages.json`)
7. If the platform requires custom inject URLs per user: add extra config support via `src/sync/extraconfig.ts`

## Tech Stack

- **Framework**: Plasmo 0.90.5 (Manifest V3)
- **UI**: HeroUI (v2.7.8) + Tailwind CSS 3.3.5
- **Icons**: `lucide-react` preferred; `iconifyIcon` field on PlatformInfo for platform logos
- **Storage**: `@plasmohq/storage` (local area)
- **Content parsing**: `@mozilla/readability` + `turndown` (HTML→Markdown)
- **i18n**: Chrome's `chrome.i18n.getMessage()` with `locales/{locale}/messages.json`

## Code Conventions

- **TypeScript**: interfaces over types, maps (`Record<string, T>`) over enums
- **Naming**: PascalCase for components/interfaces, camelCase for functions/variables, SNAKE_CASE for constants, `UPPER_SNAKE` for message action strings
- **Styling**: `bg-background`/`text-foreground` for theming, `gap` over margins for spacing
- **i18n**: All user-facing text via `chrome.i18n.getMessage('key')`; `console.log` does not need i18n
- **Default locale**: `zh_CN`
