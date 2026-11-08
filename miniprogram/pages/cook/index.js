const {store,H}=require('../../core/store');
const {stepImage}=require('../../core/content');
const ui=require('../../core/ui');
Page({
 data:{meal:null,recipe:null,recipes:[],scrollTop:0,materialsOpen:false,error:'',finishing:false},
 onLoad(options){this.mealId=options.id;this.positions={};this.expanded={};this.top=0;},
 onShow(){
   const meal=store.meal(this.mealId);if(!meal){this.setData({error:'没有找到这餐，请从做饭页重新选择。',meal:null});return;}
   const h=store.get(),progress=store.meta().cooking[meal.id];
   this.positions={...(progress?.positions||{}),...this.positions};this.expanded={...(progress?.expanded||{}),...this.expanded};
   const recipes=meal.recipeIds.map(id=>h.recipes.find(r=>r.id===id));
   const recipeId=this.data.recipe?.id||progress?.recipeId||meal.recipeIds[0];
   this.setData({meal,recipes,error:store.issue()});this.showRecipe(recipes.find(r=>r.id===recipeId)||recipes[0]);
 },
 showRecipe(recipe){
   const meal=this.data.meal;
   const names=this.data.recipes.map(r=>r.name);
   const unassigned=meal.data.items.some(i=>i.dish.split('、').some(name=>!names.includes(name)));
   const materials=meal.data.items.filter(i=>unassigned||meal.recipeIds.length===1||i.dish.split('、').includes(recipe.name)||recipe.items.some(original=>original.name===i.name)).map(i=>({...i,choiceLabel:i.choice==='omit'?'本餐不放':i.choice==='pending'?'待取舍':''}));
   const top=this.positions[recipe.id]||0;this.top=top;this.restoring=true;
   this.setData({recipe:{...recipe,steps:recipe.steps.map((step,i)=>({...step,number:i+1,image:stepImage(recipe,i)}))},materials,materialsOpen:!!this.expanded[recipe.id],scrollTop:top,readerViews:[{id:recipe.id,top}]},()=>{this.restoring=false;});
 },
 choose(event){
   const id=event.currentTarget.dataset.id;if(id===this.data.recipe?.id)return;
   this.flush();const recipe=this.data.recipes.find(r=>r.id===id);if(!recipe)return;
   this.showRecipe(recipe);this.persist();
 },
 onScroll(event){
   if(this.restoring||!this.data.recipe||(event.currentTarget?.dataset?.recipe && event.currentTarget.dataset.recipe!==this.data.recipe.id))return;
   this.top=Math.max(0,event.detail.scrollTop);this.positions[this.data.recipe.id]=this.top;
   clearTimeout(this.timer);this.timer=setTimeout(()=>this.persist(),350);
 },
 persist(){
   if(!this.data.recipe)return;
   try{store.setReading(this.mealId,this.data.recipe.id,this.top,this.data.materialsOpen);}catch(error){ui.error(this,error);}
 },
 flush(){clearTimeout(this.timer);this.persist();},
 onHide(){this.flush();},onUnload(){this.flush();},
 toggleMaterials(){this.setData({materialsOpen:!this.data.materialsOpen});this.expanded[this.data.recipe.id]=this.data.materialsOpen;this.persist();},
 adjust(){this.flush();wx.navigateTo({url:ui.mealUrl('adjust',this.mealId)});},
 copySource(){if(this.data.recipe.sourceUrl)wx.setClipboardData({data:this.data.recipe.sourceUrl,success:()=>ui.toast('链接已复制，请到浏览器查看原菜谱'),fail:error=>ui.error(this,new Error('未能复制，请重试。'))});},
 edit(){this.flush();wx.navigateTo({url:'/pages/recipe-edit/index?id='+this.data.recipe.id});},
 async finish(){
   if(this.data.finishing||this.data.meal?.status!=='planned')return;
   this.setData({finishing:true});
   const confirmed=await ui.confirm({title:'这餐做好了吗？',content:'确认后会移入「做过」。阅读到最后不会自动完成这餐。',confirmText:'做好了'});
   if(!confirmed){this.setData({finishing:false});return;}
   try{this.flush();store.change(h=>H.setMealStatus(h,this.mealId,'completed'));ui.toast('这餐做好了，慢慢享用');wx.switchTab({url:'/pages/home/index'});}
   catch(error){ui.error(this,error);}finally{this.setData({finishing:false});}
 }
});
