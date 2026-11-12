/* Llama · service worker · avisos */
self.addEventListener("install",function(e){self.skipWaiting();});
self.addEventListener("activate",function(e){e.waitUntil(caches.keys().then(function(k){return Promise.all(k.filter(function(n){return n.indexOf("365-")===0;}).map(function(n){return caches.delete(n);}));}).then(function(){return self.clients.claim();}));});
self.addEventListener("push",function(e){
 var body="Tienes algo nuevo \uD83D\uDD25";
 try{if(e.data){var j=e.data.json();if(j&&j.body)body=j.body;}}catch(_){}
 e.waitUntil(self.registration.showNotification("Llama",{body:body,tag:"llama",renotify:true}));
});
self.addEventListener("notificationclick",function(e){
 e.notification.close();
 e.waitUntil(self.clients.matchAll({type:"window",includeUncontrolled:true}).then(function(cs){
  for(var i=0;i<cs.length;i++){if("focus" in cs[i])return cs[i].focus();}
  if(self.clients.openWindow)return self.clients.openWindow("./");
 }));
});
