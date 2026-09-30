import { cdpClick, cdpInsertText, cdpSendKeys } from "./cdp.js";

// Reads the interactive-element index built by buildDomTree.js (via
// octolimbIndexPage below) and turns a highlightIndex back into a live DOM
// node, or the viewport-relative center point of one — self-contained, runs
// injected via chrome.scripting.executeScript.
function octolimbDomAction(action, args) {
  const store = (window.__octolimb__ ??= { elements: [] });

  // Nanobrowser's click_element/input_text schemas carry an optional xpath
  // alongside the index, though nanobrowser itself never actually falls
  // back to it (its selectorMap is always rebuilt fresh right before use).
  // Ours persists across separate tool calls, so a stale index (the page
  // changed since the last read_page) is more likely here — use the xpath
  // as a genuine recovery path when given.
  function resolveXPath(xpath) {
    const docs = [document];
    for (const frame of document.querySelectorAll("iframe")) {
      try {
        if (frame.contentDocument) docs.push(frame.contentDocument);
      } catch {
        // Cross-origin iframe; inaccessible from here, skip it.
      }
    }
    for (const doc of docs) {
      try {
        const found = doc.evaluate(
          xpath,
          doc,
          null,
          XPathResult.FIRST_ORDERED_NODE_TYPE,
          null,
        ).singleNodeValue;
        if (found) return found;
      } catch {
        // xpath doesn't resolve against this document; try the next one.
      }
    }
    return null;
  }

  function elementAt(index, xpath) {
    const cached = store.elements[index];
    if (cached && cached.isConnected) return cached;
    if (xpath) {
      const resolved = resolveXPath(xpath);
      if (resolved) return resolved;
    }
    throw new Error(`No element at index ${index}. Call read_page again to refresh indices.`);
  }

  function centerOf(el) {
    el.scrollIntoView({ block: "center" });
    const rect = el.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  }

  function scrollTarget(index) {
    if (index === null || index === undefined) {
      return document.scrollingElement || document.documentElement;
    }
    return elementAt(index);
  }

  switch (action) {
    // Used by the background script to get click/type coordinates for the
    // CDP path, without performing the interaction itself.
    case "_get_center": {
      const el = elementAt(args.index, args.xpath);
      return { ...centerOf(el), tag: el.tagName.toLowerCase() };
    }

    // Plain-DOM fallback tier (used when chrome.debugger isn't available,
    // e.g. DevTools is already attached to the tab) — matches nanobrowser's
    // own click() fallback exactly.
    case "click_element": {
      const el = elementAt(args.index, args.xpath);
      centerOf(el);
      el.click();
      return { clicked: true, tag: el.tagName.toLowerCase(), via: "dom" };
    }

    case "input_text": {
      const el = elementAt(args.index, args.xpath);
      centerOf(el);
      el.focus();
      if ("value" in el) {
        const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value")?.set;
        if (setter) setter.call(el, args.text);
        else el.value = args.text;
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
      } else if (el.isContentEditable) {
        el.textContent = args.text;
        el.dispatchEvent(new Event("input", { bubbles: true }));
      } else {
        throw new Error("Element is not a text input, textarea, or contenteditable element");
      }
      return { typed: true, via: "dom" };
    }

    case "send_keys": {
      const target = document.activeElement || document.body;
      const parts = args.keys.split("+").map((part) => part.trim());
      const keyName = parts[parts.length - 1];
      const modifiers = parts.slice(0, -1).map((mod) => mod.toLowerCase());
      const keyMap = {
        enter: "Enter",
        backspace: "Backspace",
        delete: "Delete",
        escape: "Escape",
        tab: "Tab",
        pageup: "PageUp",
        pagedown: "PageDown",
        home: "Home",
        end: "End",
        arrowup: "ArrowUp",
        arrowdown: "ArrowDown",
        arrowleft: "ArrowLeft",
        arrowright: "ArrowRight",
        insert: "Insert",
        space: " ",
      };
      const key = keyMap[keyName.toLowerCase()] ?? keyName;
      const eventInit = {
        key,
        bubbles: true,
        cancelable: true,
        ctrlKey: modifiers.includes("control") || modifiers.includes("ctrl"),
        shiftKey: modifiers.includes("shift"),
        altKey: modifiers.includes("alt"),
        metaKey: modifiers.includes("meta") || modifiers.includes("cmd"),
      };
      target.dispatchEvent(new KeyboardEvent("keydown", eventInit));
      target.dispatchEvent(new KeyboardEvent("keypress", eventInit));
      target.dispatchEvent(new KeyboardEvent("keyup", eventInit));
      return { sent: true, via: "dom" };
    }

    case "scroll_to_percent": {
      const target = scrollTarget(args.index);
      const max = target.scrollHeight - target.clientHeight;
      const percent = Math.min(100, Math.max(0, args.yPercent ?? 0));
      target.scrollTo({ top: (percent / 100) * max, behavior: "instant" });
      return { scrolled: true };
    }

    case "scroll_to_top": {
      const target = scrollTarget(args.index);
      target.scrollTo({ top: 0, behavior: "instant" });
      return { scrolled: true };
    }

    case "scroll_to_bottom": {
      const target = scrollTarget(args.index);
      target.scrollTo({ top: target.scrollHeight, behavior: "instant" });
      return { scrolled: true };
    }

    case "previous_page": {
      const target = scrollTarget(args.index);
      target.scrollBy({ top: -target.clientHeight, behavior: "instant" });
      return { scrolled: true };
    }

    case "next_page": {
      const target = scrollTarget(args.index);
      target.scrollBy({ top: target.clientHeight, behavior: "instant" });
      return { scrolled: true };
    }

    case "scroll_to_text": {
      const nth = args.nth && args.nth > 0 ? args.nth : 1;
      const needle = args.text.trim().toLowerCase();
      let count = 0;
      let found = null;
      for (const el of document.body.querySelectorAll("*")) {
        const ownText = Array.from(el.childNodes).some(
          (node) =>
            node.nodeType === Node.TEXT_NODE &&
            node.textContent.trim().toLowerCase().includes(needle),
        );
        if (ownText) {
          count += 1;
          if (count === nth) {
            found = el;
            break;
          }
        }
      }
      if (!found) throw new Error(`Text not found: ${args.text}`);
      found.scrollIntoView({ block: "center" });
      return { scrolled: true };
    }

    case "get_dropdown_options": {
      const el = elementAt(args.index);
      if (el.tagName.toLowerCase() !== "select") {
        throw new Error("Element is not a <select> dropdown");
      }
      return {
        options: Array.from(el.options).map((option) => ({
          text: option.text,
          value: option.value,
        })),
      };
    }

    case "select_dropdown_option": {
      const el = elementAt(args.index);
      if (el.tagName.toLowerCase() !== "select") {
        throw new Error("Element is not a <select> dropdown");
      }
      const needle = args.text.trim();
      const option = Array.from(el.options).find((opt) => opt.text.trim() === needle);
      if (!option) throw new Error(`No option with text: ${args.text}`);
      el.value = option.value;
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return { selected: true, value: option.value };
    }

    default:
      throw new Error(`Unknown DOM action: ${action}`);
  }
}

