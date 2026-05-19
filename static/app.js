const state = {
  chats: [],
  filteredChats: [],
  selectedChat: null,
  selectedTitle: "",
  media: [],
  mediaBatches: [],
  selectedIds: new Set(),
  nextOffsetId: 0,
  isScanning: false,
  scanToken: 0,
  scannedMessages: 0,
  accessKey: localStorage.getItem("telegramDownloaderAccessKey") || "",
  keyMode: null,
  testDownloadUsed: localStorage.getItem("telegramDownloaderTestDownloadUsed") === "1",
};

const $ = (id) => document.getElementById(id);
const TEST_ACCESS_KEY = "KEYTEST";
const TELEGRAM_CREDENTIALS_KEY = "telegramDownloaderCredentials";

function toast(message) {
  const el = $("toast");
  el.textContent = message;
  el.classList.remove("hidden");
  clearTimeout(window.toastTimer);
  window.toastTimer = setTimeout(() => el.classList.add("hidden"), 4200);
}

async function request(path, options = {}) {
  const headers = {
    "Content-Type": "application/json",
    ...(state.accessKey ? { "X-Access-Key": state.accessKey } : {}),
    ...(options.headers || {}),
  };
  const res = await fetch(path, {
    ...options,
    headers,
  });
  const data = await res.json();
  if (!res.ok || data.error) {
    throw new Error(data.error || "Request failed");
  }
  return data;
}

function isTestKey() {
  return state.keyMode === "test" || state.accessKey.trim() === TEST_ACCESS_KEY;
}

function updateKeyStatus() {
  $("accessKey").value = state.accessKey;
  if (!state.accessKey) {
    $("keyStatus").textContent = "Nhập key để tải danh sách nhóm/kênh và media.";
    return;
  }
  if (isTestKey()) {
    $("keyStatus").textContent = state.testDownloadUsed
      ? "Key Test đã dùng 1 lượt tải. Hãy nhập key khác để tải tiếp."
      : "Key Test: xem được nhóm/media, chỉ tải được 1 file.";
    return;
  }
  $("keyStatus").textContent = state.keyMode === "full" ? "Key hợp lệ: không giới hạn tải." : "Key đã lưu. Bấm Tải danh sách để kiểm tra.";
}

function loadTelegramCredentials() {
  try {
    const saved = JSON.parse(localStorage.getItem(TELEGRAM_CREDENTIALS_KEY) || "{}");
    $("apiId").value = saved.apiId || "";
    $("apiHash").value = saved.apiHash || "";
    $("phone").value = saved.phone || "";
  } catch {
    localStorage.removeItem(TELEGRAM_CREDENTIALS_KEY);
  }
}

function saveTelegramCredentials(apiId, apiHash, phone) {
  localStorage.setItem(TELEGRAM_CREDENTIALS_KEY, JSON.stringify({ apiId, apiHash, phone }));
}

function requireAccessKey() {
  const typedKey = $("accessKey").value.trim();
  if (typedKey && typedKey !== state.accessKey) {
    state.accessKey = typedKey;
    state.keyMode = null;
    localStorage.setItem("telegramDownloaderAccessKey", typedKey);
    updateKeyStatus();
  }
  if (state.accessKey.trim()) {
    return true;
  }
  toast("Nhập access key trước.");
  $("accessKey").focus();
  return false;
}

function markTestDownloadUsed() {
  if (!isTestKey()) {
    return;
  }
  state.testDownloadUsed = true;
  localStorage.setItem("telegramDownloaderTestDownloadUsed", "1");
  updateKeyStatus();
}

function canDownloadWithCurrentKey(messageCount) {
  if (!requireAccessKey()) {
    return false;
  }
  if (!isTestKey()) {
    return true;
  }
  if (state.testDownloadUsed) {
    toast("Key Test đã tải 1 file. Hãy nhập key khác để tải tiếp.");
    return false;
  }
  if (messageCount !== 1) {
    toast("Key Test chỉ được tải đúng 1 file.");
    return false;
  }
  return true;
}

