import fs from 'node:fs';
import path from 'node:path';
import {loadSqlite} from '../db.mjs';
import {t} from '../i18n.mjs';

const table = (db,name) => Boolean(db.prepare("select 1 from sqlite_master where type='table' and name=?").get(name));
export function v2MigrationComplete(db) {
  if(!table(db,'session_v2'))return false;
  if(!table(db,'session') || !db.prepare('select 1 from session limit 1').get())return true;
  if(!table(db,'kv'))return false;
  const row=db.prepare('select value from kv where key=?').get('migration.v1-v2');
  try {return JSON.parse(row?.value ?? 'null')?.phase==='completed';}catch{return false;}
}

/** Snapshot the whole SQLite database, including committed WAL pages, before the CLI can migrate it. */
export function backupV1Database(file) {
  if(!file || !fs.existsSync(file))return null;
  const {DatabaseSync}=loadSqlite();
  const db=new DatabaseSync(file,{readOnly:true});
  try {
    if(!table(db,'session') || !db.prepare('select 1 from session limit 1').get() || v2MigrationComplete(db))return null;
    const backup=file+'.pleiad-before-v2.db';
    if(fs.existsSync(backup)) {
      const saved=new DatabaseSync(backup,{readOnly:true});
      try {if(saved.prepare('pragma quick_check').get()?.quick_check!=='ok')throw new Error('Invalid OpenCode migration backup');}finally{saved.close();}
      return backup;
    }
    // VACUUM INTO reads a consistent transaction, unlike copying the .db file alone.
    const temporary=backup+'.'+process.pid+'.tmp';
    try {
      db.prepare('vacuum into ?').run(temporary);
      fs.chmodSync(temporary,0o600);
      fs.renameSync(temporary,backup);
    }finally{if(fs.existsSync(temporary))fs.unlinkSync(temporary);}
    return backup;
  }finally{db.close();}
}

/** Verify this conversation, rather than trusting an empty/no-op migration status. */
export function verifyV1Conversation(file,id) {
  if(!fs.existsSync(file))return;
  const {DatabaseSync}=loadSqlite();
  const db=new DatabaseSync(file,{readOnly:true});
  try {
    if(!table(db,'session') || !db.prepare('select 1 from session where id=?').get(id))return;
    const fail=()=>{throw Object.assign(new Error(t('opencode.errors.migrationLoss')),{code:'OPENCODE_MIGRATION_LOSS'});};
    if(!v2MigrationComplete(db) || !db.prepare('select 1 from session_v2 where id=?').get(id))return fail();
    const old=db.prepare('select id,data from message where session_id=? order by time_created,id').all(id);
    const oldParts=db.prepare('select message_id,data from part where session_id=? order by id').all(id);
    const parts=Map.groupBy(oldParts,p=>p.message_id);
    const next=new Map(db.prepare('select id,type,data from session_message where session_id=? order by seq').all(id).map(r=>[r.id,{...JSON.parse(r.data),type:r.type}]));
    const messages=new Map(old.map(m=>[m.id,JSON.parse(m.data)]));
    for(const row of old) {
      const message=messages.get(row.id),owned=(parts.get(row.id)??[]).map(p=>JSON.parse(p.data));
      const parentParts=(parts.get(message.parentID)??[]).map(p=>JSON.parse(p.data));
      if(owned.some(p=>p.type==='compaction'))continue;
      if(message.summary && parentParts.some(p=>p.type==='compaction'))continue;
      if(owned.length && owned.every(p=>p.type==='subtask'))continue;
      if(parentParts.some(p=>p.type==='subtask') && owned.some(p=>p.type==='tool'&&p.tool==='task'))continue;
      const migrated=next.get(row.id);if(!migrated)return fail();
      const files=owned.filter(p=>p.type==='file');
      if(files.length) {
        if(files.length!==(migrated.files??[]).length)return fail();
        for(const file of files) {
          const match=/^data:([^,]*?),(.*)$/s.exec(file.url ?? '');if(!match)return fail();
          const data=match[1].includes(';base64')?Buffer.from(match[2],'base64').toString('base64'):Buffer.from(decodeURIComponent(match[2])).toString('base64');
          if(!(migrated.files??[]).some(f=>f.data===data && f.mime===file.mime))return fail();
        }
      }
      for(const part of owned) {
        if(part.type==='file' && !String(part.url).startsWith('data:'))return fail();
        if(part.type==='text' && !part.ignored && !part.synthetic) {
          const text=message.role==='assistant'?(migrated.content??[]).filter(c=>c.type==='text').map(c=>c.text).join('\n\n'):migrated.text??'';
          if(!text.includes(part.text))return fail();
        }
        if(part.type==='tool' && !(migrated.content??[]).some(c=>c.type==='tool'&&c.id===part.callID))return fail();
      }
    }
  }finally{db.close();}
}

export const opencodeDatabase = (dataDir,env) => env.OPENCODE_DB && env.OPENCODE_DB!==':memory:' ? path.resolve(env.OPENCODE_DB) : path.join(dataDir,'opencode.db');
