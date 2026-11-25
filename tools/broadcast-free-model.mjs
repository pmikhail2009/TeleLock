import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { freeModelAnnouncement, freeModelCampaign } from '../serverless/tgcloud/lib/announcement.js';

// Preview is the default. Sending requires an already published bot, gateway and panel.
const root=fileURLToPath(new URL('../',import.meta.url));
if(!process.argv.includes('--send')) {
  console.log(freeModelAnnouncement('ru')+'\n\n--- English ---\n\n'+freeModelAnnouncement('en'));
} else {
  const {getFiles,runFunction,getWebhook}=await import('../serverless/node_modules/@tgcloud/cli/src/api/endpoints.js');
  const {token}=JSON.parse(await fs.readFile(path.join(root,'serverless/.tgcloud/credentials'),'utf8'));
  const live=await getFiles(token),sources=live.canonical_modules;
  assert.ok(sources['lib/controls']?.includes('export const fullAccess = () => true;'),'Publish the free model first');
  assert.ok(sources['handlers/message']?.includes("relay('thanks'"),'Publish the new bot handler first');
  assert.equal((await getWebhook(token)).in_sync,true,'Fix the bot webhook first');
  const probe=await runFunction(token,'endpoints/releaseProbe',{
    'endpoints/releaseProbe':`import {fetch} from 'sdk'; import {gateway,secret} from '../lib/config';
      export default async function(){const response=await fetch(gateway+'/service/thanks',{
        method:'POST',headers:{Authorization:'Bearer '+secret,'Content-Type':'application/json'},body:JSON.stringify({owner:-1})
      });return {status:response.status};}`,
    'lib/config':sources['lib/config'],
  },{});
  assert.equal(probe.result.status,400,'Publish the new gateway first');
  const panel=await fetch('https://pmikhail2009.github.io/katka-panel/');
  assert.ok(panel.ok && (await panel.text()).includes('const fullAccess = () => true;'),'Publish the new game panel first');
  const audience=await runFunction(token,'endpoints/audience',{
    'schema':sources.schema,
    'endpoints/audience':`import {db} from 'sdk'; export default async function(){
      return await db.all('SELECT owner FROM katka_bindings UNION SELECT owner FROM katka_codes');}`,
  },{});
  const owners=[...new Set(audience.result.map(row=>row.owner))].filter(owner=>Number.isSafeInteger(owner)&&owner>0);
  const journalPath=path.join(root,'build',freeModelCampaign+'.json');
  await fs.mkdir(path.dirname(journalPath),{recursive:true});
  let journal;
  try{journal=JSON.parse(await fs.readFile(journalPath,'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;journal={campaign:freeModelCampaign,deliveries:{}};}
  assert.equal(journal.campaign,freeModelCampaign);
  const save=()=>fs.writeFile(journalPath,JSON.stringify(journal,null,2));
  const sendSources={
    'lib/config':sources['lib/config'],'lib/controls':sources['lib/controls'],
    'lib/announcement':await fs.readFile(path.join(root,'serverless/tgcloud/lib/announcement.js'),'utf8'),
    'endpoints/sendAnnouncement':`import {api,fetch} from 'sdk'; import {gateway,secret} from '../lib/config';
      import {keyboard} from '../lib/controls'; import {freeModelAnnouncement} from '../lib/announcement';
      export default async function({owner}) {
        const response=await fetch(gateway+'/service/status',{method:'POST',
          headers:{Authorization:'Bearer '+secret,'Content-Type':'application/json'},body:JSON.stringify({owner})});
        if(!response.ok)throw new Error('Could not read the account language');
        const state=await response.json();
        const sent=await api.sendMessage({chat_id:owner,text:freeModelAnnouncement(state.language),
          reply_markup:keyboard(!!state.generation,'home',state.tier,state.language),link_preview_options:{is_disabled:true}});
        return {message:sent.message_id,language:state.language};
      }`,
  };
  for(const owner of owners) {
    // Reserve durably before sending. An ambiguous response is never resent automatically.
    if(journal.deliveries[owner])continue;
    journal.deliveries[owner]={status:'unknown',attempted:new Date().toISOString()};await save();
    try{
      const result=await runFunction(token,'endpoints/sendAnnouncement',sendSources,{owner});
      assert.ok(Number.isSafeInteger(result.result.message));
      journal.deliveries[owner]={status:'sent',...result.result};
    }catch{
      console.error('Delivery could not be confirmed; reserved to prevent duplicate sends.');
    }
    await save();
  }
  const deliveries=Object.values(journal.deliveries);
  console.log(JSON.stringify({campaign:freeModelCampaign,audience:owners.length,
    sent:deliveries.filter(item=>item.status==='sent').length,unknown:deliveries.filter(item=>item.status==='unknown').length}));
}
