document.querySelectorAll('[data-message]').forEach(b=>b.addEventListener('click',()=>{document.getElementById('message').textContent=b.dataset.message;document.getElementById('info').showModal()}));document.querySelectorAll('[data-expand]').forEach(i=>i.addEventListener('click',()=>{const d=document.getElementById('screenshot-view');d.querySelector('img').src=i.src;d.querySelector('img').alt=i.alt;d.showModal()}));
fetch('/api/landing/config').then(r=>r.json()).then(config=>{
 if(config.affiliateUrl){document.getElementById('affiliate-link').href=config.affiliateUrl;document.getElementById('affiliate-section').hidden=false;}
}).catch(()=>{});
document.getElementById('beta-signup').addEventListener('submit',async function(event){
 event.preventDefault();if(!this.reportValidity())return;
 const status=this.querySelector('.signup-status'),button=this.querySelector('button[type=submit]');
 button.disabled=true;status.classList.remove('visible');
 try{
  const response=await fetch('/api/landing/signup',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:this.elements.email.value.trim(),marketingConsent:this.elements.marketingConsent.checked})});
  const result=await response.json();if(!response.ok)throw new Error(result.error||'We could not save your email. Please try again.');
  const dialog=document.getElementById('beta-access'),install=document.getElementById('testflight-install');
  const ready=Boolean(result.testflightUrl);
  dialog.querySelector('h2').textContent=ready?'Ready to try Guardian?':'You are on the list.';
  dialog.querySelector('h2+p').textContent=ready?'Install TestFlight, then use the link below to join the beta and install Funded Guardian.':'Thanks for your interest in Guardian for iOS.';
  if(ready){install.href=result.testflightUrl;install.hidden=false;}else{install.removeAttribute('href');install.hidden=true;}
  dialog.querySelector('.access-pending').hidden=ready;
  dialog.showModal();
 }catch(error){status.textContent=error.message||'Something went wrong. Please try again.';status.classList.add('visible');}
 finally{button.disabled=false;}
});

document.querySelectorAll("[data-close-dialog]").forEach(button=>button.addEventListener("click",()=>button.closest("dialog").close()));

// Progressive enhancement: the page stays visible and usable without motion or JavaScript.
const reducedMotion=window.matchMedia('(prefers-reduced-motion: reduce)');
if(!reducedMotion.matches && 'IntersectionObserver' in window){
 const items=document.querySelectorAll('.section>.tag,.section>h2,.card,.product-block,.screen-gallery figure,.steps article,.faq details,.cta');
 const observer=new IntersectionObserver(entries=>entries.forEach(entry=>{
  if(entry.isIntersecting){entry.target.classList.add('in-view');observer.unobserve(entry.target);}
 }),{threshold:.08});
 items.forEach((item,index)=>{item.classList.add('reveal');item.style.setProperty('--reveal-delay',`${(index%3)*70}ms`);observer.observe(item);});
 document.body.classList.add('motion-ready');
}
let ticking=false;
function updateScroll(){
 const max=document.documentElement.scrollHeight-window.innerHeight;
 document.documentElement.style.setProperty('--scroll',String(max>0?window.scrollY/max:0));
 const hero=document.querySelector('.hero-product');
 if(hero&&!reducedMotion.matches&&window.innerWidth>760&&window.scrollY<1200) hero.style.setProperty('--hero-shift',`${Math.min(window.scrollY*.06,45)}px`);
 ticking=false;
}
window.addEventListener('scroll',()=>{if(!ticking){ticking=true;requestAnimationFrame(updateScroll);}},{passive:true});
window.addEventListener('resize',updateScroll,{passive:true});
document.addEventListener('visibilitychange',()=>document.querySelectorAll('.hero-ios-pair figure,.ambient').forEach(el=>el.style.animationPlayState=document.hidden?'paused':'running'));
updateScroll();
