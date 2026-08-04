export function shouldSubmitComposer(event) {
  return event.key === "Enter"
    && !event.shiftKey
    && !event.isComposing
    && event.keyCode !== 229;
}

export function clearComposerInput(input) {
  input.value = "";
  input.dispatchEvent(new Event("input", { bubbles: true }));
}
