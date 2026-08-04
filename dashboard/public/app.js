const state = {
  conversations: [],
  current: null,
  sending: false,
};

const $ = (selector) => document.querySelector(selector);
const elements = {
  loginView: $("#loginView"),
  appView: $("#appView"),
  loginForm: $("#loginForm"),
  loginError: $("#loginError"),
  password: $("#password"),
  logoutButton: $("#logoutButton"),
  newChatButton: $("#newChatButton"),
  emptyNewChat: $("#emptyNewChat"),
  conversationList: $("#conversationList"),
  conversationTitle: $("#conversationTitle"),
  emptyState: $("#emptyState"),
  chatView: $("#chatView"),
  messageList: $("#messageList"),
  composer: $("#composer"),
  messageInput: $("#messageInput"),
  sendButton: $("#sendButton"),
  thinkingToggle: $("#thinkingToggle"),
  maxTokens: $("#maxTokens"),
  statusPill: $("#statusPill"),
  statusText: $("#statusText"),
  panel: $("#panel"),
  panelTitle: $("#panelTitle"),
  panelEyebrow: $("#panelEyebrow"),
  panelContent: $("#panelContent"),
  closePanel: $("#closePanel"),
  toast: $("#toast"),
};

async function request(url, options = {}) {
  const response = await fetch(url, {
    credentials: "same-origin",
    ...options,
    headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...options.headers,
    },
  });
  const contentType = response.headers.get("content-type") || "";
  const data = contentType.includes("application/json")
    ? await response.json()
    : await response.text();
  if (!response.ok) {
    const message = data?.error?.message || data?.message || `HTTP ${response.status}`;
    throw new Error(message);
  }
  return data;
}

function showToast(message) {
  elements.toast.textContent = message;
  elements.toast.classList.remove("hidden");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => elements.toast.classList.add("hidden"), 2400);
}

function escapeHtml(value = "") {
  return value.replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;",
  })[character]);
}

function formatDate(value) {
  if (!value) return "尚未使用";
  return new Intl.DateTimeFormat("zh-TW", {
    month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
  }).format(new Date(value));
}

async function bootstrap() {
  try {
    await request("/api/auth/me");
    showApp();
  } catch {
    showLogin();
  }
}

function showLogin() {
  elements.appView.classList.add("hidden");
  elements.loginView.classList.remove("hidden");
  elements.password.focus();
}

async function showApp() {
  elements.loginView.classList.add("hidden");
  elements.appView.classList.remove("hidden");
  await Promise.all([loadConversations(), refreshStatus()]);
}

async function refreshStatus() {
  elements.statusPill.className = "status-pill checking";
  elements.statusText.textContent = "檢查模型";
  try {
    const result = await request("/api/status");
    elements.statusPill.className = "status-pill online";
    elements.statusText.textContent = `模型在線 · ${result.latency_ms}ms`;
  } catch {
    elements.statusPill.className = "status-pill offline";
    elements.statusText.textContent = "模型離線";
  }
}

async function loadConversations(selectId) {
  const result = await request("/api/conversations");
  state.conversations = result.data || [];
  renderConversationList();
  if (selectId) await selectConversation(selectId);
}

function renderConversationList() {
  elements.conversationList.innerHTML = state.conversations.map((conversation) => `
    <button class="conversation-item ${state.current?.id === conversation.id ? "active" : ""}"
      data-conversation-id="${conversation.id}">
      <strong>${escapeHtml(conversation.title)}</strong>
      <span>${conversation.message_count} 則訊息 · ${formatDate(conversation.updated_at)}</span>
    </button>
  `).join("");
  elements.conversationList.querySelectorAll("[data-conversation-id]").forEach((button) => {
    button.addEventListener("click", () => selectConversation(button.dataset.conversationId));
  });
}

async function createConversation() {
  const conversation = await request("/api/conversations", {
    method: "POST",
    body: JSON.stringify({}),
  });
  await loadConversations(conversation.id);
  elements.messageInput.focus();
}

async function selectConversation(id) {
  state.current = await request(`/api/conversations/${id}`);
  elements.emptyState.classList.add("hidden");
  elements.chatView.classList.remove("hidden");
  elements.conversationTitle.textContent = state.current.title;
  renderConversationList();
  renderMessages();
}

function renderMessages() {
  elements.messageList.innerHTML = state.current.messages
    .map((message) => messageHtml(message))
    .join("");
  scrollMessages();
}

function messageHtml(message, pending = false) {
  const label = message.role === "user" ? "YOU" : "SWIFTLM";
  return `
    <article class="message ${message.role} ${pending ? "pending" : ""}" ${pending ? 'id="pendingAssistant"' : ""}>
      <div class="message-role">${label}</div>
      <div class="message-content">${escapeHtml(message.content)}</div>
    </article>
  `;
}

function scrollMessages() {
  elements.messageList.scrollTop = elements.messageList.scrollHeight;
}

function resizeComposer() {
  elements.messageInput.style.height = "auto";
  elements.messageInput.style.height = `${Math.min(elements.messageInput.scrollHeight, 180)}px`;
}

