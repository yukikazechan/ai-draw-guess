import {setTimeout as delay} from 'node:timers/promises';

// Retry only failures likely to recover without changing the model configuration.
export function isTransientModelError(error){
  if(typeof error?.retryable==='boolean')return error.retryable;
  if(error?.name==='AbortError')return false;
  if(error?.name==='TimeoutError')return true;
  const message=String(error?.message||'');
  if(/API (400|401|403|404|429)\b/.test(message))return false;
  return /API (408|500|502|503|504|524)\b|fetch failed|network error|网络错误|ECONNRESET|ECONNREFUSED|ETIMEDOUT|仍未完成|上游.*超时/i.test(message);
}

export async function recoverModelRequest(request,{signal,onRetry=()=>{},delayMs=1000}={}){
  signal?.throwIfAborted();
  try{return await request();}
  catch(error){
    if(signal?.aborted||!isTransientModelError(error))throw error;
    onRetry();
    await delay(delayMs,undefined,{signal});
    signal?.throwIfAborted();
    return request();
  }
}
