export function updateConversationDrawer(elements, options) {
  const visible = Boolean(options.mobile && options.inChatView && options.open);

  elements.appView.classList.toggle("conversation-drawer-open", visible);
  elements.toggleButton.hidden = !options.inChatView;
  elements.toggleButton.setAttribute("aria-expanded", String(visible));
  elements.backdrop.hidden = !visible;
  elements.backdrop.classList.toggle("hidden", !visible);

  if (options.mobile) {
    elements.sidebar.inert = !visible;
    elements.sidebar.setAttribute("aria-hidden", String(!visible));
  } else {
    elements.sidebar.inert = false;
    elements.sidebar.removeAttribute("aria-hidden");
  }

  return visible;
}
