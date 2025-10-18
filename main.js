// ==================== 設定 ====================
const CLIENT_ID = "616108077164-13ta54cr62nklvambt4ln1of6sfps5sm.apps.googleusercontent.com";
const API_KEY = "AIzaSyDQ8UIFpAIfWR3pWO1WiZzzLT_y8o9pY8s";
const SCOPES = "https://www.googleapis.com/auth/drive.file";

let tokenClient;
let plantAppFolderId = null;
let currentProjectId = null;
let currentProjectSettings = null;
let commandFileId = null;
let currentCommandData = null;

let lastStateForNotify = ""; // ブラウザ内ローカル通知用

// ==== Web Push ====
const VAPID_PUBLIC_KEY = "BMQPaHWTP-zU0BYOeWXT-bxBjMQbF0rIkuhRgme5L-iAiPl6hYJQhLAqg35cFa51-zC_3IViSkiJUPBSjetokOg";
const SW_PATH = "sw.js";
function urlBase64ToUint8Array(b64) {
  const pad = '='.repeat((4 - b64.length % 4) % 4);
  const base64 = (b64 + pad).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; ++i) out[i] = raw.charCodeAt(i);
  return out;
}

// ==================== 共通関数 ====================
function showError(context, err) {
  console.error(`[ERROR] ${context}`, err);
  alert(`❌ ${context}\n${err?.message || err}`);
}

function initGapi() {
  return new Promise((resolve, reject) => {
    gapi.load("client", () => {
      gapi.client
        .init({
          apiKey: API_KEY,
          discoveryDocs: ["https://www.googleapis.com/discovery/v1/apis/drive/v3/rest"]
        })
        .then(resolve)
        .catch(err => { showError("gapi初期化", err); reject(err); });
    });
  });
}

function gisLogin() {
  return new Promise((resolve, reject) => {
    try {
      tokenClient = google.accounts.oauth2.initTokenClient({
        client_id: CLIENT_ID,
        scope: SCOPES,
        callback: (tokenResponse) => {
          if (tokenResponse && tokenResponse.access_token) resolve(tokenResponse.access_token);
          else reject(new Error("トークン取得失敗"));
        }
      });
      tokenClient.requestAccessToken();
    } catch (err) {
      showError("GISログイン", err); reject(err);
    }
  });
}

async function sha256(message) {
  const buf = new TextEncoder().encode(message);
  const hash = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, "0")).join("");
}

// ==================== Drive ヘルパ ====================
async function uploadJsonToDrive(fileName, jsonData, parentId) {
  const blob = new Blob([JSON.stringify(jsonData, null, 2)], { type: "application/json" });
  const metadata = { name: fileName, mimeType: "application/json", parents: [parentId] };
  const form = new FormData();
  form.append("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }));
  form.append("file", blob);
  await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart", {
    method: "POST",
    headers: new Headers({ Authorization: "Bearer " + gapi.client.getToken().access_token }),
    body: form
  });
}

