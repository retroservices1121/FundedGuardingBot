document.querySelectorAll('[data-message]').forEach(b=>b.addEventListener('click',()=>{document.getElementById('message').textContent=b.dataset.message;document.getElementById('info').showModal()}));document.querySelectorAll('[data-expand]').forEach(i=>i.addEventListener('click',()=>{const d=document.getElementById('screenshot-view');d.querySelector('img').src=i.src;d.querySelector('img').alt=i.alt;d.showModal()}));
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
