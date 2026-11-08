'use strict';
const {store}=require('./core/store');
App({onLaunch(){store.get();}});
