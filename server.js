import http from "node:http";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, readFileSync, copyFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const dbPath = process.env.DB_PATH || join(root, "data", "quizelab.sqlite");
mkdirSync(dirname(dbPath), { recursive: true });
const existing = existsSync(dbPath);
const db = new DatabaseSync(dbPath);
export const closeDatabase = () => db.close();
db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;");
function transaction(fn) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
// Keep the old tables and migrate in one transaction. Back up the checkpointed DB first.
if (db.prepare("PRAGMA user_version").get().user_version < 2) {
  if (existing) {
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    const backup = dbPath + ".before-v2.bak";
    if (!existsSync(backup)) copyFileSync(dbPath, backup);
  }
  transaction(() => {
    db.exec(`CREATE TABLE IF NOT EXISTS questions (id INTEGER PRIMARY KEY, title TEXT NOT NULL, category TEXT NOT NULL, options TEXT NOT NULL, answer INTEGER NOT NULL, explanation TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS attempts (id INTEGER PRIMARY KEY, questions TEXT NOT NULL, answers TEXT NOT NULL, score INTEGER NOT NULL, total INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS collections (id INTEGER PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('category','deck')), parent_id INTEGER REFERENCES collections(id) ON DELETE RESTRICT, mastery_target INTEGER NOT NULL DEFAULT 5, mastery_mode TEXT NOT NULL DEFAULT 'total');
    CREATE TABLE IF NOT EXISTS tags (name TEXT PRIMARY KEY);`);
    const columns = new Set(
      db
        .prepare("PRAGMA table_info(questions)")
        .all()
        .map((c) => c.name),
    );
    for (const [name, type] of [
      ["deck_id", "INTEGER REFERENCES collections(id)"],
      ["tags", "TEXT NOT NULL DEFAULT '[]'"],
      ["answer_count", "INTEGER NOT NULL DEFAULT 0"],
      ["correct_count", "INTEGER NOT NULL DEFAULT 0"],
      ["streak", "INTEGER NOT NULL DEFAULT 0"],
    ]) {
      if (!columns.has(name))
        db.exec(`ALTER TABLE questions ADD COLUMN ${name} ${type}`);
    }
    if (
      !db
        .prepare("PRAGMA table_info(attempts)")
        .all()
        .some((c) => c.name === "submission_key")
    )
      db.exec("ALTER TABLE attempts ADD COLUMN submission_key TEXT");
    db.exec(
      "CREATE UNIQUE INDEX IF NOT EXISTS attempt_submission_key ON attempts(submission_key); CREATE INDEX IF NOT EXISTS question_deck ON questions(deck_id);",
    );
    for (const row of db
      .prepare("SELECT DISTINCT category FROM questions WHERE deck_id IS NULL")
      .all()) {
      const id = Number(
        db
          .prepare("INSERT INTO collections(name,kind) VALUES(?,'deck')")
          .run(row.category || "移行した問題集").lastInsertRowid,
      );
      db.prepare(
        "UPDATE questions SET deck_id=? WHERE deck_id IS NULL AND category=?",
      ).run(id, row.category);
    }
    // Reconstruct actual answer/correct counts from existing saved test results.
    for (const attempt of db
      .prepare("SELECT questions,answers FROM attempts ORDER BY id")
      .all()) {
      const items = JSON.parse(attempt.questions),
        answers = JSON.parse(attempt.answers);
      items.forEach((q, i) => {
        const correct = answers[i] === q.answer;
        db.prepare(
          "UPDATE questions SET answer_count=answer_count+?, correct_count=correct_count+?, streak=CASE WHEN ? THEN streak+1 ELSE 0 END WHERE id=?",
        ).run(
          answers[i] === null ? 0 : 1,
          correct ? 1 : 0,
          correct ? 1 : 0,
          q.id,
        );
      });
    }
    db.exec("PRAGMA user_version=2");
  });
}
const collections = () =>
  db.prepare("SELECT * FROM collections ORDER BY kind,name,id").all();
function question(q) {
  const count = q.mastery_mode === "streak" ? q.streak : q.correct_count;
  return {
    ...q,
    options: JSON.parse(q.options),
    tags: JSON.parse(q.tags),
    mastered: count >= q.mastery_target,
    progress_count: count,
  };
}
const questionSQL =
  "SELECT q.*, c.name AS category, c.mastery_target, c.mastery_mode FROM questions q JOIN collections c ON c.id=q.deck_id";
