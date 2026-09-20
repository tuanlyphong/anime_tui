import assert from 'node:assert/strict';
import { mkdtemp, rm, chmod, symlink, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { getProgress, saveProgress } from '../lib/progress.js';
import { playEpisode } from '../lib/playback.js';
const player = fileURLToPath(new URL('./fixtures/playback-player.js',import.meta.url));
const animeUrl='/anime', episodeUrl='/episode';
async function setup(t) {
 const home=await mkdtemp(path.join(os.tmpdir(),'playback-test-'));
 const old=process.env.HOME, oldTmp=process.env.TMPDIR; process.env.HOME=home; process.env.TMPDIR=home;
 await chmod(player,0o755);
 t.after(async()=>{process.env.HOME=old; if(oldTmp===undefined) delete process.env.TMPDIR; else process.env.TMPDIR=oldTmp; await rm(home,{recursive:true,force:true});});
}
const play = mode => playEpisode({streamUrl:'https://example.test/video.mp4',animeUrl,episodeUrl,label:'Episode',player,playerArgs:[`--fixture=${mode}`]});
test('unexpected player SIGKILL after IPC attaches is failed playback',async t=>{
 await setup(t);
 const result=await play('self-kill');
 assert.equal(result.outcome,'failed');
 assert.match(result.error.message,/SIGKILL/);
});
test('natural EOF commits watched before returning',async t=>{
 await setup(t); assert.equal((await play('eof')).outcome,'finished');
 assert.deepEqual(Object.keys(await getProgress(animeUrl,episodeUrl)).sort(),['completedAt','state']);
 assert.deepEqual(await readdir(process.env.HOME),['.local']);
});
test('quit flushes latest valid position',async t=>{
 await setup(t); assert.equal((await play('quit')).outcome,'stopped');
 assert.equal((await getProgress(animeUrl,episodeUrl)).positionSeconds,754);
});
test('early EOF never marks watched',async t=>{
 await setup(t); assert.equal((await play('early')).outcome,'failed');
 assert.equal((await getProgress(animeUrl,episodeUrl)).state,'unfinished');
});
test('failed seek preserves original resume record',async t=>{
 await setup(t); const old=await saveProgress(animeUrl,episodeUrl,{positionSeconds:900,durationSeconds:1000});
 assert.equal((await play('seek-fail')).outcome,'failed');
 assert.deepEqual(await getProgress(animeUrl,episodeUrl),old);
});
test('missing IPC is a failed setup with no progress',async t=>{
 await setup(t); assert.equal((await play('no-ipc')).outcome,'failed');
 assert.equal(await getProgress(animeUrl,episodeUrl),null);
});
test('zero exit before IPC establishment is failed setup',async t=>{
 await setup(t);
 assert.equal((await playEpisode({streamUrl:'video.mp4',animeUrl,episodeUrl,player:'/bin/true'})).outcome,'failed');
});
test('failed unpause preserves original resume record',async t=>{
 await setup(t); const old=await saveProgress(animeUrl,episodeUrl,{positionSeconds:900,durationSeconds:1000});
 assert.equal((await play('unpause-fail')).outcome,'failed');
 assert.deepEqual(await getProgress(animeUrl,episodeUrl),old);
});
test('periodic persistence occurs while the player is still running',async t=>{
 await setup(t); const pending=play('periodic');
 await new Promise(r=>setTimeout(r,5300));
 assert.equal((await getProgress(animeUrl,episodeUrl)).positionSeconds,754);
 assert.equal((await pending).outcome,'stopped');
});

async function abyss(t, mode = 'success') {
 const directory = await mkdtemp(path.join(os.tmpdir(), 'playback-java-'));
 const oldPath = process.env.PATH, oldMode = process.env.FAKE_JAVA_MODE;
 await symlink(fileURLToPath(new URL('./fixtures/fake-java.js',import.meta.url)), path.join(directory,'java'));
 process.env.PATH = `${directory}:${oldPath}`; process.env.FAKE_JAVA_MODE = mode;
 t.after(async()=>{process.env.PATH=oldPath; if(oldMode===undefined) delete process.env.FAKE_JAVA_MODE; else process.env.FAKE_JAVA_MODE=oldMode; await rm(directory,{recursive:true,force:true});});
 return {streamUrl:'https://abyssplayer.com/id',animeUrl,episodeUrl,label:'Episode',player,jar:'fixture.jar'};
}
test('progressive preparation cancellation preserves exact old state',async t=>{
 await setup(t); const options=await abyss(t,'wait');
 const old=await saveProgress(animeUrl,episodeUrl,{positionSeconds:950,durationSeconds:1000});
 assert.equal((await playEpisode({...options,playerArgs:['--fixture=prepare-cancel']})).outcome,'stopped');
 assert.deepEqual(await getProgress(animeUrl,episodeUrl),old);
});
test('progressive resume accepts actual target-containing range below requested margin',async t=>{
 await setup(t); const options=await abyss(t);
 await saveProgress(animeUrl,episodeUrl,{positionSeconds:900,durationSeconds:1000});
 assert.equal((await playEpisode({...options,playerArgs:['--fixture=drain-eof']})).outcome,'finished');
});
test('cancelled source cannot establish natural completion',async t=>{
 await setup(t); const options=await abyss(t,'wait');
 assert.equal((await playEpisode({...options,playerArgs:['--fixture=eof']})).outcome,'failed');
});
test('source failure preserves preparing resume',async t=>{
 await setup(t); const options=await abyss(t,'nonzero');
 const old=await saveProgress(animeUrl,episodeUrl,{positionSeconds:950,durationSeconds:1000});
 assert.equal((await playEpisode(options)).outcome,'failed');
 assert.deepEqual(await getProgress(animeUrl,episodeUrl),old);
});
test('download-first full file shares tracked EOF lifecycle',async t=>{
 await setup(t); const options=await abyss(t);
 assert.equal((await playEpisode({...options,progressive:false})).outcome,'finished');
});
test('termination escalates after two seconds for a stubborn player and descendant holding pipes',async t=>{
 await setup(t); const start=Date.now();
 assert.equal((await play('stubborn')).outcome,'stopped');
 assert.ok(Date.now()-start>=1900);
 assert.ok(Date.now()-start<4000);
});
test('handled signal cancels the supplied source without exiting the controller process',async t=>{
 await setup(t); const options=await abyss(t,'wait');
 const old=await saveProgress(animeUrl,episodeUrl,{positionSeconds:950,durationSeconds:1000});
 const listeners=process.listenerCount('SIGINT');
 const timer=setTimeout(()=>process.emit('SIGINT'),500);
 const result=await playEpisode(options); clearTimeout(timer);
 assert.equal(result.outcome,'stopped');
 assert.deepEqual(await getProgress(animeUrl,episodeUrl),old);
 assert.equal(process.listenerCount('SIGINT'),listeners);
});
