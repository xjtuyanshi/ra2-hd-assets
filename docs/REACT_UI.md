# React UI maintenance boundaries

The web UI uses React and TypeScript. The original game UI, VM, and per-frame rendering remain outside React.

## File responsibilities

The directory is organized by page; see the [UI directory guide](../src/ui/README.md).

- `index.html`: metadata and entry host.
- `src/ui/pages/game/AppShell.tsx`: the single component tree, stable canvas ref, and VM mount/unmount entry point.
- `src/ui/pages/game/components/`: resource selection, map management, toolbar, startup/error/exit panels, and debug panel.
- `src/ui/pages/game/styles.css`: the Red Alert client appearance and responsive rules.
- `src/ui/pages/game/components/AppRegions.tsx`: each UI region subscribes to its own snapshot; dialogs stay within the same component tree through portals.
- `src/ui/pages/game/hooks/`: effect/ref interfaces for file pickers and browser events; unmount cleans up listeners and asynchronous requests.
- `src/ui/pages/game/state/`: game-page state; generic stores and the `useSyncExternalStore` subscription hook live in `src/ui/shared/state/`.
- `gameSourcePicker.ts`, `runtimeToolbar.ts`, and `page.ts`: file import, performance sampling, and VM lifecycle services. They neither render components nor mutate ordinary UI nodes.
- `src/ui/shared/i18n/`: typed UI messages, browser-language selection, and presentation-boundary translation of existing metadata and diagnostics.

## Localization

The page resolves the first supported language in `navigator.languages` when it opens, falling back to `navigator.language` and then English. English variants use English; Chinese variants use Simplified Chinese. Unsupported entries are skipped when a later preferred language is supported. The document language and title follow this selection. Game-resource language is independent.

Use `t` with typed message keys and numbered interpolation slots for UI text, including accessible names and status messages. Chinese source keys provide the Chinese catalog; `messages.ts` supplies English translations. `localizeLabel` and `localizeText` translate existing game metadata and known runtime diagnostics at the presentation boundary, keeping UI imports out of game, VM, and resource layers. Unknown diagnostic details and filenames are preserved.

The locale stays fixed during a page session. Experimental model Workers receive the owning page's locale in their load message before producing localized results; WorkerNavigator alone is insufficient. Localization introduces no React frame state, extra React roots, or production model loading.

## DOM ownership and performance

Only `main.ts` creates a React root. Do not use `flushSync`, root registries, or dynamic DOM hosts. Conditional rendering controls visibility; props/state provide text, selected values, and collapsed styles. Interaction state such as model-probe dialog visibility, volume, resolution selection, and map-edit drafts stays inside components. Only cross-component requests and VM status enter subscribable services. Services neither retain ReactNode values nor accept HTMLElement objects to update the interface.

After mounting, an effect passes the canvas ref to the VM service. Unmount cancels pending resource requests, releases timers/input listeners/ResizeObserver, and invalidates the old startup generation; late results cannot restart the VM. The import service accepts File objects delivered by React's onChange. React input types do not yet support the native file-picker cancel event, so this browser compatibility listener remains in the hook and is cleaned up alongside the 200 ms focus-based cancellation fallback.

Shell nodes remain stable. WebGL, audio, Worker messages, mouse coalescing, touch displacement, and input locks still use independent adapters. These frequent updates do not pass through React state. The toolbar receives aggregate counters every 500 ms; debug views update only while open, at intervals of at least 200 ms. React also owns the upscaling selector and hints; identical status across consecutive frames does not trigger subscriptions.

Only browser or frequent-input adapters such as canvas/WebGL, input-lock hints, and touch displacement retain necessary DOM operations. Components must not also control adapter-owned attributes or recreate the canvas to switch views.

Modals share native `dialog.showModal()`, letting the browser constrain and restore focus. Esc closes web dialogs without synthesizing Esc for the game. Busy imports cannot be dismissed early.

## Regression entry points

Start a separate development server and set `RA2_BROWSER_ORIGIN`:

```bash
pnpm run check
pnpm run test:browser:react-ui
pnpm run test:browser:touch-ui
pnpm run test:browser:performance
pnpm run test:custom-maps
pnpm run test:browser:archive-layers
```

The React browser test needs no game assets and should run locally before submission. GitHub workflows run it for dev/main PRs, pushes, and manual dispatch. It covers English and Chinese at desktop and narrow viewports, unsupported-language fallback, resource selection, model-probe dialogs, link attributes, Esc dismissal, keyboard controls, canvas stability, state transitions, late file imports after cancellation, page-service destruction, and model Worker error language. Dedicated browser tests supplement map import and touch coverage.

`reactUiArchitecture.test.ts` enforces a single root and prevents ordinary components/services from assembling DOM again. `uiState.test.ts` covers notification deduplication, subscription disposal, request cancellation, and stale dialog callbacks. `i18n.test.ts` covers locale selection, interpolation, diagnostic translation, and catalog consistency.

Controller or lifecycle changes also require RA2/YR multiplayer short matches and ZIP cache reload using legally available local assets. Asset-free tests do not replace real-game acceptance; short matches cannot establish public-network long-match stability or complete 4/8-player coverage.

The resource picker first imports files or a directory, then detects RA2/YR against player-side required manifests. With only one complete version, it loads that executable and starts directly. With both complete versions, it prompts before loading either executable. Archive startup layers use files actually present for both versions; detection uses the complete directory. Background extraction must not overwrite pending version-selection hints. Reselection or destruction cancels the pending provider. Development builds show one uncollapsed “Development test” button; shared-directory resources use the same detection.

The homepage background retains its complete frame and original aspect ratio. Desktop content stays within the inner screen and can scroll; narrow screens place the background above the form.