// Runs window.buildDomTree() (loaded separately from buildDomTree.js) and
// resolves its indexed elements to live DOM nodes, cached on
// window.__octolimb__ for click_element/input_text/etc. to use by index.
// Self-contained aside from assuming window.buildDomTree already exists.
function octolimbIndexPage({
  includeText = false,
  maxTextLength = 4000,
  viewportExpansion = 0,
} = {}) {
  // Reset before each build: buildDomTree.js populates this by highlightIndex
  // as it walks (see the OctoLimb addition there), and a stale tail from a
  // previous, larger page would otherwise linger past the new element count.
  window.__octolimbLiveElements = [];

  const { map } = window.buildDomTree({
    showHighlightElements: true,
    focusHighlightIndex: -1,
    viewportExpansion,
    debugMode: false,
    startId: 0,
    startHighlightIndex: 0,
  });

  // Fallback only: buildDomTree.js should always have populated the live
  // reference for every highlightIndex it assigned. XPath can't address
  // shadow-DOM content at all, so this only helps for same-origin-iframe
  // edge cases where the live reference somehow didn't get captured.
  function resolveXPath(xpath) {
    const docs = [document];
    for (const frame of document.querySelectorAll("iframe")) {
      try {
        if (frame.contentDocument) docs.push(frame.contentDocument);
      } catch {
        // Cross-origin iframe; inaccessible from here, skip it.
      }
    }
    for (const doc of docs) {
      try {
        const found = doc.evaluate(
          xpath,
          doc,
          null,
          XPathResult.FIRST_ORDERED_NODE_TYPE,
          null,
        ).singleNodeValue;
        if (found) return found;
      } catch {
        // xpath doesn't resolve against this document; try the next one.
      }
    }
    return null;
  }

  const entries = Object.values(map)
    .filter((node) => node.highlightIndex !== undefined)
    .sort((a, b) => a.highlightIndex - b.highlightIndex);

  const liveElements = window.__octolimbLiveElements || [];
  const cache = [];
  const elements = [];
  for (const node of entries) {
    const el = liveElements[node.highlightIndex] || resolveXPath(node.xpath);
    cache[node.highlightIndex] = el;
    elements.push({
      index: node.highlightIndex,
      tag: node.tagName,
      text: (
        (el && (el.innerText || el.value)) ||
        (node.attributes && node.attributes["aria-label"]) ||
        ""
      )
        .toString()
        .trim()
        .slice(0, 80),
      xpath: node.xpath,
    });
  }
  window.__octolimb__ = { elements: cache };

  // buildDomTree.js's heuristic interactivity check (isHeuristicallyInteractive)
  // over-indexes on sites that nest several <span>/<div> wrapper layers
  // inside one clickable <a>/<button> purely for styling — Reddit's
  // shreddit-* web components do this heavily, so a single link produces
  // 4-5 entries in a row with identical text and no independent action.
  // Each one used to bloat read_page's element list (and therefore every
  // downstream tool call's context, since it's resent on every turn) for
  // no benefit: the model only ever needs to click the outermost
  // interactive ancestor. Drop a non-distinct-interactive-tag entry from
  // what's sent to the model (never from `cache` above, which stays
  // complete so click_element/input_text by index keep working even for
  // an index we chose not to list) when an earlier entry in traversal
  // order is both an ancestor (its xpath is a strict prefix) and shares
  // the same visible text.
  const dedupeExemptTags = new Set([
    "a",
    "button",
    "input",
    "select",
    "textarea",
    "summary",
    "details",
    "label",
    "option",
  ]);
  const dedupedElements = [];
  for (const entry of elements) {
    const isRedundantWrapper =
      !dedupeExemptTags.has(entry.tag) &&
      dedupedElements.some(
        (ancestor) => entry.text === ancestor.text && entry.xpath.startsWith(`${ancestor.xpath}/`),
      );
    if (!isRedundantWrapper) dedupedElements.push(entry);
  }

  return {
    url: location.href,
    title: document.title,
    // Omitted by default (JSON.stringify drops `undefined`) — most steps in
    // a task are "find and click," not "read content," and body text was
    // the single largest contributor to read_page's token cost. Pass
    // include_text: true when the task actually needs page content.
    text: includeText
      ? (document.body ? document.body.innerText : "").slice(0, maxTextLength)
      : undefined,
    elements: dedupedElements,
  };
}

