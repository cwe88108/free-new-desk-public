import {onMounted,onBeforeUnmount} from 'vue';

export function useSourceChanges(refresh:()=>Promise<unknown>):void{
  let unsubscribe:(()=>void)|undefined;
  onMounted(()=>{unsubscribe=window.desktop.source.onChanged(()=>{void refresh().catch(error=>console.error('Source refresh failed',error));});});
  onBeforeUnmount(()=>unsubscribe?.());
}