async function updateJsonOnDrive(fileId, jsonData) {
  const blob = new Blob([JSON.stringify(jsonData, null, 2)], { type: "application/json" });
  const metadata = { mimeType: "application/json" };
  const form = new FormData();
  form.append("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }));
  form.append("file", blob);
  await fetch(`https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=multipart`, {
    method: "PATCH",
    headers: new Headers({ Authorization: "Bearer " + gapi.client.getToken().access_token }),
    body: form
  });
}

async function createPlantAppFolder() {
  const search = await gapi.client.drive.files.list({
    q: "name='PlantApp' and mimeType='application/vnd.google-apps.folder' and trashed=false",
    fields: "files(id, name)"
  });
  if (search.result.files.length > 0) {
    plantAppFolderId = search.result.files[0].id;
  } else {
    const folder = await gapi.client.drive.files.create({
      resource: { name: "PlantApp", mimeType: "application/vnd.google-apps.folder" },
      fields: "id"
    });
    plantAppFolderId = folder.result.id;
    await uploadJsonToDrive("settings.json", { version: 1 }, plantAppFolderId);
  }
}

async function loadProjects() {
  const res = await gapi.client.drive.files.list({
    q: `'${plantAppFolderId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
    fields: "files(id, name)"
  });
  const listDiv = document.getElementById("projectList");
  listDiv.innerHTML = "";
  if (res.result.files.length === 0) {
    listDiv.innerHTML = "<p>プロジェクトがありません</p>";
    return;
  }
  res.result.files.forEach(file => {
    const match = file.name.match(/^project_(\d+)_(.*)$/);
    const displayName = match ? match[2] : file.name;
    const row = document.createElement("div");
    row.innerHTML = `
      <span>${displayName}</span>
      <button onclick="openProject('${file.id}')">開く</button>
      <button onclick="renameProject('${file.id}', '${file.name}')">名前変更</button>
      <button onclick="deleteProject('${file.id}')">削除</button>
    `;
    listDiv.appendChild(row);
  });
}

async function createProject() {
  const name = prompt("新しいプロジェクト名を入力してください:");
  if (!name || name.trim() === "") return;

  const idPart = Math.floor(1000000000 + Math.random() * 9000000000).toString();
  const displayName = name.trim();
  const fullName = `project_${idPart}_${displayName}`;

  const profile = await gapi.client.drive.about.get({ fields: "user(emailAddress)" });
  const ownerHash = await sha256(profile.result.user.emailAddress);
  const raspiKey = Math.random().toString(36).substring(2, 15);

  const projectFolder = await gapi.client.drive.files.create({
    resource: { name: fullName, mimeType: "application/vnd.google-apps.folder", parents: [plantAppFolderId] },
    fields: "id"
  });
  const projectFolderId = projectFolder.result.id;

  const subFolders = ["analysis", "picture", "data"];
  const subFolderIds = {};
  for (const sub of subFolders) {
    const sf = await gapi.client.drive.files.create({
      resource: { name: sub, mimeType: "application/vnd.google-apps.folder", parents: [projectFolderId] },
      fields: "id"
    });
    subFolderIds[sub] = sf.result.id;
  }

  const settingsContent = {
    id: idPart,
    name: displayName,
    created: new Date().toISOString(),
    lastModified: new Date().toISOString(),
    notes: "",
    projectFolderId: projectFolderId,
    subFolderIds: subFolderIds,
    raspiAuthKey: raspiKey,
    ownerIdHash: ownerHash
  };
  await uploadJsonToDrive("project_settings.json", settingsContent, projectFolderId);

  // ★ 事前通知分＆パッド秒を追加
  const initialCommands = {
    growthAuto: { enabled: false, interval: 10, schedules: [], runNow: false, preNoticeMin: 5, padAfterNoticeSec: 60 },
    bmeAuto:    { enabled: false, interval: 10, schedules: [], runNow: false },
    waterAuto:  { enabled: false, interval: 10, schedules: [], runNow: false },
    lightAuto:  { enabled: false, interval: 1,  schedules: [], runNow: false } // 日照度は1分をデフォルトに
  };
  await uploadJsonToDrive("command.json", initialCommands, projectFolderId);

  alert("プロジェクトを作成しました！");
  await loadProjects();
}

async function loadCommandFile() {
  const res = await gapi.client.drive.files.list({
    q: `'${currentProjectId}' in parents and name='command.json' and trashed=false`,
    fields: "files(id, name)"
  });
  if (res.result.files.length > 0) {
    commandFileId = res.result.files[0].id;
    const fileContent = await gapi.client.drive.files.get({ fileId: commandFileId, alt: "media" });
    currentCommandData = fileContent.result;
    // フィールドが無い古いcommand.jsonの互換
    currentCommandData.growthAuto = currentCommandData.growthAuto || {};
    if (typeof currentCommandData.growthAuto.preNoticeMin !== "number") currentCommandData.growthAuto.preNoticeMin = 5;
    if (typeof currentCommandData.growthAuto.padAfterNoticeSec !== "number") currentCommandData.growthAuto.padAfterNoticeSec = 60;
  }
}

// ==================== スケジュールUI ====================
async function addSchedule(key) {
  if (!currentCommandData || !commandFileId) return alert("コマンド未読込");
  const time = prompt("追加する時間をHH:MMで入力（例 08:30）");
  if (!time || !/^\d{1,2}:\d{2}$/.test(time)) return alert("形式が正しくありません");
  currentCommandData[key].schedules.push({ time, enabled: true });
  await updateJsonOnDrive(commandFileId, currentCommandData);
  renderSchedules(key);
}
function renderSchedules(key) {
  const listEl = document.getElementById(`${key}ScheduleList`);
  listEl.innerHTML = "";
  currentCommandData[key].schedules.forEach((s, idx) => {
    const item = document.createElement("div");
    item.textContent = `${s.time} `;
    const toggleBtn = document.createElement("button");
    toggleBtn.textContent = s.enabled ? "ON" : "OFF";
    toggleBtn.onclick = async () => { s.enabled = !s.enabled; await updateJsonOnDrive(commandFileId, currentCommandData); renderSchedules(key); };
    const delBtn = document.createElement("button");
    delBtn.textContent = "削除";
    delBtn.onclick = async () => { currentCommandData[key].schedules.splice(idx, 1); await updateJsonOnDrive(commandFileId, currentCommandData); renderSchedules(key); };
    item.appendChild(toggleBtn); item.appendChild(delBtn);
    listEl.appendChild(item);
  });
}
async function updateCommand(key, field, value) {
  if (!currentCommandData || !commandFileId) return;
  currentCommandData[key][field] = value;
  await updateJsonOnDrive(commandFileId, currentCommandData);
}
async function runNow(key) {
  if (!currentCommandData || !commandFileId) return;
  currentCommandData[key].runNow = true;
  await updateJsonOnDrive(commandFileId, currentCommandData);
  alert(`${key} を即時実行として送信しました`);
}
async function runPairNow() {
  if (!currentCommandData || !commandFileId) return;
  currentCommandData["growthAuto"].runNow = true;
  await updateJsonOnDrive(commandFileId, currentCommandData);
  alert("成長計測（撮影）を送信しました");
}

// ==================== ステータス表示/履歴 ====================
async function loadStatus() {
  if (!currentProjectId) return;
  try {
    const res = await gapi.client.drive.files.list({
      q: `'${currentProjectId}' in parents and name='status.json' and trashed=false`,
      fields: "files(id, modifiedTime)"
    });
    if (res.result.files.length === 0) {
      document.getElementById("piState").innerText = "—";
      document.getElementById("piTemp").innerText = "—";
      document.getElementById("piLast").innerText = "—";
      document.getElementById("piMsg").innerText = "未取得";
      return;
    }
    const fid = res.result.files[0].id;
    const content = await gapi.client.drive.files.get({ fileId: fid, alt: "media" });
    const st = content.result || {};
    document.getElementById("piState").innerText = st.state || "—";
    document.getElementById("piTemp").innerText = (st.cpu_temp_c ?? "—");
    document.getElementById("piLast").innerText = st.last_schedule_tag || st.last_pair_id || "—";
    document.getElementById("piMsg").innerText = st.message || "—";

    // ブラウザ内の簡易通知（PWAのWeb Pushとは別物）
    if (("Notification" in window) && Notification.permission === "granted") {
      if (st.state && st.state !== lastStateForNotify) {
        const body = st.state === "paused_overheat"
          ? `高温検知で一時停止中（${st.cpu_temp_c ?? "?"}℃）`
          : `状態: ${st.state}`;
        new Notification("PlantApp 状態通知", { body });
        lastStateForNotify = st.state;
      }
    }
  } catch (e) {
    console.warn("status取得失敗", e);
  }
}

async function enableNotify() {
  try {
    if (!currentProjectId) return alert("プロジェクトを開いてから許可してください");

    const ua = navigator.userAgent || "";
    const isiOS = /iPad|iPhone|iPod/.test(ua);
    const isStandalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone;
    if (isiOS && !isStandalone) {
      alert("iOSはPWAのみ受信可です。共有メニュー→『ホーム画面に追加』して起動してください。");
    }

    if (!("Notification" in window) || !("serviceWorker" in navigator) || !("PushManager" in window)) {
      return alert("このブラウザはWeb Pushに対応していません");
    }
    const perm = await Notification.requestPermission();
    if (perm !== "granted") return alert("通知が拒否されました");

    const reg = await navigator.serviceWorker.register(SW_PATH);
    await navigator.serviceWorker.ready;

    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY)
    });

    await savePushSubscriptionToDrive(sub);
    alert("プッシュ通知を有効化しました");
  } catch (err) {
    showError("通知の有効化", err);
  }
}

// 最新と履歴（既存）
async function loadLatestStatus() {
  if (!currentProjectSettings) return;
  document.getElementById("reloadStatus").innerText = "読み込み中...";
  try {
    // 画像（最新1件）
    const picRes = await gapi.client.drive.files.list({
      q: `'${currentProjectSettings.subFolderIds.picture}' in parents and trashed=false`,
      orderBy: "createdTime desc",
      pageSize: 1,
      fields: "files(id, name, createdTime)"
    });
    if (picRes.result.files.length > 0) {
      const fileId = picRes.result.files[0].id;
      document.getElementById("latestImage").src = `https://drive.google.com/uc?export=view&id=${fileId}`;
      document.getElementById("latestImageTime").innerText =
        `画像時刻: ${new Date(picRes.result.files[0].createdTime).toLocaleString()}`;
    }

    // 環境データ（最新1件）
    const dataRes = await gapi.client.drive.files.list({
      q: `'${currentProjectSettings.subFolderIds.data}' in parents and trashed=false and name contains '.json'`,
      orderBy: "createdTime desc",
      pageSize: 1,
      fields: "files(id, name, createdTime)"
    });
    if (dataRes.result.files.length > 0) {
      const fileId = dataRes.result.files[0].id;
      const fileContent = await gapi.client.drive.files.get({ fileId: fileId, alt: "media" });
      document.getElementById("latestEnv").innerText =
        `${new Date(dataRes.result.files[0].createdTime).toLocaleString()} 時点\n` +
        JSON.stringify(fileContent.result, null, 2);
    }
    await loadStatus();
    document.getElementById("reloadStatus").innerText = "完了";
  } catch (err) {
    showError("最新状態取得", err);
    document.getElementById("reloadStatus").innerText = "失敗";
  }
}

async function loadHistory() {
  if (!currentProjectSettings) return;
  document.getElementById("historyStatus").innerText = "読み込み中...";
  const table = document.getElementById("historyTable");
  table.innerHTML = `<tr><th>時刻</th><th>画像</th><th>データ</th></tr>`;
  try {
    const pics = await gapi.client.drive.files.list({
      q: `'${currentProjectSettings.subFolderIds.picture}' in parents and trashed=false`,
      orderBy: "createdTime desc",
      fields: "files(id, name, createdTime)"
    });
    const datas = await gapi.client.drive.files.list({
      q: `'${currentProjectSettings.subFolderIds.data}' in parents and trashed=false and name contains '.json'`,
      orderBy: "createdTime desc",
      fields: "files(id, name, createdTime)"
    });

    const dataMap = {};
    for (const d of datas.result.files) {
      const content = await gapi.client.drive.files.get({ fileId: d.id, alt: "media" });
      const obj = content.result || {};
      const pid = obj.pair_id || "";
      const key = pid || new Date(d.createdTime).toLocaleString();
      dataMap[key] = JSON.stringify(obj);
    }

    for (const p of pics.result.files) {
      const timeStr = new Date(p.createdTime).toLocaleString();
      const row = document.createElement("tr");
      row.innerHTML = `
        <td>${timeStr}</td>
        <td><img src="https://drive.google.com/uc?export=view&id=${p.id}" width="100"></td>
        <td>${dataMap[timeStr] || ""}</td>
      `;
      table.appendChild(row);
    }
    document.getElementById("historyStatus").innerText = "完了";
  } catch (err) {
    showError("履歴読み込み", err);
    document.getElementById("historyStatus").innerText = "失敗";
  }
}

function downloadHistory() {
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF();
  doc.text("成長記録", 10, 10);
  let y = 20;
  const table = document.getElementById("historyTable");
  for (let i = 0; i < table.rows.length; i++) {
    const cells = table.rows[i].cells;
    let rowText = "";
    for (let j = 0; j < cells.length; j++) rowText += cells[j].innerText + (j < cells.length - 1 ? " | " : "");
    doc.text(rowText, 10, y);
    y += 10;
  }
  doc.save(`history_${new Date().toISOString().slice(0, 10)}.pdf`);
}

// ==================== プロジェクト画面 ====================
async function openProject(fileId) {
  currentProjectId = fileId;
  await loadCommandFile();

  const settingsRes = await gapi.client.drive.files.list({
    q: `'${fileId}' in parents and name='project_settings.json' and trashed=false`,
    fields: "files(id)"
  });
  if (settingsRes.result.files.length > 0) {
    const setFileId = settingsRes.result.files[0].id;
    const setContent = await gapi.client.drive.files.get({ fileId: setFileId, alt: "media" });
    currentProjectSettings = setContent.result;
  }

  document.getElementById("homeScreen").classList.add("hidden");
  document.getElementById("projectScreen").classList.remove("hidden");

  const mapping = [
    { key: "growthAuto", btn: "growthAutoBtn", nowBtn: "growthNowBtn", interval: "growthAutoInterval" },
    { key: "bmeAuto",    btn: "bmeAutoBtn",    nowBtn: "bmeNowBtn",    interval: "bmeAutoInterval" },
    { key: "waterAuto",  btn: "waterAutoBtn",  nowBtn: "waterNowBtn",  interval: "waterAutoInterval" },
    { key: "lightAuto",  btn: "lightAutoBtn",  nowBtn: "lightNowBtn",  interval: "lightAutoInterval" }
  ];

  mapping.forEach(({ key, btn, nowBtn, interval }) => {
    const btnEl = document.getElementById(btn);
    btnEl.textContent = currentCommandData[key]?.enabled ? "ON" : "OFF";
    btnEl.onclick = () => {
      const newState = !(currentCommandData[key]?.enabled);
      btnEl.textContent = newState ? "ON" : "OFF";
      updateCommand(key, "enabled", newState);
    };

    const intEl = document.getElementById(interval);
    intEl.value = currentCommandData[key]?.interval ?? 10;
    intEl.onchange = () => updateCommand(key, "interval", parseInt(intEl.value, 10));

    document.getElementById(nowBtn).onclick = () => runNow(key);
  });

  // ★ 成長計測：事前通知分・パッド秒
  const preEl = document.getElementById("growthPreNoticeMin");
  const padEl = document.getElementById("growthPadSec");
  preEl.value = currentCommandData.growthAuto?.preNoticeMin ?? 5;
  padEl.value = currentCommandData.growthAuto?.padAfterNoticeSec ?? 60;
  preEl.onchange = () => updateCommand("growthAuto", "preNoticeMin", parseInt(preEl.value, 10));
  padEl.onchange = () => updateCommand("growthAuto", "padAfterNoticeSec", parseInt(padEl.value, 10));

  document.getElementById("pairNowBtn").onclick = runPairNow;

  document.getElementById("growthBtn").onclick = () => {
    document.getElementById("growthMenu").classList.toggle("hidden");
  };
  document.getElementById("envBtn").onclick = () => {
    document.getElementById("envMenu").classList.toggle("hidden");
  };

  document.getElementById("reloadEnvBtn").onclick = loadLatestStatus;
  document.getElementById("recordBtn").onclick = loadHistory;
  document.getElementById("downloadHistoryBtn").onclick = downloadHistory;
  document.getElementById("enableNotifyBtn").onclick = enableNotify;

  await loadLatestStatus();

  // ステータス自動更新（60秒ごと）
  setInterval(loadStatus, 60000);
}

// ==================== アカウント/プロジェクト管理 ====================
async function deleteAccount() {
  if (!plantAppFolderId) return alert("PlantAppフォルダが見つかりません。");
  if (!confirm("⚠️ アカウントデータをすべて削除します。本当に実行しますか？")) return;
  try {
    const res = await gapi.client.drive.files.list({
      q: `'${plantAppFolderId}' in parents and trashed=false`,
      fields: "files(id)"
    });
    for (const file of res.result.files) {
      await gapi.client.drive.files.update({ fileId: file.id, resource: { trashed: true } });
    }
    await gapi.client.drive.files.update({ fileId: plantAppFolderId, resource: { trashed: true } });
    alert("削除しました");
    plantAppFolderId = null; currentProjectId = null; currentProjectSettings = null; commandFileId = null; currentCommandData = null;
    document.getElementById("homeScreen").classList.add("hidden");
    document.getElementById("projectScreen").classList.add("hidden");
    document.getElementById("loginScreen").classList.remove("hidden");
  } catch (err) { showError("アカウント削除", err); }
}
async function deleteProject(fileId) {
  if (!confirm("本当にこのプロジェクトを削除しますか？")) return;
  try { await gapi.client.drive.files.update({ fileId, resource: { trashed: true } }); await loadProjects(); }
  catch (err) { showError("プロジェクト削除", err); }
}
async function renameProject(fileId, oldName) {
  const m = oldName.match(/^project_(\d+)_(.*)$/);
  if (!m) return alert("名前形式が正しくありません");
  const idPart = m[1]; const oldDisplay = m[2];
  const newDisplay = prompt("新しい名前:", oldDisplay);
  if (!newDisplay || newDisplay.trim() === "") return;
  const newName = `project_${idPart}_${newDisplay.trim()}`;
  try { await gapi.client.drive.files.update({ fileId, resource: { name: newName } }); await loadProjects(); }
  catch (err) { showError("名前変更", err); }
}

// ===== Web Push: Drive保存ヘルパ =====
async function findFileInProjectByName(name) {
  const res = await gapi.client.drive.files.list({
    q: `'${currentProjectId}' in parents and name='${name}' and trashed=false`,
    fields: "files(id,name)"
  });
  return res.result.files.length ? res.result.files[0].id : null;
}
async function getJsonByFileId(fileId) {
  const r = await gapi.client.drive.files.get({ fileId, alt: "media" });
  return r.result || null;
}
async function savePushSubscriptionToDrive(subscription) {
  const fname = "push_subscriptions.json";
  const fileId = await findFileInProjectByName(fname);
  const item = {
    endpoint: subscription.endpoint,
    keys: subscription.toJSON().keys || {},
    ua: navigator.userAgent,
    ts: new Date().toISOString()
  };
  if (!fileId) {
    await uploadJsonToDrive(fname, { v:1, updated:new Date().toISOString(), items:[item] }, currentProjectId);
    return;
  }
  const cur = (await getJsonByFileId(fileId)) || { v:1, items:[] };
  cur.items = Array.isArray(cur.items) ? cur.items : [];
  const i = cur.items.findIndex(x => x.endpoint === item.endpoint);
  if (i >= 0) cur.items[i] = item; else cur.items.push(item);
  cur.updated = new Date().toISOString();
  await updateJsonOnDrive(fileId, cur);
}

// ==================== 初期化 ====================
window.onload = () => {
  const bindBtn = (id, handler) => {
    const el = document.getElementById(id); if (!el) return;
    el.addEventListener("click", handler); el.addEventListener("touchstart", handler);
  };
  bindBtn("loginBtn", () => handleLogin(false));
  bindBtn("createProjectBtn", createProject);
  bindBtn("deleteAccountBtn", deleteAccount);
  bindBtn("backBtn", () => {
    document.getElementById("projectScreen").classList.add("hidden");
    document.getElementById("homeScreen").classList.remove("hidden");
    loadProjects();
  });
  bindBtn("reloadEnvBtn", loadLatestStatus);
  bindBtn("recordBtn", loadHistory);
  bindBtn("downloadHistoryBtn", downloadHistory);
};

// グローバル
window.addSchedule = addSchedule;
window.loadLatestStatus = loadLatestStatus;
window.loadHistory = loadHistory;
window.downloadHistory = downloadHistory;
