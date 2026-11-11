# Even Hub developer platform brief (Even Realities G2)

Research date 2026-10-20. Target: a G2 app with tap=confirm, double-tap=back, long-press=menu, swipe=move.

This project is not listed publicly on Even Hub. Each user uploads their own build to their own developer account as a Beta build. The review and submission rules below are kept because Beta builds follow the same platform constraints, not because the project is submitted for review.

## Sources and method

Primary sources, in order of authority.

1. `@evenrealities/even_hub_sdk@0.0.16`, published 2026-09-24. Types read from `package/dist/index.d.ts` (1535 lines) after `npm pack`. The docs themselves call the `.d.ts` "the authoritative source" (https://hub.evenrealities.com/docs/build/device-apis).
2. `@evenrealities/evenhub-cli@0.1.14`, `package/main.js`. The bundled zod schema for `app.json` is the real validator.
3. `@evenrealities/evenhub-simulator@0.9.5` and `@evenrealities/pretext@0.1.4`, `package/README.md`.
4. Docs pages under https://hub.evenrealities.com/docs/. These are VitePress v2 with prerendered HTML. Plain `curl` returns the full article text, so the "JS-rendered" premise in the brief was wrong and no browser was needed.

Claims marked **verified locally** were executed against the SDK bundle with `node -e "require('./dist/index.cjs')"`. Everything else is a doc or type claim. Items I could not settle are marked UNCONFIRMED.

Version drift you must account for. The docs changelog (https://hub.evenrealities.com/docs/reference/changelog, last updated 2026-08-29) lists SDK 0.0.14 as current and `min_sdk_version` floor 0.0.14 for review. npm carries 0.0.16, and its `package.json` declares `"minAppVersion": "2.2.10"`. The types below are from 0.0.16.

## 1. App architecture

**Where the code runs.** A plugin is an ordinary web app, HTML/CSS/JS or TypeScript, running in a WebView hosted by the Even Realities phone app. Chromium on Android, WKWebView on iOS. The phone app is Flutter and relays everything to the glasses over BLE 5.2. No app logic runs on the glasses apart from native scroll handling (https://hub.evenrealities.com/docs/get-started/architecture).

The documented chain runs your JS to `bridge.callEvenApp(method, params)`, then the WebView bridge, then the Even Realities App, then Bluetooth, then the glasses. Events come back through `window._listenEvenAppMessage(...)` (same page).

**Framework.** Framework-agnostic. Official templates are Vite + TypeScript with vanilla TS for bundle size. React, Vue, and Svelte are all named as supported (https://hub.evenrealities.com/docs/reference/faq). ESM-first. Runtime requirement per the SDK README is `window.flutter_inappwebview.callHandler`.

**Bridge init.** One call gates everything:

```ts
import { waitForEvenAppBridge } from '@evenrealities/even_hub_sdk'
const bridge = await waitForEvenAppBridge()
```

`waitForEvenAppBridge(): Promise<EvenAppBridge>` resolves once the host bridge is live. Calling SDK methods before it resolves silently no-ops (https://hub.evenrealities.com/docs/get-started/quickstart/first-app). `EvenAppBridge` is a singleton, `EvenAppBridge.getInstance()`.

**The bridge surface**, from `dist/index.d.ts` and **verified locally** by reflecting the prototype:

`callEvenApp`, `getUserInfo`, `getDeviceInfo`, `setLocalStorage`, `getLocalStorage`, `getAppLocation`, `startAppLocationUpdates`, `stopAppLocationUpdates`, `pickImageFromAlbum`, `captureImageFromCamera`, `createStartUpPageContainer`, `rebuildPageContainer`, `updateImageRawData`, `textContainerUpgrade`, `audioControl`, `imuControl`, `shutDownPageContainer`, `onLaunchSource`, `onDeviceStatusChanged`, `onEvenHubEvent`, `onAppLocationChanged`.

There is exactly one event subscription for OS input: `onEvenHubEvent(cb: (event: EvenHubEvent) => void): () => void`.

**Boot order.** `waitForEvenAppBridge()`, then `createStartUpPageContainer(...)` exactly once, then everything else. `audioControl(true, AudioInputSource.Glasses)` requires the startup page to exist first.

Project layout from https://hub.evenrealities.com/docs/get-started/quickstart/first-app. `src/main.ts` is your entry, `index.html` and `vite.config.ts` stay as shipped, `app.json` is the only Even-specific file, `public/icon.png` is a 24x24 greyscale icon.

## 2. Display

**Canvas.** 576 x 288 px per eye, origin top-left, X right, Y down. 4-bit greyscale, 16 levels, rendered green. White is bright green, black is off/transparent (https://hub.evenrealities.com/docs/build/display).

**Model.** No DOM, no CSS, no flexbox. You declare rectangular containers at absolute pixel coordinates, then the firmware composites them. Arbitrary pixel drawing is not available (https://hub.evenrealities.com/docs/reference/faq).

**Container ceilings.** From the same display page and `CreateStartUpPageContainer` in the `.d.ts`.

| Field | Limit | Enforced by |
| --- | --- | --- |
| `containerTotalNum` | 1 to 12 | firmware |
| `textObject` | max 8 | firmware |
| `imageObject` | max 4 | firmware |
| `listObject` | remaining slots of the 12 | firmware |

Important nuance, **verified locally**. `validateEvenHubPageContainer` accepts 13 text containers and returns `{ valid: true }`. The SDK only validates z-order, menu, and brightness. The 8/4/12 ceilings are rejected by the firmware, so a page that passes SDK validation can still fail on device.

**Shared container properties** (https://hub.evenrealities.com/docs/build/display).

| Property | Range | Note |
| --- | --- | --- |
| `xPosition`, `yPosition` | 0 to 576 / 0 to 288 | top-left |
| `width`, `height` | 0 to 576 / 0 to 288 | |
| `containerID` | number | unique per page |
| `containerName` | max 16 chars | unique per page |
| `isEventCapture` | 0 or 1 | exactly one container must be 1 |
| `zOrderIndex` | unique per page | all-or-nothing per page, SDK 0.0.12+ |
| `borderWidth` | 0 to 5 | text and list only |
| `borderColor` | 0 to 15 | text and list only |
| `borderRadius` | 0 to 10 | spelled `borderRadius` in the SDK, typo preserved from protobuf |
| `paddingLength` | 0 to 32 | text and list only |

There is no background or fill property. The border is the only decoration.

**Text containers.** `TextContainerProperty`. Plain text, left-aligned and top-aligned. No alignment option, no font size, no bold or italic. Extra fields beyond the shared set are `content?: string` and `textColor?: number`.

**Text length limits** (https://hub.evenrealities.com/docs/build/display).

| Call | Max characters |
| --- | --- |
| `createStartUpPageContainer` | 1,000 |
| `rebuildPageContainer` | 1,000 |
| `textContainerUpgrade` | 2,000 |

**Text behaviour.** Wraps at container width. `\n` is a line break. A full-screen text container holds roughly 400 to 500 characters. "Centering" means padding with spaces.

**Text scrolling.** The firmware scrolls a text container when content overflows and that container has `isEventCapture: 1`. There is no programmatic scroll position (https://hub.evenrealities.com/docs/build/device-apis, "What the SDK doesn't expose").

**Updating text.** `textContainerUpgrade` is the in-place path, flicker-free on hardware. Pass a `TextContainerUpgrade`:

```ts
declare class TextContainerUpgrade {
  containerID?: number
  containerName?: string
  contentOffset?: number
  contentLength?: number
  content?: string
  textColor?: number
}
```

`containerID` and `containerName` must both match the created container or the call silently no-ops. `contentOffset` and `contentLength` exist for partial-string updates. `rebuildPageContainer` is the full-redraw path, and it flickers on hardware.

**Text brightness.** `textColor` is 0 to 4, five levels (SDK 0.0.14+). It is brightness, not color. Omitting it on create/rebuild gives the device default of 4. Omitting it on upgrade keeps the current level. Level 0 is the dimmest level, not "unset", so `textColor: 0` can render effectively invisible. Values outside 0 to 4 are rejected by the SDK with `INVALID_TEXT_BRIGHTNESS`. Note the two scales on one container, `textColor` 0 to 4 against `borderColor` 0 to 15.

**List containers.** `ListContainerProperty` with an `itemContainer: ListItemContainerProperty` holding `itemCount`, `itemWidth`, `isItemSelectBorderEn`, `itemName: string[]`. Firmware handles scroll highlighting. Limits are 20 items per list and 64 characters per item. No per-item styling, no row height, no separators, and no in-place update. Changing a list means rebuilding the page.

**Image containers.** `ImageContainerProperty`, max 288 x 144 px per container, 4-bit greyscale. `imageData` accepts `number[]`, `Uint8Array`, `ArrayBuffer`, or base64. You cannot supply pixels in `createStartUpPageContainer`. Create a placeholder, then call `updateImageRawData`. No concurrent sends. Payloads are LZ4-compressed in transit automatically (SDK 0.0.12+). Sends are paced at 100 ms, and a call inside that window is held rather than dropped.

**Font.** One LVGL font baked into firmware. No font selection, no size control, not monospaced. Characters outside the font set are silently dropped. Emoji are not available; the FAQ recommends Unicode geometric and box-drawing characters instead.

**Line metrics**, from `@evenrealities/pretext@0.1.4` (`dist/font_measure.d.ts`), an officially published package under the `@evenrealities` scope by the same maintainers as the SDK. Fixed line height is 27 px. Advance widths come from the firmware's LVGL C font files. The glyph fallback chain is documented in the typings as `evenroster -> evenroster_crylgrek -> cn -> evenemoji`.

**Japanese and CJK.** Partly confirmed, and this is the weakest-sourced item in the brief.

- The `cn` font sits in the fallback chain, and `@evenrealities/pretext` advertises "Wide character support, Latin, Cyrillic, Greek, CJK (Chinese, Japanese, Korean), Bopomofo" (`package/README.md`).
- `supported_languages` is a mandatory manifest field accepting `ja` and `zh` (https://hub.evenrealities.com/docs/ship/packaging).
- The contextual menu page reasons about CJK explicitly, "CJK is 3 bytes per glyph, so a Chinese label is capped near 10" (https://hub.evenrealities.com/docs/build/contextual-menu).
- The simulator changelog for 0.2.0 lists "lighter CJK font" and 0.7.0 lists "Unknown-glyph handling matches firmware".

No docs page states Japanese text coverage in the text container section. **UNCONFIRMED** whether every JIS level-1 kanji renders, and UNCONFIRMED whether the glyph set matches between firmware and simulator. Test kana and your actual vocabulary on hardware before designing around Japanese copy.

## 3. Input events

This section decides the product spec. Read it as the constraint list.

**Two hardware sources, one gesture set.** Even G2 temple touchpads, and the optional R1 ring. Both deliver "press, double press, swipe up, swipe down, long press and release", distinguishable by source (https://hub.evenrealities.com/docs/build/device-apis).

**Event types.** `OsEventTypeList` from `dist/index.d.ts`.

| Event | Value | Delivered to the app as |
| --- | --- | --- |
| `CLICK_EVENT` | 0 | `textEvent` or `listEvent` |
| `SCROLL_TOP_EVENT` | 1 | `textEvent` or `listEvent` |
| `SCROLL_BOTTOM_EVENT` | 2 | `textEvent` or `listEvent` |
| `DOUBLE_CLICK_EVENT` | 3 | `textEvent` or `listEvent` |
| `FOREGROUND_ENTER_EVENT` | 4 | `sysEvent` |
| `FOREGROUND_EXIT_EVENT` | 5 | `sysEvent` |
| `ABNORMAL_EXIT_EVENT` | 6 | `sysEvent` |
| `SYSTEM_EXIT_EVENT` | 7 | `sysEvent` |
| `IMU_DATA_REPORT` | 8 | `sysEvent` |
| `LONG_PRESS_EVENT` | 9 | `sysEvent` |
| `LONG_PRESS_RELEASE_EVENT` | 10 | `sysEvent` |

**Routing.** Exactly one container per page sets `isEventCapture: 1`. Click, double click, scroll top, and scroll bottom land on that container, as `event.textEvent` for a text container or `event.listEvent` for a list container. Two paths bypass the routing table and always arrive: `event.sysEvent` for long press, and `event.menuItemClickEvent` for contextual-menu selections.

**Source discrimination.** `EventSourceType` is on `sysEvent.eventSource`. `0` is a null dummy, `1` is `TOUCH_EVENT_FROM_GLASSES_R`, `2` is `TOUCH_EVENT_FROM_RING`, `3` is `TOUCH_EVENT_FROM_GLASSES_L`.

Docs contradiction you should know about. https://hub.evenrealities.com/docs/build/device-apis says "Both events always arrive on `event.sysEvent` ... and `eventSource` is absent on them". The `.d.ts` says the opposite for the parser, "CLICK / DOUBLE_CLICK / LONG_PRESS / LONG_PRESS_RELEASE all identify right temple, ring, or left temple through this field, and parsing long-press events must not keep only eventType". **Verified locally** that a long-press payload carrying `EventSource: 2` round-trips as `{"eventType":9,"eventSource":2}`. So the SDK preserves the source. Whether firmware populates it for long press is UNCONFIRMED.

**Reserved and OS-claimed gestures.** Three distinct mechanisms, and they do not all behave the same.

1. **Tap then long press belongs to the OS.** "The OS claims tap then long press for its own menu. A tap followed by a sustained press raises the contextual menu, so whether a press reaches your app depends on which layer owns it" (https://hub.evenrealities.com/docs/build/device-apis). This is repeated in the FAQ: "The OS claims tap then long press for its own menu, so a press only reaches you when your layer owns it."
2. **Double tap is a system gesture with a mandatory contract.** The simulator documents `double_click` as "System double-tap, normally back, dismiss, or the exit dialog on a root page" (https://hub.evenrealities.com/docs/test/simulator). On the root page the requirement is hard, "Root-page double-tap calls `bridge.shutDownPageContainer(1)` ... Apps that exit silently or do nothing on double-tap are rejected" (https://hub.evenrealities.com/docs/ship/app-submission).
3. **Swipe is a native scroll, not a free gesture.** `SCROLL_TOP_EVENT` and `SCROLL_BOTTOM_EVENT` are described as "Swipe up / scroll reaches top boundary" and "Swipe down / scroll reaches bottom boundary". The firmware owns scrolling of the event-capturing container. There is no drag vector, no per-swipe delta, and no swipe-left or swipe-right at all.

**Mapping the product spec against what the platform actually delivers.**

| Spec intent | Platform reality | Verdict |
| --- | --- | --- |
| tap = confirm | `CLICK_EVENT` (0) on the capturing container | Works |
| double-tap = back | `DOUBLE_CLICK_EVENT` (3) is delivered, but the OS also treats it as system back/dismiss, and on the root page it must open the exit dialog or review rejects the app | Works on internal pages, conflicts with the mandatory exit contract on the root page |
| long-press = menu | `LONG_PRESS_EVENT` (9) and `LONG_PRESS_RELEASE_EVENT` (10) exist, but a tap-then-long-press raises the OS menu instead, so the raw press is not reliably yours. The supported menu path is `menuObject` plus `menuItemClickEvent` | Use `menuObject`, do not build on raw long press |
| swipe = move | Only `SCROLL_TOP` and `SCROLL_BOTTOM`, which are boundary events for the native scroll of the capturing container. No directional swipe, no delta, no left/right | Not supported as a cursor or selection gesture |

Practical consequence for the gesture design. A "swipe to move the selection" interaction has no platform primitive. You get two boundary signals from a scroll. Either model navigation as up/down `SCROLL_*` events on a list container and let the firmware own the highlight, or drop swipe and use click cycles.

**Two implementation gotchas on click handling.**

- Docs tell you to handle `case undefined` because "SDK normalizes 0 to undefined in some cases" (https://hub.evenrealities.com/docs/build/device-apis). **Verified locally** on 0.0.16 that `OsEventTypeList.fromJson(0)` returns `0`, and a Click on a text container parses to `{"containerID":1,"eventType":0}`. The advice is stale but harmless. Keep the `case undefined` branch for older SDK versions.
- `onEvenHubEvent` is a single subscription. Do not add a second one per screen. Unsubscribe with the returned function.

## 4. Microphone and audio

Start and stop with `audioControl(isOpen: boolean, source?: AudioInputSource): Promise<boolean>`. `AudioInputSource` is `Glasses = "glasses"` or `Phone = "phone"`, and the default when omitted is glasses.

```ts
await bridge.audioControl(true, AudioInputSource.Glasses) // G2 four-mic array
await bridge.audioControl(false)                          // stop
```

**Format, both sources.** PCM 16 kHz, signed 16-bit little-endian, mono (https://hub.evenrealities.com/docs/build/device-apis). The simulator page adds the chunking, "100 ms of data per event (3,200 bytes / 1,600 samples)" (https://hub.evenrealities.com/docs/test/simulator).

**Delivery.** Chunks arrive on the same event subscription as everything else:

```ts
declare class AudioEvent {
  audioPcm: Uint8Array
  source: AudioInputSource
  direction: number | null
  speakerRole: AudioSpeakerRole   // 'self' | 'other' | 'unknown'
}
```

`bridge.onEvenHubEvent(e => { const a = e.audioEvent; /* a.audioPcm */ })`

**Constraints.**

- Glasses capture requires `createStartUpPageContainer` to have run first. Phone capture does not.
- Manifest permission `g2-microphone` for glasses, `phone-microphone` for phone. Unused permissions get flagged at review.
- Per-mic capture inside the four-mic array and DOA angle reporting are "on the roadmap", not shipped. You get one mixed mono stream.
- `direction` is the raw signed int16 direction tag, and the SDK does not convert its unit or range. It is `null` for phone mic.
- `speakerRole` is described as "the App audio algorithm result, not a firmware identity assertion".
- No audio output on the glasses. There is no speaker.
- Capture stops if the WebView is suspended. Re-enable on foreground with the same `AudioInputSource`.

There is no streaming transcription API. The `asr` template ships "audio capture wired, transcription scaffolding, mic UI states" (https://hub.evenrealities.com/docs/get-started/quickstart/templates), so ASR is yours to build, typically server-side.

## 5. Networking

**You can `fetch`, `XMLHttpRequest`, and WebSocket from the WebView.** Two independent gates apply (https://hub.evenrealities.com/docs/build/networking).

**Gate 1, Even-side whitelist.** The destination domain must appear in the `network` permission `whitelist` in `app.json`, enforced by the Even Realities App before the request leaves the WebView. Anything not listed is blocked with no traffic generated.

**Gate 2, browser CORS.** The WebView engine enforces standard CORS. The remote server must return `Access-Control-Allow-Origin` and friends. The docs are emphatic, "The whitelist is not a CORS bypass", and "APIs that work on localhost but fail inside the WebView are almost always CORS misconfigurations on the remote side".

**Manifest shape**, confirmed against the zod schema in `@evenrealities/evenhub-cli@0.1.14` `package/main.js`:

```ts
{ name: "network", desc: string /* 1..300 chars */, whitelist: string[] /* default [] */ }
```

The schema does not validate the string format of whitelist entries. Format rules are prose only.

**Format rules** (https://hub.evenrealities.com/docs/build/networking).

- "One whitelist entry per origin. Use the full origin (`https://api.example.com`). Bare hostnames and wildcards aren't supported."
- "HTTPS in production. Plain `http://` is only useful for local dev against a LAN dev server."
- Reviewer rubric also demands that "Backend service domains, if any, are documented and traceable to the developer", and the privacy policy must cover every permission.

**Answering the Tailscale question directly.**

- A raw `100.x.y.z` address works only as `http://` and only read as local dev. Production review expects HTTPS, and a bare IP over HTTPS needs a cert the phone will trust. UNCONFIRMED whether a non-standard port is permitted inside a whitelist entry, since the CLI never validates the string.
- `https://machine.tailXXXX.ts.net` is a genuine HTTPS origin with a real certificate, so it is the better shape. Whether Even accepts a non-public hostname at review is UNCONFIRMED. The documented reviewer check is "documented and traceable to the developer", which a documented Tailscale host arguably satisfies.
- WebSocket is allowed and subject to the same whitelist. UNCONFIRMED whether the entry must be the `https://` origin or the `wss://` scheme, since the docs say "same whitelist rules" without spelling the scheme out.

**Hard limit worth planning around.** "Can I make network calls while backgrounded? No. WebView is suspended on background; in-flight requests stall." And WebSockets "typically drop if suspended" on Android. BLE throughput is about 10 to 30 KB/s, which caps image and animation work, not networking.

## 6. Background and lifecycle

**Platform split** (https://hub.evenrealities.com/docs/build/background-lifecycle).

| Platform | Engine | On background or lock |
| --- | --- | --- |
| iOS | WKWebView | Keeps running, in-memory JS state survives, no special handling needed |
| Android | Chromium WebView | May be suspended under memory pressure, process reclaimed, in-memory state gone |

The docs' instruction is blunt, "Treat Android suspend as the app starts cold." Persist to `localStorage` eagerly and rebuild on relaunch.

**What survives.**

| Resource | Survives background/lock |
| --- | --- |
| `localStorage` | Always, persisted to disk, cleared on uninstall |
| In-memory JS state | iOS yes, Android maybe not |
| Open WebSocket | iOS typically, Android typically dropped |
| `audioControl(true, ...)` capture | No if suspended, re-enable on foreground |
| `startAppLocationUpdates` stream | No if suspended, re-arm on foreground |

**Distribution mode changes the answer, and this is the trap.** From https://hub.evenrealities.com/docs/test/local-testing and https://hub.evenrealities.com/docs/test/beta-testing.

| Mode | Behaviour on lock/background |
| --- | --- |
| Dev QR sideload | Dies the moment the app backgrounds. Dev WebSocket dies, blank screen until you re-scan. Cannot validate lock behaviour at all |
| Private build (`.ehpk` from portal) | Survives backgrounding briefly, fails the 5-minute lock test |
| Beta build | Reviewer-parity. Passes the 5-minute lock test |

So a G2 app that must run with the phone pocketed can only be validated on a beta build. The reviewer runs exactly that check, "Phone locked + Even App backgrounded, glasses-launched app renders within reasonable time", plus "After 2 minutes idle the app is still alive and responsive" (https://hub.evenrealities.com/docs/ship/app-submission).

**Notifications and waking the glasses.** "Can I receive push notifications? No. Plugins are foreground-only on the glasses. The phone app receives notifications and may surface them in its own UI" (https://hub.evenrealities.com/docs/reference/faq).

So there is no mechanism to wake the glasses display or push content while the app is backgrounded. Any design that assumes server-initiated updates to a resting app is out of scope. The contextual menu is the one thing that renders "without waking your WebView", but the OS owns that overlay and the app cannot write to it at runtime.

**Exit contract.** `shutDownPageContainer(exitMode?: number)`. Mode 1 shows the system exit-confirmation dialog and is required on the root page. Mode 0 is immediate exit and is only acceptable on internal pages where the user already confirmed. After exit the phone-side WebView must also close; lingering WebViews are rejected.

**Foreground events are not exits.** `FOREGROUND_EXIT_EVENT` fires when the contextual-menu overlay closes. The page stays mounted. Docs warn to make that handler idempotent.

## 7. Contextual menu

**What it is.** An OS-drawn overlay raised by tap then long press. The OS owns the frame and permanently surrounds your items with system slots (https://hub.evenrealities.com/docs/build/contextual-menu).

| Slot | Owner |
| --- | --- |
| Display off | System, not reachable from the SDK |
| Brightness | System, handled end to end, app never notified |
| Your action items | Your app, up to 10 |
| Close [app name] | System, not reachable |

**Can apps define it.** Yes, SDK 0.0.14+ and Even App 2.2.9+. You attach `menuObject` to `createStartUpPageContainer` or `rebuildPageContainer`.

```ts
declare class MenuItemProperty {
  itemName?: string  // max 32 UTF-8 BYTES, not characters
  itemID?: number    // non-zero uint32, unique in the top-level menu
}
declare class MenuContainerProperty {
  menuItems?: MenuItemProperty[]  // firmware accepts at most 10
}
```

**Behavioural limits.**

- Fire-and-forget. Selecting an item sends one `menuItemClickEvent` and closes the menu. No toggle state, no re-render, no acknowledgement path.
- `menuObject` is replaced wholesale on rebuild. Omitting it clears your items and restores the default. Re-send it on every rebuild that should keep the menu.
- Selecting an item produces `FOREGROUND_ENTER_EVENT`, then `menuItemClickEvent`, then `FOREGROUND_EXIT_EVENT`.
- `menuItemClickEvent` does not route through `isEventCapture`.
- Client-side validation codes, **verified locally** as reachable. `TOO_MANY_MENU_ITEMS` on 11 items, `INVALID_MENU_ITEM_NAME` at 33 ASCII bytes, `INVALID_MENU_ITEM_ID` for `itemID: 0`, `DUPLICATE_MENU_ITEM_ID` on repeats.
- On an app older than 2.2.9 the declaration is a silent no-op. Packing against SDK 0.0.14+ makes the CLI stamp the 2.2.9 floor so affected users are blocked at open instead.
- Design note from the same page, "Don't add your own exit item, the root-page double-tap contract in App Submission is unchanged and still required."

This is the sanctioned home for a menu surface. Since the OS already binds tap-then-long-press to it, treating "long press = menu" as a custom implementation fights the platform. Declaring `menuObject` gives the same user-visible outcome through the supported path.

## 8. Tooling

**CLI.** `npm install -g @evenrealities/evenhub-cli`, binary `evenhub` with alias `eh` (https://hub.evenrealities.com/docs/reference/cli). Version 0.1.14.

| Command | Purpose |
| --- | --- |
| `evenhub init` | Write a starter `app.json`. `-d/--directory`, `-o/--output` |
| `evenhub qr` | Print a QR for dev sideload. `-u/--url`, `-i/--ip`, `-p/--port`, `--path`, `--https`/`--http`, `-e/--external`, `-s/--scale`, `--clear` |
| `evenhub pack <json> <project>` | Build the `.ehpk`. `-o/--output`, `--no-ignore`, `-c/--check`, `--sdk-ver <version>`, `--enforce-manual-version` |
| `evenhub login` | Store account credentials |
| `evenhub --completion-bash\|zsh\|fish` | Shell completions |

Since 0.1.14 a failed pack exits non-zero, so CI fails instead of passing on a missing `.ehpk`. `pack` derives `min_app_version` from the SDK's npm `minAppVersion` metadata and stamps it into the `.ehpk` only. It never rewrites your source `app.json`.

**Manifest `app.json`.** Confirmed from the zod schema in `main.js`, cross-checked against https://hub.evenrealities.com/docs/ship/packaging.

| Field | Required | Rule |
| --- | --- | --- |
| `package_id` | yes | `/^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)+$/`, at least two segments, no hyphens |
| `edition` | yes | exactly `"202601"` |
| `name` | yes | max 20 chars, must not contain "Even" |
| `version` | yes | `x.y.z`, no `v` prefix, no prerelease |
| `min_app_version` | no | CLI derives and stamps it, higher of yours and the SDK floor |
| `min_sdk_version` | yes | string, reviewer floor 0.0.14 |
| `entrypoint` | yes | must resolve inside the build folder, e.g. `index.html` |
| `permissions` | yes | array of objects, may be `[]` |
| `supported_languages` | yes | subset of `en, de, fr, es, it, zh, ja, ko` |

Permission names, all six from the CLI schema, `network`, `location`, `g2-microphone`, `phone-microphone`, `album`, `camera`. `network` is the only one taking `whitelist`.

**Simulator.** `npm install -g @evenrealities/evenhub-simulator`, version 0.9.5 on npm. `evenhub-simulator http://localhost:5173`. Options include `-g/--glow`, `--automation-port <port>`, `--aid`, `--print-config-path`.

The automation plane is the useful part for CI (https://hub.evenrealities.com/docs/test/simulator):

| Endpoint | Purpose |
| --- | --- |
| `GET /api/ping` | health check |
| `GET /api/screenshot/glasses` | 576x288 RGBA PNG of the LVGL framebuffer |
| `GET /api/screenshot/webview` | PNG of the host webview |
| `GET /api/console[?since_id=N]` | console, uncaught exceptions, failed fetches |
| `DELETE /api/console` | clear the buffer |
| `POST /api/input` | `{"action": "up"\|"down"\|"click"\|"double_click"\|"long_press"\|"long_press_release"\|"context_menu"}` |

Caveats the docs state plainly. Not an emulator. Font and greyscale are not pixel-perfect against hardware. It does not decompress the SDK's LZ4 image path, so the compressed transfer path must be validated on device. It cannot confirm which system menu slots a given firmware shows. Allow about 4 s after launch before sending input, and poll `/api/console` for a readiness line.

**Templates.** `github.com/even-realities/evenhub-templates`, pulled with `npx degit even-realities/evenhub-templates/<name>`. Four templates, `minimal`, `text-heavy` (pagination plus a font-measurement helper), `asr` (audio capture plus transcription scaffolding), `image`. No in-place upgrader; diff against upstream.

**Testing ladder.** Simulator for layout and logic. QR sideload for real BLE timing, HMR, and real input. Private build for the real packaging path and real permission prompts. Beta build for lock survival and reviewer parity. Reviewer rubric elsewhere, `evenhub pack app.json dist -o myapp.ehpk -c` as a pre-submission check.

**Other constraints worth knowing.** `.ehpk` practical size cap is about 10 MB. No paid distribution. No regional targeting. Released versions are immutable and fix-forward only. No deep links to the system browser. No haptics. No clipboard. No file system.

## Open questions and UNCONFIRMED items

1. Japanese glyph coverage in the firmware text-container font. Evidence is indirect (`cn` fallback font in `@evenrealities/pretext`, `ja` in `supported_languages`, CJK byte math in the menu docs). UNCONFIRMED for a real Japanese corpus on hardware.
2. Whether `eventSource` is populated on long-press events by firmware. The `.d.ts` says it must be preserved, the docs say it is absent, and the parser does preserve it when present.
3. Whether a whitelist entry may carry a non-default port, and whether a `*.ts.net` hostname clears review. The CLI does not validate the string.
4. Whether a WebSocket whitelist entry must use `https://` or `wss://`.
5. Which system menu slots appear alongside app items on any given firmware build.
6. Whether any OS-level gesture besides double-tap and tap-then-long-press is consumed before reaching the app.
7. The `docs/reference/changelog` page lags npm by two SDK patches, so 0.0.15 and 0.0.16 release notes were not readable from the docs. `minAppVersion` for 0.0.16 is 2.2.10 from `package.json`, but what changed is UNCONFIRMED.

## Recommendations for the product spec

1. Replace the raw long-press gesture with `menuObject`. The platform binds tap-then-long-press to its own overlay, so a custom long-press menu competes with the OS. `menuObject` gives a real menu with selection events and no gesture conflict.
2. Treat double-tap as back on internal pages only, and wire root-page double-tap to `shutDownPageContainer(1)`. The exit dialog on the root page is a hard review gate, and a custom exit UI on the root page is an explicit rejection reason.
3. Drop swipe as a movement gesture. The platform exposes only two scroll boundary events for the capturing container. Model navigation on a list container and let the firmware own highlight movement, or use click cycles.
4. Budget for a single event subscription and one event-capturing container per page. That is the routing model, not a limitation to route around.
5. Assume no push and no wake. Every server-driven update happens while the app is foregrounded, and state that must survive a lock goes to `localStorage`.
