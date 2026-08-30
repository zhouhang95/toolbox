const $ = (selector) => document.querySelector(selector);
const elements = {
  dropzone: $("#dropzone"), fileInput: $("#fileInput"), dropTitle: $("#dropTitle"),
  dropHint: $("#dropHint"), filePill: $("#filePill"), folderButton: $("#folderButton"),
  folderLabel: $("#folderLabel"), extractButton: $("#extractButton"), subfolder: $("#subfolder"),
  formats: document.querySelectorAll('input[name="format"]'),
  progress: $("#progress"), statusText: $("#statusText"), statusDetail: $("#statusDetail"),
  progressBar: $("#progressBar"), result: $("#result"), resultTitle: $("#resultTitle"),
  resultDetail: $("#resultDetail"), resetButton: $("#resetButton"),
  errorPanel: $("#errorPanel"), errorText: $("#errorText")
};

let selectedFile = null;
let directoryHandle = null;
let worker = null;
// `?downloads=1` is useful for browsers that expose the API but cannot grant a
// directory handle (embedded webviews and automated smoke tests, for example).
const forceDownloads = new URLSearchParams(location.search).has("downloads");
const supportsFolderPicker = "showDirectoryPicker" in window && !forceDownloads;

function readableSize(bytes) {
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return `${value.toFixed(unit ? 1 : 0)} ${units[unit]}`;
}