// Runs in the MAIN world (the page's own JS context) so AI-supplied code
// can reach the page's own globals, unlike the functions above which run
// isolated for safety.
function octolimbExecuteJs(code) {
  // Indirect eval (the `(0, eval)` form runs in global scope rather than
  // this function's local scope) returns the completion value of the last
  // statement/expression — REPL semantics, so a bare expression like
  // `document.title` returns its value with no explicit `return` needed.
  // `new Function(code)` does NOT have this behavior: a bare expression
  // statement in a function body is evaluated and discarded, so every
  // bare-expression call would silently return undefined.
  try {
    // eslint-disable-next-line no-eval -- deliberate: this tool's entire
    // purpose is running AI-supplied code in the page context.
    return (0, eval)(code);
  } catch (error) {
    if (error instanceof SyntaxError && /return|illegal/i.test(error.message)) {
      // The code used a top-level `return` (function-body style, e.g. code
      // ported from a `new Function` convention) — retry as a function body.
      // eslint-disable-next-line no-new-func -- see note above.
      return new Function(code)();
    }
    throw error;
  }
}

// The tab this task is pinned to. Every action targets this tab by id —
// never "whatever tab happens to be active/focused right now" — so a task
// stays correct even if the user clicks into a different tab mid-task
// (chrome.scripting.executeScript and chrome.debugger both work against a
// background tab by id just fine, so nothing here needs the tab to be
// foregrounded). Reset to null by done() and by close_tab on this tab, so
// the next task starts its own fresh tab rather than inheriting this one.
let currentTabId = null;