function browserDownload(item) {
  if (!item || !canDownloadWithCurrentKey(1)) {
    return;
  }
  markTestDownloadUsed();
  const link = document.createElement("a");
  link.href = item.download_url;
  link.download = item.name || "";
  link.rel = "noopener";
  document.body.appendChild(link);
  link.click();
  link.remove();
  toast(`Đang tải ${compactName(item.name)}...`);
}

function formatBytes(size) {
  if (!size) return "";
  const units = ["B", "KB", "MB", "GB"];
  let value = Number(size);
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(index ? 1 : 0)} ${units[index]}`;
}

function formatDate(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("vi-VN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function compactName(name) {
  const value = String(name || "");
  if (value.length <= 34) return value;
  const dot = value.lastIndexOf(".");
  const ext = dot > -1 ? value.slice(dot) : "";
  return `${value.slice(0, 24)}...${ext.slice(0, 8)}`;
}

function renderChats() {
  const query = $("chatSearch").value.trim().toLowerCase();
  state.filteredChats = state.chats.filter((chat) => chat.title.toLowerCase().includes(query));
  $("chatList").innerHTML = state.filteredChats
    .map(
      (chat) => `
        <button class="chat-item ${state.selectedChat === chat.id ? "active" : ""}" data-chat-id="${chat.id}">
          <span class="chat-title">${escapeHtml(chat.title)}</span>
          <span class="chat-meta">${chat.type}${chat.unread_count ? ` · ${chat.unread_count} unread` : ""}</span>
        </button>
      `,
    )
    .join("");
}

function renderMedia() {
  const scanText = state.isScanning
    ? `Đang quét... ${state.media.length} media, ${state.scannedMessages} tin nhắn.`
    : state.media.length
      ? `Đã quét ${state.media.length} media.`
      : "Chưa có media.";
  $("selectedCount").textContent = state.selectedIds.size
    ? `${state.selectedIds.size} media đã chọn. ${scanText}`
    : scanText;
  $("mediaList").innerHTML = state.mediaBatches
    .map((batch, batchIndex) => {
      const divider =
        batchIndex > 0
          ? '<div class="batch-divider" aria-label="Load more divider">-------------------------</div>'
          : "";
      const items = batch
        .map((item) => {
          const checked = state.selectedIds.has(item.id);
          return `
        <article class="media-item ${checked ? "selected" : ""}" data-message-id="${item.id}">
          <button class="preview" data-open-preview="${item.id}" title="Xem ${escapeHtml(item.kind)}">
            <img src="${escapeHtml(item.thumbnail_url)}" alt="${escapeHtml(item.name)}" loading="lazy" width="320" height="320" />
            <span class="kind">${item.kind}</span>
            ${item.kind === "video" ? '<span class="play">▶</span>' : ""}
          </button>
          <div>
            <div class="media-row">
              <div class="media-name" title="${escapeHtml(item.name)}">${escapeHtml(compactName(item.name))}</div>
              <input type="checkbox" ${checked ? "checked" : ""} aria-label="Select media ${item.id}" />
            </div>
            <div class="media-date">${escapeHtml(formatDate(item.date))}</div>
            <button class="download-one" data-download-one="${item.id}" title="Tải file này">Tải về</button>
          </div>
        </article>
      `;
        })
        .join("");
      return `${divider}${items}`;
    })
    .join("");
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function openViewer(item) {
  const viewer = $("viewer");
  $("viewerTitle").textContent = item.name;
  $("viewerMeta").textContent = `${item.kind.toUpperCase()} · ${formatBytes(item.size) || "unknown size"}`;
  $("viewerDownload").dataset.downloadOne = String(item.id);
  $("viewerBody").innerHTML = '<div class="viewer-loading">Đang tải preview...</div>';
  viewer.classList.remove("hidden");
  viewer.setAttribute("aria-hidden", "false");

  const src = `${item.preview_url}&v=${encodeURIComponent(item.id)}`;
  if (item.kind === "video") {
    $("viewerBody").innerHTML = `
      <video class="viewer-media" src="${escapeHtml(src)}" controls autoplay playsinline></video>
    `;
  } else {
    $("viewerBody").innerHTML = `
      <img class="viewer-media" src="${escapeHtml(src)}" alt="${escapeHtml(item.name)}" />
    `;
  }
}

function closeViewer() {
  $("viewer").classList.add("hidden");
  $("viewer").setAttribute("aria-hidden", "true");
  $("viewerBody").innerHTML = "";
}

async function refreshStatus() {
  const status = await request("/api/status");
  if (status.authorized) {
    $("loginPanel").classList.add("hidden");
  } else {
    $("loginPanel").classList.remove("hidden");
  }
}

async function startLogin() {
  const apiId = $("apiId").value.trim();
  const apiHash = $("apiHash").value.trim();
  const phone = $("phone").value.trim();
  if (!apiId || !apiHash || !phone) {
    toast("Nhập đủ API ID, API Hash và số điện thoại.");
    return;
  }
  saveTelegramCredentials(apiId, apiHash, phone);
  const result = await request("/api/login/start", {
    method: "POST",
    body: JSON.stringify({ api_id: apiId, api_hash: apiHash, phone }),
  });
  if (result.authorized) {
    $("loginPanel").classList.add("hidden");
    toast("Đã đăng nhập.");
  } else {
    $("codeArea").classList.remove("hidden");
    toast("Telegram đã gửi mã đăng nhập.");
  }
}

async function completeLogin() {
  const code = $("loginCode").value.trim();
  const password = $("password").value;
  if (!code) {
    toast("Nhập mã xác thực.");
    return;
  }
  const result = await request("/api/login/code", {
    method: "POST",
    body: JSON.stringify({ code, password }),
  });
  if (result.password_required) {
    toast("Tài khoản cần mật khẩu 2FA.");
    return;
  }
  $("loginPanel").classList.add("hidden");
  toast("Đăng nhập thành công.");
}

async function loadChats() {
  if (!requireAccessKey()) {
    return;
  }
  const data = await request("/api/chats");
  state.keyMode = data.key_mode || state.keyMode;
  localStorage.setItem("telegramDownloaderAccessKey", state.accessKey);
  updateKeyStatus();
  state.chats = data.chats;
  renderChats();
  toast(`Đã tải ${state.chats.length} nhóm/kênh.`);
}

async function selectChat(chatId) {
  const chat = state.chats.find((item) => item.id === chatId);
  state.scanToken += 1;
  state.selectedChat = chatId;
  state.selectedTitle = chat ? chat.title : chatId;
  state.media = [];
  state.mediaBatches = [];
  state.selectedIds.clear();
  state.nextOffsetId = 0;
  state.scannedMessages = 0;
  state.isScanning = true;
  $("mediaTitle").textContent = state.selectedTitle;
  renderChats();
  renderMedia();
  await scanAllMedia(state.scanToken);
}

async function loadMediaBatch(append = true) {
  if (!state.selectedChat) {
    toast("Chọn nhóm/kênh trước.");
    return;
  }
  const params = new URLSearchParams({
    chat_id: state.selectedChat,
    limit: "80",
    offset_id: append ? String(state.nextOffsetId || 0) : "0",
  });
  const data = await request(`/api/media?${params}`);
  if (!append) {
    state.media = [];
    state.mediaBatches = [];
    state.scannedMessages = 0;
  }
  state.scannedMessages += Number(data.scanned || 0);
  if (data.media.length) {
    state.media.push(...data.media);
    state.mediaBatches.push(data.media);
  }
  if (typeof data.next_offset_id === "number") {
    state.nextOffsetId = data.next_offset_id;
  }
  renderMedia();
  return data;
}

async function scanAllMedia(token) {
  try {
    let append = false;
    while (token === state.scanToken) {
      const previousOffset = state.nextOffsetId;
      const data = await loadMediaBatch(append);
      append = true;
      if (!data || !data.scanned || data.next_offset_id === previousOffset) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 120));
    }
    if (token === state.scanToken) {
      state.isScanning = false;
      renderMedia();
      toast(state.media.length ? `Đã quét xong ${state.media.length} media.` : "Không tìm thấy media trong nhóm này.");
    }
  } catch (error) {
    if (token === state.scanToken) {
      state.isScanning = false;
      renderMedia();
      toast(error.message);
    }
  }
}

async function saveAccessKey() {
  const key = $("accessKey").value.trim();
  if (!key) {
    toast("Nhập access key.");
    return;
  }
  const data = await request("/api/key/check", {
    method: "POST",
    body: JSON.stringify({ access_key: key }),
  });
  state.accessKey = key;
  state.keyMode = data.key_mode;
  localStorage.setItem("telegramDownloaderAccessKey", key);
  updateKeyStatus();
  toast(data.key_mode === "test" ? "Đã lưu Key Test." : "Đã lưu key không giới hạn.");
}

async function downloadSelected() {
  if (!state.selectedChat) {
    toast("Chọn nhóm/kênh trước.");
    return;
  }
  const messageIds = [...state.selectedIds];
  if (!messageIds.length) {
    toast("Tick ít nhất một ảnh hoặc video.");
    return;
  }
  if (!canDownloadWithCurrentKey(messageIds.length)) {
    return;
  }
  const items = messageIds.map((id) => state.media.find((media) => media.id === id)).filter(Boolean);
  items.forEach((item, index) => {
    setTimeout(() => browserDownload(item), index * 250);
  });
}

async function downloadOne(messageId) {
  if (!state.selectedChat) {
    toast("Chọn nhóm/kênh trước.");
    return;
  }
  const item = state.media.find((media) => media.id === messageId);
  browserDownload(item);
}

async function pollJob(jobId) {
  const data = await request(`/api/job?id=${encodeURIComponent(jobId)}`);
  $("jobBox").innerHTML = `
    <strong>${escapeHtml(data.status)}</strong>
    <div>${data.done}/${data.total} file đã tải.</div>
    ${data.error ? `<div class="media-text">${escapeHtml(data.error)}</div>` : ""}
    ${data.files.length ? `<div class="media-text">${data.files.map(escapeHtml).join("<br>")}</div>` : ""}
  `;
  if (data.status === "queued" || data.status === "running") {
    setTimeout(() => pollJob(jobId), 1200);
  } else if (data.status === "completed") {
    toast("Tải xong.");
  }
}

document.addEventListener("click", (event) => {
  const downloadButton = event.target.closest("[data-download-one]");
  if (downloadButton) {
    event.preventDefault();
    event.stopPropagation();
    const id = Number(downloadButton.dataset.downloadOne);
    downloadOne(id).catch((error) => toast(error.message));
    return;
  }

  const previewButton = event.target.closest("[data-open-preview]");
  if (previewButton) {
    event.preventDefault();
    event.stopPropagation();
    const id = Number(previewButton.dataset.openPreview);
    const item = state.media.find((media) => media.id === id);
    if (item) {
      openViewer(item);
    }
    return;
  }

  const chatButton = event.target.closest(".chat-item");
  if (chatButton) {
    selectChat(chatButton.dataset.chatId).catch((error) => toast(error.message));
    return;
  }

  const mediaItem = event.target.closest(".media-item");
  if (mediaItem) {
    const id = Number(mediaItem.dataset.messageId);
    if (state.selectedIds.has(id)) {
      state.selectedIds.delete(id);
    } else {
      state.selectedIds.add(id);
    }
    renderMedia();
  }
});

$("refreshStatus").addEventListener("click", () => refreshStatus().catch((error) => toast(error.message)));
$("startLogin").addEventListener("click", () => startLogin().catch((error) => toast(error.message)));
$("completeLogin").addEventListener("click", () => completeLogin().catch((error) => toast(error.message)));
$("accessKey").addEventListener("input", () => {
  const raw = $("accessKey").value;
  if (raw !== TEST_ACCESS_KEY) {
    $("accessKey").value = raw.toUpperCase();
  }
});
$("saveAccessKey").addEventListener("click", () => saveAccessKey().catch((error) => toast(error.message)));
$("loadChats").addEventListener("click", () => loadChats().catch((error) => toast(error.message)));
$("downloadSelected").addEventListener("click", () => downloadSelected().catch((error) => toast(error.message)));
$("chatSearch").addEventListener("input", renderChats);
$("closeViewer").addEventListener("click", closeViewer);
$("viewer").addEventListener("click", (event) => {
  if (event.target.id === "viewer") {
    closeViewer();
  }
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    closeViewer();
  }
});

updateKeyStatus();
loadTelegramCredentials();
refreshStatus().catch((error) => toast(error.message));
