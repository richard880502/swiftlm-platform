import { clearComposerInput, shouldSubmitComposer } from "./composer.js";

const state = {
  conversations: [],
  nodes: [],
  current: null,
  currentView: "chat",
  sending: false,
  query: "",
  generationPollTimer: null,
  statusPollTimer: null,
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
  conversationSearch: $("#conversationSearch"),
  conversationSection: $("#conversationSection"),
  conversationList: $("#conversationList"),
  chatWorkspace: $("#chatWorkspace"),
  activityWorkspace: $("#activityWorkspace"),
  keysWorkspace: $("#keysWorkspace"),
  nodesWorkspace: $("#nodesWorkspace"),
  viewEyebrow: $("#viewEyebrow"),
  viewTitle: $("#viewTitle"),
  viewDescription: $("#viewDescription"),
  deleteConversationButton: $("#deleteConversationButton"),
  emptyState: $("#emptyState"),
  chatView: $("#chatView"),
  messageList: $("#messageList"),
  composer: $("#composer"),
  messageInput: $("#messageInput"),
  sendButton: $("#sendButton"),
  thinkingToggle: $("#thinkingToggle"),
  maxTokens: $("#maxTokens"),
  conversationNode: $("#conversationNode"),
  conversationModel: $("#conversationModel"),
  statusPill: $("#statusPill"),
  statusText: $("#statusText"),
  sidebarStatusText: $("#sidebarStatusText"),
  requestCount: $("#requestCount"),
  successRate: $("#successRate"),
  averageLatency: $("#averageLatency"),
  activityList: $("#activityList"),
  refreshActivityButton: $("#refreshActivityButton"),
  keyReveal: $("#keyReveal"),
  createKeyForm: $("#createKeyForm"),
  keyName: $("#keyName"),
  keyNode: $("#keyNode"),
  keyList: $("#keyList"),
  nodeCount: $("#nodeCount"),
  onlineNodeCount: $("#onlineNodeCount"),
  availableModelCount: $("#availableModelCount"),
  nodeList: $("#nodeList"),
  refreshNodesButton: $("#refreshNodesButton"),
  createNodeForm: $("#createNodeForm"),
  nodeName: $("#nodeName"),
  nodeModelName: $("#nodeModelName"),
  nodeModelId: $("#nodeModelId"),
  nodeOrigin: $("#nodeOrigin"),
  toast: $("#toast"),
};

const viewCopy = {
  chat: {
    eyebrow: "CONVERSATIONS",
    title: "對話",
    description: "在你的 Mac 上與本機模型安全對談。",
  },
  activity: {
    eyebrow: "REQUEST HISTORY",
    title: "使用紀錄",
    description: "檢視每一筆模型請求、延遲與 Token 使用量。",
  },
  keys: {
    eyebrow: "ACCESS MANAGEMENT",
    title: "API Keys",
    description: "建立與管理可呼叫 OpenAI 相容端點的存取金鑰。",
  },
  nodes: {
    eyebrow: "MODEL NODES",
    title: "機器",
    description: "管理可透過 Wonder Mesh 存取的 SwiftLM 模型節點。",
  },
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
  return String(value).replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;",
  })[character]);
}

function formatDate(value) {
  if (!value) return "尚未使用";
  return new Intl.DateTimeFormat("zh-TW", {
    month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
  }).format(new Date(value));
}

function formatNumber(value) {
  return new Intl.NumberFormat("zh-TW").format(Number(value) || 0);
}

