import { accountRisk } from './risk.js';
import type { ChallengeAccount } from './types.js';
export type PersonalGuards={mode:'off'|'warn'|'enforce';maxRiskUsd?:number;lossRoomPercent?:number;quickTradeEnabled?:boolean;quickAmounts?:number[]};
export function parseGuards(input:Record<string,unknown>):PersonalGuards {
 if(!['off','warn','enforce'].includes(String(input.mode)))throw new Error('Choose off, warn or enforce.');
 const optional=(key:string,max=Number.MAX_SAFE_INTEGER)=>{const raw=input[key];if(raw===null||raw===undefined||raw==='')return undefined;const value=Number(raw);if(!Number.isFinite(value)||value<=0||value>max)throw new Error(`Invalid ${key}.`);return value;};
 if(input.quickTradeEnabled!==undefined&&typeof input.quickTradeEnabled!=='boolean')throw new Error('Invalid quick trading preference.');
 if(input.quickAmounts!==undefined&&(!Array.isArray(input.quickAmounts)||input.quickAmounts.length!==3||input.quickAmounts.some(v=>typeof v!=='number'||!Number.isFinite(v)||v<=0||v>100000)))throw new Error('Choose three positive quick risk amounts up to $100,000.');
 const result:PersonalGuards={mode:input.mode as PersonalGuards['mode'],maxRiskUsd:optional('maxRiskUsd'),lossRoomPercent:optional('lossRoomPercent',100)};
 if(input.quickTradeEnabled!==undefined)result.quickTradeEnabled=input.quickTradeEnabled;
 if(input.quickAmounts!==undefined)result.quickAmounts=input.quickAmounts as number[];
 if(result.mode!=='off'&&result.maxRiskUsd===undefined&&result.lossRoomPercent===undefined)throw new Error('Choose at least one personal limit.');return result;
}
export function guardWarnings(guards:PersonalGuards|undefined,account:ChallengeAccount,risk:number){
 if(!guards||guards.mode==='off')return [];
 const warnings:string[]=[];
 if(guards.maxRiskUsd!==undefined&&risk>guards.maxRiskUsd)warnings.push(`Risk exceeds your $${guards.maxRiskUsd.toFixed(2)} personal trade limit.`);
 if(guards.lossRoomPercent!==undefined){const state=accountRisk(account);const rooms=[state.daily_loss_room,state.max_drawdown_room].filter((v):v is number=>typeof v==='number'&&Number.isFinite(v));if(!rooms.length){if(guards.mode==='enforce')throw new Error('Remaining loss room is unavailable. Your chosen limit cannot be checked.');warnings.push('Remaining loss room is unavailable.');}else{const allowed=Math.max(0,Math.min(...rooms))*guards.lossRoomPercent/100;if(risk>allowed)warnings.push(`Risk exceeds your ${guards.lossRoomPercent}% loss-room limit ($${allowed.toFixed(2)}).`);}}
 if(guards.mode==='enforce'&&warnings.length)throw new Error(warnings.join(' '));return warnings;
}
