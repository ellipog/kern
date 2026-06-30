# Plugin Extension-Point Guide

Kern plugins contribute UI through **extension points**, not by rendering into a fixed panel. The old `PluginWrapper` (visible collapsible panel) was replaced by an invisible `PluginBoot` loader that lets plugins register tabs, toolbar actions, and sidebar items into the host UI.

---

## Architecture Overview

Two Shadow DOM contexts exist per plugin:

| Context | Component | Visibility | Purpose |
|---------|-----------|------------|---------|
| **Plugin shell** | `PluginBoot` | Hidden (`display:none`) | Loads plugin JS + CSS; calls `mount()`; provides the HostAPI bridge |
| **Tab content** | `PluginTabContent` | Visible when tab is active | Renders a single tab's UI inside its own Shadow Root |

The CSS loaded by `PluginBoot` only applies to its own (hidden) Shadow DOM. For tab content, `PluginBoot` automatically enriches each registered tab with the plugin's CSS URL (`cssUrl`), and `PluginTabContent` injects that stylesheet into the tab's Shadow Root before calling the tab's `mount()` function. **Plugins don't need to handle CSS loading manually.**

---

## Extension Points

### 1. Tabs

Register tabs in the server detail view alongside the built-in "terminal" and "files" tabs.

```typescript
// In your plugin's mount() function:
hostAPI.registerTab({
  id: "my-plugin-tab",       // Unique, prefix to avoid collisions
  label: "My Tab",           // Shown in the tab bar
  mount: (el, server, api) => {
    // el is an HTMLElement inside a Shadow Root — render into it.
    // CSS from your plugin's stylesheet is already loaded.
    el.innerHTML = `<div class="my-panel">Hello from my tab</div>`;
  },
  unmount: () => {
    // Optional cleanup when tab is deactivated
  },
});
```

**Important:**
- Tab `mount()` functions receive a no-op HostAPI for `registerTab`/`unregisterTab` — always register tabs from the plugin's top-level `mount()`, not from within a tab's `mount()`.
- The mount point is inside an open Shadow Root. Use your plugin's CSS classes (from `dist/index.css`) for styling — Tailwind/global host styles don't penetrate the Shadow Root.
- CSS is automatically loaded by `PluginTabContent` using the `cssUrl` that `PluginBoot` enriches on the tab descriptor. No manual CSS injection needed.

### 2. Toolbar Actions

Register buttons in the header toolbar (next to start/stop/restart/install).

```typescript
hostAPI.registerToolbarAction({
  id: "my-action",           // Unique, prefix to avoid collisions
  label: "Action Name",      // Button label
  order: 50,                 // Sort order (lower = first, default 100)
  disabled: false,           // Initially disabled?
  onClick: () => {
    // Called when the button is clicked
    console.log("action clicked");
  },
});
```

Actions auto-sort by `order` in the toolbar.

### 3. Sidebar Items

Register clickable items in the app's left sidebar.

```typescript
hostAPI.registerSidebarItem({
  id: "my-sidebar-item",
  label: "My Item",
  icon: "📌",
  order: 50,
  onClick: () => {
    // Called when clicked
  },
});
```

---

## Lifecycle

### mount(el, server, api)

Called by `PluginBoot` when the server detail view opens. This is where you:
1. Initialize state and UI
2. Subscribe to events (`api.listen()`)
3. Register extension points (`api.registerTab()`, `api.registerToolbarAction()`, `api.registerSidebarItem()`)

```typescript
export function mount(el, server, api) {
  // Initialize
  // Subscribe to events
  // Register tabs, actions, items
  api.registerTab({ ... });
  api.registerToolbarAction({ ... });
}
```

### unmount()

Called when the view closes. Clean up all resources.

```typescript
export function unmount() {
  // Unsubscribe from events
  // Clear timers
  // state = null;
}
```

Extension points are automatically unregistered by `PluginBoot` on cleanup — you only need to clean up your own state (timers, listeners, etc.).

---

## Keeping Tab Content in Sync