function safeBaseName(name) {
  return name.replace(/\.pdf$/i, "").replace(/[\\/:*?"<>|]/g, "_").trim() || "pdf";
}

function updateButton() {
  elements.extractButton.disabled = !selectedFile || (!directoryHandle && supportsFolderPicker);
}

function selectFile(file) {
  if (!file) return;
  if (!file.name.toLowerCase().endsWith(".pdf") && file.type !== "application/pdf") {
    showError("请选择 PDF 文件。");
    return;
  }
  selectedFile = file;
  elements.dropzone.classList.add("has-file");
  elements.dropTitle.textContent = file.name;
  elements.dropHint.textContent = "点击可更换文件";
  elements.filePill.hidden = false;
  elements.filePill.textContent = readableSize(file.size);
  elements.result.hidden = true;
  elements.errorPanel.hidden = true;
  updateButton();
}

function showError(message) {
  elements.progress.hidden = true;
  elements.errorText.textContent = message;
  elements.errorPanel.hidden = false;
  elements.errorPanel.open = true;
  elements.extractButton.disabled = false;
}

elements.dropzone.addEventListener("click", (event) => {
  // The synthetic click on the nested file input bubbles back to the dropzone.
  // Ignore that second event or some browsers suppress the file picker entirely.
  if (event.target !== elements.fileInput) elements.fileInput.click();
});
elements.dropzone.addEventListener("keydown", (event) => {
  if (event.key === "Enter" || event.key === " ") { event.preventDefault(); elements.fileInput.click(); }
});
elements.fileInput.addEventListener("change", () => selectFile(elements.fileInput.files[0]));
for (const eventName of ["dragenter", "dragover"]) {
  elements.dropzone.addEventListener(eventName, (event) => { event.preventDefault(); elements.dropzone.classList.add("dragging"); });
}
for (const eventName of ["dragleave", "drop"]) {
  elements.dropzone.addEventListener(eventName, (event) => { event.preventDefault(); elements.dropzone.classList.remove("dragging"); });
}
elements.dropzone.addEventListener("drop", (event) => selectFile([...event.dataTransfer.files].find((file) => file.name.toLowerCase().endsWith(".pdf"))));

// Prevent the browser from navigating to a dropped PDF when the pointer lands
// on a child edge or elsewhere in the page instead of the exact dropzone node.
for (const eventName of ["dragover", "drop"]) {
  window.addEventListener(eventName, (event) => event.preventDefault());
}

if (!supportsFolderPicker) {
  elements.folderLabel.textContent = "当前浏览器不支持文件夹选择，将改为逐个下载";
  elements.folderButton.hidden = true;
}

elements.folderButton.addEventListener("click", async () => {
  try {
    directoryHandle = await window.showDirectoryPicker({ mode: "readwrite", id: "pdfimages-output" });
    elements.folderLabel.textContent = directoryHandle.name;
    updateButton();
  } catch (error) {
    if (error.name !== "AbortError") showError(error.message);
  }
});

async function createSaveTarget() {
  if (!elements.subfolder.checked) return directoryHandle;
  return directoryHandle.getDirectoryHandle(`${safeBaseName(selectedFile.name)}_images`, { create: true });
}

async function saveChunkToDirectory(files, target) {
  for (const file of files) {
    const handle = await target.getFileHandle(file.name, { create: true });
    const writable = await handle.createWritable();
    await writable.write(file.buffer);
    await writable.close();
  }
}

function downloadFiles(files) {
  files.forEach((file, index) => {
    setTimeout(() => {
      const link = document.createElement("a");
      link.href = URL.createObjectURL(new Blob([file.buffer]));
      link.download = file.name;
      link.click();
      setTimeout(() => URL.revokeObjectURL(link.href), 2000);
    }, index * 160);
  });
  return "浏览器下载目录";
}

elements.extractButton.addEventListener("click", async () => {
  if (!selectedFile) return;
  elements.extractButton.disabled = true;
  elements.errorPanel.hidden = true;
  elements.result.hidden = true;
  elements.progress.hidden = false;
  elements.progressBar.style.width = "8%";
  elements.statusText.textContent = "正在读取 PDF…";
  elements.statusDetail.textContent = readableSize(selectedFile.size);

  try {
    const buffer = await selectedFile.arrayBuffer();
    let saveQueue = Promise.resolve();
    let saveTargetPromise = null;
    let savedCount = 0;
    let saveFailure = null;
    let outputLocation = supportsFolderPicker ? directoryHandle.name : "浏览器下载目录";
    worker?.terminate();
    worker = new Worker("./pdf-worker.js", { type: "module" });
    worker.onmessage = async ({ data }) => {
      if (data.type === "status") {
        elements.statusText.textContent = data.text;
        elements.statusDetail.textContent = data.phase === "engine" ? "WASM" : "POPPLER";
        elements.progressBar.style.width = data.phase === "engine" ? "22%" : "58%";
      } else if (data.type === "page-output") {
        const percent = Math.round((data.current / data.total) * 100);
        elements.statusText.textContent = `正在处理第 ${data.current} / ${data.total} 页`;
        elements.statusDetail.textContent = `${percent}% · 已提取 ${data.fileCount} 个文件`;
        elements.progressBar.style.width = `${10 + percent * 0.85}%`;
        if (data.files.length) {
          saveQueue = saveQueue.then(async () => {
            if (saveFailure) return;
            if (supportsFolderPicker) {
              saveTargetPromise ||= createSaveTarget();
              const target = await saveTargetPromise;
              outputLocation = target.name;
              await saveChunkToDirectory(data.files, target);
            } else {
              outputLocation = downloadFiles(data.files);
            }
            savedCount += data.files.length;
          }).catch((error) => {
            if (!saveFailure) {
              saveFailure = error;
              worker.terminate();
              showError(`保存文件失败：${error.message}`);
            }
          });
        }
      } else if (data.type === "error") {
        worker.terminate();
        showError([data.message, ...(data.details || [])].filter(Boolean).join("\n"));
      } else if (data.type === "complete") {
        worker.terminate();
        try {
          await saveQueue;
        } catch {
          return;
        }
        if (saveFailure) return;
        elements.progressBar.style.width = "100%";
        elements.statusText.textContent = "完成";
        elements.statusDetail.textContent = `${savedCount} FILES`;
        elements.resultTitle.textContent = savedCount ? `已提取 ${savedCount} 个文件` : "PDF 中没有可提取的图片";
        elements.resultDetail.textContent = savedCount ? `已逐页保存到「${outputLocation}」` : "没有生成输出文件";
        elements.result.hidden = false;
        elements.extractButton.disabled = false;
      }
    };
    worker.onerror = (event) => showError(event.message || "Worker 启动失败");
    const format = [...elements.formats].find((input) => input.checked)?.value || "all";
    worker.postMessage({ type: "extract", buffer, format }, [buffer]);
  } catch (error) {
    showError(error.stack || error.message);
  }
});

elements.resetButton.addEventListener("click", () => {
  selectedFile = null;
  elements.fileInput.value = "";
  elements.dropzone.classList.remove("has-file");
  elements.dropTitle.textContent = "拖入 PDF 文件";
  elements.dropHint.textContent = "或点击此处选择文件";
  elements.filePill.hidden = true;
  elements.progress.hidden = true;
  elements.result.hidden = true;
  updateButton();
});
