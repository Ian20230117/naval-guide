import http from 'node:http';
import {readFileSync,mkdirSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {randomBytes,randomInt} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {networkInterfaces} from 'node:os';
import {makeGuidance} from './guidance.mjs';
import {dayKey,timezone as zone} from './dates.mjs';
const root=path.dirname(fileURLToPath(import.meta.url));
const book=JSON.parse(readFileSync(path.join(root,'content/book.json'),'utf8'));
const data=process.env.DATA_DIR || path.join(root,'data'); mkdirSync(data,{recursive:true});
const db=new DatabaseSync(path.join(data,'guide.sqlite'));
db.exec(readFileSync(path.join(root,'db/schema.sql'),'utf8'));
db.exec('PRAGMA busy_timeout=5000');
function transaction(fn){ db.exec('BEGIN IMMEDIATE');try{const result=fn();db.exec('COMMIT');return result;}catch(e){db.exec('ROLLBACK');throw e;} }
function thought(row){return row && {id:row.id,excerpt:JSON.parse(row.excerpt_json),createdAt:row.created_at,day:row.day,daily:!!row.daily,actions:db.prepare('SELECT * FROM actions WHERE thought_id=? AND reader=? ORDER BY id DESC').all(row.id,row.reader).map(action)};}
function action(row){return {id:row.id,thoughtId:row.thought_id,createdAt:row.created_at,day:row.day,...JSON.parse(row.content_json)};}
function draw(reader,key,daily=false){return transaction(()=>{
 let row=db.prepare('SELECT * FROM thoughts WHERE reader=? AND request_key=?').get(reader,key);
 if(row)return thought(row);
 if(daily){row=db.prepare('SELECT * FROM thoughts WHERE reader=? AND day=? AND daily=1').get(reader,dayKey());if(row)return thought(row);}
 const used=new Set(db.prepare('SELECT excerpt_id FROM thoughts WHERE reader=?').all(reader).map(r=>r.excerpt_id));
 const remaining=book.excerpts.filter(e=>!used.has(e.id));
 if(!remaining.length)return null;
 const excerpt=remaining[randomInt(remaining.length)], now=new Date().toISOString();
 const id=db.prepare('INSERT INTO thoughts(reader,excerpt_id,excerpt_json,created_at,day,daily,request_key) VALUES(?,?,?,?,?,?,?)').run(reader,excerpt.id,JSON.stringify(excerpt),now,dayKey(),daily?1:0,key).lastInsertRowid;
 return thought(db.prepare('SELECT * FROM thoughts WHERE id=?').get(id));
});}
async function body(req){let text='';for await(const chunk of req){text+=chunk;if(text.length>4096)throw Object.assign(new Error('請求過大'),{status:413});}try{return JSON.parse(text || '{}');}catch{throw Object.assign(new Error('請求格式不正確'),{status:400});}}
function reply(res,status,value){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(value));}
const server=http.createServer(async(req,res)=>{try{
 res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','same-origin');
 res.setHeader('Content-Security-Policy',"default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
 const url=new URL(req.url,'http://localhost');
 if(!url.pathname.startsWith('/api/')){
  const files={'/':'index.html','/app.js':'app.js','/style.css':'style.css','/favicon.svg':'favicon.svg'};
  const file=files[url.pathname];if(!file){res.writeHead(404);return res.end('找不到頁面');}
  if(!['GET','HEAD'].includes(req.method)){res.writeHead(405);return res.end();}
  res.writeHead(200,{'Content-Type':file.endsWith('.js')?'text/javascript; charset=utf-8':file.endsWith('.css')?'text/css; charset=utf-8':file.endsWith('.svg')?'image/svg+xml':'text/html; charset=utf-8','Cache-Control':'no-cache'});
  return res.end(req.method==='HEAD'?undefined:readFileSync(path.join(root,'public',file)));
 }
 if(req.method==='POST' && req.headers.origin && req.headers.origin!==`http://${req.headers.host}` && req.headers.origin!==`https://${req.headers.host}`)return reply(res,403,{error:'請從本站操作'});
 let reader=(req.headers.cookie||'').split(';').map(s=>s.trim()).find(s=>s.startsWith('naval_reader='))?.slice(13);
 if(!reader || !/^[a-f0-9]{64}$/.test(reader) || !db.prepare('SELECT id FROM readers WHERE id=?').get(reader)){
  reader=randomBytes(32).toString('hex');db.prepare('INSERT INTO readers VALUES(?,?)').run(reader,new Date().toISOString());
  res.setHeader('Set-Cookie',`naval_reader=${reader}; HttpOnly; SameSite=Strict; Path=/; Max-Age=315360000${process.env.COOKIE_SECURE==='1'?'; Secure':''}`);
 }
 if(url.pathname==='/api/state' && req.method==='GET'){
  const daily=draw(reader,`daily:${dayKey()}`,true);
  const latest=thought(db.prepare('SELECT * FROM thoughts WHERE reader=? ORDER BY id DESC LIMIT 1').get(reader));
  const seen=db.prepare('SELECT count(*) AS n FROM thoughts WHERE reader=?').get(reader).n;
  return reply(res,200,{day:dayKey(),timezone:zone,daily,latest,total:book.excerptCount,seen,remaining:book.excerptCount-seen});
 }
 if(url.pathname==='/api/thoughts' && req.method==='POST'){
  const b=await body(req);if(!/^[\w-]{10,100}$/.test(b.requestKey||''))return reply(res,400,{error:'缺少有效操作識別碼'});
  const result=draw(reader,b.requestKey);return result?reply(res,201,result):reply(res,409,{error:'你已讀完所有不重複摘錄。可回顧歷史，並繼續產生行動指引。',exhausted:true});
 }
 if(url.pathname==='/api/actions' && req.method==='POST'){
  const b=await body(req);if(!Number.isSafeInteger(b.thoughtId)||!/^[\w-]{10,100}$/.test(b.requestKey||''))return reply(res,400,{error:'請先選擇思維引導'});
  const row=db.prepare('SELECT * FROM thoughts WHERE id=? AND reader=?').get(b.thoughtId,reader);if(!row)return reply(res,404,{error:'找不到這段思維引導'});
  const result=transaction(()=>{let existing=db.prepare('SELECT * FROM actions WHERE reader=? AND request_key=?').get(reader,b.requestKey);if(existing)return action(existing);
   const count=db.prepare('SELECT count(*) AS n FROM actions WHERE thought_id=?').get(row.id).n;
   const content=makeGuidance(JSON.parse(row.excerpt_json),count),now=new Date().toISOString();
   const id=db.prepare('INSERT INTO actions(thought_id,reader,created_at,day,content_json,request_key) VALUES(?,?,?,?,?,?)').run(row.id,reader,now,dayKey(),JSON.stringify(content),b.requestKey).lastInsertRowid;
   return action(db.prepare('SELECT * FROM actions WHERE id=?').get(id));});return reply(res,201,result);
 }
 if(url.pathname==='/api/history' && req.method==='GET'){
  const date=url.searchParams.get('day');if(date && !/^\d{4}-\d{2}-\d{2}$/.test(date))return reply(res,400,{error:'日期格式不正確'});
  const dates=db.prepare('SELECT day,sum(n) AS count FROM (SELECT day,count(*) AS n FROM thoughts WHERE reader=? GROUP BY day UNION ALL SELECT day,count(*) AS n FROM actions WHERE reader=? GROUP BY day) GROUP BY day ORDER BY day DESC').all(reader,reader);
  const selected=date || dates[0]?.day || dayKey();
  const offset=Math.max(0,Number(url.searchParams.get('offset'))||0);
  const items=db.prepare("SELECT 'thought' AS kind,id,created_at FROM thoughts WHERE reader=? AND day=? UNION ALL SELECT 'action' AS kind,id,created_at FROM actions WHERE reader=? AND day=? ORDER BY created_at DESC,id DESC LIMIT 30 OFFSET ?").all(reader,selected,reader,selected,offset).map(r=>{
   if(r.kind==='thought')return {kind:r.kind,...thought(db.prepare('SELECT * FROM thoughts WHERE id=?').get(r.id))};
   const a=db.prepare('SELECT * FROM actions WHERE id=?').get(r.id);return {kind:r.kind,...action(a),thought:thought(db.prepare('SELECT * FROM thoughts WHERE id=?').get(a.thought_id))};});
  return reply(res,200,{dates,day:selected,items,offset,hasMore:offset+items.length<(dates.find(d=>d.day===selected)?.count||0)});
 }
 if(url.pathname==='/api/export' && req.method==='GET'){
  res.setHeader('Content-Disposition','attachment; filename="naval-history.json"');return reply(res,200,{version:1,exportedAt:new Date().toISOString(),timezone:zone,thoughts:db.prepare('SELECT * FROM thoughts WHERE reader=? ORDER BY id').all(reader).map(thought)});
 }
 return reply(res,404,{error:'找不到這個操作'});
 }catch(e){console.error(e);reply(res,e.status||500,{error:e.status?e.message:'暫時無法讀取或保存內容，請稍後重試。'});}});
const port=Number(process.env.PORT||3000);server.listen(port,process.env.HOST||'0.0.0.0',()=>{
 console.log(`幸福與財富指引：http://localhost:${server.address().port}`);
 for(const list of Object.values(networkInterfaces()))for(const n of list||[])if(n.family==='IPv4'&&!n.internal)console.log(`手機（相同 Wi-Fi）：http://${n.address}:${server.address().port}`);
});
for(const sig of ['SIGINT','SIGTERM'])process.on(sig,()=>server.close(()=>{db.close();process.exit(0);}));
