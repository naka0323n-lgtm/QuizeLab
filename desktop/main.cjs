const { app, BrowserWindow, dialog, Menu, shell } = require("electron");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

// Keep the same data directory in development and packaged versions.
app.setName("QuizeLab");
app.setPath("userData", path.join(app.getPath("appData"), "QuizeLab"));
const primaryInstance = app.requestSingleInstanceLock();
let window;
let backend;
let baseURL;

function createWindow() {
  window = new BrowserWindow({
    title: "QuizeLab",
    width: 1280,
    height: 860,
    minWidth: 780,
    minHeight: 600,
    backgroundColor: "#f7f8fa",
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      devTools: !app.isPackaged,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-prevent-unload", (event) => {
    const choice = dialog.showMessageBoxSync(window, {
      type: "question",
      title: "テストを中断しますか？",
      message: "受験中の解答は保存されていません。終了しますか？",
      buttons: ["テストに戻る", "保存せず終了"],
      defaultId: 0,
      cancelId: 0,
    });
    if (choice === 1) event.preventDefault();
  });
  window.webContents.on("will-navigate", (event, url) => {
    if (new URL(url).origin !== baseURL) event.preventDefault();
  });
  window.webContents.session.setPermissionRequestHandler(
    (_contents, _permission, callback) => callback(false),
  );
  window.once("ready-to-show", () => window.show());
  window.on("closed", () => {
    window = null;
  });
  window.loadURL(baseURL).catch((error) => {
    dialog.showErrorBox("画面を開けませんでした", error.message);
    app.quit();
  });
}

function setMenu() {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: "ファイル",
        submenu: [
          {
            label: "データ保存フォルダーを開く",
            click: async () => {
              const error = await shell.openPath(app.getPath("userData"));
              if (error)
                dialog.showErrorBox("フォルダーを開けませんでした", error);
            },
          },
          { type: "separator" },
          { label: "終了", role: "quit" },
        ],
      },
      {
        label: "編集",
        submenu: [
          { label: "元に戻す", role: "undo" },
          { label: "やり直す", role: "redo" },
          { type: "separator" },
          { label: "切り取り", role: "cut" },
          { label: "コピー", role: "copy" },
          { label: "貼り付け", role: "paste" },
          { label: "すべて選択", role: "selectAll" },
        ],
      },
      {
        label: "表示",
        submenu: [
          { label: "拡大", role: "zoomIn" },
          { label: "縮小", role: "zoomOut" },
          { label: "元のサイズ", role: "resetZoom" },
          { label: "全画面表示", role: "togglefullscreen" },
        ],
      },
      {
        label: "ヘルプ",
        submenu: [
          {
            label: "QuizeLab について",
            click: () =>
              dialog.showMessageBox(window, {
                type: "info",
                title: "QuizeLab",
                message: `QuizeLab ${app.getVersion()}`,
                detail:
                  "選択問題を作成・管理し、テスト形式で学習できます。\n問題と学習履歴は、このパソコンの SQLite に保存されます。\n\nバックアップする場合は、データ保存フォルダーを確認し、アプリを終了してからフォルダー全体をコピーしてください。",
              }),
          },
        ],
      },
    ]),
  );
}

if (!primaryInstance) app.quit();
else {
  app.on("second-instance", () => {
    if (window) {
      if (window.isMinimized()) window.restore();
      window.show();
      window.focus();
    }
  });
  app
    .whenReady()
    .then(async () => {
      // The bundled Electron runtime supplies node:sqlite; no external Node.js is required.
      process.env.DB_PATH = path.join(
        app.getPath("userData"),
        "quizelab.sqlite",
      );
      backend = await import(
        pathToFileURL(path.join(__dirname, "..", "server.js")).href
      );
      await new Promise((resolve, reject) => {
        backend.server.once("error", reject);
        backend.server.listen(0, "127.0.0.1", resolve);
      });
      baseURL = `http://127.0.0.1:${backend.server.address().port}`;
      setMenu();
      createWindow();
    })
    .catch((error) => {
      dialog.showErrorBox(
        "QuizeLab を起動できませんでした",
        `保存フォルダーの書き込み権限と空き容量を確認してください。\n\n${error.message}`,
      );
      app.quit();
    });
  app.on("window-all-closed", () => app.quit());
  app.on("will-quit", () => {
    backend?.server.close();
    backend?.closeDatabase();
  });
}