async function sendMessage(event) {
  event.preventDefault();
  const content = elements.messageInput.value.trim();
  if (!content || !state.current || state.sending) return;

  state.sending = true;
  elements.sendButton.disabled = true;
  elements.messageInput.value = "";
  resizeComposer();
  state.current.messages.push({ role: "user", content, created_at: new Date().toISOString() });
  renderMessages();
  elements.messageList.insertAdjacentHTML("beforeend", messageHtml({ role: "assistant", content: "" }, true));
  const pending = $("#pendingAssistant");
  const output = pending.querySelector(".message-content");
  scrollMessages();

  try {
    const response = await fetch(`/api/conversations/${state.current.id}/messages`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content,
        enable_thinking: elements.thinkingToggle.checked,
        max_tokens: Number(elements.maxTokens.value),
        temperature: 0.7,
      }),
    });
    if (!response.ok || !response.body) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error?.error?.message || `HTTP ${response.status}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let assistant = "";

    const consume = (eventText) => {
      const eventName = eventText.split("\n").find((line) => line.startsWith("event:"))?.slice(6).trim();
      const data = eventText.split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart()).join("\n");
      if (!data || data === "[DONE]" || eventName === "dashboard") return;
      if (eventName === "error") {
        throw new Error(JSON.parse(data).message || "串流失敗");
      }
      try {
        assistant += JSON.parse(data).choices?.[0]?.delta?.content || "";
      } catch {
        assistant += data;
      }
      output.textContent = assistant;
      scrollMessages();
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
      let boundary;
      while ((boundary = buffer.indexOf("\n\n")) >= 0) {
        consume(buffer.slice(0, boundary));
        buffer = buffer.slice(boundary + 2);
      }
    }
    if (buffer.trim()) consume(buffer);
    pending.classList.remove("pending");
    await loadConversations(state.current.id);
  } catch (error) {
    pending.classList.remove("pending");
    output.textContent = `請求失敗：${error.message}`;
    await refreshStatus();
  } finally {
    state.sending = false;
    elements.sendButton.disabled = false;
    elements.messageInput.focus();
  }
}

async function openPanel(type) {
  elements.panel.classList.remove("hidden");
  if (type === "keys") await renderKeysPanel();
  if (type === "activity") await renderActivityPanel();
}

async function renderKeysPanel(revealedKey) {
  elements.panelTitle.textContent = "API Keys";
  elements.panelEyebrow.textContent = "ACCESS MANAGEMENT";
  const result = await request("/api/keys");
  elements.panelContent.innerHTML = `
    ${revealedKey ? `
      <div class="key-reveal">
        <strong>只會顯示這一次</strong>
        <code>${escapeHtml(revealedKey)}</code>
        <button class="primary" id="copyRevealedKey">複製 Key</button>
      </div>
    ` : ""}
    <form id="createKeyForm" class="panel-toolbar">
      <input id="keyName" placeholder="例如：MacBook、測試服務" maxlength="80" required />
      <button class="primary" type="submit">建立</button>
    </form>
    <div>
      ${result.data.length ? result.data.map((key) => `
        <div class="card-row">
          <div class="card-row-head">
            <div><strong>${escapeHtml(key.name)}</strong><br /><code>${escapeHtml(key.prefix)}</code></div>
            ${key.revoked_at
              ? '<span class="muted">已撤銷</span>'
              : `<button class="danger-button" data-revoke-key="${key.id}">撤銷</button>`}
          </div>
          <p>建立：${formatDate(key.created_at)} · 最近使用：${formatDate(key.last_used_at)}</p>
        </div>
      `).join("") : '<p class="muted">尚未建立 Dashboard API Key。</p>'}
    </div>
  `;

  $("#createKeyForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const created = await request("/api/keys", {
      method: "POST",
      body: JSON.stringify({ name: $("#keyName").value }),
    });
    await renderKeysPanel(created.key);
  });
  $("#copyRevealedKey")?.addEventListener("click", async () => {
    await navigator.clipboard.writeText(revealedKey);
    showToast("API Key 已複製");
  });
  elements.panelContent.querySelectorAll("[data-revoke-key]").forEach((button) => {
    button.addEventListener("click", async () => {
      if (!confirm("確定撤銷這把 API Key？使用它的程式會立即失效。")) return;
      await request(`/api/keys/${button.dataset.revokeKey}/revoke`, { method: "POST" });
      await renderKeysPanel();
    });
  });
}

async function renderActivityPanel() {
  elements.panelTitle.textContent = "使用紀錄";
  elements.panelEyebrow.textContent = "REQUEST HISTORY";
  const result = await request("/api/activity?limit=100");
  elements.panelContent.innerHTML = result.data.length ? result.data.map((entry) => `
    <div class="card-row">
      <div class="card-row-head">
        <strong>${escapeHtml(entry.route)}</strong>
        <span>${entry.status} · ${entry.latency_ms}ms</span>
      </div>
      <p>${formatDate(entry.created_at)} · ${escapeHtml(entry.api_key_name || "Dashboard")}
      ${entry.prompt_tokens == null ? "" : ` · ${entry.prompt_tokens}+${entry.completion_tokens || 0} tokens`}</p>
      ${entry.response_preview ? `<p>${escapeHtml(entry.response_preview.slice(0, 180))}</p>` : ""}
    </div>
  `).join("") : '<p class="muted">尚無使用紀錄。</p>';
}

elements.loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  elements.loginError.textContent = "";
  try {
    await request("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ password: elements.password.value }),
    });
    elements.password.value = "";
    await showApp();
  } catch (error) {
    elements.loginError.textContent = error.message;
  }
});

elements.logoutButton.addEventListener("click", async () => {
  await request("/api/auth/logout", { method: "POST" });
  state.current = null;
  showLogin();
});
elements.newChatButton.addEventListener("click", createConversation);
elements.emptyNewChat.addEventListener("click", createConversation);
elements.composer.addEventListener("submit", sendMessage);
elements.messageInput.addEventListener("input", resizeComposer);
elements.messageInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    elements.composer.requestSubmit();
  }
});
elements.closePanel.addEventListener("click", () => elements.panel.classList.add("hidden"));
document.querySelectorAll("[data-panel]").forEach((button) => {
  button.addEventListener("click", () => openPanel(button.dataset.panel));
});

bootstrap();