If your plugin has state that changes over time (e.g., server status, log output), each tab's `mount()` function is called once when the tab becomes active. To update tab content when state changes, use an **update function map**:

```typescript
// Module-level map of tab update functions
const tabUpdateFns = new Map<string, () => void>();

// In mount():
hostAPI.registerTab({
  id: "my-live-tab",
  label: "Live Data",
  mount: (el) => {
    const update = () => {
      // Re-render the tab's content from current state
      el.innerHTML = "";
      el.appendChild(renderCurrentData());
    };
    tabUpdateFns.set("my-live-tab", update);
    update(); // Initial render
  },
  unmount: () => {
    tabUpdateFns.delete("my-live-tab");
  },
});

// Call render() whenever state changes:
function render() {
  // Update the mount point content
  // Then update all active tabs:
  for (const fn of tabUpdateFns.values()) fn();
}
```

**Always use a `Map` keyed by tab ID** (not an `Array`) so each tab independently manages its own update function. Using an `Array` causes all tabs to share the same cleanup — unmounting one tab would remove all update functions.

---

## CSS Scoping & the Shadow DOM

Your plugin's stylesheet (e.g., `dist/index.css`) is loaded into **two** Shadow Roots:

1. **PluginBoot's hidden Shadow Root** — ensures CSS is available before `mount()` runs.
2. **PluginTabContent's visible Shadow Root** — styles the tab content.

Both use the same URL (resolved from the manifest's `uiEntry` field by replacing `.js` with `.css`). The browser caches the file, so there's no performance penalty.

**Styling rules:**
- Use your own class names (prefix them to be safe, e.g., `mc-*`, `dbot-*`).
- Use CSS variables for theming to keep the look consistent with the host.
- Host styles (Tailwind, global CSS) do NOT penetrate the Shadow Root — you own the full style scope.
- The `:host` pseudo-class targets the shadow root's host element.

Example pattern (from the Discord plugin):

```css
:host,
.dbot {
  --dbot-bg: #0b0c10;
  --dbot-fg: #c8ccd4;
  --dbot-green: #4cf5a0;
  font-family: "JetBrains Mono", monospace;
  font-size: 12px;
  color: var(--dbot-fg);
}
.dbot { display: flex; flex-direction: column; gap: 8px; }
```

---

## manifest.json

Declare your plugin's static metadata and tabs in `manifest.json`:

```json
{
  "id": "my_plugin",
  "displayName": "My Plugin",
  "version": "1.0.0",
  "uiEntry": "dist/index.js",
  "tabs": [
    { "id": "my-tab", "label": "My Tab" }
  ],
  "configSchema": [ ... ],
  "lifecycle": { ... }
}
```

The `tabs` field is **metadata only** — it tells the host which tabs the plugin intends to register. The actual `mount`/`unmount` functions are provided at runtime via `hostAPI.registerTab()`.

---

## Complete Example

Here's a minimal plugin that registers one tab and one toolbar action:

```javascript
// dist/index.js
let state = null;

export function mount(el, server, api) {
  api.registerTab({
    id: "example-status",
    label: "Status",
    mount: (tabEl) => {
      tabEl.innerHTML = `
        <div class="example-panel">
          <p class="example-text">Server: ${escapeHtml(server.name)}</p>
          <p class="example-text">Status: ${server.status}</p>
        </div>
      `;
    },
    unmount: () => {},
  });

  api.registerToolbarAction({
    id: "example-hello",
    label: "Say Hi",
    icon: "👋",
    order: 100,
    onClick: () => console.log("Hello from example plugin!"),
  });

  state = { cleanup: () => api.unregisterTab("example-status") };
}

export function unmount() {
  if (!state) return;
  state.cleanup();
  state = null;
}
```

```css
/* dist/index.css */
.example-panel {
  padding: 16px;
  color: #c8ccd4;
  font-family: "JetBrains Mono", monospace;
}
.example-text {
  margin: 4px 0;
  font-size: 12px;
}
```
