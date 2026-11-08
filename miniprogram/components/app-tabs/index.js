// Native tabs have separate component instances; carry only the next explicit switch.
let pendingSlide=null;
let runningSlide=null;
const slideDuration=240;
function currentRoute(){const pages=getCurrentPages();return pages.length?pages[pages.length-1].route:'';}
Component({
 properties:{active:{type:String,value:'home'}},
 data:{keyboardOpen:false,slideFrom:'',slideDelay:0},
 observers:{active(){this.syncSlide();}},
 lifetimes:{
  attached(){
   this._keyboard=event=>this.setData({keyboardOpen:event.height>0,slideFrom:''});
   if(wx.onKeyboardHeightChange)wx.onKeyboardHeightChange(this._keyboard);
   this.syncSlide();
  },
  detached(){if(wx.offKeyboardHeightChange)wx.offKeyboardHeightChange(this._keyboard);}
 },
 pageLifetimes:{show(){this.syncSlide();},hide(){this.setData({slideFrom:''});}},
 methods:{
  syncSlide(){
   if(!pendingSlide||pendingSlide.to!==this.data.active||currentRoute()!=='pages/'+this.data.active+'/index')return;
   const slide=pendingSlide;pendingSlide=null;
   const elapsed=Math.max(0,Date.now()-slide.started);
   runningSlide=slide.from===slide.to?null:slide;
   this.setData({slideFrom:slide.from===slide.to||elapsed>=slideDuration?'':slide.from,slideDelay:elapsed});
  },
  slideEnd(){this.setData({slideFrom:''});},
  go(event){
   const tab=event.currentTarget.dataset.tab;
   if(!['home','library'].includes(tab))return;
   if(pendingSlide?.to===tab||(!pendingSlide&&currentRoute()==='pages/'+tab+'/index'))return;
   const now=Date.now(),elapsed=runningSlide?now-runningSlide.started:slideDuration;
   const reversing=runningSlide?.from===tab&&runningSlide.to===this.data.active&&elapsed>=0&&elapsed<slideDuration;
   // Symmetric easing plus a negative delay reverses from the current position.
   const slide={from:this.data.active,to:tab,started:now-(reversing?slideDuration-elapsed:0)};
   pendingSlide=slide;
   wx.switchTab({url:'/pages/'+tab+'/index',fail:()=>{
    if(pendingSlide!==slide)return;
    pendingSlide=null;
    wx.showToast({title:'切换失败，请重试',icon:'none'});
   }});
  }
 }
});
