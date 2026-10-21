import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

test('問題管理・採点・履歴・再起動後の永続化', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'quizelab-test-'));
  let child, base;
  async function start() {
    child = spawn(process.execPath, ['server.js'], { env: { ...process.env, PORT: '0', DB_PATH: join(dir, 'test.sqlite') }, stdio: ['ignore','pipe','pipe'] });
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(Error('startup timeout')), 10000);
      child.on('error', e => { clearTimeout(timeout); reject(e); });
      child.stdout.on('data', chunk => { const match = String(chunk).match(/http:\/\/127.0.0.1:(\d+)/); if (match) { base = `http://127.0.0.1:${match[1]}`; clearTimeout(timeout); resolve(); } });
      child.on('exit', code => { clearTimeout(timeout); reject(Error('server exit '+code)); });
    });
  }
  async function stop() { const exited = once(child, 'exit'); child.kill(); await exited; }
  async function request(path, method='GET', data) { const res = await fetch(base+path, { method, headers: {'Content-Type':'application/json'}, body:data===undefined?undefined:JSON.stringify(data) }); return {status:res.status, value:await res.json()}; }
  try {
    await start();
    assert.equal((await fetch(base)).status, 200);
    assert.deepEqual((await request('/api/questions')).value, []);
    const q = {title:'通信を暗号化するプロトコルは？',category:'ネットワーク',options:['HTTP','HTTPS','FTP'],answer:1,explanation:'HTTPS は TLS で通信を暗号化します。'};
    assert.equal((await request('/api/questions','POST',{...q,answer:9})).status,400);
    const id = (await request('/api/questions','POST',q)).value.id;
    const id2 = (await request('/api/questions','POST',{...q,title:'別の問題'})).value.id;
    assert.equal((await request('/api/questions/'+id,'PUT',{...q,title:'更新した問題'})).status,200);
    const attempt = await request('/api/attempts','POST',{ids:[id,id2],answers:[1,null]});
    assert.equal(attempt.status,201);assert.equal(attempt.value.score,1);assert.equal(attempt.value.total,2);
    assert.equal((await request('/api/attempts','POST',{ids:[id,id],answers:[1,1]})).status,400);
    assert.equal((await request('/api/attempts','POST',{ids:[id],answers:[100]})).status,400);
    assert.equal((await request('/api/questions/'+id2,'DELETE')).status,200);
    assert.equal((await request('/api/questions/'+id2,'DELETE')).status,404);
    const denied = await fetch(base+'/api/questions',{method:'POST',headers:{Origin:'https://example.com','Content-Type':'application/json'},body:JSON.stringify(q)});
    assert.equal(denied.status,403);
    await stop();await start();
    const persisted = (await request('/api/questions')).value;
    assert.equal(persisted.length,1);assert.equal(persisted[0].title,'更新した問題');assert.deepEqual(persisted[0].options,q.options);
    const attempts = (await request('/api/attempts')).value;
    assert.equal(attempts.length,1);assert.equal(attempts[0].score,1);
  } finally { if(child && child.exitCode===null)await stop();rmSync(dir,{recursive:true,force:true}); }
});