/**
 * Navigates the task's tab to `url`, creating a new tab for it if none is
 * pinned yet (or the pinned one was closed) — this is what makes go_to_url/
 * search_google "start a new tab per task" instead of hijacking whatever
 * tab the user was already looking at.
 */
async function ensureTaskTab(url) {
  if (currentTabId !== null) {
    try {
      await chrome.tabs.get(currentTabId);
      await chrome.tabs.update(currentTabId, { url });
      await waitForTabLoad(currentTabId);
      return currentTabId;
    } catch {
      currentTabId = null; // pinned tab is gone; fall through to create a fresh one
    }
  }
  const tab = await chrome.tabs.create({ url });
  currentTabId = tab.id;
  await waitForTabLoad(tab.id);
  return tab.id;
}

/** Returns the task's pinned tab — every non-navigation action uses this, never the active tab. */
async function getTaskTab() {
  if (currentTabId === null) {
    throw new Error(
      "No active OctoLimb task tab. Call go_to_url, open_tab, or search_google first to start one.",
    );
  }
  try {
    return await chrome.tabs.get(currentTabId);
  } catch {
    currentTabId = null;
    throw new Error(
      "The OctoLimb task tab was closed. Call go_to_url, open_tab, or search_google to start a new one.",
    );
  }
}

function waitForTabLoad(tabId) {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }, 10_000);
    function listener(updatedTabId, info) {
      if (updatedTabId === tabId && info.status === "complete") {
        clearTimeout(timeout);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function ensureBuildDomTreeLoaded(tabId) {
  const [{ result: alreadyLoaded }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => typeof window.buildDomTree === "function",
  });
  if (!alreadyLoaded) {
    await chrome.scripting.executeScript({ target: { tabId }, files: ["buildDomTree.js"] });
  }
}

async function runDomAction(tabId, action, args) {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: octolimbDomAction,
    args: [action, args],
  });
  return result;
}

const SCROLL_AND_DROPDOWN_ACTIONS = new Set([
  "scroll_to_percent",
  "scroll_to_top",
  "scroll_to_bottom",
  "previous_page",
  "next_page",
  "scroll_to_text",
  "get_dropdown_options",
  "select_dropdown_option",
]);

