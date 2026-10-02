import express from 'express';
import http from 'http';
import path from 'path';
import fs from 'fs';
import {fileURLToPath} from 'url';
import {Server as SocketServer} from 'socket.io';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const dataDir = path.join(__dirname, 'data');
const publicDir = path.join(__dirname, 'public');
fs.mkdirSync(dataDir, {recursive:true});
fs.mkdirSync(publicDir, {recursive:true});
const dbFile = path.join(dataDir, 'db.json');
const emptyDb = {users:{}, friends:{}, friendRequests:[], runs:[], posts:[], comments:{}};
let db = fs.existsSync(dbFile) ? JSON.parse(fs.readFileSync(dbFile,'utf8')) : emptyDb;
for (const k of Object.keys(emptyDb)) if (db[k] === undefined) db[k] = structuredClone(emptyDb[k]);
const save = () => fs.writeFileSync(dbFile, JSON.stringify(db,null,2));

const HANU = {lat:20.9902,lng:105.7972};
const RADIUS_M = 300;
const live = new Map();
const sockets = new Map();
const app = express();
app.use(express.json({limit:'12mb'}));
app.use('/media', express.static(publicDir));
app.use(express.static(path.join(__dirname,'dist')));
const server = http.createServer(app);
const io = new SocketServer(server, {cors:{origin:'*'}});

function uid(){return Math.random().toString(36).slice(2)+Date.now().toString(36)}
function hav(a,b){const R=6371000,p=Math.PI/180,dLat=(b.lat-a.lat)*p,dLon=(b.lng-a.lng)*p,x=Math.sin(dLat/2)**2+Math.cos(a.lat*p)*Math.cos(b.lat*p)*Math.sin(dLon/2)**2;return 2*R*Math.asin(Math.sqrt(x));}
function publicUser(u){return {id:u.id,nickname:u.nickname||'Runner',avatar:(u.nickname||'R')[0].toUpperCase(),createdAt:u.createdAt};}
function ensureUser(id,nickname){if(!db.users[id]) db.users[id]={id,nickname:nickname||'Runner',createdAt:new Date().toISOString()}; else if(nickname) db.users[id].nickname=nickname; save(); return db.users[id];}
function weeklyRuns(){const since=Date.now()-7*86400000; return db.runs.filter(r=>new Date(r.date).getTime()>=since);}
function leaderboard(){const map={}; for(const r of weeklyRuns()){map[r.userId]??={userId:r.userId,distance:0,time:0,runs:0}; map[r.userId].distance+=r.distance; map[r.userId].time+=r.time; map[r.userId].runs++;} return Object.values(map).map(x=>({...x,nickname:db.users[x.userId]?.nickname||'Runner'})).sort((a,b)=>b.distance-a.distance).slice(0,100);}
function sendRunners(){const arr=[...live.values()].map(x=>({...x,distanceFromHanu:hav(HANU,{lat:x.lat,lng:x.lng})})); io.emit('runners:update',arr);}
function safePost(p){return {...p,likes:(p.likes||[]).length,likedBy:undefined,comments:db.comments[p.id]||[]};}

