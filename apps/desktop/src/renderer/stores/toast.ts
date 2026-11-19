import { defineStore } from 'pinia';
import { ref } from 'vue';

export type ToastLevel='info'|'success'|'error';
export interface ToastItem{id:number;level:ToastLevel;title:string;detail?:string|undefined;duration:number;createdAt:number;}

let sequence=0;
const DEFAULT_DURATION=3800;

export const useToastStore=defineStore('toast',()=>{
  const items=ref<ToastItem[]>([]);
  const timers=new Map<number,ReturnType<typeof setTimeout>>();

  function dismiss(id:number){const timer=timers.get(id);if(timer){clearTimeout(timer);timers.delete(id);}items.value=items.value.filter(item=>item.id!==id);}

  function show(level:ToastLevel,title:string,detail?:string,duration=DEFAULT_DURATION):number{const id=++sequence;const item:ToastItem={id,level,title,detail,duration,createdAt:Date.now()};items.value=[...items.value.slice(-4),item];if(duration>0)timers.set(id,setTimeout(()=>dismiss(id),duration));return id;}

  function info(title:string,detail?:string){return show('info',title,detail);}
  function success(title:string,detail?:string){return show('success',title,detail);}
  function error(title:string,detail?:string){return show('error',title,detail,6000);}

  return{items,show,info,success,error,dismiss};
});
