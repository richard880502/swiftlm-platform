import { clearComposerInput, shouldSubmitComposer } from "./composer.js";
import { updateConversationDrawer } from "./mobile-navigation.js";
import { enhanceMarkdown, enhanceMarkdownIn } from "./markdown-enhancer.js";

const state = {
  conversations: [],
  nodes: [],
  current: null,
  currentView: "chat",
  sending: false,
  query: "",
  generationPollTimer: null,
  statusPollTimer: null,
  editingNodeId: null,
  addingModelNodeId: null,
  stopping: false,
  conversationDrawerOpen: false,
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
  sidebar: $("#conversationDrawer"),
  mobileConversationButton: $("#mobileConversationButton"),
  drawerBackdrop: $("#drawerBackdrop"),
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
  nodeUpstreamKey: $("#nodeUpstreamKey"),
  nodeProvider: $("#nodeProvider"),
  enrollmentReveal: $("#enrollmentReveal"),
  createEnrollmentTokenForm: $("#createEnrollmentTokenForm"),
  enrollmentLabel: $("#enrollmentLabel"),
  enrollmentList: $("#enrollmentList"),
  nodeAuthType: $("#nodeAuthType"),
  nodeAuthHeader: $("#nodeAuthHeader"),
  probeNodeButton: $("#probeNodeButton"),
  toast: $("#toast"),
};

const PROVIDER_LABELS = {
  swiftlm: "SwiftLM",
  vllm: "vLLM",
  llamacpp: "llama.cpp",
  generic: "OpenAI 相容",
};

const AUTH_TYPE_LABELS = {
  none: "無驗證",
  bearer: "Bearer Key",
  api_key_header: "API Key header",
};

const mobileViewport = window.matchMedia("(max-width: 820px)");

function setConversationDrawer(open, { restoreFocus = false } = {}) {
  state.conversationDrawerOpen = updateConversationDrawer({
    appView: elements.appView,
    sidebar: elements.sidebar,
    toggleButton: elements.mobileConversationButton,
    backdrop: elements.drawerBackdrop,
  }, {
    mobile: mobileViewport.matches,
    inChatView: state.currentView === "chat",
    open,
  });

  if (restoreFocus && mobileViewport.matches) elements.mobileConversationButton.focus();
}

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

function nodeModels(node) {
  const models = (node?.models || []).filter((model) => model.enabled);
  // A node written before per-node model lists existed, or one whose models API
  // call hasn't resolved yet, still has its own primary model to fall back to.
  return models.length ? models : node ? [{ model_id: node.model_id, model_name: node.model_name }] : [];
}