app.get('/api/bootstrap', (req,res)=>{const id=req.query.userId; if(!id) return res.status(400).json({error:'userId required'}); ensureUser(id,req.query.nickname); const friends=(db.friends[id]||[]).map(fid=>publicUser(db.users[fid])).filter(Boolean); const incoming=db.friendRequests.filter(r=>r.to===id&&r.status==='pending').map(r=>({...r,fromUser:publicUser(db.users[r.from])})); const outgoing=db.friendRequests.filter(r=>r.from===id&&r.status==='pending'); const userRuns=db.runs.filter(r=>r.userId===id).slice(-100).reverse(); res.json({user:publicUser(db.users[id]),friends,requests:incoming,outgoing,feed:db.posts.slice(-50).reverse().map(safePost),leaderboard:leaderboard(),runners:[...live.values()],runs:userRuns});});
app.post('/api/users', (req,res)=>{const {id,nickname}=req.body||{}; if(!id) return res.status(400).json({error:'id required'}); const u=ensureUser(id,nickname); res.json(publicUser(u));});
app.get('/api/leaderboard',(req,res)=>res.json(leaderboard()));
app.get('/api/feed',(req,res)=>res.json(db.posts.slice(-100).reverse().map(safePost)));
app.post('/api/friends/request',(req,res)=>{const {from,to}=req.body||{}; if(!from||!to||from===to)return res.status(400).json({error:'invalid users'}); ensureUser(from); ensureUser(to); if((db.friends[from]||[]).includes(to))return res.json({ok:true,already:true}); const existing=db.friendRequests.find(r=>((r.from===from&&r.to===to)||(r.from===to&&r.to===from))&&r.status==='pending'); if(existing)return res.json({ok:true,pending:true}); const r={id:uid(),from,to,status:'pending',date:new Date().toISOString()}; db.friendRequests.push(r); save(); io.emit('friends:update'); res.json(r);});
app.post('/api/friends/respond',(req,res)=>{const {requestId,userId,accept}=req.body||{}; const r=db.friendRequests.find(x=>x.id===requestId&&x.to===userId&&x.status==='pending'); if(!r)return res.status(404).json({error:'request not found'}); r.status=accept?'accepted':'declined'; if(accept){db.friends[r.from]??=[];db.friends[r.to]??=[];if(!db.friends[r.from].includes(r.to))db.friends[r.from].push(r.to);if(!db.friends[r.to].includes(r.from))db.friends[r.to].push(r.from);} save(); io.emit('friends:update'); res.json({ok:true,status:r.status});});
app.post('/api/runs',(req,res)=>{const {userId,nickname,distance,time,competition,route,competitionResult}=req.body||{}; if(!userId||!Number.isFinite(distance)||!Number.isFinite(time))return res.status(400).json({error:'invalid run'}); ensureUser(userId,nickname); const r={id:uid(),userId,nickname:db.users[userId].nickname,distance,time,competition:!!competition,competitionResult:competitionResult||null,route:Array.isArray(route)?route.slice(0,5000):[],date:new Date().toISOString()}; db.runs.push(r); save(); io.emit('leaderboard:update',leaderboard()); res.json(r);});
app.post('/api/posts',(req,res)=>{const {userId,nickname,text,imageData,distance,pace}=req.body||{}; if(!userId||!imageData)return res.status(400).json({error:'A camera image is required'}); ensureUser(userId,nickname); if(!String(imageData).startsWith('data:image/'))return res.status(400).json({error:'Only camera image data is accepted'}); const m=String(imageData).match(/^data:image\/(jpeg|jpg|png);base64,(.+)$/); if(!m)return res.status(400).json({error:'Invalid image'}); const file=`${uid()}.${m[1]==='png'?'png':'jpg'}`; fs.writeFileSync(path.join(publicDir,file),Buffer.from(m[2],'base64')); const p={id:uid(),userId,nickname:db.users[userId].nickname,text:String(text||'New run update 🏃').slice(0,180),image:`/media/${file}`,distance:Number(distance)||0,pace:String(pace||'—'),likes:[],date:new Date().toISOString()}; db.posts.push(p); save(); io.emit('feed:update',safePost(p)); res.json(safePost(p));});
app.post('/api/posts/:id/like',(req,res)=>{const {userId}=req.body||{};const p=db.posts.find(x=>x.id===req.params.id);if(!p||!userId)return res.status(404).json({error:'not found'});p.likes??=[];const i=p.likes.indexOf(userId);if(i>=0)p.likes.splice(i,1);else p.likes.push(userId);save();io.emit('feed:like',{id:p.id,likes:p.likes.length,userId});res.json({likes:p.likes.length,liked:i<0});});
app.post('/api/posts/:id/comment',(req,res)=>{const {userId,nickname,text}=req.body||{};if(!userId||!String(text||'').trim())return res.status(400).json({error:'comment required'});ensureUser(userId,nickname);const c={id:uid(),userId,nickname:db.users[userId].nickname,text:String(text).trim().slice(0,240),date:new Date().toISOString()};db.comments[req.params.id]??=[];db.comments[req.params.id].push(c);save();io.emit('feed:comment',{postId:req.params.id,comment:c});res.json(c);});

io.on('connection',socket=>{
 socket.on('register',({userId,nickname})=>{if(!userId)return;ensureUser(userId,nickname);sockets.set(userId,socket.id);socket.data.userId=userId;sendRunners();});
 socket.on('run:start',payload=>{const id=socket.data.userId;if(!id)return;live.set(id,{userId:id,nickname:db.users[id]?.nickname||payload.nickname||'Runner',lat:payload.lat,lng:payload.lng,distance:0,seconds:0,competition:!!payload.competition,updatedAt:Date.now()});sendRunners();});
 socket.on('run:location',payload=>{const id=socket.data.userId;if(!id||!Number.isFinite(payload.lat)||!Number.isFinite(payload.lng))return;const prev=live.get(id)||{};live.set(id,{...prev,userId:id,nickname:db.users[id]?.nickname||payload.nickname||'Runner',lat:payload.lat,lng:payload.lng,distance:Number(payload.distance)||0,seconds:Number(payload.seconds)||0,competition:!!payload.competition,updatedAt:Date.now()});sendRunners();});
 socket.on('run:stop',()=>{const id=socket.data.userId;if(id){live.delete(id);sendRunners();}});
 socket.on('disconnect',()=>{const id=socket.data.userId;if(id&&sockets.get(id)===socket.id){sockets.delete(id);live.delete(id);sendRunners();}});
});
setInterval(()=>{const now=Date.now(); for(const [id,r] of live) if(now-r.updatedAt>30000)live.delete(id); sendRunners();},10000);
app.use((req,res)=>res.sendFile(path.join(__dirname,'dist','index.html')));
server.listen(PORT,()=>console.log(`HANU Run Tracker server on http://localhost:${PORT}`));
