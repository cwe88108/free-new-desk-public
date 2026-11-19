import type {SourceAuditStage,SourceHealth} from '@free-new-desk/contracts';

const operations=[['home','首页'],['category','分类'],['search','搜索'],['detail','详情'],['play','播放解析']] as const;
function state(stage:SourceAuditStage|undefined){return!stage?'未验证':stage.message?.startsWith('SKIPPED:')?'不适用':stage.message?.startsWith('NOT_RUN:')?'未执行':stage.ok?'通过':'失败';}
export function sourceCapabilities(health:SourceHealth|undefined,live=false){
  const audit=health?.audit;
  const stages=operations.map(([key,label])=>{const stage=audit?.stages.find(item=>item.stage===key);return{key,label,state:state(stage),durationMs:stage?.durationMs,message:stage?.message};});
  const reason=health?.failureReason??health?.message??'';
  const runtimeMissing=/SRC_JAVA_NOT_FOUND|SRC_PYTHON_(?:NOT_FOUND|UNAVAILABLE|RUNTIME_DISABLED)|SRC_ANDROID_|unsupported-runtime: android|真实 Android runtime|Python.*(?:not found|ENOENT)|spawn .*ENOENT/i.test(reason);
  const pendingApproval=/SOURCE_EXECUTABLE_NOT_APPROVED/i.test(reason);
  const unsupported=/DRPY_RUNTIME_UNSUPPORTED|DRPY_UNSUPPORTED_ENGINE|SRC_JAR_INVALID|SRC_JAR_CLASS_MISSING|Unsupported source kind/i.test(reason);
  const passed=stages.filter(stage=>stage.state==='通过').length;
  const applicable=stages.filter(stage=>stage.state!=='不适用').length;
  const complete=Boolean(audit?.ok&&passed>0&&stages.every(stage=>stage.state==='通过'||stage.state==='不适用'));
  // Source audits resolve a playback descriptor; they do not observe decoded video or audio.
  const label=pendingApproval?'待授权':runtimeMissing?'需要运行时':live?(health?.ok?'列表已解析':health?'检查失败':'待验证'):complete?'接口通过':passed?'部分兼容':unsupported?'不兼容':health?.retryable?'待重试':health&&!health.ok?'检查失败':'待验证';
  const detail=live?'频道列表解析结果不代表频道实际可播放。':complete?'适用接口检查通过；实际播放仍待验证。':`${passed}/${applicable} 项接口通过；实际播放待验证。`;
  return{label,detail,stages,complete,runtimeMissing,pendingApproval};
}
