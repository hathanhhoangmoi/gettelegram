const state = {
  chats: [],
  filteredChats: [],
  selectedChat: null,
  selectedTitle: "",
  media: [],
  mediaBatches: [],
  selectedIds: new Set(),
  nextOffsetId: 0,
};

const $ = (id) => document.getElementById(id);

function toast(message) {
  const el = $("toast");
  el.textContent = message;
  el.classList.remove("hidden");
  clearTimeout(window.toastTimer);
  window.toastTimer = setTimeout(() => el.classList.add("hidden"), 4200);
}

async function request(path, options = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  const data = await res.json();
  if (!res.ok || data.error) {
    throw new Error(data.error || "Request failed");
  }
  return data;
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
  $("selectedCount").textContent = state.selectedIds.size
    ? `${state.selectedIds.size} media đã chọn.`
    : "Chưa chọn media.";
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
            <img src="${escapeHtml(item.thumbnail_url)}" alt="${escapeHtml(item.name)}" loading="lazy" />
            <span class="kind">${item.kind}</span>
            ${item.kind === "video" ? '<span class="play">▶</span>' : ""}
          </button>
          <div>
            <div class="media-row">
              <div class="media-name" title="${escapeHtml(item.name)}">${escapeHtml(compactName(item.name))}</div>
              <input type="checkbox" ${checked ? "checked" : ""} aria-label="Select media ${item.id}" />
            </div>
            <div class="media-date">${escapeHtml(item.date)}</div>
            <div class="media-size">${formatBytes(item.size)}</div>
            ${item.text ? `<div class="media-text">${escapeHtml(item.text)}</div>` : ""}
            <button class="download-one" data-download-one="${item.id}" title="Tải file này">Tải file</button>
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
  const data = await request("/api/chats");
  state.chats = data.chats;
  renderChats();
  toast(`Đã tải ${state.chats.length} nhóm/kênh.`);
}

async function selectChat(chatId) {
  const chat = state.chats.find((item) => item.id === chatId);
  state.selectedChat = chatId;
  state.selectedTitle = chat ? chat.title : chatId;
  state.media = [];
  state.mediaBatches = [];
  state.selectedIds.clear();
  state.nextOffsetId = 0;
  $("mediaTitle").textContent = state.selectedTitle;
  renderChats();
  await loadMedia(false);
}

async function loadMedia(append = true) {
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
  }
  if (data.media.length) {
    state.media.push(...data.media);
    state.mediaBatches.push(data.media);
  }
  if (typeof data.next_offset_id === "number") {
    state.nextOffsetId = data.next_offset_id;
  }
  renderMedia();
  if (!data.media.length && data.scanned) {
    toast("Đoạn này chưa có media, bấm Tải thêm để quét tiếp.");
  }
  if (data.scan_limit_reached) {
    toast("Đã quét sâu nhưng chưa đủ media, bấm Tải thêm để tiếp tục.");
  }
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
  const job = await request("/api/download", {
    method: "POST",
    body: JSON.stringify({ chat_id: state.selectedChat, message_ids: messageIds }),
  });
  $("jobBox").classList.remove("hidden");
  pollJob(job.job_id);
}

async function downloadOne(messageId) {
  if (!state.selectedChat) {
    toast("Chọn nhóm/kênh trước.");
    return;
  }
  const item = state.media.find((media) => media.id === messageId);
  const job = await request("/api/download", {
    method: "POST",
    body: JSON.stringify({ chat_id: state.selectedChat, message_ids: [messageId] }),
  });
  $("jobBox").classList.remove("hidden");
  toast(`Đang tải ${item ? compactName(item.name) : "file"}...`);
  pollJob(job.job_id);
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
$("loadChats").addEventListener("click", () => loadChats().catch((error) => toast(error.message)));
$("loadMore").addEventListener("click", () => loadMedia(true).catch((error) => toast(error.message)));
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

refreshStatus().catch((error) => toast(error.message));
