import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { updateConversationDrawer } from "../public/mobile-navigation.js";

function fakeElement() {
  const classes = new Set();
  const attributes = new Map();
  return {
    hidden: false,
    inert: false,
    classList: {
      contains: (name) => classes.has(name),
      toggle(name, force) {
        if (force) classes.add(name);
        else classes.delete(name);
      },
    },
    getAttribute: (name) => attributes.get(name),
    setAttribute: (name, value) => attributes.set(name, value),
    removeAttribute: (name) => attributes.delete(name),
  };
}

function fixture() {
  return {
    appView: fakeElement(),
    sidebar: fakeElement(),
    toggleButton: fakeElement(),
    backdrop: fakeElement(),
  };
}

test("the conversation drawer exposes matching mobile accessibility state", () => {
  const elements = fixture();
  assert.equal(updateConversationDrawer(elements, { mobile: true, inChatView: true, open: true }), true);
  assert.equal(elements.appView.classList.contains("conversation-drawer-open"), true);
  assert.equal(elements.toggleButton.getAttribute("aria-expanded"), "true");
  assert.equal(elements.toggleButton.hidden, false);
  assert.equal(elements.backdrop.hidden, false);
  assert.equal(elements.sidebar.inert, false);
  assert.equal(elements.sidebar.getAttribute("aria-hidden"), "false");
});

test("the drawer stays closed outside chat and cannot trap focus", () => {
  const elements = fixture();
  assert.equal(updateConversationDrawer(elements, { mobile: true, inChatView: false, open: true }), false);
  assert.equal(elements.appView.classList.contains("conversation-drawer-open"), false);
  assert.equal(elements.toggleButton.getAttribute("aria-expanded"), "false");
  assert.equal(elements.toggleButton.hidden, true);
  assert.equal(elements.backdrop.hidden, true);
  assert.equal(elements.sidebar.inert, true);
  assert.equal(elements.sidebar.getAttribute("aria-hidden"), "true");
});

test("desktop restores the existing sidebar semantics", () => {
  const elements = fixture();
  elements.sidebar.setAttribute("aria-hidden", "true");
  elements.sidebar.inert = true;
  updateConversationDrawer(elements, { mobile: false, inChatView: true, open: true });
  assert.equal(elements.sidebar.inert, false);
  assert.equal(elements.sidebar.getAttribute("aria-hidden"), undefined);
  assert.equal(elements.appView.classList.contains("conversation-drawer-open"), false);
});

test("the mobile shell keeps all destinations and phone viewport safeguards", () => {
  const index = fs.readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  const styles = fs.readFileSync(new URL("../public/styles.css", import.meta.url), "utf8");
  const mobileNavigation = index.match(/<nav class="mobile-navigation"[\s\S]*?<\/nav>/)?.[0] || "";

  assert.equal((mobileNavigation.match(/data-view=/g) || []).length, 4);
  assert.match(index, /aria-controls="conversationDrawer"/);
  assert.match(styles, /@media \(max-width: 820px\)/);
  assert.match(styles, /height: 100dvh/);
  assert.match(styles, /safe-area-inset-bottom/);
});
