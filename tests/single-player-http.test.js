import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createAppServer } from '../server.mjs';

const character={name:'Aster',stats:{strength:4,dexterity:4,speed:4,defense:4,intelligence:4},trait:'balanced',color:'#b87333',appearance:{sex:'male',hairstyle:'braided_ponytail',skin:'ivory',hairColor:'chestnut',eyes:'amber',facePreset:'p05'}};
async function fixture(t){
  const server=createAppServer({temporarySessions:true,tickMs:1000000});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));await server.duels.close();});
  const origin=`http://127.0.0.1:${server.address().port}`;
  const request=async(path,{token,body}={})=>{
    const response=await fetch(origin+path,{method:body===undefined?'GET':'POST',headers:{...(body===undefined?{}:{'Content-Type':'application/json'}),...(token?{Authorization:`Bearer ${token}`}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});
    return {status:response.status,value:await response.json()};
  };
  return {server,request};
}
test('Single Player HTTP creation requires a guest and public inspection creates no sessions',async t=>{
  const {server,request}=await fixture(t);
  const rejected=await request('/api/tournaments/single-player',{body:{character}});
  assert.equal(rejected.status,401);
  assert.equal(Object.keys(server.duels.data.sessions).length,0);
  const publicList=await request('/api/arena/tournaments');assert.equal(publicList.status,200);
  assert.deepEqual(publicList.value.tournaments,[]);
  assert.equal(Object.keys(server.duels.data.sessions).length,0);
});
test('Single Player HTTP entry immediately returns the human equipment seat with seven bots and survives retry',async t=>{
  const {server,request}=await fixture(t);
  const guest=await request('/api/session',{body:{}});assert.equal(guest.status,200);
  const token=guest.value.token;
  const created=await request('/api/tournaments/single-player',{token,body:{character}});
  assert.equal(created.status,200);const view=created.value;
  assert.equal(view.singlePlayer,true);assert.equal(view.phase,'equipment');assert.equal(view.you,0);
  assert.equal(view.players.length,8);assert.equal(view.players.filter(p=>p.bot===true).length,7);
  assert.equal(view.players[view.you].character.name,'Aster');assert.equal(view.currentMatchIndex,0);
  assert.equal(view.match.you,0);assert.equal(view.match.ready[0],false);assert.equal(view.match.ready[1],true);
  assert.equal(view.match.duel,null,'Unrevealed equipment never becomes public combat state.');
  const resumed=await request('/api/tournaments/single-player',{token,body:{character}});
  assert.equal(resumed.status,200);assert.equal(resumed.value.code,view.code);
  assert.equal(Object.keys(server.duels.data.tournaments).length,1);
  assert.equal(Object.keys(server.duels.data.sessions).length,1,'Bots never create authenticated guests.');
  const observed=await request(`/api/arena/tournaments/${view.code}`);
  assert.equal(observed.status,200);assert.equal(observed.value.singlePlayer,true);assert.equal(observed.value.role,'spectator');
  assert.equal(observed.value.you,null);assert.equal(observed.value.match.you,null);
  assert.equal(observed.value.match.yourLoadout,null);assert.equal(Object.keys(server.duels.data.sessions).length,1);
});