export async function runTool(tool, args) {
  // `intent` mirrors nanobrowser's own action schemas ("purpose of this
  // action"); nanobrowser only ever uses it for a progress message, never
  // for the interaction itself, so we do the same here.
  if (args && args.intent) {
    console.log(`[OctoLimb] ${tool}: ${args.intent}`);
  }

  switch (tool) {
    case "done":
      // Task over — the next task pins its own fresh tab rather than
      // silently continuing to act on this one.
      currentTabId = null;
      return { done: true, success: !!args.success, text: args.text ?? "" };

    case "cache_content":
      return { cached: true, content: args.content ?? "" };

    case "wait": {
      const seconds = Math.min(Math.max(args.seconds ?? 3, 0), 30);
      await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
      return { waited: seconds };
    }

    case "search_google": {
      const url = `https://www.google.com/search?q=${encodeURIComponent(args.query)}`;
      await ensureTaskTab(url);
      return { navigated: true, url };
    }

    case "go_to_url": {
      if (!args.url) throw new Error("go_to_url requires a 'url' argument");
      await ensureTaskTab(args.url);
      return { navigated: true, url: args.url };
    }

    case "go_back": {
      const tab = await getTaskTab();
      await chrome.tabs.goBack(tab.id);
      await waitForTabLoad(tab.id);
      return { wentBack: true };
    }

    case "switch_tab": {
      const tab = await chrome.tabs.update(args.tab_id, { active: true });
      if (tab && tab.windowId !== undefined) {
        await chrome.windows.update(tab.windowId, { focused: true });
      }
      // An explicit switch re-pins the task to this tab (e.g. following a
      // link that opened a new tab), same as open_tab.
      currentTabId = args.tab_id;
      return { switched: true, tabId: args.tab_id };
    }

    case "open_tab": {
      const tab = await chrome.tabs.create({ url: args.url });
      currentTabId = tab.id;
      return { opened: true, tabId: tab.id };
    }

    case "close_tab": {
      await chrome.tabs.remove(args.tab_id);
      if (currentTabId === args.tab_id) currentTabId = null;
      return { closed: true, tabId: args.tab_id };
    }

    case "read_page": {
      const tab = await getTaskTab();
      await ensureBuildDomTreeLoaded(tab.id);
      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: octolimbIndexPage,
        args: [
          {
            includeText: args.include_text ?? false,
            maxTextLength: args.max_text_length ?? 4000,
            viewportExpansion: args.viewport_expansion ?? 0,
          },
        ],
      });
      return result;
    }

    case "click_element": {
      const tab = await getTaskTab();
      const center = await runDomAction(tab.id, "_get_center", {
        index: args.index,
        xpath: args.xpath,
      });
      if (await cdpClick(tab.id, center.x, center.y)) {
        return { clicked: true, tag: center.tag, via: "cdp" };
      }
      return runDomAction(tab.id, "click_element", args);
    }

    case "input_text": {
      const tab = await getTaskTab();
      const center = await runDomAction(tab.id, "_get_center", {
        index: args.index,
        xpath: args.xpath,
      });
      if (await cdpInsertText(tab.id, center.x, center.y, args.text)) {
        return { typed: true, via: "cdp" };
      }
      return runDomAction(tab.id, "input_text", args);
    }

    case "send_keys": {
      const tab = await getTaskTab();
      if (await cdpSendKeys(tab.id, args.keys)) {
        return { sent: true, via: "cdp" };
      }
      return runDomAction(tab.id, "send_keys", args);
    }

    case "execute_js": {
      if (typeof args.code !== "string") {
        throw new Error("execute_js requires a 'code' string argument");
      }
      const tab = await getTaskTab();
      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        world: "MAIN",
        func: octolimbExecuteJs,
        args: [args.code],
      });
      return result;
    }

    default: {
      if (SCROLL_AND_DROPDOWN_ACTIONS.has(tool)) {
        const tab = await getTaskTab();
        return runDomAction(tab.id, tool, args);
      }
      throw new Error(`Unknown tool: ${tool}`);
    }
  }
}