function renderModelOptions(nodeId = elements.conversationNode.value) {
  const node = state.nodes.find((item) => item.id === nodeId);
  const models = nodeModels(node);
  const preferred = state.current?.node_id === nodeId ? state.current?.model_id : null;
  const value = models.some((model) => model.model_id === preferred) ? preferred : models[0]?.model_id || "";
  elements.conversationModel.innerHTML = models
    .map((model) => `<option value="${escapeHtml(model.model_id)}">${escapeHtml(model.model_name)}</option>`)
    .join("");
  elements.conversationModel.value = value;
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
    if (state.currentView === "nodes" && !state.editingNodeId && !state.addingModelNodeId) renderNodes();
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
  elements.sendButton.disabled = state.stopping;
  elements.sendButton.type = busy ? "button" : "submit";
  elements.sendButton.textContent = busy ? "■" : "↑";
  elements.sendButton.setAttribute("aria-label", busy ? "停止生成" : "傳送");
  elements.sendButton.classList.toggle("stop-button", busy);
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
  enhanceMarkdownIn(elements.messageList);
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

  const conversationId = state.current.id;
  state.sending = true;
  state.stopping = false;
  state.current.generation_in_progress = true;
  updateConversationHeader();
  clearComposerInput(elements.messageInput);
  state.current.messages.push({ role: "user", content, created_at: new Date().toISOString() });
  renderMessages();
  elements.messageList.insertAdjacentHTML("beforeend", messageHtml({ role: "assistant", content: "" }, true));
  const pending = $("#pendingAssistant");
  const output = pending.querySelector(".message-content");
  scrollMessages();
  elements.messageList.classList.add("is-streaming");
  let renderFrame = null;

  try {
    const response = await fetch(`/api/conversations/${conversationId}/messages`, {
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
    let stopped = false;
    const flushPendingOutput = () => {
      renderFrame = null;
      output.textContent = assistant;
      scrollMessages();
    };

    const schedulePendingOutput = () => {
      if (renderFrame !== null) return;
      renderFrame = requestAnimationFrame(flushPendingOutput);
    };

    const consume = (eventText) => {
      const eventName = eventText.split("\n").find((line) => line.startsWith("event:"))?.slice(6).trim();
      const data = eventText.split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart()).join("\n");
      if (!data || data === "[DONE]" || eventName === "dashboard") return;
      if (eventName === "stopped") {
        stopped = true;
        return;
      }
      if (eventName === "error") throw new Error(JSON.parse(data).message || "串流失敗");
      try {
        assistant += JSON.parse(data).choices?.[0]?.delta?.content || "";
      } catch {
        assistant += data;
      }
      schedulePendingOutput();
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
    if (renderFrame !== null) {
      cancelAnimationFrame(renderFrame);
      flushPendingOutput();
    }
    pending.classList.remove("pending");
    enhanceMarkdown(output);
    if (state.current?.id === conversationId) {
      state.current = await request(`/api/conversations/${conversationId}`);
      state.current.generation_in_progress = false;
      updateConversationHeader();
      renderMessages();
      await loadConversations();
      showToast(stopped ? "已停止生成" : "回答已完成");
    }
  } catch (error) {
    if (renderFrame !== null) cancelAnimationFrame(renderFrame);
    if (state.current?.id === conversationId) state.current.generation_in_progress = false;
    pending.classList.remove("pending");
    output.textContent = `請求失敗：${error.message}`;
    await loadNodes();
  } finally {
    elements.messageList.classList.remove("is-streaming");
    state.sending = false;
    state.stopping = false;
    if (state.current?.id === conversationId) updateConversationHeader();
    if (!state.current?.generation_in_progress) elements.messageInput.focus();
  }
}

async function stopCurrentGeneration() {
  if (!state.current || (!state.sending && !state.current.generation_in_progress) || state.stopping) return;
  state.stopping = true;
  updateConversationHeader();
  try {
    await request(`/api/conversations/${state.current.id}/stop`, { method: "POST" });
    showToast("正在停止生成…");
  } catch (error) {
    state.stopping = false;
    updateConversationHeader();
    showToast(error.message);
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
  setConversationDrawer(false);
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
  if (type === "nodes") {
    renderNodes();
    renderEnrollmentTokens();
  }
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
        : `輸入 ${formatNumber(entry.prompt_tokens)} · 輸出 ${formatNumber(entry.completion_tokens)} tokens`;
      const throughput = entry.throughput_tps == null
        ? "tok/s 未回報"
        : `${formatNumber(entry.throughput_tps)} tok/s`;
      const timing = [
        entry.queue_ms == null ? null : `排隊 ${formatNumber(entry.queue_ms)} ms`,
        entry.ttft_ms == null ? null : `首 Token ${formatNumber(entry.ttft_ms)} ms`,
      ].filter(Boolean).join(" · ");
      const success = entry.status >= 200 && entry.status < 300;
      return `
        <article class="activity-row">
          <span class="request-indicator ${success ? "success" : "failed"}" aria-hidden="true"></span>
          <div class="activity-main">
            <div class="activity-title"><strong>${escapeHtml(entry.route)}</strong><span>${formatDate(entry.created_at)}</span></div>
            <p>${escapeHtml(entry.node_name || "未指定機器")} · ${escapeHtml(entry.model_name || entry.model || "模型")} · ${escapeHtml(entry.api_key_name || "Dashboard")} · ${tokens}</p>
            <p class="activity-performance">${throughput}${timing ? ` · ${escapeHtml(timing)}` : ""}</p>
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

function nodeAuthPayload() {
  const authType = elements.nodeAuthType.value;
  return {
    auth_type: authType,
    upstream_api_key: authType === "none" ? "" : elements.nodeUpstreamKey.value,
    auth_header: authType === "api_key_header" ? elements.nodeAuthHeader.value : "",
  };
}

// Only the fields the selected strategy actually uses stay editable, so a keyless
// private node is never blocked by a required credential field.
function syncAuthFields() {
  const authType = elements.nodeAuthType.value;
  const needsCredential = authType !== "none";
  elements.nodeUpstreamKey.disabled = !needsCredential;
  elements.nodeUpstreamKey.required = needsCredential;
  elements.nodeUpstreamKey.placeholder = needsCredential
    ? "貼上該服務的 API Key"
    : "此驗證方式不需要憑證";
  elements.nodeAuthHeader.disabled = authType !== "api_key_header";
}

function renderModelChips(node) {
  const models = node.models || [];
  return `
    <div class="node-models">
      ${models.map((model) => `
        <span class="model-chip ${model.enabled ? "" : "disabled"}">
          <span>${escapeHtml(model.model_name)}</span>
          <code>${escapeHtml(model.model_id)}</code>
          <button type="button" data-toggle-model="${escapeHtml(model.id)}" data-model-node="${escapeHtml(node.id)}"
            data-model-enabled="${model.enabled ? "0" : "1"}" title="${model.enabled ? "停用這個模型" : "啟用這個模型"}">
            ${model.enabled ? "●" : "○"}
          </button>
          ${models.length > 1 ? `<button type="button" data-remove-model="${escapeHtml(model.id)}" data-model-node="${escapeHtml(node.id)}" title="移除這個模型">×</button>` : ""}
        </span>
      `).join("")}
      <button type="button" class="toolbar-button subtle-button" data-add-model="${escapeHtml(node.id)}">+ 新增模型</button>
    </div>
  `;
}

function renderNodeRow(node) {
  const stateName = node.status?.state === "online" ? "在線"
    : node.status?.state === "disabled" ? "已停用" : "離線";
  const latency = node.status?.latency_ms == null ? "—" : `${formatNumber(node.status.latency_ms)} ms`;
  const canDelete = !node.is_default;
  const editingKey = state.editingNodeId === node.id;
  const addingModel = state.addingModelNodeId === node.id;
  return `
      <article class="node-row ${node.enabled ? "" : "disabled"}">
        <span class="node-indicator ${escapeHtml(node.status?.state || "offline")}" aria-hidden="true"></span>
        <div class="node-main">
          <div class="node-title">
            <strong>${escapeHtml(node.name)}</strong>
            <span class="node-provider-tag">${escapeHtml(PROVIDER_LABELS[node.provider] || node.provider || "swiftlm")}</span>
            <span class="state-label ${node.status?.state === "online" ? "active" : ""}">${stateName}</span>
          </div>
          ${renderModelChips(node)}
          <small>最後檢查 ${formatDate(node.status?.checked_at)} · ${latency} · ${escapeHtml(AUTH_TYPE_LABELS[node.auth_type] || node.auth_type || "bearer")}</small>
        </div>
        <div class="node-actions">
          <button class="${node.enabled ? "danger-button" : "toolbar-button"}" data-toggle-node="${escapeHtml(node.id)}" data-node-enabled="${node.enabled ? "0" : "1"}">
            ${node.enabled ? "停用" : "啟用"}
          </button>
          ${canDelete ? `<button class="toolbar-button" data-edit-node-key="${escapeHtml(node.id)}">更新驗證</button>` : ""}
          ${canDelete ? `<button class="danger-button subtle-danger" data-delete-node="${escapeHtml(node.id)}">刪除</button>` : ""}
        </div>
        ${editingKey ? `
          <form class="node-key-update" data-node-key-form="${escapeHtml(node.id)}">
            <label>驗證方式
              <select name="auth_type">
                ${["bearer", "none", "api_key_header"].map((type) => `
                  <option value="${type}"${(node.auth_type || "bearer") === type ? " selected" : ""}>${escapeHtml(AUTH_TYPE_LABELS[type])}</option>
                `).join("")}
              </select>
            </label>
            <label>新的上游憑證<input name="upstream_api_key" type="password" autocomplete="new-password" placeholder="切換為「無驗證」時留空" /></label>
            <label>Header 名稱<input name="auth_header" placeholder="X-API-Key" maxlength="63" value="${escapeHtml(node.auth_header || "")}" /></label>
            <button class="primary" type="submit">儲存</button>
            <button class="toolbar-button" type="button" data-cancel-node-key>取消</button>
          </form>
        ` : ""}
        ${addingModel ? `
          <form class="node-key-update" data-node-model-form="${escapeHtml(node.id)}">
            <label>模型 ID<input name="model_id" placeholder="例如 Qwen/Qwen3-14B" maxlength="240" required /></label>
            <label>顯示名稱<input name="model_name" placeholder="選填，預設同模型 ID" maxlength="120" /></label>
            <button class="primary" type="submit">新增</button>
            <button class="toolbar-button" type="button" data-cancel-model>取消</button>
          </form>
        ` : ""}
      </article>
    `;
}

function renderNodes() {
  const nodes = state.nodes || [];
  const online = nodes.filter((node) => node.status?.state === "online").length;
  const available = nodes.filter((node) => node.enabled).length;
  elements.nodeCount.textContent = formatNumber(nodes.length);
  elements.onlineNodeCount.textContent = `${formatNumber(online)} / ${formatNumber(nodes.length)}`;
  elements.availableModelCount.textContent = formatNumber(available);
  // One malformed node must never blank the whole list: without this, an
  // exception thrown while building any single row aborts the .map() call
  // entirely, and since the summary counts above are already written by then,
  // the counts look right while the list itself silently keeps its last
  // successful (stale) content -- a confusing, hard-to-notice failure mode.
  elements.nodeList.innerHTML = nodes.length ? nodes.map((node) => {
    try {
      return renderNodeRow(node);
    } catch (error) {
      console.error("Failed to render node row", node?.id, error);
      return `<article class="node-row"><div class="node-main"><strong>${escapeHtml(node?.name || node?.id || "unknown")}</strong><p>這台機器目前無法顯示（詳情見主控台）。</p></div></article>`;
    }
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
  elements.nodeList.querySelectorAll("[data-delete-node]").forEach((button) => {
    button.addEventListener("click", async () => {
      const node = state.nodes.find((item) => item.id === button.dataset.deleteNode);
      const usage = node?.usage || {};
      const consequences = [
        `${usage.api_key_count || 0} 把 API Key`,
        `${usage.conversation_count || 0} 個對話`,
        `${usage.request_count || 0} 筆使用紀錄`,
      ].join("、");
      if (!confirm(`確定刪除「${node?.name || "這台機器"}」？\n\n這會一併撤銷／刪除：${consequences}。\n此動作無法復原。`)) return;
      try {
        await request(`/api/nodes/${button.dataset.deleteNode}`, {
          method: "DELETE", body: JSON.stringify({ purge: true }),
        });
        await loadNodes();
        showToast("機器與相關資料已刪除");
      } catch (error) {
        showToast(error.message);
      }
    });
  });
  elements.nodeList.querySelectorAll("[data-edit-node-key]").forEach((button) => {
    button.addEventListener("click", () => {
      state.editingNodeId = button.dataset.editNodeKey;
      renderNodes();
      elements.nodeList.querySelector("[data-node-key-form] input")?.focus();
    });
  });
  elements.nodeList.querySelectorAll("[data-cancel-node-key]").forEach((button) => {
    button.addEventListener("click", () => {
      state.editingNodeId = null;
      renderNodes();
    });
  });
  elements.nodeList.querySelectorAll("[data-node-key-form]").forEach((form) => {
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const data = new FormData(form);
      try {
        await request(`/api/nodes/${form.dataset.nodeKeyForm}/auth`, {
          method: "PATCH",
          body: JSON.stringify({
            auth_type: data.get("auth_type"),
            upstream_api_key: data.get("upstream_api_key"),
            auth_header: data.get("auth_header"),
          }),
        });
        state.editingNodeId = null;
        await loadNodes();
        showToast("節點驗證方式已更新");
      } catch (error) {
        showToast(error.message);
      }
    });
  });
  elements.nodeList.querySelectorAll("[data-add-model]").forEach((button) => {
    button.addEventListener("click", () => {
      state.addingModelNodeId = button.dataset.addModel;
      renderNodes();
      elements.nodeList.querySelector("[data-node-model-form] input")?.focus();
    });
  });
  elements.nodeList.querySelectorAll("[data-cancel-model]").forEach((button) => {
    button.addEventListener("click", () => {
      state.addingModelNodeId = null;
      renderNodes();
    });
  });
  elements.nodeList.querySelectorAll("[data-node-model-form]").forEach((form) => {
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const data = new FormData(form);
      try {
        await request(`/api/nodes/${form.dataset.nodeModelForm}/models`, {
          method: "POST",
          body: JSON.stringify({ model_id: data.get("model_id"), model_name: data.get("model_name") }),
        });
        state.addingModelNodeId = null;
        await loadNodes();
        showToast("模型已新增");
      } catch (error) {
        showToast(error.message);
      }
    });
  });
  elements.nodeList.querySelectorAll("[data-toggle-model]").forEach((button) => {
    button.addEventListener("click", async () => {
      try {
        await request(`/api/nodes/${button.dataset.modelNode}/models/${button.dataset.toggleModel}/enabled`, {
          method: "PATCH", body: JSON.stringify({ enabled: button.dataset.modelEnabled === "1" }),
        });
        await loadNodes();
      } catch (error) {
        showToast(error.message);
      }
    });
  });
  elements.nodeList.querySelectorAll("[data-remove-model]").forEach((button) => {
    button.addEventListener("click", async () => {
      if (!confirm("確定從這台機器移除這個模型？")) return;
      try {
        await request(`/api/nodes/${button.dataset.modelNode}/models/${button.dataset.removeModel}`, {
          method: "DELETE",
        });
        await loadNodes();
        showToast("模型已移除");
      } catch (error) {
        showToast(error.message);
      }
    });
  });
}

const ENROLLMENT_STATE_LABELS = { pending: "待使用", used: "已使用", expired: "已過期" };

function joinCommand(token) {
  const server = window.location.origin;
  return `swiftlm-node join ${token} \\\n  --server ${server} \\\n  --name "GPU 01" \\\n  --base-url https://gpu-01-origin.example/v1 \\\n  --model-id <model-id>`;
}

async function renderEnrollmentTokens(revealedToken) {
  if (revealedToken) {
    elements.enrollmentReveal.classList.remove("hidden");
    elements.enrollmentReveal.innerHTML = `
      <div><strong>請立即保存這個 Token</strong><p>10 分鐘內有效、只能使用一次；離開後不會再次顯示。</p></div>
      <code>${escapeHtml(joinCommand(revealedToken))}</code>
      <button class="primary" id="copyRevealedToken">複製指令</button>
    `;
    $("#copyRevealedToken").addEventListener("click", async () => {
      await navigator.clipboard.writeText(joinCommand(revealedToken));
      showToast("Join 指令已複製");
    });
  } else {
    elements.enrollmentReveal.classList.add("hidden");
    elements.enrollmentReveal.innerHTML = "";
  }

  elements.enrollmentList.innerHTML = '<div class="loading-row">正在載入 Enrollment Tokens…</div>';
  try {
    const result = await request("/api/enrollment-tokens");
    elements.enrollmentList.innerHTML = result.data.length ? result.data.map((token) => `
      <article class="key-row ${token.state !== "pending" ? "revoked" : ""}">
        <div class="key-badge" aria-hidden="true"></div>
        <div class="key-main">
          <div class="key-title">
            <strong>${escapeHtml(token.label || "（未命名）")}</strong>
            <span class="state-label ${token.state === "pending" ? "active" : ""}">${escapeHtml(ENROLLMENT_STATE_LABELS[token.state] || token.state)}</span>
          </div>
          <p>建立於 ${formatDate(token.created_at)} · 到期 ${formatDate(token.expires_at)}${token.used_at ? ` · 已於 ${formatDate(token.used_at)} 使用` : ""}</p>
        </div>
        ${token.state === "pending" ? `<button class="danger-button" data-revoke-token="${token.id}">撤銷</button>` : ""}
      </article>
    `).join("") : '<div class="empty-list"><strong>尚未產生 Enrollment Token</strong><span>產生一個 token，讓新機器透過 join 指令自行註冊。</span></div>';

    elements.enrollmentList.querySelectorAll("[data-revoke-token]").forEach((button) => {
      button.addEventListener("click", async () => {
        if (!confirm("確定撤銷這個 Enrollment Token？")) return;
        await request(`/api/enrollment-tokens/${button.dataset.revokeToken}`, { method: "DELETE" });
        await renderEnrollmentTokens();
        showToast("Enrollment Token 已撤銷");
      });
    });
  } catch (error) {
    elements.enrollmentList.innerHTML = `<div class="empty-list"><strong>無法載入 Enrollment Tokens</strong><span>${escapeHtml(error.message)}</span></div>`;
  }
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
      body: JSON.stringify({ node_id: node.id, model_id: elements.conversationModel.value }),
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
elements.newChatButton.addEventListener("click", () => {
  setConversationDrawer(false);
  createConversation();
});
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
elements.createEnrollmentTokenForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const issued = await request("/api/enrollment-tokens", {
      method: "POST",
      body: JSON.stringify({ label: elements.enrollmentLabel.value }),
    });
    elements.createEnrollmentTokenForm.reset();
    await renderEnrollmentTokens(issued.token);
  } catch (error) {
    showToast(error.message);
  }
});
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
        provider: elements.nodeProvider.value,
        ...nodeAuthPayload(),
      }),
    });
    elements.createNodeForm.reset();
    syncAuthFields();
    await loadNodes();
    showToast("機器已加入，正在檢查模型狀態");
  } catch (error) {
    showToast(error.message);
  }
});
elements.nodeAuthType.addEventListener("change", syncAuthFields);
elements.probeNodeButton.addEventListener("click", async () => {
  if (!elements.nodeOrigin.value.trim()) {
    showToast("請先輸入節點的 /v1 網址");
    return;
  }
  elements.probeNodeButton.disabled = true;
  try {
    const auth = nodeAuthPayload();
    // Probing is a read-only reachability check, so an endpoint that needs no
    // credential can be identified before any auth strategy has been chosen.
    const probe = await request("/api/nodes/probe", {
      method: "POST",
      body: JSON.stringify({
        base_url: elements.nodeOrigin.value,
        ...(auth.upstream_api_key ? auth : { auth_type: "none" }),
      }),
    });
    elements.nodeProvider.value = probe.provider;
    // The node already knows which model it serves, so the operator only has to
    // confirm it instead of retyping an exact model ID.
    const discovered = probe.models?.[0]?.id;
    if (discovered && !elements.nodeModelId.value.trim()) elements.nodeModelId.value = discovered;
    if (discovered && !elements.nodeModelName.value.trim()) elements.nodeModelName.value = discovered;
    showToast(`偵測到 ${PROVIDER_LABELS[probe.provider] || probe.provider}，共 ${probe.models?.length || 0} 個模型`);
  } catch (error) {
    showToast(error.message);
  } finally {
    elements.probeNodeButton.disabled = false;
  }
});
elements.conversationSearch.addEventListener("input", () => {
  state.query = elements.conversationSearch.value;
  renderConversationList();
});
elements.composer.addEventListener("submit", sendMessage);
elements.sendButton.addEventListener("click", (event) => {
  if (state.sending || state.current?.generation_in_progress) {
    event.preventDefault();
    stopCurrentGeneration();
  }
});
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
elements.mobileConversationButton.addEventListener("click", () => {
  setConversationDrawer(!state.conversationDrawerOpen);
});
elements.drawerBackdrop.addEventListener("click", () => setConversationDrawer(false, { restoreFocus: true }));
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && state.conversationDrawerOpen) {
    setConversationDrawer(false, { restoreFocus: true });
  }
});
mobileViewport.addEventListener("change", () => setConversationDrawer(false));

syncAuthFields();
setConversationDrawer(false);
bootstrap();
