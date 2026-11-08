'use strict';
function error(page,err) {page.setData({error:err?.message||'操作未完成，请重试。',saving:false});}
function toast(title) {wx.showToast({title,icon:'none'});}
function back(fallback='/pages/home/index') {
  if(typeof getCurrentPages==='function'&&getCurrentPages().length>1) wx.navigateBack({delta:1});
  else if(['/pages/home/index','/pages/library/index'].includes(fallback)) wx.switchTab({url:fallback});
  else wx.redirectTo({url:fallback});
}
function mealUrl(page,id) {return '/pages/'+page+'/index?id='+encodeURIComponent(id);}
function confirm({title,content,confirmText='确认'}) {
  return new Promise(resolve=>wx.showModal({title,content,confirmText,confirmColor:'#173D2B',cancelText:'取消',success:res=>resolve(!!res.confirm),fail:()=>resolve(false)}));
}
module.exports={error,toast,back,mealUrl,confirm};
