import {marker} from './core.js';

export default function createEngine(){
  let ext='';
  return{
    init(ruleExt){ext=String(ruleExt??'');return this;},
    getRule(){return{title:'controlled-v1',ext,marker};},
    home(){return{class:[{type_id:'1',type_name:'Controlled'}],list:[{vod_id:'home-1',vod_name:'Home One'}]};},
    homeVod(){return{list:[{vod_id:'home-vod-1',vod_name:'Home Vod One'}]};},
    category(tid,pg){return{page:Number(pg)||1,pagecount:1,list:[{vod_id:`${tid}-1`,vod_name:'Category One'}]};},
    detail(id){return{list:[{vod_id:String(id),vod_name:'Detail',vod_play_from:'direct',vod_play_url:'Play$https://media.example/video.mp4'}]};},
    search(key,quick,pg){return{page:Number(pg)||1,pagecount:1,list:[{vod_id:'search-1',vod_name:String(key)}]};},
    play(flag,id){return{parse:0,jx:0,url:String(id),header:{'User-Agent':'Controlled/1.0'}};}
  };
}
