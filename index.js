import {
  StreamBridge
} from "./worker-client.js";

const STORAGE_KEYS = {
  history: "lm-chat-history-v1",
  context: "lm-chat-context-v1",
  seed: "lm-seed-v1",
  settings: "lm-chat-settings-v1",
};

const state = {
  bridge: null,
  history: [],
  context: [],
  generating: false,
  ready: false,
  currentStreamReader: null,
};

const chatLog = document.getElementById("chat-log");
const statusDot = document.getElementById("status-dot");
const statusText = document.getElementById("status-text");
const metaBox = document.getElementById("meta-box");
const seedInput = document.getElementById("seed-input");
const maxTokensInput = document.getElementById("max-tokens");
const maxSentencesInput = document.getElementById("max-sentences");
const messageInput = document.getElementById("message-input");
const sendButton = document.getElementById("send-button");
const composer = document.getElementById("composer");

function setStatus(text, tone = "loading") {
  statusText.textContent = text;
  statusDot.classList.remove("ready", "error");

  if (tone === "ready") {
    statusDot.classList.add("ready");
  }

  if (tone === "error") {
    statusDot.classList.add("error");
  }
}

function safeJsonParse(text, fallback) {
  try {
    return JSON.parse(text) ?? fallback;
  } catch {
    return fallback;
  }
}

