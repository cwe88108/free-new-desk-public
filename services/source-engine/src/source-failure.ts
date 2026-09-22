import type {AppError} from '@free-new-desk/contracts';

function messageOf(error:unknown):string{return error instanceof Error?error.message:String(error);}
function coded(code:string,message:string,recoverable:boolean,stage:NonNullable<AppError['stage']>,category:NonNullable<AppError['category']>,suggestedAction?:NonNullable<AppError['suggestedAction']>):AppError{
  return{code,message,recoverable,stage,category,...(suggestedAction?{suggestedAction}:{})};
}

export function sourceFailure(error:unknown):AppError{
  const message=messageOf(error),upper=message.toUpperCase();
  if(error instanceof DOMException&&error.name==='AbortError'||/\bABORT(?:ED)?\b|CANCELLED/.test(upper))return coded('SOURCE_CANCELLED',message,false,'request','cancelled');
  if(/TYPE4_DIALECT_UNKNOWN|DRPY_RUNTIME_UNSUPPORTED|DRPY_UNSUPPORTED_ENGINE/.test(upper))return coded('RUNTIME_PROFILE_UNKNOWN',message,false,'runtime','compatibility','select-profile');
  if(/TYPE4_RESULT_SHAPE_UNSUPPORTED|RESULT_SHAPE_UNSUPPORTED/.test(upper))return coded('RESULT_SHAPE_UNSUPPORTED',message,false,'resolve','compatibility','open-diagnostics');
  if(/HTTP\s+(401|403)\b|AUTH_REQUIRED|UNAUTHORIZED|FORBIDDEN/.test(upper))return coded('AUTH_REQUIRED',message,false,'request','auth','login');
  if(/TIMEOUT|TIMED OUT|HARD_TIMEOUT/.test(upper))return coded('RESOLVE_TIMEOUT',message,true,'request','network','retry');
  if(/HTTP\s+5\d\d\b/.test(upper))return coded('UPSTREAM_HTTP_ERROR',message,true,'request','upstream','retry');
  if(/CLASSNOTFOUND|HOST_CAPABILITY_MISSING|JAVA_NOT_FOUND|MODULE.+NOT FOUND/.test(upper))return coded('HOST_CAPABILITY_MISSING',message,false,'runtime','compatibility','open-diagnostics');
  if(/NETWORK|FETCH|ECONN|ENOTFOUND|EAI_AGAIN|SOCKET/.test(upper))return coded('SOURCE_NETWORK_ERROR',message,true,'request','network','retry');
  return coded('SOURCE_ENGINE_ERROR',message,true,'invoke','resource','open-diagnostics');
}
