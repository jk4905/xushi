const {store,M}=require('../../core/store');
const ui=require('../../core/ui');
Page({
  data:{meal:null,error:''},
  onShow(){
    if(this.getTabBar())this.getTabBar().setData({active:'home'});
    const h=store.get(), meal=store.meal()||h.meals.find(m=>m.status==='planned')||null;
    const progress=meal&&store.meta().cooking[meal.id];
    const summary=meal?M.summary(meal.data):null;
    this.setData({meal,error:store.issue(),cooking:!!progress,names:meal?meal.recipeIds.map(id=>h.recipes.find(r=>r.id===id)?.name).join(' · '):'',prepared:summary?summary.atHome+summary.bought:0,total:summary?.required||0});
  },
  arrange(){wx.navigateTo({url:'/pages/builder/index'});},
  resume(){if(this.data.meal)wx.navigateTo({url:ui.mealUrl(this.data.cooking?'cook':'shopping',this.data.meal.id)});},
  history(){wx.navigateTo({url:'/pages/history/index'});},
  backup(){wx.navigateTo({url:'/pages/backup/index'});}
});
