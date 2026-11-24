let token='';const $=id=>document.getElementById(id);const number=n=>Number(n||0).toLocaleString();const usd=n=>Number(n||0).toLocaleString('en-US',{style:'currency',currency:'USD',maximumFractionDigits:0});
function cells(body,rows){body.replaceChildren();for(const row of rows){const tr=document.createElement('tr');for(const text of row){const td=document.createElement('td');td.textContent=text;tr.append(td);}body.append(tr);}}
async function refresh(){if(!token)return;$('status').textContent='Updating…';try{const response=await fetch('/api/admin/mobile/stats?platform='+$('platform').value,{headers:{Authorization:'Bearer '+token},cache:'no-store'});const data=await response.json();if(!response.ok)throw new Error(data.error);$('dashboard').hidden=false;$('login').hidden=true;$('lock').hidden=false;const s=data.summary;const installs=data.installations.filter(p=>data.platform==='all'||p.platform===data.platform);const total=field=>installs.reduce((sum,p)=>sum+Number(p[field]),0);
const cards=[['First app launches',number(total('first_launches')),'Tracking starts with the app update'],['Launched in 7 days',number(total('launched_7d')),'Distinct reported installation IDs'],['Signed-in users',number(s.users),'Current registered mobile identities'],['Connected accounts',number(s.connections),'Current MyFundedPerps connections'],['Submitted notional',usd(s.submitted_notional),'Estimated order value, all retained history'],['Submitted orders',number(s.submitted_orders),'Excludes demo and known failures'],['7-day notional',usd(s.notional_7d),'Estimated submitted value'],['Dry-run orders',number(s.dry_runs),'Excluded from trading notional'],['Needs attention',number(Number(s.failed)+Number(s.unresolved)),`${number(s.failed)} failed / ${number(s.unresolved)} unresolved`]];
$('cards').replaceChildren();for(const [caption,value,note] of cards){const card=document.createElement('div');card.className='card';for(const [className,text]of[['caption',caption],['value',value],['muted',note]]){const div=document.createElement('div');div.className=className;div.textContent=text;card.append(div);}$('cards').append(card);}
cells($('adoption'),['ios','android'].map(platform=>{const p=data.installations.find(p=>p.platform===platform);return[platform==='ios'?'iOS':'Android',number(p?.first_launches),number(p?.launched_7d)];}));cells($('markets'),data.markets.map(m=>[m.symbol||'Unknown',number(m.orders),usd(m.notional)]));
const chart=$('chart');chart.replaceChildren();const days=new Map(data.days.map(d=>[String(d.day).slice(0,10),Number(d.notional)]));const values=Array.from({length:30},(_,i)=>{const date=new Date();date.setUTCDate(date.getUTCDate()-29+i);return days.get(date.toISOString().slice(0,10))||0;});const max=Math.max(...values,1);values.forEach((value,i)=>{const rect=document.createElementNS('http://www.w3.org/2000/svg','rect');rect.setAttribute('x',String(i*21));rect.setAttribute('y',String(150-value/max*140));rect.setAttribute('width','13');rect.setAttribute('height',String(Math.max(value/max*140,1)));rect.setAttribute('rx','3');rect.setAttribute('fill',value?'#36d59e':'#24372b');const title=document.createElementNS('http://www.w3.org/2000/svg','title');title.textContent=usd(value);rect.append(title);chart.append(rect);});$('empty').hidden=data.days.length>0;$('status').textContent='Updated '+new Date(data.updatedAt).toLocaleString();}catch(error){$('dashboard').hidden=true;$('status').textContent=error.message||'Could not load analytics.';$('login').hidden=false;}}
$('login').addEventListener('submit',event=>{event.preventDefault();token=$('secret').value;$('secret').value='';void refresh();});$('refresh').addEventListener('click',()=>void refresh());$('platform').addEventListener('change',()=>void refresh());$('lock').addEventListener('click',()=>{token='';$('dashboard').hidden=true;$('login').hidden=false;$('lock').hidden=true;$('status').textContent='Dashboard locked.';});

