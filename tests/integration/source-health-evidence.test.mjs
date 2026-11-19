import test from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import path from 'node:path';import {DatabaseSync} from 'node:sqlite';
import {DataService} from '../../services/data-service/dist/index.js';
const source={id:'s',name:'Source',kind:'T1_JSON',endpoint:'https://fixture.test/api',enabled:true,trust:'A'};
const audit={sourceId:'s',ok:false,scope:'source-interface',checkedAt:'2026-11-09',stages:[{stage:'home',ok:true,durationMs:12},{stage:'play',ok:false,durationMs:45,message:'Fixture failure'}]};
const health={sourceId:'s',ok:false,latencyMs:57,checkedAt:audit.checkedAt,score:0,audit};

test('capability stages and timings survive reopening an existing database',()=>{
 const dir=mkdtempSync(path.join(tmpdir(),'fnd-capabilities-')),file=path.join(dir,'app.db');let db;
 try{db=new DataService(file);db.saveSource(source);db.saveSourceHealth(health,source);db.close();db=new DataService(file);assert.deepEqual(db.listSourceHealth()[0].audit,audit);db.saveSource({...source,name:'Renamed',enabled:false});assert.equal(db.listSourceHealth().length,1);db.saveSource({...source,endpoint:'https://fixture.test/new'});assert.equal(db.listSourceHealth().length,0);db.saveSourceHealth(health,source);assert.equal(db.listSourceHealth().length,0);db.removeSource('s');db.saveSourceHealth(health,source);assert.equal(db.listSourceHealth().length,0);}finally{db?.close();rmSync(dir,{recursive:true,force:true});}
});
test('older health databases migrate without inventing audit evidence',()=>{
 const dir=mkdtempSync(path.join(tmpdir(),'fnd-health-migrate-')),file=path.join(dir,'app.db');let db;
 try{const old=new DatabaseSync(file);old.exec("CREATE TABLE source_health(source_id TEXT PRIMARY KEY,ok INTEGER NOT NULL,latency_ms INTEGER NOT NULL,checked_at TEXT NOT NULL,score INTEGER NOT NULL,message TEXT);INSERT INTO source_health VALUES('s',1,3,'old',100,'legacy')");old.close();db=new DataService(file);assert.equal(db.listSourceHealth()[0].ok,true);assert.equal(db.listSourceHealth()[0].audit,undefined);db.saveSource(source);db.saveSourceHealth(health,source);assert.deepEqual(db.listSourceHealth()[0].audit,audit);}finally{db?.close();rmSync(dir,{recursive:true,force:true});}
});