const getQuestion = (id) => {
  const q = db.prepare(questionSQL + " WHERE q.id=?").get(id);
  return q && question(q);
};
const allQuestions = () =>
  db
    .prepare(questionSQL + " ORDER BY q.id DESC")
    .all()
    .map(question);
function collectionStats() {
  const nodes = collections(),
    items = allQuestions();
  const descendants = (id) => {
    const ids = [id];
    for (const child of nodes.filter((n) => n.parent_id === id))
      ids.push(...descendants(child.id));
    return ids;
  };
  return nodes.map((n) => {
    const ids = descendants(n.id),
      qs = items.filter((q) => ids.includes(q.deck_id));
    const answered = qs.reduce((a, q) => a + q.answer_count, 0),
      correct = qs.reduce((a, q) => a + q.correct_count, 0);
    return {
      ...n,
      total: qs.length,
      mastered: qs.filter((q) => q.mastered).length,
      answered_questions: qs.filter((q) => q.answer_count > 0).length,
      answer_count: answered,
      correct_count: correct,
      accuracy: answered ? Math.round((correct / answered) * 100) : null,
    };
  });
}
function text(value, label, max) {
  if (typeof value !== "string" || !value.trim() || value.trim().length > max)
    throw Error(`${label}を1〜${max}文字で入力してください`);
  return value.trim();
}
function validateCollection(data, id) {
  const name = text(data.name, "名前", 100);
  if (!["category", "deck"].includes(data.kind))
    throw Error("カテゴリまたは問題集を選択してください");
  const current =
    id && db.prepare("SELECT * FROM collections WHERE id=?").get(id);
  if (current && current.kind !== data.kind)
    throw Error("カテゴリと問題集の種類は変更できません");
  const parent = data.parent_id ?? null;
  if (
    parent !== null &&
    (!Number.isInteger(parent) ||
      db.prepare("SELECT kind FROM collections WHERE id=?").get(parent)
        ?.kind !== "category")
  )
    throw Error("上位カテゴリが見つかりません");
  let cursor = parent,
    depth = 0;
  while (cursor !== null) {
    if (cursor === id)
      throw Error("自分自身や配下のカテゴリへは移動できません");
    cursor =
      db.prepare("SELECT parent_id FROM collections WHERE id=?").get(cursor)
        ?.parent_id ?? null;
    if (++depth > 8) throw Error("カテゴリの階層が深すぎます");
  }
  const target = data.mastery_target ?? current?.mastery_target ?? 5;
  const mode = data.mastery_mode ?? current?.mastery_mode ?? "total";
  if (!Number.isInteger(target) || target < 1 || target > 20)
    throw Error("習得の目標は1〜20回で指定してください");
  if (!["total", "streak"].includes(mode))
    throw Error("習得の集計方法が正しくありません");
  if (
    db
      .prepare(
        "SELECT id FROM collections WHERE name=? AND parent_id IS ? AND id<>?",
      )
      .get(name, parent, id || 0)
  )
    throw Error("同じ場所に同名のカテゴリ・問題集があります");
  return [name, data.kind, parent, target, mode];
}
function validateQuestion(q) {
  const title = text(q.title, "問題文", 10000);
  if (
    !Number.isInteger(q.deck_id) ||
    db.prepare("SELECT kind FROM collections WHERE id=?").get(q.deck_id)
      ?.kind !== "deck"
  )
    throw Error("保存先の問題集を選んでください");
  if (!Array.isArray(q.options) || q.options.length < 2 || q.options.length > 6)
    throw Error("選択肢を2〜6個入力してください");
  const options = q.options.map((o) => text(o, "選択肢", 2000));
  if (!Number.isInteger(q.answer) || q.answer < 0 || q.answer >= options.length)
    throw Error("正解を選択してください");
  if (
    q.explanation != null &&
    (typeof q.explanation !== "string" || q.explanation.length > 10000)
  )
    throw Error("解説は10000文字以内で入力してください");
  if (!Array.isArray(q.tags ?? []) || (q.tags ?? []).length > 30)
    throw Error("タグは30個以内で指定してください");
  const tags = [
    ...new Set(
      (q.tags || []).map((t) => text(t, "タグ", 50).normalize("NFKC")),
    ),
  ];
  return [
    title,
    db.prepare("SELECT name FROM collections WHERE id=?").get(q.deck_id).name,
    JSON.stringify(options),
    q.answer,
    q.explanation || "",
    q.deck_id,
    JSON.stringify(tags),
  ];
}
const send = (res, status, value) => {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(value));
};
async function body(req) {
  let value = "";
  for await (const chunk of req) {
    value += chunk;
    if (Buffer.byteLength(value) > 1_000_000)
      throw Error("送信データが大きすぎます");
  }
  try {
    return JSON.parse(value);
  } catch {
    throw Error("JSON の形式が正しくありません");
  }
}
export const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    if (
      url.pathname.startsWith("/api/") &&
      req.headers.origin &&
      req.headers.origin !== `http://${req.headers.host}`
    )
      return send(res, 403, { error: "許可されていないアクセスです" });
    if (url.pathname === "/api/collections" && req.method === "GET")
      return send(res, 200, collectionStats());
    if (url.pathname === "/api/collections" && req.method === "POST") {
      const args = validateCollection(await body(req));
      const r = db
        .prepare(
          "INSERT INTO collections(name,kind,parent_id,mastery_target,mastery_mode) VALUES(?,?,?,?,?)",
        )
        .run(...args);
      return send(res, 201, { id: Number(r.lastInsertRowid) });
    }
    const collectionMatch = url.pathname.match(/^\/api\/collections\/(\d+)$/);
    if (collectionMatch && ["PUT", "DELETE"].includes(req.method)) {
      const id = +collectionMatch[1];
      if (!db.prepare("SELECT id FROM collections WHERE id=?").get(id))
        return send(res, 404, { error: "問題集・カテゴリが見つかりません" });
      if (req.method === "PUT")
        db.prepare(
          "UPDATE collections SET name=?,kind=?,parent_id=?,mastery_target=?,mastery_mode=? WHERE id=?",
        ).run(...validateCollection(await body(req), id), id);
      else {
        if (
          db.prepare("SELECT id FROM collections WHERE parent_id=?").get(id) ||
          db.prepare("SELECT id FROM questions WHERE deck_id=?").get(id)
        )
          throw Error(
            "空のカテゴリ・問題集だけ削除できます。先に問題や配下の問題集を移動してください",
          );
        db.prepare("DELETE FROM collections WHERE id=?").run(id);
      }
      return send(res, 200, { ok: true });
    }
    if (url.pathname === "/api/tags" && req.method === "GET")
      return send(
        res,
        200,
        db
          .prepare("SELECT name FROM tags ORDER BY name")
          .all()
          .map((t) => t.name),
      );
    if (url.pathname === "/api/questions" && req.method === "GET")
      return send(res, 200, allQuestions());
    if (url.pathname === "/api/questions" && req.method === "POST") {
      const args = validateQuestion(await body(req));
      const id = transaction(() => {
        const r = db
          .prepare(
            "INSERT INTO questions(title,category,options,answer,explanation,deck_id,tags) VALUES(?,?,?,?,?,?,?)",
          )
          .run(...args);
        JSON.parse(args[6]).forEach((t) =>
          db.prepare("INSERT OR IGNORE INTO tags(name) VALUES(?)").run(t),
        );
        return Number(r.lastInsertRowid);
      });
      return send(res, 201, { id });
    }
    const reset = url.pathname.match(/^\/api\/questions\/(\d+)\/reset$/);
    if (reset && req.method === "POST") {
      const changed = db
        .prepare(
          "UPDATE questions SET answer_count=0,correct_count=0,streak=0 WHERE id=?",
        )
        .run(+reset[1]);
      return send(
        res,
        changed.changes ? 200 : 404,
        changed.changes ? { ok: true } : { error: "問題が見つかりません" },
      );
    }
    const match = url.pathname.match(/^\/api\/questions\/(\d+)$/);
    if (match && ["PUT", "DELETE"].includes(req.method)) {
      const current = getQuestion(+match[1]);
      if (!current) return send(res, 404, { error: "問題が見つかりません" });
      if (req.method === "DELETE")
        db.prepare("DELETE FROM questions WHERE id=?").run(match[1]);
      else {
        const args = validateQuestion(await body(req));
        transaction(() => {
          // Changing the answer content invalidates learning progress; moving/tagging does not.
          const changed =
            current.title !== args[0] ||
            JSON.stringify(current.options) !== args[2] ||
            current.answer !== args[3];
          db.prepare(
            "UPDATE questions SET title=?,category=?,options=?,answer=?,explanation=?,deck_id=?,tags=? WHERE id=?",
          ).run(...args, match[1]);
          if (changed)
            db.prepare(
              "UPDATE questions SET answer_count=0,correct_count=0,streak=0 WHERE id=?",
            ).run(match[1]);
          JSON.parse(args[6]).forEach((t) =>
            db.prepare("INSERT OR IGNORE INTO tags(name) VALUES(?)").run(t),
          );
        });
      }
      return send(res, 200, { ok: true });
    }
    if (url.pathname === "/api/attempts" && req.method === "GET")
      return send(
        res,
        200,
        db
          .prepare(
            "SELECT id,score,total,created_at FROM attempts ORDER BY id DESC",
          )
          .all(),
      );
    if (url.pathname === "/api/attempts" && req.method === "POST") {
      const { ids, answers, submission_key: key } = await body(req);
      if (
        !Array.isArray(ids) ||
        !ids.length ||
        ids.length > 500 ||
        new Set(ids).size !== ids.length ||
        !ids.every(Number.isInteger) ||
        !Array.isArray(answers) ||
        answers.length !== ids.length
      )
        throw Error("受験データが正しくありません");
      if (
        key !== undefined &&
        (typeof key !== "string" || !/^[a-zA-Z0-9-]{16,100}$/.test(key))
      )
        throw Error("提出キーが正しくありません");
      const prior =
        key &&
        db.prepare("SELECT * FROM attempts WHERE submission_key=?").get(key);
      if (prior) {
        const old = JSON.parse(prior.questions);
        if (
          JSON.stringify(old.map((q) => q.id)) !== JSON.stringify(ids) ||
          prior.answers !== JSON.stringify(answers)
        )
          throw Error("提出済みの解答とは異なる内容です");
        return send(res, 200, {
          score: prior.score,
          total: prior.total,
          questions: old,
        });
      }
      const items = ids.map(getQuestion);
      if (items.some((q) => !q))
        throw Error("削除された問題があります。試験を選び直してください");
      if (
        answers.some(
          (a, i) =>
            a !== null &&
            (!Number.isInteger(a) || a < 0 || a >= items[i].options.length),
        )
      )
        throw Error("解答が正しくありません");
      const score = items.reduce(
        (n, q, i) => n + (q.answer === answers[i] ? 1 : 0),
        0,
      );
      const updated = transaction(() => {
        items.forEach((q, i) => {
          const correct = q.answer === answers[i];
          db.prepare(
            "UPDATE questions SET answer_count=answer_count+?,correct_count=correct_count+?,streak=CASE WHEN ? THEN streak+1 ELSE 0 END WHERE id=?",
          ).run(
            answers[i] === null ? 0 : 1,
            correct ? 1 : 0,
            correct ? 1 : 0,
            q.id,
          );
        });
        const snapshots = ids.map(getQuestion);
        db.prepare(
          "INSERT INTO attempts(questions,answers,score,total,submission_key) VALUES(?,?,?,?,?)",
        ).run(
          JSON.stringify(snapshots),
          JSON.stringify(answers),
          score,
          ids.length,
          key || null,
        );
        return snapshots;
      });
      return send(res, 201, { score, total: ids.length, questions: updated });
    }
    if (url.pathname.startsWith("/api/"))
      return send(res, 404, { error: "API が見つかりません" });
    const assets = {
      "/": ["index.html", "text/html"],
      "/app.js": ["app.js", "text/javascript"],
      "/style.css": ["style.css", "text/css"],
    };
    const asset = assets[url.pathname];
    if (!asset || req.method !== "GET")
      return send(res, 404, { error: "ページが見つかりません" });
    res.writeHead(200, {
      "Content-Type": `${asset[1]}; charset=utf-8`,
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy":
        "default-src 'self'; style-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'",
    });
    res.end(readFileSync(join(root, "public", asset[0])));
  } catch (error) {
    send(res, 400, { error: error.message });
  }
});
if (process.argv[1] === fileURLToPath(import.meta.url))
  server.listen(Number(process.env.PORT || 3000), "127.0.0.1", () =>
    console.log("QuizeLab: http://127.0.0.1:" + server.address().port),
  );
