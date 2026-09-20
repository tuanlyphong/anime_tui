#!/usr/bin/env node
import net from 'node:net';
import { spawn } from 'node:child_process';
const args = process.argv.slice(2);
const mode = args.find(a => a.startsWith('--fixture='))?.split('=')[1] || 'eof';
if (mode === 'stubborn') {
 process.on('SIGTERM',()=>{});
 spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{stdio:'inherit'});
}
if (mode === 'no-ipc') setInterval(() => {}, 1000);
else {
 const socket = args.find(a => a.startsWith('--input-ipc-server=')).split('=')[1];
 net.createServer(client => {
  const send = data => client.write(JSON.stringify(data) + '\n');
  let buffer = '';
  const observed = new Set();
  let position = 0;
  const prop = (name, data) => send({event:'property-change', name, data});
  client.on('data', chunk => {
   buffer += chunk;
   let newline;
   while ((newline = buffer.indexOf('\n')) >= 0) {
    const {command:c, request_id} = JSON.parse(buffer.slice(0,newline));
    buffer = buffer.slice(newline+1);
    let error = 'success';
    if(c[0] === 'observe_property') observed.add(c[2]);
    if(c[0] === 'seek') { if(mode==='seek-fail') error='seeking failed'; else position=c[1]; }
    if(c[0] === 'set_property' && mode==='unpause-fail') error='unpause failed';
    send({request_id,error,data:c[0]==='get_property' ? position : undefined});
    if(c[0] === 'loadfile') {
     if(observed.size < 3) process.exit(22);
     prop('duration', 1000); prop('time-pos',0);
     send({event:'file-loaded'});
     prop('demuxer-cache-state', {'seekable-ranges':[{start:0,end:904.94}]});
     if(mode==='prepare-cancel') setTimeout(()=>process.exit(0),100);
    }
    if(c[0]==='set_property' && c[1]==='pause' && c[2]===false) {
     if(mode==='self-kill') { setTimeout(()=>process.kill(process.pid,'SIGKILL'),50); continue; }
     if(mode==='unpause-fail') continue;
     if (mode==='drain-eof') {
      process.stdin.resume();
      process.stdin.on('end',()=>{ prop('time-pos',1000); send({event:'end-file',reason:'eof'}); });
      continue;
     }
     prop('time-pos', mode==='eof' ? 1000 : 754);
     setTimeout(()=> {send({event:'end-file',reason:mode==='eof'||mode==='early'?'eof':'quit'}); if(mode!=='stubborn') setTimeout(()=>process.exit(0),20);}, mode==='periodic'?5500:50);
    }
   }
  });
 }).listen(socket);
}