function saveJson(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

function readJson(key, fallback) {
  return safeJsonParse(localStorage.getItem(key), fallback) ?? fallback;
}

function tokenize(text) {
  return String(text ?? "")
    .trim()
    .split(/\s+/)
    .join(" ")
    .split(" ")
    .filter(Boolean);
}

function trimContext(limit = 180) {
  if (state.context.length > limit) {
    state.context = state.context.slice(-limit);
  }
}

function renderMessage(role, text) {
  const message = document.createElement("article");
  message.className = `message ${role}`;

  const roleLabel = document.createElement("div");
  roleLabel.className = "message-role";
  roleLabel.textContent = role;

  const body = document.createElement("div");
  body.textContent = text;

  message.append(roleLabel, body);
  chatLog.appendChild(message);
  chatLog.scrollTop = chatLog.scrollHeight;
  return body;
}

function refreshMeta() {
  metaBox.innerHTML = `Context tokens: ${state.context.length}<br />Messages: ${state.history.length}`;
}

function persistState() {
  saveJson(STORAGE_KEYS.history, state.history);
  saveJson(STORAGE_KEYS.context, state.context);
  localStorage.setItem(STORAGE_KEYS.seed, seedInput.value);
  saveJson(STORAGE_KEYS.settings, {
    maxTokens: Number(maxTokensInput.value) || 256,
    maxSentences: Number(maxSentencesInput.value) || 8,
  });
  refreshMeta();
}

function renderHistory() {
  chatLog.innerHTML = "";

  if (!state.history.length) {
    renderMessage(
      "system",
      "Ready when you are. Enter a message to seed the model and stream a reply.",
    );
    refreshMeta();
    return;
  }

  for (const entry of state.history) {
    renderMessage(entry.role, entry.text);
  }

  refreshMeta();
}

async function generateReply() {
  const assistantBody = renderMessage("assistant", "…");
  let fullText = "";
  const maxTokens = Math.max(8, Number(maxTokensInput.value) || 72);
  const maxSentences = Math.max(1, Number(maxSentencesInput.value) || 4);

  const stream = state.bridge.requestStream({
    context: [...state.context],
    maxTokens,
    maxSentences,
  });

  const reader = stream.getReader();
  state.currentStreamReader = reader;

  try {
    while (true) {
      const {
        done,
        value
      } = await reader.read();
      if (done) {
        break;
      }

      const choice = value?.choices?.[0];
      if (!choice) {
        continue;
      }

      if (value._token) {
        state.context.push(value._token);
        trimContext();
      }

      const content = choice.delta?.content;
      if (content) {
        fullText += content;
        assistantBody.textContent = fullText || "…";
        chatLog.scrollTop = chatLog.scrollHeight;
      }
    }
  } finally {
    state.currentStreamReader = null;
    reader.releaseLock();
  }

  const finalText = fullText.trim() || "(No output generated.)";
  assistantBody.textContent = finalText;
  state.history.push({
    role: "assistant",
    text: finalText
  });
  persistState();
}

async function handleSend() {
  if (!state.ready || state.generating) {
    return;
  }

  const input = messageInput.value.trim();
  if (!input) {
    messageInput.focus();
    return;
  }

  state.generating = true;
  sendButton.disabled = true;
  setStatus("Generating…");

  const starterContext = tokenize(seedInput.value);
  if (starterContext.length) {
    const existingSeed = state.context.slice(0, starterContext.length).join(" ");
    if (existingSeed !== starterContext.join(" ")) {
      state.context.push(...starterContext);
    }
  }

  const userText = input;
  messageInput.value = "";
  renderMessage("user", userText);
  state.history.push({
    role: "user",
    text: userText
  });
  state.context.push(...tokenize(userText));
  trimContext();
  persistState();

  try {
    await generateReply();
    setStatus("Ready", "ready");
  } catch (error) {
    const message = error?.message ?? String(error);
    renderMessage("system", `Error: ${message}`);
    setStatus("Generation failed", "error");
  } finally {
    state.generating = false;
    sendButton.disabled = false;
  }
}

function resetContextToSeed() {
  state.context = tokenize(seedInput.value);
  persistState();
  renderMessage("system", "Context reset.");
}

function clearChat() {
  state.history = [];
  state.context = tokenize(seedInput.value);
  persistState();
  renderHistory();
}

function copyLastReply() {
  const lastAssistant = [...state.history]
    .reverse()
    .find((entry) => entry.role === "assistant");

  if (!lastAssistant) {
    return;
  }

  navigator.clipboard.writeText(lastAssistant.text);
}

function restorePersistedState() {
  state.history = readJson(STORAGE_KEYS.history, []);
  state.context = readJson(STORAGE_KEYS.context, []);

  const settings = readJson(STORAGE_KEYS.settings, {
    maxTokens: 72,
    maxSentences: 4,
  });

  seedInput.value = localStorage.getItem(STORAGE_KEYS.seed) ?? "";
  maxTokensInput.value = settings.maxTokens;
  maxSentencesInput.value = settings.maxSentences;

  if (!Array.isArray(state.history)) {
    state.history = [];
  }

  if (!Array.isArray(state.context)) {
    state.context = [];
  }

  renderHistory();
}

async function initWorker() {
  state.bridge = await StreamBridge.create("./lm-worker.js");
  state.ready = true;
  setStatus("Ready", "ready");
}

function registerUiHandlers() {
  document.getElementById("sync-seed").addEventListener("click", () => {
    state.context = tokenize(seedInput.value);
    persistState();
    renderMessage("system", "Seed loaded into context.");
  });

  document.getElementById("reset-context").addEventListener("click", resetContextToSeed);
  document.getElementById("clear-chat").addEventListener("click", clearChat);
  document.getElementById("copy-last").addEventListener("click", copyLastReply);

  document.querySelectorAll("[data-prompt]").forEach((button) => {
    button.addEventListener("click", () => {
      messageInput.value = button.dataset.prompt ?? "";
      messageInput.focus();
    });
  });

  composer.addEventListener("submit", async (event) => {
    event.preventDefault();
    await handleSend();
  });

  messageInput.addEventListener("keydown", async (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      await handleSend();
    }
  });

  [seedInput, maxTokensInput, maxSentencesInput].forEach((element) => {
    element.addEventListener("change", persistState);
  });

  window.addEventListener("beforeunload", () => {
    if (state.currentStreamReader) {
      state.currentStreamReader.cancel().catch(() => {});
    }
    state.bridge?.terminate();
  });
}

async function init() {
  restorePersistedState();
  registerUiHandlers();

  try {
    await initWorker();
    refreshMeta();
  } catch (error) {
    setStatus("Failed to load models " + `Error: ${error?.message ?? String(error)}`, "error");
    renderMessage("system", `Error: ${error?.message ?? String(error)}`);
  }
}

init();
