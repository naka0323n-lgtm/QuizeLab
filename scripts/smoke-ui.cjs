const { chromium } = require("playwright");
const { spawn } = require("node:child_process");
const path = require("node:path");
const os = require("node:os");
const { mkdtempSync, rmSync } = require("node:fs");
const assert = require("node:assert/strict");
(async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "quizelab-ui-"));
  const child = spawn(process.execPath, ["server.js"], {
    cwd: path.join(__dirname, ".."),
    env: { ...process.env, PORT: "0", DB_PATH: dir + "/test.sqlite" },
  });
  let browser;
  try {
    const base = await new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(Error("Server startup timed out")),
        10000,
      );
      child.once("error", reject);
      child.stdout.on("data", (d) => {
        const m = String(d).match(/http:\/\/127.0.0.1:\d+/);
        if (m) {
          clearTimeout(timeout);
          resolve(m[0]);
        }
      });
    });
    browser = await chromium.launch({
      executablePath: process.env.CHROMIUM_PATH || undefined,
      headless: true,
      args: ["--no-sandbox"],
    });
    const page = await browser.newPage({
      viewport: { width: 1440, height: 1000 },
    });
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("dialog", (d) => d.accept());
    await page.goto(base);
    await page.locator("#new-category").click();
    await page.locator("[name=name]").fill("基本情報技術者");
    await page.getByRole("button", { name: "作成する", exact: true }).click();
    await page.locator("#create-deck").click();
    await page.locator("[name=name]").fill("テクノロジ");
    await page.getByRole("button", { name: "作成する", exact: true }).click();
    await page.locator("#create").click();
    await page
      .locator("[name=title]")
      .fill("通信を暗号化するプロトコルはどれか。");
    for (const [i, v] of ["HTTPS", "HTTP", "FTP", "SMTP"].entries())
      await page.locator(".option-text").nth(i).fill(v);
    await page
      .locator("[name=explanation]")
      .fill("TLS を使用する HTTPS が正解です。");
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN1sAAAAASUVORK5CYII=",
      "base64",
    );
    await page
      .locator("#question-image-file")
      .setInputFiles({
        name: "question.png",
        mimeType: "image/png",
        buffer: png,
      });
    await page.waitForFunction(
      () => document.querySelector("#image-preview img")?.naturalWidth > 0,
    );
    await page.locator("#new-tag").fill("重要");
    await page.locator("#add-tag").click();
    await page.getByRole("button", { name: "問題を保存", exact: true }).click();
    await page.locator("dialog").waitFor({ state: "detached" });
    await page.locator("[data-edit]").waitFor();
    await page.locator("#create").click();
    await page.locator("[name=title]").fill("データを永続化するものは？");
    for (const [i, v] of ["SQLite", "変数", "一時メモリ", "画面"].entries())
      await page.locator(".option-text").nth(i).fill(v);
    await page.locator("[data-tag]").filter({ hasText: "重要" }).click();
    await page.getByRole("button", { name: "問題を保存", exact: true }).click();
    await page.locator("dialog").waitFor({ state: "detached" });
    await page.locator("[data-edit]").first().waitFor();
    assert.equal(await page.locator(".question-row .tag").count(), 2);
    await page.locator("#question-limit").selectOption("20");
    await page.locator("[data-select]").first().check();
    assert.equal(await page.locator("#question-limit").inputValue(), "20");
    await page.locator("[data-select]").first().uncheck();
    await page.screenshot({
      path: dir + "/quizelab-v2-deck.png",
      fullPage: true,
    });
    for (let round = 0; round < 5; round++) {
      await page.locator("#start").click();
      await page.locator(".exam-option").first().click();
      await page.locator("#next").click();
      await page.locator(".exam-option").first().click();
      await page.locator("#submit").click();
      await page.locator(".score").waitFor();
      const picture = page.locator(".review .question-image img");
      assert.equal(await picture.count(), 1);
      await picture.evaluate((img) => img.decode());
      await page.locator("[data-image]").click();
      await page.locator(".image-viewer img").evaluate((img) => img.decode());
      await page.locator(".image-viewer [data-close]").click();
      assert.match(await page.locator(".score").innerText(), /100%/);
      await page.locator("#home").click();
    }
    await page
      .getByRole("heading", { name: "すべての問題を習得しました！" })
      .waitFor();
    assert.equal(await page.locator("#start").isDisabled(), true);
    assert.equal(await page.locator(".question-row").count(), 0);
    await page.locator("[data-status=mastered]").click();
    assert.equal(await page.locator(".question-row").count(), 2);
    assert.equal(await page.locator(".mastered-tag").count(), 2);
    assert.match(
      await page.locator(".question-row").first().innerText(),
      /正解 5 回/,
    );
    await page.screenshot({
      path: dir + "/quizelab-v2-mastered.png",
      fullPage: true,
    });
    await page.locator("[data-edit]").first().click();
    await page.locator("#reset-progress").click();
    await page.locator("dialog").waitFor({ state: "detached" });
    await page.locator(".question-row").first().waitFor();
    assert.equal(await page.locator(".question-row").count(), 1);
    await page.locator("#all-collections").click();
    await page.locator(".deck-card").waitFor();
    await page.screenshot({
      path: dir + "/quizelab-v2-overview.png",
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({
      path: dir + "/quizelab-v2-mobile.png",
      fullPage: true,
    });
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
      false,
    );
    await page.locator("[data-open]").click();
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
      false,
    );
    await page.locator("[data-view=history]").click();
    assert.equal(await page.locator(".history-row").count(), 5);
    await page.locator("[data-node]").last().click();
    await page.locator("[data-status=all]").click();
    const row = page
      .locator(".question-row")
      .filter({ hasText: "通信を暗号化" });
    await row.locator("[data-edit]").click();
    await page.locator("#image-preview img").evaluate((img) => img.decode());
    await page.locator("#remove-image").click();
    await page.getByRole("button", { name: "変更を保存", exact: true }).click();
    await page.locator("dialog").waitFor({ state: "detached" });
    await row.locator("[data-edit]").click();
    assert.equal(await page.locator("#image-preview img").count(), 0);
    await page.locator("dialog [data-close]").first().click();
    assert.deepEqual(errors, []);
    console.log(
      "PASS UI: hierarchical decks, click-to-reuse tags, selection settings, five rounds, mastery exclusion/review/reset, deck stats, history, mobile",
    );
  } finally {
    if (browser) await browser.close();
    child.kill();
    await new Promise((resolve) => child.on("exit", resolve));
    rmSync(dir, { recursive: true, force: true });
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
