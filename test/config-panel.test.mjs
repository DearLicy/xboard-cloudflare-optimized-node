import test from 'node:test';
import assert from 'node:assert/strict';
import { readConfig, routeObjectName, secretEqual } from '../src/config.js';
import { userMap, panelRequest } from '../src/panel.js';
const env = { PANEL_URL: 'https://panel.example.com', PANEL_TOKEN: 'secret', MACHINE_ID: '4', PATH_TOKEN: 'test-token-long-enough', REGION_MAP: JSON.stringify({'asia.example.com':{node_id:4,location_hint:'apac'}}) };
test('configuration is fail closed and rejects unsupported/duplicate routes', () => {
  const config = readConfig(env); assert.equal(config.routes.get('asia.example.com').nodeId,4);
  for (const patch of [{PATH_TOKEN:''},{MACHINE_ID:''},{PANEL_URL:'http://panel.example.com'},{REGION_MAP:'{}'},{REGION_MAP:JSON.stringify({'africa.example.com':{node_id:4,location_hint:'afr'}})},{REGION_MAP:JSON.stringify({'a.example.com':{node_id:4},'b.example.com':{node_id:4}})}]) assert.throws(()=>readConfig({...env,...patch}));
});
test('region shares state and global route shards by incoming edge',()=>{
  assert.equal(routeObjectName({nodeId:4,locationHint:'apac'},{cf:{colo:'HKG'}}),routeObjectName({nodeId:4,locationHint:'apac'},{cf:{colo:'LHR'}}));
  assert.notEqual(routeObjectName({nodeId:4},{cf:{colo:'HKG'}}),routeObjectName({nodeId:4},{cf:{colo:'LHR'}}));
});
test('constant work secret comparison denies absent values',async()=>{
  assert.equal(await secretEqual('a','a'),true); assert.equal(await secretEqual('a','b'),false);assert.equal(await secretEqual('',''),false);
});
test('panel users parse limits and reject corrupt or incompatible responses',()=>{
  const map=userMap({users:[{id:1,uuid:'11111111-1111-1111-1111-111111111111',speed_limit:10,device_limit:2}]}); assert.equal([...map.values()][0].speedLimitMbps,10);
  assert.throws(()=>userMap({users:[{id:1,uuid:'bad'}]}));assert.throws(()=>userMap({data:true}));
});
test('report uses machine credentials and raw bytes once with standard UA',async()=>{
  const config=readConfig(env);let calls=0;
  await panelRequest(config,4,'report',{traffic:{1:[100,200]}},async(url, options)=>{calls++;assert.equal(url.pathname,'/api/v2/server/report');assert.equal(options.headers['user-agent'],'xboard-cloudflare-node/2.0');assert.deepEqual(JSON.parse(options.body),{traffic:{1:[100,200]},machine_id:4,node_id:4,token:'secret'});return Response.json({data:true});});assert.equal(calls,1);
  await assert.rejects(()=>panelRequest(config,4,'report',{},async()=>new Response('',{status:500})));
});
