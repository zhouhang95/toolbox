import createPdfImages from "./wasm/pdfimages.js";

self.onmessage = async ({ data }) => {
  if (data.type !== "extract") return;
  const errors = [];
  let totalFileCount = 0;

  try {
    self.postMessage({ type: "status", phase: "engine", text: "正在启动 Poppler…" });
    let module;
    module = await createPdfImages({
      locateFile: (name) => new URL(`./wasm/${name}`, import.meta.url).href,
      print: () => {},
      printErr: (line) => errors.push(String(line)),
      onPdfImagesProgress: (current, total) => {
        const names = module.FS.readdir("/work")
          .filter((name) => name !== "." && name !== ".." && name !== "input.pdf")
          .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
        const files = names.map((name) => {
          const bytes = module.FS.readFile(`/work/${name}`);
          return { name, buffer: bytes.slice().buffer };
        });
        for (const name of names) module.FS.unlink(`/work/${name}`);
        totalFileCount += files.length;
        const transfer = files.map((file) => file.buffer);
        self.postMessage({ type: "page-output", current, total, fileCount: totalFileCount, files }, transfer);
      }
    });

    module.FS.mkdir("/work");
    module.FS.writeFile("/work/input.pdf", new Uint8Array(data.buffer));
    self.postMessage({
      type: "status",
      phase: "extract",
      text: data.format === "png" ? "正在解码为 PNG…" : "正在提取源格式图片…"
    });

    // The WASM build intentionally omits TIFF. These flags are the supported
    // equivalent of pdfimages -all while preserving every available raw stream.
    const formatArgs = data.format === "png"
      ? ["-png"]
      : ["-png", "-j", "-jp2", "-jbig2", "-ccitt"];
    const exitCode = module.callMain([
      ...formatArgs,
      "/work/input.pdf", "/work/image"
    ]);

    const remainingNames = module.FS.readdir("/work")
      .filter((name) => name !== "." && name !== ".." && name !== "input.pdf")
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    const remainingFiles = remainingNames.map((name) => {
      const bytes = module.FS.readFile(`/work/${name}`);
      return { name, buffer: bytes.slice().buffer };
    });
    if (remainingFiles.length) {
      totalFileCount += remainingFiles.length;
      const transfer = remainingFiles.map((file) => file.buffer);
      self.postMessage({ type: "page-output", current: 1, total: 1, fileCount: totalFileCount, files: remainingFiles }, transfer);
    }

    if (exitCode && totalFileCount === 0) {
      throw new Error(errors.join("\n") || `pdfimages 退出码：${exitCode}`);
    }

    self.postMessage({ type: "complete", fileCount: totalFileCount, warnings: errors });
  } catch (error) {
    self.postMessage({ type: "error", message: error?.stack || String(error), details: errors });
  }
};
