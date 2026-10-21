import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const dbPath = process.env.DB_PATH || join(root, 'data', 'quizelab.sqlite');
mkdirSync(dirname(dbPath), { recursive: true });
const db = new DatabaseSync(dbPath);
export const closeDatabase = () => db.close();
db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS questions (id INTEGER PRIMARY KEY, title TEXT NOT NULL, category TEXT NOT NULL, options TEXT NOT NULL, answer INTEGER NOT NULL, explanation TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS attempts (id INTEGER PRIMARY KEY, questions TEXT NOT NULL, answers TEXT NOT NULL, score INTEGER NOT NULL, total INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);`);

const parseQuestion = q => ({ ...q, options: JSON.parse(q.options) });
const send = (res, status, value) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };
async function body(req) {
  let value = ''; for await (const chunk of req) { value += chunk; if (Buffer.byteLength(value) > 1_000_000) throw new Error('送信データが大きすぎます'); }
  try { return JSON.parse(value); } catch { throw new Error('JSON の形式が正しくありません'); }
}
function validate(q) {
  if (typeof q.title !== 'string' || !q.title.trim() || q.title.length > 10000) throw new Error('問題文を1〜10000文字で入力してください');
  if (typeof q.category !== 'string' || !q.category.trim() || q.category.length > 100) throw new Error('カテゴリを1〜100文字で入力してください');
  if (!Array.isArray(q.options) || q.options.length < 2 || q.options.length > 6 || q.options.some(x => typeof x !== 'string' || !x.trim() || x.length > 2000)) throw new Error('選択肢を2〜6個入力してください');
  if (!Number.isInteger(q.answer) || q.answer < 0 || q.answer >= q.options.length) throw new Error('正解を選択してください');
  if (q.explanation != null && (typeof q.explanation !== 'string' || q.explanation.length > 10000)) throw new Error('解説は10000文字以内で入力してください');
  return [q.title.trim(), q.category.trim(), JSON.stringify(q.options.map(x => x.trim())), q.answer, q.explanation || ''];
}
export const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/api/') && req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) return send(res, 403, { error: '許可されていないアクセスです' });
    if (url.pathname === '/api/questions' && req.method === 'GET') return send(res, 200, db.prepare('SELECT * FROM questions ORDER BY id DESC').all().map(parseQuestion));
    if (url.pathname === '/api/questions' && req.method === 'POST') {
      const args = validate(await body(req)); const result = db.prepare('INSERT INTO questions(title,category,options,answer,explanation) VALUES(?,?,?,?,?)').run(...args);
      return send(res, 201, { id: Number(result.lastInsertRowid) });
    }
    const match = url.pathname.match(/^\/api\/questions\/(\d+)$/);
    if (match && ['PUT', 'DELETE'].includes(req.method)) {
      if (!db.prepare('SELECT id FROM questions WHERE id=?').get(match[1])) return send(res, 404, { error: '問題が見つかりません' });
      if (req.method === 'DELETE') db.prepare('DELETE FROM questions WHERE id=?').run(match[1]);
      else db.prepare('UPDATE questions SET title=?,category=?,options=?,answer=?,explanation=? WHERE id=?').run(...validate(await body(req)), match[1]);
      return send(res, 200, { ok: true });
    }
    if (url.pathname === '/api/attempts' && req.method === 'GET') return send(res, 200, db.prepare('SELECT id,score,total,created_at FROM attempts ORDER BY id DESC').all());
    if (url.pathname === '/api/attempts' && req.method === 'POST') {
      const { ids, answers } = await body(req);
      if (!Array.isArray(ids) || !ids.length || ids.length > 500 || new Set(ids).size !== ids.length || !ids.every(Number.isInteger) || !Array.isArray(answers) || answers.length !== ids.length) throw new Error('受験データが正しくありません');
      const questions = ids.map(id => db.prepare('SELECT * FROM questions WHERE id=?').get(id));
      if (questions.some(q => !q)) throw new Error('削除された問題があります。試験を選び直してください');
      if (answers.some((a, i) => a !== null && (!Number.isInteger(a) || a < 0 || a >= JSON.parse(questions[i].options).length))) throw new Error('解答が正しくありません');
      const score = questions.reduce((n, q, i) => n + (q.answer === answers[i] ? 1 : 0), 0);
      db.prepare('INSERT INTO attempts(questions,answers,score,total) VALUES(?,?,?,?)').run(JSON.stringify(questions.map(parseQuestion)), JSON.stringify(answers), score, ids.length);
      return send(res, 201, { score, total: ids.length, questions: questions.map(parseQuestion) });
    }
    if (url.pathname.startsWith('/api/')) return send(res, 404, { error: 'API が見つかりません' });
    const assets = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'] };
    const asset = assets[url.pathname];
    if (!asset || req.method !== 'GET') return send(res, 404, { error: 'ページが見つかりません' });
    res.writeHead(200, { 'Content-Type': `${asset[1]}; charset=utf-8`, 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'self'; style-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'" });
    res.end(readFileSync(join(root, 'public', asset[0])));
  } catch (error) { send(res, 400, { error: error.message }); }
});
if (process.argv[1] === fileURLToPath(import.meta.url)) server.listen(Number(process.env.PORT || 3000), '127.0.0.1', () => console.log('QuizeLab: http://127.0.0.1:' + server.address().port));
