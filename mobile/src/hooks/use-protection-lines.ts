import {useEffect,useState} from 'react';
import {AppState} from 'react-native';
import {useIsFocused} from 'expo-router/react-navigation';
import {useSession} from '../../App';
export type ProtectionLine={id:string;kind:'TP'|'SL';price:number};
type Position={id:string;provider:string;coin:string};
type Exit={id:string;group?:string;exit_group?:string;type?:string;trigger_price?:number;limit_price?:number;price?:number};
export function useProtectionLines(provider:string,coin:string,enabled:boolean){
 const {request,token}=useSession(),focused=useIsFocused();
 const [state,setState]=useState<{key:string;lines:ProtectionLine[];status:string}>({key:'',lines:[],status:''});
 const key=`${provider.toLowerCase()}|${coin.toUpperCase()}`;
 useEffect(()=>{
  if(!enabled||!focused)return;let mounted=true,inFlight=false;let timer:ReturnType<typeof setTimeout>|undefined;
  async function load(){
   if(!mounted||inFlight||AppState.currentState==='background')return;inFlight=true;
   try{
    const activity=await request('activity','GET',undefined,token);
    const positions:Position[]=(activity.open??[]).filter((p:Position)=>p.provider?.toLowerCase()===provider.toLowerCase()&&p.coin?.toUpperCase()===coin.toUpperCase());
    const responses=await Promise.all(positions.map(p=>request('protection','POST',{positionId:p.id},token)));
    const lines:ProtectionLine[]=responses.flatMap((value,i)=>(value.orders??[]).flatMap((o:Exit)=>{const kind=/tp|take/i.test(o.group??o.exit_group??o.type??'')?'TP':/sl|stop/i.test(o.group??o.exit_group??o.type??'')?'SL':null;const price=Number(o.trigger_price??o.limit_price??o.price);return kind&&Number.isFinite(price)&&price>0?[{id:`${positions[i].id}:${o.id}`,kind,price}]:[];}));
    if(mounted)setState({key,lines,status:lines.length?'Working TP/SL exits':positions.length?'No working TP/SL exits':'No open position for this asset'});
   }catch{if(mounted)setState({key,lines:[],status:'TP/SL levels unavailable · retrying'});}
   finally{inFlight=false;if(mounted)timer=setTimeout(()=>void load(),20000);}
  }
  void load();const sub=AppState.addEventListener('change',s=>{if(s==='active'){if(timer)clearTimeout(timer);void load();}});
  return()=>{mounted=false;if(timer)clearTimeout(timer);sub.remove();};
 },[provider,coin,enabled,focused,request,token,key]);
 return enabled&&state.key===key?state:{lines:[],status:enabled?'Loading TP/SL levels…':''};
}
