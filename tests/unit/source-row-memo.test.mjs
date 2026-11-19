import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {parse} from '@vue/compiler-sfc';
import {baseParse} from '@vue/compiler-dom';
import {h,withMemo} from 'vue';

const template=parse(await readFile(new URL('../../apps/desktop/src/renderer/views/SourcesView.vue',import.meta.url),'utf8')).descriptor.template.content;
const expressions=[];
function visit(node){if(node.type===1&&node.tag==='tr'){const memo=node.props.find(prop=>prop.type===7&&prop.name==='memo');if(memo)expressions.push({expression:memo.exp.content,point:node.props.some(prop=>prop.type===7&&prop.name==='on'&&prop.arg?.content==='dragover')});}for(const child of node.children??[])visit(child);}
visit(baseParse(template));
function subject(expression,context){let renders=0;const cache=[];return{draw(){const deps=vm.runInNewContext(expression,context);return withMemo(deps,()=>{renders++;return h('tr');},cache,0);},count:()=>renders};}
test('source row memo preserves unchanged rows but invalidates edits, toggles, audit, trust and order state',()=>{
  assert.equal(expressions.length,3);
  const source={id:'s',name:'Original',enabled:false},healthMap=new Map(),executableStateMap=new Map(),auditing=new Set(),executableBusy=new Set();
  const context={source,healthMap,executableStateMap,auditing,executableBusy,sourceOrderBusy:false,group:{items:[source,{id:'last'}]},liveSources:[]};
  const row=subject(expressions.find(item=>item.point).expression,context);row.draw();for(let i=0;i<50;i++)row.draw();assert.equal(row.count(),1);
  const mutations=[()=>source.enabled=true,()=>source.name='Edited',()=>healthMap.set('s',{checkedAt:'a'}),()=>healthMap.get('s').checkedAt='b',()=>healthMap.get('s').score=90,()=>healthMap.get('s').ok=true,()=>healthMap.get('s').audit={ok:true},()=>executableStateMap.set('s',{approved:true}),()=>executableStateMap.get('s').approved=false,()=>auditing.add('s'),()=>executableBusy.add('s'),()=>context.sourceOrderBusy=true,()=>context.group.items.reverse()];
  for(const mutate of mutations){const before=row.count();mutate();row.draw();assert.equal(row.count(),before+1);}
});
test('live and compatibility memo update when displayed data and evidence change',()=>{
  for(const item of expressions.filter(item=>!item.point)){
    const source={id:'s',name:'Live',enabled:false,epg:''},healthMap=new Map(),health={checkedAt:'a'},rowData={source,health,group:'Group',type:'直播'};
    const context={source,healthMap,row:rowData,liveSources:[]};const row=subject(item.expression,context);row.draw();row.draw();assert.equal(row.count(),1);
    if(item.expression.includes('row.source')){rowData.group='New group';row.draw();rowData.health.audit={ok:true};row.draw();source.name='Renamed';row.draw();rowData.health.latencyMs=30;row.draw();assert.equal(row.count(),5);}
    else{source.epg='new';row.draw();source.enabled=true;row.draw();}
    if(!item.expression.includes('row.source'))assert.equal(row.count(),3);
  }
});
