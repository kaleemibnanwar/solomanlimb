// Real input-event dispatch via chrome.debugger (Chrome DevTools Protocol),
// mirroring nanobrowser's primary click/type path (Puppeteer-core connected
// over the same protocol — see docs/octolimb-integration.md). This talks to
// CDP directly instead of pulling in puppeteer-core, so the extension stays
// plain JS with no build step.
//
// Requires the "debugger" permission. Attaching shows Chrome's own
// "<extension> is debugging this browser" banner on the tab, exactly like
// nanobrowser does — there is no way to suppress that notification.
//
// Every exported function returns `false` (never throws) on failure so
// callers can fall back to a plain DOM-script interaction, matching
// nanobrowser's own two-tier click strategy.

const attachedTabs = new Set();

function sendCommand(tabId, method, params = {}) {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand({ tabId }, method, params, (result) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(result);
      }
    });
  });
}

async function ensureAttached(tabId) {
  if (attachedTabs.has(tabId)) return true;
  try {
    await new Promise((resolve, reject) => {
      chrome.debugger.attach({ tabId }, "1.3", () => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else {
          resolve();
        }
      });
    });
    attachedTabs.add(tabId);
    return true;
  } catch (error) {
    if (String(error.message).toLowerCase().includes("already attach")) {
      attachedTabs.add(tabId);
      return true;
    }
    console.warn(
      "[OctoLimb] chrome.debugger attach failed, falling back to DOM scripting:",
      error.message,
    );
    return false;
  }
}

chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId !== undefined) attachedTabs.delete(source.tabId);
});
chrome.tabs.onRemoved.addListener((tabId) => attachedTabs.delete(tabId));

async function dispatchClick(tabId, x, y) {
  await sendCommand(tabId, "Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x,
    y,
    button: "none",
  });
  await sendCommand(tabId, "Input.dispatchMouseEvent", {
    type: "mousePressed",
    x,
    y,
    button: "left",
    clickCount: 1,
  });
  await sendCommand(tabId, "Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x,
    y,
    button: "left",
    clickCount: 1,
  });
}

export async function cdpClick(tabId, x, y) {
  if (!(await ensureAttached(tabId))) return false;
  try {
    await dispatchClick(tabId, x, y);
    return true;
  } catch (error) {
    console.warn("[OctoLimb] CDP click failed, falling back to DOM click:", error.message);
    return false;
  }
}

export async function cdpInsertText(tabId, x, y, text) {
  if (!(await ensureAttached(tabId))) return false;
  try {
    // Click first to focus the field, matching real user behavior and
    // nanobrowser's own click-before-type flow.
    await dispatchClick(tabId, x, y);
    await sendCommand(tabId, "Input.insertText", { text });
    return true;
  } catch (error) {
    console.warn("[OctoLimb] CDP text input failed, falling back to DOM input:", error.message);
    return false;
  }
}

// Minimal USKeyboardLayout-style map covering the keys nanobrowser's own
// send_keys description calls out, plus letters/digits.
const SPECIAL_KEYS = {
  enter: { key: "Enter", code: "Enter", keyCode: 13 },
  backspace: { key: "Backspace", code: "Backspace", keyCode: 8 },
  tab: { key: "Tab", code: "Tab", keyCode: 9 },
  escape: { key: "Escape", code: "Escape", keyCode: 27 },
  space: { key: " ", code: "Space", keyCode: 32 },
  pageup: { key: "PageUp", code: "PageUp", keyCode: 33 },
  pagedown: { key: "PageDown", code: "PageDown", keyCode: 34 },
  end: { key: "End", code: "End", keyCode: 35 },
  home: { key: "Home", code: "Home", keyCode: 36 },
  arrowleft: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
  arrowup: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
  arrowright: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
  arrowdown: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
  insert: { key: "Insert", code: "Insert", keyCode: 45 },
  delete: { key: "Delete", code: "Delete", keyCode: 46 },
};

function resolveKeyDescriptor(rawKey) {
  const lower = rawKey.toLowerCase();
  if (SPECIAL_KEYS[lower]) return SPECIAL_KEYS[lower];
  if (/^[a-z]$/i.test(rawKey)) {
    const upper = rawKey.toUpperCase();
    return { key: rawKey, code: `Key${upper}`, keyCode: upper.charCodeAt(0) };
  }
  if (/^[0-9]$/.test(rawKey)) {
    return { key: rawKey, code: `Digit${rawKey}`, keyCode: 48 + Number(rawKey) };
  }
  return { key: rawKey, code: rawKey, keyCode: rawKey.charCodeAt(0) || 0 };
}

const MODIFIER_BITS = { alt: 1, control: 2, ctrl: 2, meta: 4, cmd: 4, shift: 8 };

export async function cdpSendKeys(tabId, keysString) {
  if (!(await ensureAttached(tabId))) return false;
  try {
    const parts = keysString.split("+").map((part) => part.trim());
    const keyPart = parts[parts.length - 1];
    const modifiers = parts
      .slice(0, -1)
      .map((mod) => mod.toLowerCase())
      .reduce((bits, name) => bits | (MODIFIER_BITS[name] ?? 0), 0);
    const descriptor = resolveKeyDescriptor(keyPart);
    const base = {
      key: descriptor.key,
      code: descriptor.code,
      windowsVirtualKeyCode: descriptor.keyCode,
      nativeVirtualKeyCode: descriptor.keyCode,
      modifiers,
    };
    await sendCommand(tabId, "Input.dispatchKeyEvent", { type: "rawKeyDown", ...base });
    if (descriptor.key.length === 1) {
      await sendCommand(tabId, "Input.dispatchKeyEvent", {
        type: "char",
        ...base,
        text: descriptor.key,
      });
    }
    await sendCommand(tabId, "Input.dispatchKeyEvent", { type: "keyUp", ...base });
    return true;
  } catch (error) {
    console.warn("[OctoLimb] CDP send_keys failed, falling back to DOM key events:", error.message);
    return false;
  }
}
