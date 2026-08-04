import assert from "node:assert/strict";
import test from "node:test";
import { clearComposerInput, shouldSubmitComposer } from "../public/composer.js";

test("Enter submits only after IME composition has completed", () => {
  assert.equal(shouldSubmitComposer({ key: "Enter", shiftKey: false, isComposing: false, keyCode: 13 }), true);
  assert.equal(shouldSubmitComposer({ key: "Enter", shiftKey: true, isComposing: false, keyCode: 13 }), false);
  assert.equal(shouldSubmitComposer({ key: "Enter", shiftKey: false, isComposing: true, keyCode: 13 }), false);
  assert.equal(shouldSubmitComposer({ key: "Enter", shiftKey: false, isComposing: false, keyCode: 229 }), false);
});

test("clearing the composer also emits an input event for UI resizing", () => {
  let dispatched;
  const input = {
    value: "尚未清除",
    dispatchEvent(event) {
      dispatched = event;
    },
  };

  clearComposerInput(input);

  assert.equal(input.value, "");
  assert.equal(dispatched.type, "input");
  assert.equal(dispatched.bubbles, true);
});