const ticketsPath='/api/admin/mobile/tickets';
let tickets=[];
let ticketRequest=false;
let ticketPreview;
async function ticketApi(action='',input){
  const response=await fetch(ticketsPath+action,{
    method:input?'POST':'GET',
    headers:{Authorization:'Bearer '+token,...(input?{'Content-Type':'application/json'}:{})},
    body:input?JSON.stringify(input):undefined,cache:'no-store',
  });
  const data=await response.json();
  if(!response.ok)throw new Error(data.error||'Could not complete the request.');
  return data;
}
function selectedTicket(){return tickets[Number($('ticket').value)];}
function clearTicketPreview(){
  ticketPreview=undefined;
  $('confirm-resolution').hidden=true;
}
function showTicketDetails(){
  clearTicketPreview();
  const ticket=selectedTicket();
  $('ticket-details').textContent=ticket?
    `User ${ticket.user_id} · Account ${ticket.account} · Market ${ticket.market} · Submitted ${new Date(ticket.submitted_at).toLocaleString()} (${number(Math.floor(ticket.age_seconds/60))} min ago)${ticket.legacy?' · Legacy request':''}`:'';
}
async function loadTickets(message){
  const currentToken=token;
  const previous=selectedTicket();
  clearTicketPreview();
  const data=await ticketApi();
  if(!token||token!==currentToken)return;
  tickets=data.tickets;
  const select=$('ticket');
  select.replaceChildren();
  tickets.forEach((ticket,index)=>select.add(new Option(`${ticket.kind==='trade'?'Trade':'Close'} · ${ticket.id}`,String(index))));
  const index=tickets.findIndex(ticket=>ticket.id===previous?.id&&ticket.kind===previous.kind);
  if(index>=0)select.value=String(index);
  $('ticket-form').hidden=!tickets.length;
  showTicketDetails();
  $('ticket-status').textContent=message||(tickets.length?'Choose a request to check.':'No uncertain trade or close requests.');
}
async function withTicketRequest(run){
  if(!token||ticketRequest)return;
  const currentToken=token;
  ticketRequest=true;
  try{await run();}
  catch(error){
    if(token===currentToken)$('ticket-status').textContent=error.message||'Could not complete the request.';
  }finally{ticketRequest=false;}
}
const ticketMessages={
  absent:'MyFundedPerps returned no order yet. Check again after the request is at least one minute old.',
  failed:'Could not verify this request with MyFundedPerps. Check the account there before resolving it.',
  found:'MyFundedPerps found the order but could not provide a complete result.',
  legacy:'This older request cannot be checked here. Verify the outcome in MyFundedPerps.',
  busy:'This request is still being processed. Check again shortly.',
  missing:'This request is no longer available.',
  already_resolved:'This request already has a result.',
  found_use_check:'MyFundedPerps found the order. Use Check MyFundedPerps to record its result.',
  too_recent:'Wait until this request is at least one minute old.',
};
async function actOnTicket(action,confirm=false){
  const ticket=selectedTicket();
  if(!ticket||!$('operator').reportValidity())return;
  const input={ticketId:ticket.id,kind:ticket.kind,operator:$('operator').value,note:$('ticket-note').value};
  if(action==='resolve'){
    input.outcome=$('ticket-outcome').value;
    if(!input.outcome||!input.note.trim()){
      $('ticket-status').textContent='Choose an outcome and explain how you verified it.';
      return;
    }
    if(confirm&&ticketPreview!==JSON.stringify(input))return;
  }
  clearTicketPreview();
  const currentToken=token;
  $('ticket-status').textContent='Checking…';
  const data=await ticketApi('/'+action,{...input,confirm});
  if(!token||token!==currentToken)return;
  if(data.status==='dry_run'){
    const outcome=input.outcome==='not_submitted'?'Order was not sent':'Order was verified in MyFundedPerps';
    $('ticket-status').textContent=`Preview only. Confirm to record “${outcome}” for request ${input.ticketId}.`;
    ticketPreview=JSON.stringify(input);
    $('confirm-resolution').hidden=false;
  }else if(data.status==='resolved'||data.status==='already_resolved'||data.status==='missing'){
    const message=data.status==='resolved'?(data.result.status==='not_submitted'?'Recorded that the order was not sent.':
      data.result.status==='submitted_verified'?'Recorded the verified submission.':`Recorded MyFundedPerps order ${data.result.orderId}.`):ticketMessages[data.status];
    $('ticket-status').textContent=message;
    await loadTickets(message);
  }else{
    $('ticket-status').textContent=ticketMessages[data.status]||'The result is still unknown. Check MyFundedPerps.';
  }
}
$('ticket-form').addEventListener('submit',event=>event.preventDefault());
$('load-tickets').addEventListener('click',()=>void withTicketRequest(()=>loadTickets()));
$('ticket').addEventListener('change',showTicketDetails);
$('ticket-form').addEventListener('input',clearTicketPreview);
$('check-ticket').addEventListener('click',()=>void withTicketRequest(()=>actOnTicket('check')));
$('preview-resolution').addEventListener('click',()=>void withTicketRequest(()=>actOnTicket('resolve')));
$('confirm-resolution').addEventListener('click',()=>void withTicketRequest(()=>actOnTicket('resolve',true)));
$('lock').addEventListener('click',()=>{
  tickets=[];
  $('ticket-form').reset();
  $('ticket-form').hidden=true;
  $('ticket-status').textContent='';
  showTicketDetails();
});