async function bootstrap() {
  try {
    await request("/api/auth/me");
    await showApp();
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
  await Promise.all([loadConversations(), loadNodes()]);
  switchView("chat");
  const lastConversationId = localStorage.getItem("swiftlm:lastConversation");
  if (lastConversationId && state.conversations.some(({ id }) => id === lastConversationId)) {
    await selectConversation(lastConversationId);
  }
}

function currentNode() {
  return state.nodes.find((node) => node.id === state.current?.node_id) || state.nodes[0] || null;
}

function renderNodeOptions() {
  const enabled = state.nodes.filter((node) => node.enabled);
  const selectedId = state.current?.node_id || enabled[0]?.id || "";
  const options = enabled.map((node) => `<option value="${escapeHtml(node.id)}">${escapeHtml(node.name)}</option>`).join("");
  elements.conversationNode.innerHTML = options;
  elements.keyNode.innerHTML = options;
  elements.conversationNode.value = selectedId;
  elements.keyNode.value = selectedId;
  renderModelOptions(selectedId);
}

function renderModelOptions(nodeId = elements.conversationNode.value) {
  const node = state.nodes.find((item) => item.id === nodeId);
  const value = node?.model_id || "";
  elements.conversationModel.innerHTML = node
    ? `<option value="${escapeHtml(value)}">${escapeHtml(node.model_name)}</option>`
    : "";
  elements.conversationModel.value = state.current?.model_id === value ? value : value;
}

function updateNodeStatus() {
  const node = currentNode();
  const online = state.nodes.filter((item) => item.status?.state === "online").length;
  elements.sidebarStatusText.textContent = state.nodes.length
    ? `${online} / ${state.nodes.length} 台已連線`
    : "尚未加入機器";
  clearTimeout(state.statusPollTimer);
  state.statusPollTimer = setTimeout(loadNodes, 5000);
  elements.statusPill.className = "status-pill checking";
  elements.statusText.textContent = "檢查模型";
  if (node?.status?.state === "online") {
    elements.statusPill.className = "status-pill online";
    elements.statusText.textContent = `${node.name} · ${node.status.latency_ms}ms`;
  } else if (node?.status?.state === "disabled") {
    elements.statusPill.className = "status-pill checking";
    elements.statusText.textContent = `${node.name} · 已停用`;
  } else if (node) {
    elements.statusPill.className = "status-pill offline";
    elements.statusText.textContent = `${node.name} · 模型離線`;
  } else {
    elements.statusPill.className = "status-pill offline";
    elements.statusText.textContent = "尚未加入機器";
  }
}

async function loadNodes() {
  try {
    const result = await request("/api/nodes");
    state.nodes = result.data || [];
    renderNodeOptions();
    updateNodeStatus();
    if (state.currentView === "nodes") renderNodes();
  } catch {
    state.nodes = [];
    updateNodeStatus();
  }
}

async function loadConversations(selectId) {
  const result = await request("/api/conversations");
  state.conversations = result.data || [];
  renderConversationList();
  if (selectId) await selectConversation(selectId);
}

function renderConversationList() {
  const normalized = state.query.trim().toLocaleLowerCase("zh-Hant");
  const visible = state.conversations.filter((conversation) => (
    !normalized
      || conversation.title.toLocaleLowerCase("zh-Hant").includes(normalized)
      || conversation.last_message?.toLocaleLowerCase("zh-Hant").includes(normalized)
  ));

  elements.conversationList.innerHTML = visible.length ? visible.map((conversation) => `
    <button class="conversation-item ${state.current?.id === conversation.id ? "active" : ""}"
      data-conversation-id="${conversation.id}">
      <span class="conversation-symbol" aria-hidden="true"></span>
      <span class="conversation-copy">
        <strong>${escapeHtml(conversation.title)}</strong>
        <small>${conversation.message_count} 則訊息 · ${formatDate(conversation.updated_at)}</small>
      </span>
    </button>
  `).join("") : `<p class="conversation-empty">${normalized ? "找不到符合的對話" : "還沒有對話"}</p>`;

  elements.conversationList.querySelectorAll("[data-conversation-id]").forEach((button) => {
    button.addEventListener("click", () => selectConversation(button.dataset.conversationId));
  });
}

async function createConversation() {
  const node = (state.current && state.nodes.find((item) => item.id === state.current.node_id && item.enabled))
    || state.nodes.find((item) => item.enabled);
  if (!node) return showToast("請先在「機器」加入可用的模型節點");
  try {
    const conversation = await request("/api/conversations", {
      method: "POST",
      body: JSON.stringify({ node_id: node.id, model_id: node.model_id }),
    });
    switchView("chat");
    await loadConversations(conversation.id);
    elements.messageInput.focus();
  } catch (error) {
    showToast(error.message);
  }
}

async function selectConversation(id) {
  stopGenerationPolling();
  state.current = await request(`/api/conversations/${id}`);
  localStorage.setItem("swiftlm:lastConversation", state.current.id);
  switchView("chat", { preserveTitle: true });
  elements.emptyState.classList.add("hidden");
  elements.chatView.classList.remove("hidden");
  updateConversationHeader();
  renderNodeOptions();
  renderConversationList();
  renderMessages();
  scheduleGenerationPolling();
}

function updateConversationHeader() {
  const busy = state.sending || state.current.generation_in_progress;
  elements.viewTitle.textContent = state.current.title;
  elements.viewDescription.textContent = state.current.generation_in_progress
    ? "模型仍在生成 · 完成後會自動更新"
    : `${state.current.node_name} · ${state.current.model_name} · ${state.current.messages.length} 則訊息`;
  elements.deleteConversationButton.classList.remove("hidden");
  elements.deleteConversationButton.disabled = busy;
  elements.sendButton.disabled = busy;
  elements.messageInput.disabled = busy;
  const targetLocked = busy || state.current.messages.length > 0;
  elements.conversationNode.disabled = targetLocked;
  elements.conversationModel.disabled = targetLocked;
}

function stopGenerationPolling() {
  clearTimeout(state.generationPollTimer);
  state.generationPollTimer = null;
}

function scheduleGenerationPolling() {
  stopGenerationPolling();
  if (!state.current?.generation_in_progress) return;
  const conversationId = state.current.id;
  state.generationPollTimer = setTimeout(async () => {
    if (state.current?.id !== conversationId) return;
    try {
      const updated = await request(`/api/conversations/${conversationId}`);
      if (state.current?.id !== conversationId) return;
      const wasGenerating = state.current.generation_in_progress;
      state.current = updated;
      updateConversationHeader();
      renderMessages();
      await loadConversations();
      if (updated.generation_in_progress) {
        scheduleGenerationPolling();
      } else if (wasGenerating) {
        showToast("回答已完成");
      }
    } catch {
      scheduleGenerationPolling();
    }
  }, 1500);
}

async function deleteCurrentConversation() {
  if (!state.current || state.sending || state.current.generation_in_progress) return;
  const title = state.current.title;
  if (!confirm(`確定刪除「${title}」？\n\n這個對話與其中的訊息將永久刪除。`)) return;
  await request(`/api/conversations/${state.current.id}`, { method: "DELETE" });
  localStorage.removeItem("swiftlm:lastConversation");
  stopGenerationPolling();
  state.current = null;
  elements.chatView.classList.add("hidden");
  elements.emptyState.classList.remove("hidden");
  elements.deleteConversationButton.classList.add("hidden");
  applyViewCopy("chat");
  await loadConversations();
  showToast("對話已刪除");
}

function renderMessages() {
  const messages = state.current.messages
    .map((message) => messageHtml(message))
    .join("");
  const recovering = state.current.generation_in_progress && !state.sending
    ? messageHtml({ role: "assistant", content: "模型仍在生成，重新整理不會中斷回答…" }, true, "recoveringAssistant")
    : "";
  elements.messageList.innerHTML = messages + recovering;
  scrollMessages();
}

function messageHtml(message, pending = false, id = pending ? "pendingAssistant" : "") {
  const isUser = message.role === "user";
  return `
    <article class="message ${message.role} ${pending ? "pending" : ""}" ${id ? `id="${id}"` : ""}>
      <div class="message-avatar" aria-hidden="true">${isUser ? "你" : "S"}</div>
      <div class="message-body">
        <div class="message-meta"><strong>${isUser ? "你" : "SwiftLM"}</strong><span>${isUser ? "剛剛" : "本機模型"}</span></div>
        <div class="message-content">${escapeHtml(message.content)}</div>
      </div>
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
  if (!content || !state.current || state.sending || state.current.generation_in_progress) return;

  state.sending = true;
  state.current.generation_in_progress = true;
  elements.sendButton.disabled = true;
  elements.deleteConversationButton.disabled = true;
  clearComposerInput(elements.messageInput);
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
      if (eventName === "error") throw new Error(JSON.parse(data).message || "串流失敗");
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
    state.current.generation_in_progress = false;
    pending.classList.remove("pending");
    output.textContent = `請求失敗：${error.message}`;
    await loadNodes();
  } finally {
    state.sending = false;
    const stillGenerating = Boolean(state.current?.generation_in_progress);
    elements.sendButton.disabled = stillGenerating;
    elements.deleteConversationButton.disabled = stillGenerating;
    elements.messageInput.disabled = stillGenerating;
    if (!stillGenerating) elements.messageInput.focus();
  }
}

function applyViewCopy(type) {
  const copy = viewCopy[type];
  elements.viewEyebrow.textContent = copy.eyebrow;
  elements.viewTitle.textContent = copy.title;
  elements.viewDescription.textContent = copy.description;
}

function switchView(type, options = {}) {
  state.currentView = type;
  elements.chatWorkspace.classList.toggle("hidden", type !== "chat");
  elements.activityWorkspace.classList.toggle("hidden", type !== "activity");
  elements.keysWorkspace.classList.toggle("hidden", type !== "keys");
  elements.nodesWorkspace.classList.toggle("hidden", type !== "nodes");
  elements.conversationSection.classList.toggle("view-muted", type !== "chat");
  elements.deleteConversationButton.classList.toggle("hidden", type !== "chat" || !state.current);
  document.querySelectorAll("[data-view]").forEach((button) => {
    button.classList.toggle("active", button.dataset.view === type);
  });
  if (!options.preserveTitle) applyViewCopy(type);
  if (type === "activity") renderActivity();
  if (type === "keys") renderKeys();
  if (type === "nodes") renderNodes();
}

async function renderActivity() {
  elements.activityList.innerHTML = '<div class="loading-row">正在載入使用紀錄…</div>';
  try {
    const result = await request("/api/activity?limit=100");
    const entries = result.data || [];
    const successful = entries.filter((entry) => entry.status >= 200 && entry.status < 300).length;
    const average = entries.length
      ? Math.round(entries.reduce((sum, entry) => sum + (entry.latency_ms || 0), 0) / entries.length)
      : 0;
    elements.requestCount.textContent = formatNumber(entries.length);
    elements.successRate.textContent = entries.length ? `${Math.round((successful / entries.length) * 100)}%` : "—";
    elements.averageLatency.textContent = entries.length ? `${formatNumber(average)} ms` : "—";
    elements.activityList.innerHTML = entries.length ? entries.map((entry) => {
      const tokens = entry.prompt_tokens == null
        ? "未回報 Token"
        : `${formatNumber(entry.prompt_tokens)} + ${formatNumber(entry.completion_tokens)} tokens`;
      const success = entry.status >= 200 && entry.status < 300;
      return `
        <article class="activity-row">
          <span class="request-indicator ${success ? "success" : "failed"}" aria-hidden="true"></span>
          <div class="activity-main">
            <div class="activity-title"><strong>${escapeHtml(entry.route)}</strong><span>${formatDate(entry.created_at)}</span></div>
            <p>${escapeHtml(entry.node_name || "未指定機器")} · ${escapeHtml(entry.model_name || entry.model || "模型")} · ${escapeHtml(entry.api_key_name || "Dashboard")} · ${tokens}</p>
            ${entry.response_preview ? `<p class="response-preview">${escapeHtml(entry.response_preview.slice(0, 180))}</p>` : ""}
          </div>
          <div class="activity-metrics"><strong>${entry.status}</strong><span>${formatNumber(entry.latency_ms)} ms</span></div>
        </article>
      `;
    }).join("") : '<div class="empty-list"><strong>尚無使用紀錄</strong><span>開始對話或使用 API 後，請求會顯示在這裡。</span></div>';
  } catch (error) {
    elements.activityList.innerHTML = `<div class="empty-list error"><strong>載入失敗</strong><span>${escapeHtml(error.message)}</span></div>`;
  }
}

async function renderKeys(revealedKey) {
  if (revealedKey) {
    elements.keyReveal.classList.remove("hidden");
    elements.keyReveal.innerHTML = `
      <div><strong>請立即保存這把 Key</strong><p>基於安全考量，離開後不會再次顯示完整內容。</p></div>
      <code>${escapeHtml(revealedKey)}</code>
      <button class="primary" id="copyRevealedKey">複製</button>
    `;
    $("#copyRevealedKey").addEventListener("click", async () => {
      await navigator.clipboard.writeText(revealedKey);
      showToast("API Key 已複製");
    });
  } else {
    elements.keyReveal.classList.add("hidden");
    elements.keyReveal.innerHTML = "";
  }

  elements.keyList.innerHTML = '<div class="loading-row">正在載入 API Keys…</div>';
  try {
    const result = await request("/api/keys");
    elements.keyList.innerHTML = result.data.length ? result.data.map((key) => `
      <article class="key-row ${key.revoked_at ? "revoked" : ""}">
        <div class="key-badge" aria-hidden="true"></div>
        <div class="key-main">
          <div class="key-title"><strong>${escapeHtml(key.name)}</strong>${key.revoked_at ? '<span class="state-label">已撤銷</span>' : '<span class="state-label active">使用中</span>'}</div>
          <code>${escapeHtml(key.prefix)}••••••••••••••••</code>
          <p>${escapeHtml(key.node_name)} · ${escapeHtml(key.model_name)} · 建立於 ${formatDate(key.created_at)} · 最近使用 ${formatDate(key.last_used_at)}</p>
        </div>
        ${key.revoked_at ? "" : `<button class="danger-button" data-revoke-key="${key.id}">撤銷</button>`}
      </article>
    `).join("") : '<div class="empty-list"><strong>尚未建立 API Key</strong><span>建立一把 Key，讓其他電腦或應用程式安全呼叫模型。</span></div>';

    elements.keyList.querySelectorAll("[data-revoke-key]").forEach((button) => {
      button.addEventListener("click", async () => {
        if (!confirm("確定撤銷這把 API Key？使用它的程式會立即失效。")) return;
        await request(`/api/keys/${button.dataset.revokeKey}/revoke`, { method: "POST" });
        await renderKeys();
        showToast("API Key 已撤銷");
      });
    });
  } catch (error) {
    elements.keyList.innerHTML = `<div class="empty-list error"><strong>載入失敗</strong><span>${escapeHtml(error.message)}</span></div>`;
  }
}

function renderNodes() {
  const nodes = state.nodes || [];
  const online = nodes.filter((node) => node.status?.state === "online").length;
  const available = nodes.filter((node) => node.enabled).length;
  elements.nodeCount.textContent = formatNumber(nodes.length);
  elements.onlineNodeCount.textContent = `${formatNumber(online)} / ${formatNumber(nodes.length)}`;
  elements.availableModelCount.textContent = formatNumber(available);
  elements.nodeList.innerHTML = nodes.length ? nodes.map((node) => {
    const stateName = node.status?.state === "online" ? "在線"
      : node.status?.state === "disabled" ? "已停用" : "離線";
    const latency = node.status?.latency_ms == null ? "—" : `${formatNumber(node.status.latency_ms)} ms`;
    return `
      <article class="node-row ${node.enabled ? "" : "disabled"}">
        <span class="node-indicator ${escapeHtml(node.status?.state || "offline")}" aria-hidden="true"></span>
        <div class="node-main">
          <div class="node-title"><strong>${escapeHtml(node.name)}</strong><span class="state-label ${node.status?.state === "online" ? "active" : ""}">${stateName}</span></div>
          <p>${escapeHtml(node.model_name)} · ${escapeHtml(node.model_id)}</p>
          <small>最後檢查 ${formatDate(node.status?.checked_at)} · ${latency}</small>
        </div>
        <button class="${node.enabled ? "danger-button" : "toolbar-button"}" data-toggle-node="${escapeHtml(node.id)}" data-node-enabled="${node.enabled ? "0" : "1"}">
          ${node.enabled ? "停用" : "啟用"}
        </button>
      </article>
    `;
  }).join("") : '<div class="empty-list"><strong>尚未加入機器</strong><span>加入已透過 Wonder Mesh 發布的 SwiftLM Origin。</span></div>';

  elements.nodeList.querySelectorAll("[data-toggle-node]").forEach((button) => {
    button.addEventListener("click", async () => {
      const enabled = button.dataset.nodeEnabled === "1";
      try {
        await request(`/api/nodes/${button.dataset.toggleNode}/enabled`, {
          method: "POST", body: JSON.stringify({ enabled }),
        });
        await loadNodes();
        showToast(enabled ? "機器已啟用" : "機器已停用");
      } catch (error) {
        showToast(error.message);
      }
    });
  });
}

async function updateConversationTarget() {
  if (!state.current || state.current.messages.length > 0 || state.sending || state.current.generation_in_progress) {
    renderNodeOptions();
    return;
  }
  const node = state.nodes.find((item) => item.id === elements.conversationNode.value);
  if (!node) return;
  try {
    state.current = await request(`/api/conversations/${state.current.id}/target`, {
      method: "PATCH",
      body: JSON.stringify({ node_id: node.id, model_id: node.model_id }),
    });
    renderNodeOptions();
    updateConversationHeader();
    renderConversationList();
    updateNodeStatus();
  } catch (error) {
    renderNodeOptions();
    showToast(error.message);
  }
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
  clearTimeout(state.statusPollTimer);
  state.statusPollTimer = null;
  stopGenerationPolling();
  state.current = null;
  showLogin();
});
elements.newChatButton.addEventListener("click", createConversation);
elements.emptyNewChat.addEventListener("click", createConversation);
elements.deleteConversationButton.addEventListener("click", deleteCurrentConversation);
elements.refreshActivityButton.addEventListener("click", renderActivity);
elements.createKeyForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const created = await request("/api/keys", {
    method: "POST",
    body: JSON.stringify({ name: elements.keyName.value, node_id: elements.keyNode.value }),
  });
  elements.keyName.value = "";
  await renderKeys(created.key);
});
elements.conversationNode.addEventListener("change", async () => {
  renderModelOptions(elements.conversationNode.value);
  await updateConversationTarget();
});
elements.conversationModel.addEventListener("change", updateConversationTarget);
elements.refreshNodesButton.addEventListener("click", loadNodes);
elements.createNodeForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    await request("/api/nodes", {
      method: "POST",
      body: JSON.stringify({
        name: elements.nodeName.value,
        model_name: elements.nodeModelName.value,
        model_id: elements.nodeModelId.value,
        origin_base_url: elements.nodeOrigin.value,
      }),
    });
    elements.createNodeForm.reset();
    await loadNodes();
    showToast("機器已加入，正在檢查模型狀態");
  } catch (error) {
    showToast(error.message);
  }
});
elements.conversationSearch.addEventListener("input", () => {
  state.query = elements.conversationSearch.value;
  renderConversationList();
});
elements.composer.addEventListener("submit", sendMessage);
elements.messageInput.addEventListener("input", resizeComposer);
elements.messageInput.addEventListener("keydown", (event) => {
  if (shouldSubmitComposer(event)) {
    event.preventDefault();
    elements.composer.requestSubmit();
  }
});
document.querySelectorAll("[data-view]").forEach((button) => {
  button.addEventListener("click", () => switchView(button.dataset.view));
});

bootstrap();
