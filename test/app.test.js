import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { DatabaseSync } from "node:sqlite";

test("問題管理・採点・履歴・再起動後の永続化", async () => {
  const dir = mkdtempSync(join(tmpdir(), "quizelab-test-"));
  let child, base;
  async function start() {
    child = spawn(process.execPath, ["server.js"], {
      env: { ...process.env, PORT: "0", DB_PATH: join(dir, "test.sqlite") },
      stdio: ["ignore", "pipe", "pipe"],
    });
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(Error("startup timeout")), 10000);
      child.on("error", (e) => {
        clearTimeout(timeout);
        reject(e);
      });
      child.stdout.on("data", (chunk) => {
        const match = String(chunk).match(/http:\/\/127.0.0.1:(\d+)/);
        if (match) {
          base = `http://127.0.0.1:${match[1]}`;
          clearTimeout(timeout);
          resolve();
        }
      });
      child.on("exit", (code) => {
        clearTimeout(timeout);
        reject(Error("server exit " + code));
      });
    });
  }
  async function stop() {
    const exited = once(child, "exit");
    child.kill();
    await exited;
  }
  async function request(path, method = "GET", data) {
    const res = await fetch(base + path, {
      method,
      headers: { "Content-Type": "application/json" },
      body: data === undefined ? undefined : JSON.stringify(data),
    });
    return { status: res.status, value: await res.json() };
  }
  try {
    await start();
    assert.equal((await fetch(base)).status, 200);
    assert.deepEqual((await request("/api/questions")).value, []);
    const deckId = (
      await request("/api/collections", "POST", {
        name: "ネットワーク",
        kind: "deck",
      })
    ).value.id;
    const q = {
      deck_id: deckId,
      tags: ["重要"],
      title: "通信を暗号化するプロトコルは？",
      category: "ネットワーク",
      options: ["HTTP", "HTTPS", "FTP"],
      answer: 1,
      explanation: "HTTPS は TLS で通信を暗号化します。",
    };
    assert.equal(
      (await request("/api/questions", "POST", { ...q, answer: 9 })).status,
      400,
    );
    const id = (await request("/api/questions", "POST", q)).value.id;
    const id2 = (
      await request("/api/questions", "POST", { ...q, title: "別の問題" })
    ).value.id;
    assert.equal(
      (
        await request("/api/questions/" + id, "PUT", {
          ...q,
          title: "更新した問題",
        })
      ).status,
      200,
    );
    const attempt = await request("/api/attempts", "POST", {
      ids: [id, id2],
      answers: [1, null],
    });
    assert.equal(attempt.status, 201);
    assert.equal(attempt.value.score, 1);
    assert.equal(attempt.value.total, 2);
    assert.equal(
      (await request("/api/questions")).value.find((q) => q.id === id2)
        .answer_count,
      0,
    );
    assert.equal(
      (
        await request("/api/attempts", "POST", {
          ids: [id, id],
          answers: [1, 1],
        })
      ).status,
      400,
    );
    assert.equal(
      (await request("/api/attempts", "POST", { ids: [id], answers: [100] }))
        .status,
      400,
    );
    assert.equal(
      (await request("/api/questions/" + id2, "DELETE")).status,
      200,
    );
    assert.equal(
      (await request("/api/questions/" + id2, "DELETE")).status,
      404,
    );
    const denied = await fetch(base + "/api/questions", {
      method: "POST",
      headers: {
        Origin: "https://example.com",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(q),
    });
    assert.equal(denied.status, 403);
    await stop();
    await start();
    const persisted = (await request("/api/questions")).value;
    assert.deepEqual(persisted[0].tags, ["重要"]);
    assert.equal(persisted[0].correct_count, 1);
    assert.equal(persisted[0].answer_count, 1);
    assert.equal(persisted.length, 1);
    assert.equal(persisted[0].title, "更新した問題");
    assert.deepEqual(persisted[0].options, q.options);
    const attempts = (await request("/api/attempts")).value;
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0].score, 1);
  } finally {
    if (child && child.exitCode === null) await stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

async function withServer(fn, seed) {
  const dir = mkdtempSync(join(tmpdir(), "quizelab-v2-"));
  const filename = join(dir, "test.sqlite");
  if (seed) {
    const database = new DatabaseSync(filename);
    seed(database);
    database.close();
  }
  const child = spawn(process.execPath, ["server.js"], {
    env: { ...process.env, PORT: "0", DB_PATH: filename },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let errors = "";
  child.stderr.on("data", (chunk) => (errors += chunk));
  try {
    const base = await new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(Error("startup timeout " + errors)),
        10000,
      );
      child.stdout.on("data", (chunk) => {
        const match = String(chunk).match(/http:\/\/127.0.0.1:\d+/);
        if (match) {
          clearTimeout(timeout);
          resolve(match[0]);
        }
      });
      child.on("error", (e) => {
        clearTimeout(timeout);
        reject(e);
      });
      child.on("exit", (code) => {
        clearTimeout(timeout);
        reject(Error("exit " + code + " " + errors));
      });
    });
    const request = async (path, method = "GET", data) => {
      const response = await fetch(base + "/api/" + path, {
        method,
        headers: { "Content-Type": "application/json" },
        body: data === undefined ? undefined : JSON.stringify(data),
      });
      return { status: response.status, value: await response.json() };
    };
    await fn(request, filename);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill();
      await exited;
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

test("階層・タグ再利用・累計5回習得・再送の二重計上防止・リセット", () =>
  withServer(async (request) => {
    const category = (
      await request("collections", "POST", {
        name: "基本情報技術者",
        kind: "category",
      })
    ).value.id;
    const sub = (
      await request("collections", "POST", {
        name: "科目A",
        kind: "category",
        parent_id: category,
      })
    ).value.id;
    const deck = (
      await request("collections", "POST", {
        name: "テクノロジ",
        kind: "deck",
        parent_id: sub,
      })
    ).value.id;
    assert.equal(
      (
        await request("collections/" + category, "PUT", {
          name: "基本情報技術者",
          kind: "category",
          parent_id: sub,
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await request("collections", "POST", {
          name: "配下",
          kind: "deck",
          parent_id: deck,
        })
      ).status,
      400,
    );
    const q = {
      deck_id: deck,
      title: "正解はどれ？",
      options: ["正解", "不正解"],
      answer: 0,
      tags: ["重要", "復習", "重要"],
      explanation: "説明",
    };
    const id = (await request("questions", "POST", q)).value.id;
    assert.deepEqual((await request("tags")).value, ["復習", "重要"]);
    assert.equal((await request("collections/" + deck, "DELETE")).status, 400);
    assert.equal(
      (await request("collections/" + category, "DELETE")).status,
      400,
    );
    for (let i = 0; i < 4; i++)
      assert.equal(
        (await request("attempts", "POST", { ids: [id], answers: [0] })).status,
        201,
      );
    await request("attempts", "POST", { ids: [id], answers: [1] });
    let item = (await request("questions")).value[0];
    assert.equal(item.mastered, false);
    assert.equal(item.correct_count, 4);
    assert.equal(item.streak, 0);
    const submission = {
      ids: [id],
      answers: [0],
      submission_key: "test-idempotency-123456",
    };
    assert.equal((await request("attempts", "POST", submission)).status, 201);
    assert.equal((await request("attempts", "POST", submission)).status, 200);
    assert.equal(
      (await request("attempts", "POST", { ...submission, answers: [1] }))
        .status,
      400,
    );
    item = (await request("questions")).value[0];
    assert.equal(item.mastered, true);
    assert.equal(item.correct_count, 5);
    assert.equal(item.answer_count, 6);
    const stats = (await request("collections")).value.find(
      (n) => n.id === category,
    );
    assert.equal(stats.mastered, 1);
    assert.equal(stats.total, 1);
    assert.equal(stats.accuracy, 83);
    assert.equal(stats.answered_questions, 1);
    await request("questions/" + id, "PUT", {
      ...q,
      tags: ["重要"],
      explanation: "解説変更",
    });
    assert.equal((await request("questions")).value[0].mastered, true);
    await request("questions/" + id, "PUT", { ...q, title: "問題文変更" });
    assert.equal((await request("questions")).value[0].correct_count, 0);
    await request("attempts", "POST", { ids: [id], answers: [0] });
    await request("questions/" + id + "/reset", "POST", {});
    assert.equal((await request("questions")).value[0].answer_count, 0);
    assert.equal((await request("attempts")).value.length, 7);
    await request("collections/" + deck, "PUT", {
      name: "名称変更",
      kind: "deck",
      parent_id: null,
      mastery_target: 2,
      mastery_mode: "streak",
    });
    assert.equal((await request("questions")).value[0].category, "名称変更");
    await request("attempts", "POST", { ids: [id], answers: [0] });
    await request("attempts", "POST", { ids: [id], answers: [1] });
    assert.equal((await request("questions")).value[0].streak, 0);
    await request("attempts", "POST", { ids: [id], answers: [0] });
    await request("attempts", "POST", { ids: [id], answers: [0] });
    assert.equal((await request("questions")).value[0].mastered, true);
  }));

test("旧版SQLiteから問題集・過去の正解回数を移行してバックアップする", () =>
  withServer(
    async (request, filename) => {
      const items = (await request("questions")).value;
      assert.equal(items.length, 1);
      assert.equal(items[0].category, "旧カテゴリ");
      assert.equal(items[0].correct_count, 2);
      assert.equal(items[0].answer_count, 3);
      assert.equal(items[0].streak, 1);
      assert.equal((await request("collections")).value.length, 1);
      assert.equal(existsSync(filename + ".before-v2.bak"), true);
      assert.equal((await request("attempts")).value.length, 4);
    },
    (database) => {
      database.exec(`CREATE TABLE questions(id INTEGER PRIMARY KEY,title TEXT NOT NULL,category TEXT NOT NULL,options TEXT NOT NULL,answer INTEGER NOT NULL,explanation TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
  CREATE TABLE attempts(id INTEGER PRIMARY KEY,questions TEXT NOT NULL,answers TEXT NOT NULL,score INTEGER NOT NULL,total INTEGER NOT NULL,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);`);
      database
        .prepare(
          "INSERT INTO questions(id,title,category,options,answer) VALUES(1,?,?,?,0)",
        )
        .run("既存の問題", "旧カテゴリ", JSON.stringify(["正解", "不正解"]));
      const snapshot = JSON.stringify([
        {
          id: 1,
          title: "既存の問題",
          category: "旧カテゴリ",
          options: ["正解", "不正解"],
          answer: 0,
        },
      ]);
      for (const answer of [0, 1, 0])
        database
          .prepare(
            "INSERT INTO attempts(questions,answers,score,total) VALUES(?,?,?,1)",
          )
          .run(snapshot, JSON.stringify([answer]), answer === 0 ? 1 : 0);
      const unrelated = JSON.parse(snapshot);
      unrelated[0].title = "削除済みの別問題";
      database
        .prepare(
          "INSERT INTO attempts(questions,answers,score,total) VALUES(?,?,1,1)",
        )
        .run(JSON.stringify(unrelated), "[0]");
    },
  ));
