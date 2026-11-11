'use strict';
/* =================================================================
   Llama · núcleo v2 (identidad, cifrado, sincronización, arranque).
   La firma se carga desde la base, no va escrita aquí.
   ================================================================= */
var FIRMA=(typeof window!=='undefined'&&window.LLAMA_FIRMA)||'Llama · Jota';
const ME={slot:null,uid:null};
let screen='boot';          // boot | pass | pin | app | fatal
let BOOTED=false;
let CK=null;                // clave de pareja (CryptoKey)
let fatalMsg='';

/* ---------- memoria local del móvil (NO se sincroniza) ---------- */
const dev={
 get(k,d){try{const v=localStorage.getItem('llama.'+k);return v==null?d:JSON.parse(v);}catch(e){return d;}},
 set(k,v){try{localStorage.setItem('llama.'+k,JSON.stringify(v));}catch(e){}},
 del(k){try{localStorage.removeItem('llama.'+k);}catch(e){}}
};

/* ---------- IndexedDB: guardar la clave para no pedir la frase cada vez ---------- */
function _idb(){return new Promise((res,rej)=>{const r=indexedDB.open('llama',1);r.onupgradeneeded=()=>r.result.createObjectStore('k');r.onsuccess=()=>res(r.result);r.onerror=()=>rej(r.error);});}
async function idbSet(k,v){const db=await _idb();return new Promise((res,rej)=>{const t=db.transaction('k','readwrite');t.objectStore('k').put(v,k);t.oncomplete=()=>res();t.onerror=()=>rej(t.error);});}
async function idbGet(k){const db=await _idb();return new Promise((res,rej)=>{const t=db.transaction('k','readonly');const q=t.objectStore('k').get(k);q.onsuccess=()=>res(q.result);q.onerror=()=>rej(q.error);});}
async function idbDel(k){const db=await _idb();return new Promise((res)=>{const t=db.transaction('k','readwrite');t.objectStore('k').delete(k);t.oncomplete=()=>res();});}

/* ---------- cifrado AES-GCM con clave derivada de la clave de pareja ---------- */
const _te=new TextEncoder(),_td=new TextDecoder();
const _b64=u=>{let s='';const a=new Uint8Array(u);for(let i=0;i<a.length;i++)s+=String.fromCharCode(a[i]);return btoa(s);};
const _ub64=s=>Uint8Array.from(atob(s),c=>c.charCodeAt(0));
async function deriveKey(pass){
 const base=await crypto.subtle.importKey('raw',_te.encode(pass),'PBKDF2',false,['deriveKey']);
 return crypto.subtle.deriveKey({name:'PBKDF2',salt:_te.encode('llama.v2.pareja'),iterations:150000,hash:'SHA-256'},base,{name:'AES-GCM',length:256},false,['encrypt','decrypt']);
}
async function enc(obj){
 const iv=crypto.getRandomValues(new Uint8Array(12));
 const ct=await crypto.subtle.encrypt({name:'AES-GCM',iv},CK,_te.encode(JSON.stringify(obj)));
 return _b64(iv)+'.'+_b64(ct);
}
async function dec(s){
 try{const p=String(s).split('.');const iv=_ub64(p[0]),ct=_ub64(p[1]);
  const pt=await crypto.subtle.decrypt({name:'AES-GCM',iv},CK,ct);return JSON.parse(_td.decode(pt));}catch(e){return null;}
}

/* ---------- capa de datos (Supabase) ---------- */
async function putDoc(k,obj){try{const e=await enc(obj);const r=await sb.from('docs').upsert({k,e});if(r.error)console.log('putDoc',k,r.error.message);}catch(e){}}
async function putRow(table,row){try{const r=await sb.from(table).upsert(row);if(r.error)console.log('putRow',table,r.error.message);}catch(e){}}
async function delRow(table,id){try{await sb.from(table).delete().eq('id',id);}catch(e){}}
async function rpcPts(slot,delta){try{await sb.rpc('add_points',{p_slot:slot,p_delta:delta});}catch(e){}}
async function saveProp(p){await putRow('props',{id:p.id,from_slot:p.from,to_slot:p.to,st:p.st,e:await enc(p)});}
async function saveChat(x){await putRow('chat',{id:x.id,from_slot:x.from,to_slot:x.to,kind:x.kind,at:new Date(x.at).toISOString(),seen:!!x.seen,e:await enc({t:x.t,img:x.img})});}
async function saveVale(v){await putRow('vales',{id:v.id,slot:v.u,v:v.v,used:!!v.used});}

/* ---------- reconstruir el estado S desde la base de datos ---------- */
function applyDoc(T,slot,d){if(!d)return;T.q[slot]=d.q||{};T.sty[slot]=d.sty||{};T.qdone[slot]=!!d.qdone;T.lim[slot]=d.lim||[];T.limtxt[slot]=d.limtxt||'';T.fan[slot]=d.fan||[];T.sueno[slot]=d.sueno||'';T.kok[slot]=d.kok||{};T.read[slot]=d.read||0;}
function myDoc(){const u=ME.slot;return{q:S.q[u],sty:S.sty[u],qdone:S.qdone[u],lim:S.lim[u],limtxt:S.limtxt[u],fan:S.fan[u],sueno:S.sueno[u],kok:S.kok[u],read:S.read[u]};}
async function decRows(table,cols){const r=await sb.from(table).select(cols||'*');const out=[];for(const row of (r.data||[])){const o=await dec(row.e);out.push({row,o:o||{}});}return out;}

async function loadAll(){
 const NS=fresh();NS.me=ME.slot;
 const mem=await sb.from('members').select('slot,name,pts');
 (mem.data||[]).forEach(m=>{NS.names[m.slot]=m.name||NS.names[m.slot];NS.pts[m.slot]=m.pts||0;});
 // documentos (cuestionarios por persona + cajón compartido + salgo + match + check)
 const dr=await sb.from('docs').select('k,e');const docs={};
 for(const r of (dr.data||[])){const o=await dec(r.e);if(o)docs[r.k]=o;}
 applyDoc(NS,'a',docs['a.quiz']);applyDoc(NS,'b',docs['b.quiz']);
 if(docs['shared.cajon']){const c=docs['shared.cajon'];NS.items=c.items||[];NS.custom=c.custom||[];NS.word=c.word||NS.word;NS.temp=c.temp||0;NS.tempAt=c.tempAt||0;NS.logros=c.logros||[];}
 if(docs['shared.salgo'])NS.salgo=docs['shared.salgo'];
 if(docs['shared.match']&&docs['shared.match'].idea)NS.match=docs['shared.match'];
 // ganas propias (las del otro no se pueden ver: así debe ser)
 const g=await sb.from('ganas').select('until').eq('user_id',ME.uid).maybeSingle();
 if(g.data&&new Date(g.data.until).getTime()>Date.now())NS.ganas[ME.slot]=new Date(g.data.until).getTime();
 // propuestas
 for(const x of await decRows('props')){const o=x.o;NS.props.push(Object.assign({},o,{id:x.row.id,from:x.row.from_slot,to:x.row.to_slot,st:x.row.st}));}
 NS.props.sort((a,b)=>(b.ts||0)-(a.ts||0));
 // chat
 for(const x of await decRows('chat')){const o=x.o;NS.chat.push({id:x.row.id,from:x.row.from_slot,to:x.row.to_slot,kind:x.row.kind,at:new Date(x.row.at).getTime(),seen:x.row.seen,t:o.t,img:o.img});}
 NS.chat.sort((a,b)=>a.at-b.at);
 // vales
 for(const x of await decRows('vales')){NS.vales.push({id:x.row.id,u:x.row.slot,v:x.row.v,used:x.row.used});}
 // feed (solo el mío)
 for(const x of await decRows('feed')){NS.feed.push({u:ME.slot,t:x.o.t,ts:x.o.ts||0});}
 NS.feed.sort((a,b)=>b.ts-a.ts);if(NS.feed.length>80)NS.feed.length=80;
 S=NS;
}

/* ---------- guardar (sincroniza mi cuestionario + el cajón) ---------- */
let _sv=null;
function save(){clearTimeout(_sv);_sv=setTimeout(flush,350);}
async function flush(){if(!BOOTED||!ME.slot)return;await putDoc(ME.slot+'.quiz',myDoc());await putDoc('shared.cajon',{items:S.items,custom:S.custom,word:S.word,temp:S.temp,tempAt:S.tempAt,logros:S.logros});}

/* ---------- puntos vía función segura ---------- */
function addPts(slot,delta){S.pts[slot]=Math.max(0,(S.pts[slot]||0)+delta);rpcPts(slot,delta);}

/* ---------- ganas: la coincidencia la decide el servidor ---------- */
async function setGanas(until,idea){
 const r=await sb.rpc('set_ganas',{p_until:new Date(until).toISOString(),p_match:await enc({ts:Date.now(),idea,seen:{a:false,b:false}})});
 return r.data===true;
}
const A={},IN={},SH={};

/* =================== CONTENIDO =================== */
const SECS=[
{k:'prelim',e:'💋',n:'Caricias y preliminares',items:[
 {id:'besos',n:'Besos largos, sin prisa'},
 {id:'masaje',n:'Masaje con aceite',d:['Darlo yo','Recibirlo yo']},
 {id:'desnudar',n:'Desnudar al otro despacio',d:['Desnudarte yo','Que me desnudes']},
 {id:'ducha',n:'Ducha o baño juntos'},
 {id:'susurros',n:'Decir al oído lo que me apetece',d:['Decirlo yo','Que me lo digas']},
 {id:'strip',n:'Striptease',d:['Hacerlo yo','Verlo']},
 {id:'frio',n:'Frío y calor en la piel (hielo, aliento)',d:['Hacerlo yo','Que me lo hagas']},
 {id:'vendar',n:'Vendar los ojos',d:['Vendarte yo','Que me vendes']}]},
{k:'oral',e:'🍒',n:'Sexo oral',items:[
 {id:'oral',n:'Sexo oral',d:['Darlo yo','Recibirlo yo']},
 {id:'oral69',n:'A la vez (69)'}]},
{k:'post',e:'🔄',n:'Posturas',items:[
 {id:'encima',n:'Estar encima',d:['Yo encima','Tú encima']},
 {id:'detras',n:'Desde detrás'},
 {id:'cucharita',n:'Cucharita'},
 {id:'depie',n:'De pie'},
 {id:'sentados',n:'Sentados, frente a frente'},
 {id:'borde',n:'En el borde de la cama o de la mesa'},
 {id:'nuevas',n:'Probar posturas nuevas'}]},
{k:'lug',e:'📍',n:'Lugares',items:[
 {id:'sofa',n:'Sofá'},
 {id:'cocina',n:'Cocina o mesa'},
 {id:'espejo',n:'Delante de un espejo'},
 {id:'luz',n:'Con la luz encendida'},
 {id:'hotel',n:'Hotel improvisado'},
 {id:'coche',n:'Coche, en un sitio escondido'},
 {id:'banyo',n:'Baño de un restaurante o bar, con pestillo'},
 {id:'aire',n:'Al aire libre, en un rincón escondido'},
 {id:'provocar',n:'Provocar en público sin que nadie note nada'}]},
{k:'ropa',e:'👙',n:'Ropa',items:[
 {id:'lenceria',n:'Lencería',d:['Llevarla yo','Vértela a ti']},
 {id:'sinropa',n:'Sin ropa interior fuera de casa',d:['Ir yo así','Que vayas tú así']},
 {id:'disfraz',n:'Disfraces',d:['Ponérmelo yo','Vértelo a ti']},
 {id:'tacones',n:'Tacones o medias',d:['Llevarlos yo','Vértelos a ti']},
 {id:'elegir',n:'Elegir la ropa del otro',d:['Elegir yo la tuya','Que elijas tú la mía']}]},
{k:'jug',e:'🧸',n:'Juguetes',items:[
 {id:'vibrador',n:'Vibrador',d:['Usarlo yo contigo','Que lo uses conmigo']},
 {id:'plumas',n:'Plumas y cosquillas'},
 {id:'columpio',n:'Columpio sexual'},
 {id:'comprar',n:'Comprar juguetes juntos'}]},
{k:'atad',e:'🪢',n:'Ataduras',items:[
 {id:'atar',n:'Atar las manos (esposas, cuerdas)',d:['Atarte yo','Que me ates']},
 {id:'atarcama',n:'Atar a la cama (manos y pies)',d:['Atarte yo','Que me ates']}]},
{k:'rol',e:'🎭',n:'Rol y fantasía',items:[
 {id:'desconocidos',n:'Desconocidos que se conocen en un bar'},
 {id:'masajista',n:'Masajista y cliente'},
 {id:'jefe',n:'Jefe/a y nuevo/a empleado/a'},
 {id:'medico',n:'Médico/a y paciente'},
 {id:'policia',n:'Policía y detenido/a (con esposas)'},
 {id:'fotos',n:'Sesión de fotos íntima',d:['Hacer yo las fotos','Que me las hagas']}]},
{k:'rem',e:'📱',n:'A distancia',items:[
 {id:'insinuar',n:'Que me lo insinúen durante el día, sin decirlo claro',d:['Insinuarlo yo','Que me lo insinúes']},
 {id:'mensajes',n:'Mensajes picantes'},
 {id:'fotosug',n:'Fotos sugerentes',d:['Mandarlas yo','Recibirlas']},
 {id:'fotomas',n:'Fotos más subidas (sin cara)',d:['Mandarlas yo','Recibirlas']},
 {id:'audios',n:'Audios con lo que te haría',d:['Mandarlos yo','Recibirlos']},
 {id:'llamada',n:'Llamada caliente'},
 {id:'debajo',n:'Algo especial debajo de la ropa en el trabajo',d:['Llevarlo yo','Saber que lo llevas']}]},
{k:'citas',e:'🍷',n:'Citas',items:[
 {id:'romantica',n:'Cita romántica (cena, velas, sin prisa)'},
 {id:'rapidito',n:'Rapidito improvisado'},
 {id:'nochelarga',n:'Noche larga y apasionada'},
 {id:'fuera',n:'Cita provocativa fuera de casa'},
 {id:'sorpresa',n:'Cita sorpresa',d:['Organizarla yo','Que me la organices']}]},
{k:'mas',e:'🌶️',n:'Más fuerte',items:[
 {id:'anal',n:'Sexo anal'},
 {id:'consolador',n:'Consolador o dildo'},
 {id:'azotes',n:'Azotes y nalgadas'},
 {id:'dominacion',n:'Uno manda y el otro obedece'},
 {id:'control',n:'Controlar el orgasmo (hacer esperar)'},
 {id:'mordiscos',n:'Mordiscos'},
 {id:'masturbarse',n:'Masturbarse delante del otro'},
 {id:'comida',n:'Juegos con comida'},
 {id:'explicitas',n:'Fotos o vídeos explícitos (solo para vosotros)'}]}
];
const STYLE=[
 {id:'enciende',n:'¿Qué te enciende más?',multi:2,o:['Que me lo insinúen','Palabras','Miradas','Caricias','Sorpresas','Sentirme deseado/a','Ir despacio']},
 {id:'ganas',n:'Tus ganas suelen…',o:['Estar casi siempre','Ir a rachas','Aparecer cuando me encienden']},
 {id:'pedir',n:'¿Cómo te gusta que te lo pidan?',o:['Directo','Insinuado, sin decirlo claro','Por mensaje','Con una nota escondida']},
 {id:'inicia',n:'¿Quién empieza?',o:['Me gusta empezar a mí','Que empiece el otro','A medias']},
 {id:'ritmo',n:'Ritmo',o:['Lento y largo','Intenso','Depende del día']},
 {id:'momento',n:'Tu momento',o:['Mañana','Tarde','Noche','Cuando surja']}];
const LIMS=['Nada de fotos con cara','Nada fuera de casa','Nada de sitios con gente cerca','Nada en el trabajo','Siempre con palabra de seguridad'];
const LIMRULE={'Nada fuera de casa':['provocar','fuera','hotel','coche','banyo','aire','sinropa'],'Nada de sitios con gente cerca':['banyo','aire','provocar'],'Nada en el trabajo':['debajo','fotomas']};
const CATS=[
 {k:'pista',e:'🤫',n:'Insinuar',s:'Pistas a lo largo del día'},
 {k:'rem',e:'📱',n:'A distancia',s:'Calentar antes de llegar'},
 {k:'noche',e:'🌙',n:'Esta noche',s:'Caricias, oral, posturas'},
 {k:'atad',e:'🪢',n:'Ataduras',s:'Esposas y cuerdas'},
 {k:'rol',e:'🎭',n:'Rol',s:'Ser otros por una noche'},
 {k:'obj',e:'👙',n:'Ropa y juguetes',s:'Lo que hay en el cajón'},
 {k:'fuera',e:'🌿',n:'Fuera de casa',s:'Sitios escondidos'},
 {k:'cita',e:'🍷',n:'Cita',s:'Un plan completo'},
 {k:'azar',e:'🎲',n:'Sorpresa',s:'Que elija la app'},
 {k:'mia',e:'✍️',n:'Escribir la mía',s:'O pegar muchas'}];
const LV=[null,{n:'Tierno',e:'🙂'},{n:'Coqueto',e:'😏'},{n:'Caliente',e:'🔥'},{n:'Muy caliente',e:'🔥🔥'},{n:'Sin filtro',e:'😈'}];
const TIPO={toy:[['vibrador','💜','Vibrador'],['esposas','⛓️','Esposas'],['cuerdas','🪢','Cuerdas'],['venda','🙈','Venda'],['plumas','🪶','Plumas'],['aceite','💧','Aceite'],['columpio','🎠','Columpio'],['otro','🎁','Otro']],
 ropa:[['lenceria','👙','Lencería'],['disfraz','🎭','Disfraz'],['tacones','👠','Tacones o medias'],['bata','🥻','Bata o kimono'],['otro','✨','Otra']]};
const GEN={vibrador:'un vibrador',esposas:'unas esposas',cuerdas:'unas cuerdas',venda:'una venda',plumas:'unas plumas',aceite:'aceite',columpio:'el columpio',lenceria:'lencería',disfraz:'un disfraz',tacones:'tacones o medias',bata:'una bata',otro:'algo del cajón'};

/* Retos: [tipo, nivel, texto, requisitos, 'g' = foto, duración en segundos ("180+180" = dos partes)].
   {A} = quien propone o tiene el turno · {B} = el otro. "x>" lo hace {A}; "x<" lo hace {B} */
const RAW=[
['pista',1,'Llevo toda la mañana pensando en algo que te quiero hacer. Tú sigue trabajando.','insinuar>'],
['pista',1,'Esta noche cancela el sueño. Lo vas a necesitar despierto.','insinuar>'],
['pista',1,'Tengo un plan para ti. No preguntes, solo llega con ganas.','insinuar>'],
['pista',2,'Adivina de qué color es lo que llevo debajo. Pista: te va a durar poco puesto.','insinuar>'],
['pista',2,'He dejado algo en tu lado de la cama. Ni se te ocurra tocarlo hasta que yo llegue.','insinuar>'],
['pista',2,'Cada vez que mires el móvil hoy, piensa en mi boca. De nada.','insinuar>'],
['pista',2,'Pon esta canción de camino a casa. Ya entenderás por qué cuando llegues.','insinuar>'],
['pista',3,'Esta noche no hay pijama, no hay prisa y no mandas tú.','insinuar>'],
['pista',3,'Llevo todo el día imaginando lo primero que te voy a hacer al cruzar la puerta. Y no es hablar.','insinuar>'],
['pista',3,'Cuando llegues, ni una palabra. Solo haz lo que yo te diga.','insinuar>'],
['pista',3,'Te mando una foto de una pista y nada más. El resto, en persona.','insinuar>','g'],
['pista',4,'Ya elegí lo que me pongo para ti esta noche. Y lo que no me pongo debajo.','insinuar>'],
['pista',4,'He sacado algo del cajón y lo he dejado a la vista. Ve pensando.','insinuar>'],
['pista',4,'Esta noche hay reloj, hay reglas y las pongo yo.','insinuar>'],
['pista',5,'Te espero sin nada puesto. Avisa cuando estés en el portal, ni antes ni después.','insinuar>'],
['pista',5,'Esta noche decido yo de principio a fin. Tú solo obedece y disfruta.','insinuar>'],
['pista',5,'En cuanto cierres la puerta eres mío. Ya sabes dónde encontrarme.','insinuar>'],
['rem',1,'{B}, mándale a {A} lo primero que le vas a hacer al veros. Lo primero que te salga.','mensajes'],
['rem',1,'{B}, dile a {A} tres cosas de su cuerpo que te están distrayendo ahora mismo.','mensajes'],
['rem',1,'{B}, mándale a {A} la canción que te pone en modo nosotros dos.',''],
['rem',2,'{B}, foto de tus labios para {A}. Que se note en qué estás pensando.','fotosug<','g'],
['rem',2,'{B}, cuéntale a {A} qué llevas debajo ahora mismo. Solo texto, sin foto, que sufra un poco.','mensajes'],
['rem',2,'{A} llama a {B} dos minutos. {B} solo puede decir al oído lo que le apetece. Si se corta o se ríe, vuelta a empezar.','llamada','','120'],
['rem',3,'{B}, al baño, y mándale a {A} una foto de lo que llevas debajo. Sin cara. Diez minutos, ni uno más.','fotomas<','g','600'],
['rem',3,'{B}, audio de diez segundos para {A}: cómo le vas a recibir esta noche. Bajito, como si alguien pudiera oírte.','audios<'],
['rem',3,'{B}, hoy llevas {R:lenceria} debajo. A media tarde, una pista a {A}. Solo una, y que se muera de intriga.','debajo<','g'],
['rem',3,'A las seis, {A} le escribe a {B} con detalle lo que tiene pensado para esta noche. {B} solo contesta con emojis.','mensajes'],
['rem',3,'{A} manda una foto subida de tono. {B} tiene cinco minutos para devolver otra mejor. Reto directo.','fotosug> fotosug<','g','300'],
['rem',4,'{B}, mándale a {A} la foto que más vergüenza te daría mandar. Sin cara, se ve una vez y desaparece.','fotomas<','g'],
['rem',4,'{B}, audio de veinte segundos: qué le harías a {A} ahora mismo si lo tuvieras delante. Sin cortarte.','audios<'],
['rem',4,'{A} le cuenta a {B} por mensaje, paso a paso, cómo empieza la noche. {B} no puede contestar hasta llegar a casa.','mensajes'],
['rem',5,'{B}, una foto sin filtro de las vuestras. Sin cara. De ver una vez y adiós.','fotomas<','g'],
['rem',5,'{A} llama a {B} cinco minutos. {B}, a solas y con los ojos cerrados, escucha todo lo que va a pasar esta noche. Prohibido colgar.','llamada','','300'],
['noche',1,'Diez minutos besándoos como si estuviera prohibido tocar nada más. Solo boca. El que baje la mano antes de tiempo, pierde y esta noche obedece.','besos','','600'],
['noche',1,'{B}, bocabajo. {A}, quince minutos de masaje con la música que elija {B}. Prohibido pasar de la cintura, de momento.','masaje>','','900'],
['noche',1,'Ducha juntos. {A} enjabona a {B} de arriba abajo, con calma. {B} no puede devolver el favor hasta que suene el reloj.','ducha','','300'],
['noche',2,'{A} desnuda a {B} prenda a prenda, una por minuto. Entre una y otra, solo vale besar lo que acaba de quedar al aire.','desnudar>','','300'],
['noche',2,'{B}, bocabajo. {A}, masaje con {T:aceite} desde los pies subiendo muy despacio. Diez minutos, y donde pare es cosa suya.','masaje>','','600'],
['noche',2,'{B}, al oído, dile a {A} sin vergüenza lo que más te apetece esta noche. {A} lo cumple sin preguntar.','susurros<'],
['noche',2,'Striptease: {A} baila una canción entera para {B}. {B} mira, se aguanta y no toca hasta el último segundo.','strip>','','210'],
['noche',2,'Cucharita y luz apagada. {A} detrás, manos sueltas por el cuerpo de {B} sin llegar a más. Puro calentón.','cucharita','','600'],
['noche',2,'{A} le venda los ojos a {B} con {T:venda}. Diez minutos en los que {B} solo siente, sin saber qué viene después.','vendar>','','600'],
['noche',3,'Hielo y aliento. {B}, ojos cerrados. {A} alterna un cubito y su boca por el cuello, la espalda y el interior de los muslos. Que no sepa qué toca cada vez.','frio>','','300'],
['noche',3,'{B}, bocarriba, agárrate al cabecero y no sueltes. {A}, cinco minutos solo con la boca, del cuello hacia abajo sin prisa. Si {B} se suelta, el reloj vuelve a cero.','oral>','','300'],
['noche',3,'{A}, bocarriba, manos al cabecero. {B}, cinco minutos solo con la boca y a tu ritmo. Si {A} se suelta, vuelta a empezar.','oral<','','300'],
['noche',3,'Postura que no hayáis probado nunca. La elige {B}, y {A} no puede cambiarla hasta que suene el reloj.','nuevas','','300'],
['noche',3,'{B} encima, llevando el mando. {A}, manos detrás de la cabeza, prohibido usarlas. {B} marca el ritmo.','encima<','','300'],
['noche',3,'Delante del espejo y con la luz dada. {A} detrás de {B}. Prohibido cerrar los ojos: miraos ahí todo el rato.','espejo luz','','300'],
['noche',3,'{A} venda a {B} y, con {T:plumas}, las manos y la boca, le hace adivinar qué le toca. Cada fallo, un minuto más de tortura.','vendar> plumas','','300'],
['noche',3,'{A} muerde suave a {B} por el cuello, los hombros y la cintura, marcando sin marcar. {B} solo puede aguantar.','mordiscos','','180'],
['noche',4,'69, a la vez, sin prisa y sin parar. El primero que no aguante, pierde y mañana paga prenda.','oral69'],
['noche',4,'Desde detrás y con el espejo delante. {A} no aparta la mirada de los ojos de {B} en el reflejo.','detras espejo','','300'],
['noche',4,'Cada uno elige su postura favorita: tres minutos la de {A}, tres la de {B}. Nadie cambia antes de tiempo.','nuevas','','180+180'],
['noche',4,'{B} en el borde de la cama, {A} de pie. Solo {B} decide cuándo se para. Si es que quiere.','borde','','300'],
['noche',4,'De pie contra la pared, sin llegar a la cama. {A} sujeta las muñecas de {B} por encima de la cabeza y no las suelta.','depie atar>','','300'],
['noche',4,'{A} lleva a {B} al borde con la boca o las manos y, justo antes, para. Tres veces. A la cuarta, lo que pida {B}.','control','','300'],
['noche',4,'Juego de mando: {A} da órdenes, {B} obedece sin rechistar diez minutos, dentro de vuestra lista. La palabra para todo es {P}.','dominacion','','600'],
['noche',5,'Esta noche no hay cama: sofá, cocina y ducha, por ese orden, cinco minutos en cada sitio. Sin vestirse por el camino.','sofa cocina ducha','','300+300+300'],
['noche',5,'Media hora de sí a todo: {B} pide lo que sea de vuestra lista y {A} cumple. Sin negociar.','','','1800'],
['noche',5,'{B} decide el ritmo, la postura y el final. {A} solo puede decir sí y {P}.',''],
['noche',5,'{A} manda de principio a fin. {B} obedece, aguanta y no termina hasta que {A} lo permita.','dominacion control','','900'],
['atad',2,'{A} sujeta las muñecas de {B} contra la cama mientras le besa por todas partes. Despacio. {B} no puede soltarse ni acelerar.','atar>','','180'],
['atad',2,'Hoy {A} se deja: {B} le sujeta las muñecas y le besa donde le dé la gana.','atar<','','180'],
['atad',3,'{A} ata las manos de {B} con {T:esposas}. Diez minutos, {A} pone el ritmo y {B} solo puede pedir más o decir {P}.','atar>','','600'],
['atad',3,'{B} ata a {A} con {T:esposas}. {A} se deja hacer, sin pedir nada, solo esperar lo que venga.','atar<','','600'],
['atad',3,'{A} ata a {B}, le venda los ojos y le pasa {T:vibrador} por donde menos se lo espera. Sin avisar.','atar> vibrador> vendar>','','300'],
['atad',4,'{B}, manos al cabecero con {T:cuerdas}. {A}, diez minutos para recorrerlo entero con manos y boca, a su ritmo. {B} solo dice más o {P}.','atarcama>','','600'],
['atad',4,'{B}, atado y con los ojos vendados con {T:venda}. {A}, diez minutos, y {B} nunca sabe qué viene. Dos palabras: más o {P}.','atarcama> vendar>','','600'],
['atad',4,'{B} ata a {A} al cabecero. {A} solo puede mirar lo que {B} decida enseñarle, sin tocar.','atarcama<','','600'],
['atad',4,'{A} ata a {B} y le da unos azotes suaves con la mano abierta, subiendo poco a poco. {B} cuenta en alto. La palabra es {P}.','atar> azotes','','300'],
['atad',5,'Manos y pies de {B} atados a la cama. Lo demás lo decide {A}, dentro de vuestra lista, hasta que suene el reloj.','atarcama>','','900'],
['atad',5,'{A} se deja atar de pies y manos. {B} tiene quince minutos y toda vuestra lista para hacer lo que quiera con él.','atarcama<','','900'],
['rol',2,'Desconocidos en un bar. {B} llega primero y se sienta. {A} entra diez minutos después y tiene que ligárselo desde cero. Nombres falsos, miradas de más.','desconocidos'],
['rol',2,'Masajista y cliente. {B} pide el masaje, {A} decide hasta dónde llega y cómo se cobra. Sin salir del personaje.','masajista','','900'],
['rol',3,'Jefe y nuevo empleado. {A} cita a {B} en su despacho nada más llegar a casa. {B} quiere el puesto y hará lo que haga falta.','jefe'],
['rol',3,'Sesión de fotos. {A} dispara, {B} posa y obedece cada indicación. Las fotos no salen de la app.','fotos>','g','600'],
['rol',4,'Policía y detenido. {A} cachea a {B} contra la pared, con calma y con detalle, y le pone {T:esposas}. El interrogatorio sigue en la cama.','policia atar>','','600'],
['rol',4,'Médico y paciente. {B} viene a revisión. {A} explora sin prisa y dice en voz alta todo lo que encuentra. {B} no se mueve.','medico','','600'],
['rol',4,'{B} abre la puerta con {R:disfraz} puesto. Ni una palabra fuera del personaje hasta que {A} diga corten.','disfraz<'],
['rol',5,'Desconocidos en un hotel. Llegáis por separado. {A} deja la llave en la barra y se va. Si {B} sube, no hay nombres ni reglas.','desconocidos hotel'],
['rol',5,'{A} manda, {B} sirve. Diez minutos de sumisión dentro de vuestra lista: {B} solo responde sí señor o sí señora. La palabra es {P}.','dominacion','','600'],
['obj',1,'{B} elige lo que lleva {A} debajo de la ropa mañana. Y {A} lo lleva todo el día pensando en por qué.','elegir<'],
['obj',2,'{B}, esta noche {R:lenceria}. Y a {A} no le dices nada hasta que te vea. Que le dé el vuelco.','lenceria<'],
['obj',2,'{A} espera a {B} con {R:lenceria} puesta. {B} entra, se sienta y mira. Cinco minutos sin tocar, aguantando.','lenceria>','','300'],
['obj',2,'Esta semana compráis un juguete nuevo. Lo elige {B} y lo estrena {A} esta misma noche.','comprar'],
['obj',3,'{B}: {R:tacones} y nada más. {A} no puede tocar durante toda una canción. Solo mirar y aguantarse.','tacones<','','210'],
['obj',3,'{A} usa {T:vibrador} con {B}. {B} no puede moverse: si se mueve, {A} para diez segundos y vuelta a empezar.','vibrador>','','300'],
['obj',3,'{B} elige un juguete del cajón y lo usa con {A}. {A}, manos quietas en la almohada, prohibido tocar.','vibrador<','','300'],
['obj',3,'{A} le da a {B} unos azotes suaves con la mano mientras le habla al oído. {B} cuenta en alto. La palabra es {P}.','azotes','','180'],
['obj',4,'{B}, cena sin nada debajo. Se lo sueltas a {A} al oído en el primer plato, no antes. Y que aguante hasta el postre.','sinropa<'],
['obj',4,'{A} juega con {T:vibrador} llevando a {B} al borde una y otra vez, parando justo antes. {B} no termina hasta que {A} diga.','vibrador> control','','300'],
['obj',5,'{T:columpio}: {B} dentro, {A} al mando. Diez minutos y manda quien tiene los pies en el suelo.','columpio','','600'],
['obj',5,'{A} elige ropa, juguete, postura y final para {B}. {B} solo puede decir sí.',''],
['fuera',2,'En el bar, {A} mira a {B} desde la barra como si no se conocieran. {B} tiene diez minutos para acercarse y seguirle el juego.','provocar','','600'],
['fuera',2,'Cena fuera. La mano de {A} en la rodilla de {B} todo el segundo plato, subiendo poco a poco. Que nadie lo note.','provocar'],
['fuera',3,'Cena fuera. {B} lleva {R:lenceria} debajo y solo se lo deja intuir a {A} con una pista: un tirante, un borde. Nada más.','fuera lenceria<'],
['fuera',4,'Cena fuera. {B} va sin nada debajo y se lo dice a {A} al oído en el primer plato. {A} no puede tocar hasta el postre, y se va a hacer largo.','fuera sinropa<'],
['fuera',4,'Cena fuera. {B}, a mitad del segundo plato te levantas al baño y le escribes a {A}: Te espero. {A} cuenta hasta sesenta y va. Pestillo, cinco minutos, y de vuelta como si nada.','banyo','','300'],
['fuera',4,'De vuelta a casa, aparca en un sitio escondido y a oscuras. Motor apagado, cinco minutos, y lo que surja.','coche','','300'],
['fuera',5,'Escapada al campo con una manta. Buscáis un rincón donde de verdad no llegue nadie, y el sitio lo elige {A}.','aire'],
['fuera',5,'Baño del restaurante. {A} entra primero. {B} va cuando reciba un mensaje con una sola palabra: Ya.','banyo','','300'],
['cita',1,'Cena con velas en casa y móviles lejos. {A} cocina, {B} pone música y postre. Lo de después no viene en el menú.','romantica'],
['cita',2,'Cita sorpresa, la monta {A}. {B} solo sabe la hora y qué ponerse. El resto, a ciegas.','sorpresa>'],
['cita',3,'Rapidito antes de salir de casa. Diez minutos, sin desvestirse del todo, con el reloj en contra.','rapidito','','600'],
['cita',4,'Hotel esta noche. {A} hace la maleta y {B} no puede ver qué mete. Sorpresa al llegar.','hotel'],
['cita',5,'Noche larga: cena, hotel y nadie mira el reloj. {B} decide cuándo se acaba, si es que se acaba.','nochelarga hotel']
];
const CARDS=RAW.map((x,i)=>({id:'c'+i,c:x[0],l:x[1],t:x[2],r:x[3]?x[3].split(' '):[],g:x[4]==='g',d:x[5]?String(x[5]).split('+').map(Number):null}));
const CAST=[
 ['k1',1,'Masaje de quince minutos para el otro, donde él diga.',900],
 ['k2',1,'Mañana, desayuno en la cama. Y lo sirves con poca ropa.'],
 ['k3',1,'Esta semana manda el otro con la peli. Y con lo que pase en el sofá.'],
 ['k4',2,'El otro elige tu ropa interior de mañana. Te aguantas.'],
 ['k5',2,'Le bailas una canción entera, mirándole a los ojos.',210],
 ['k6',2,'Le escribes tres cosas que te mueres por hacerle esta noche.'],
 ['k7',2,'Mañana cocinas con delantal y poco más debajo.'],
 ['k8',3,'En la próxima cena fuera vas sin nada debajo, y él lo sabe.'],
 ['k9',3,'Diez minutos con los ojos vendados, a merced del otro, dentro de vuestra lista.',600],
 ['k10',3,'Le mandas la foto que él te pida mañana. Sin cara, sin excusas.'],
 ['k11',4,'Manos atadas diez minutos. Solo puedes mirar y aguantar.',600],
 ['k12',4,'Media hora de sí a todo, dentro de vuestra lista. Manda él.',1800]];
const VALES=[['v1',100,'💆','Masaje de 30 minutos'],['v2',120,'🥐','Desayuno en la cama'],['v3',150,'🛋️','Tú eliges la peli… y lo que pasa en el sofá'],['v4',200,'👑','Una noche decides tú (dentro de vuestra lista)'],['v5',250,'🎁','Cita sorpresa organizada por el otro'],['v6',300,'✨','Cumplir una fantasía de vuestra lista'],['v7',400,'🏨','Noche de hotel']];
const CITAS=[
 {k:'romantica',e:'🕯️',n:'Romántica',r:['romantica']},
 {k:'rapidito',e:'⚡',n:'Rapidito',r:['rapidito']},
 {k:'nochelarga',e:'🔥',n:'Noche larga',r:['nochelarga']},
 {k:'rol',e:'🎭',n:'De rol',any:['desconocidos','masajista','jefe','medico','policia']},
 {k:'atad',e:'🪢',n:'Con ataduras',any:['atar>','atar<','atarcama>','atarcama<']},
 {k:'fuera',e:'🌿',n:'Provocativa fuera',r:['fuera']}];
const ROLN={desconocidos:'Desconocidos en un bar',masajista:'Masajista y cliente',jefe:'Jefe/a y nuevo/a empleado/a',medico:'Médico/a y paciente',policia:'Policía y detenido/a'};
const QK=[];SECS.forEach(s=>s.items.forEach(it=>{if(it.d)QK.push(it.id+'_d',it.id+'_r');else QK.push(it.id);}));
const QSTEPS=['style'].concat(SECS.map((s,i)=>'sec:'+i),['lim','fan','cast']);
const OCULTO='🤫 Solo donde nadie pueda veros. Nunca donde pueda haber niños';

/* =================== ESTADO =================== */
function fresh(){return{v:2,names:{a:'José Miguel',b:'Esther'},me:'a',word:'Rojo',
 q:{a:{},b:{}},sty:{a:{},b:{}},qdone:{a:false,b:false},lim:{a:[],b:[]},limtxt:{a:'',b:''},fan:{a:[],b:[]},sueno:{a:'',b:''},kok:{a:{},b:{}},
 items:[],props:[],chat:[],read:{a:0,b:0},feed:[],pts:{a:0,b:0},ganas:{a:0,b:0},match:null,vales:[],custom:[],salgo:null,temp:0,tempAt:0,logros:[]};}
let S=fresh();
const ui={tab:'home',cat:'pista',lvl:3,sug:[],sugKey:'',citaT:null,plan:null,quiz:null,sheet:null,form:null,mine:{c:'noche',l:3,t:'',bulk:'',d:0},timer:null,pistas:null,pistasKey:'',deck:null,pset:null,viewImg:null,salgoMin:30,salgoPick:-1,salgoOps:[],alts:[]};
let pinBuf='';

/* =================== AYUDAS =================== */
const $=s=>document.querySelector(s);
const esc=s=>String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const ot=u=>u==='a'?'b':'a';
const nm=u=>S.names[u]||'';
const now=()=>Date.now();
const uid=()=>Math.random().toString(36).slice(2,9);
const rnd=a=>a[Math.floor(Math.random()*a.length)];
const shuf=a=>{a=a.slice();for(let i=a.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[a[i],a[j]]=[a[j],a[i]];}return a;};
const hhmm=t=>new Date(t).toLocaleTimeString('es-ES',{hour:'2-digit',minute:'2-digit'});
function toast(t){const el=$('#toast');el.textContent=t;el.classList.add('on');clearTimeout(toast._t);toast._t=setTimeout(()=>el.classList.remove('on'),2800);}
function feed(u,t){if(u===ME.slot){S.feed.unshift({u,t,ts:now()});if(S.feed.length>80)S.feed.length=80;}pushFeed(u,t);}
async function pushFeed(u,t){try{await putRow('feed',{id:uid(),to_slot:u,e:await enc({t,ts:Date.now()})});}catch(e){}}
function hsh(s){let h=5381;for(let i=0;i<s.length;i++)h=((h<<5)+h+s.charCodeAt(i))|0;return 'h'+(h>>>0).toString(36);}

const fmt=s=>{s=Math.max(0,Math.ceil(s));return String(Math.floor(s/60)).padStart(2,'0')+':'+String(s%60).padStart(2,'0');};
function durLabel(d){if(!d||!d.length)return '';if(d.length>1)return d.every(x=>x%60===0)?d.map(x=>x/60).join(' + ')+' min':d.map(x=>fmt(x)).join(' + ');return d[0]%60===0?d[0]/60+' min':fmt(d[0]);}
const names=t=>t.replace(/\{A\}/g,nm(S.me)).replace(/\{B\}/g,nm(S.me==='a'?'b':'a'));

/* =================== MATCH Y FILTROS =================== */
function val(u,id){const v=S.q[u][id];return typeof v==='number'?v:-1;}
function okReq(r,s,t){const e=r.slice(-1);if(e==='>'){const id=r.slice(0,-1);return val(s,id+'_d')>=1&&val(t,id+'_r')>=1;}if(e==='<'){const id=r.slice(0,-1);return val(t,id+'_d')>=1&&val(s,id+'_r')>=1;}return val(s,r)>=1&&val(t,r)>=1;}
function str(r,s,t){const e=r.slice(-1);if(e==='>'){const id=r.slice(0,-1);return Math.min(val(s,id+'_d'),val(t,id+'_r'));}if(e==='<'){const id=r.slice(0,-1);return Math.min(val(t,id+'_d'),val(s,id+'_r'));}return Math.min(val(s,r),val(t,r));}
const both=()=>S.qdone.a&&S.qdone.b;
const m=(r,s,t)=>!both()||okReq(r,s,t);
function blocked(c){const L=S.lim.a.concat(S.lim.b);const ids=c.r.map(x=>x.replace(/[<>]/g,''));return L.some(l=>(LIMRULE[l]||[]).some(b=>ids.includes(b)));}
const hasK=k=>S.items.some(i=>i.k===k);
const hasT=(k,t)=>S.items.some(i=>i.k===k&&i.t===t);
function catOK(c){const re=/\{([TR]):(\w+)\}/g;let x;while((x=re.exec(c.t))){const k=x[1]==='T'?'toy':'ropa';if(hasK(k)&&!hasT(k,x[2]))return false;}return true;}
function eligible(cat,l,s,t){
 const base=CARDS.filter(c=>(cat==='azar'?c.c!=='pista':c.c===cat)&&c.l===l&&catOK(c)&&!blocked(c)&&c.r.every(r=>m(r,s,t)));
 const cu=S.custom.filter(c=>(cat==='azar'||c.c===cat)&&c.l===l&&(!c.imp||impOK(c)));
 return base.concat(cu);}
function score(c,s,t){let sc=Math.random();if(both())sc+=c.r.reduce((a,r)=>a+(str(r,s,t)===2?1:0),0);if(/\{[TR]:/.test(c.t)&&(hasK('toy')||hasK('ropa')))sc+=1.5;return sc;}
function pickSug(cat,l,s,t,n){return eligible(cat,l,s,t).map(c=>({c,sc:score(c,s,t)})).sort((a,b)=>b.sc-a.sc).slice(0,n).map(x=>x.c);}
function tipoOf(k,t){return TIPO[k].find(x=>x[0]===t)||['otro','🎁','Otro'];}
function tips(c){const t=[];const ids=c.r.map(x=>x.replace(/[<>]/g,''));
 if(c.c==='atad'||ids.includes('atar')||ids.includes('atarcama')){t.push('🚦 Semáforo activo · palabra: '+S.word);if(/esposas/.test(c.t)||ids.includes('policia'))t.push('🔑 La llave, siempre a la vista');if(/cuerdas/.test(c.t)||ids.includes('atarcama'))t.push('✂️ Tijera a mano. Nada alrededor del cuello');}
 if(ids.includes('columpio'))t.push('🔩 Revisad el anclaje y el peso máximo');
 if(ids.includes('vendar'))t.push('🙈 Preguntad cómo va cada poco');
 if(ids.some(i=>['banyo','aire','coche'].includes(i)))t.push(OCULTO);
 if(c.g)t.push('📸 Hazla desde el chat de la app: es de ver una vez y no va al carrete');
 return t;}
function resolve(c,s,t){const used=[];const txt=c.t.replace(/\{([TR]):(\w+)\}/g,(_,K,ty)=>{const k=K==='T'?'toy':'ropa';const its=S.items.filter(i=>i.k===k&&i.t===ty);const tp=tipoOf(k,ty);if(its.length){const it=rnd(its);used.push(it.id);return tp[1]+' '+it.n;}return tp[1]+' '+(GEN[ty]||ty);}).replace(/\{A\}/g,nm(s)).replace(/\{B\}/g,nm(t)).replace(/\{tu\}/g,nm(t)).replace(/\{yo\}/g,nm(s)).replace(/\{P\}/g,S.word);return{txt,used,tips:c.tips?c.tips.slice():tips(c),d:c.d?c.d.slice():null};}
function matches(){const out=[];SECS.forEach(sec=>sec.items.forEach(it=>{if(it.d){const ab=Math.min(val('a',it.id+'_d'),val('b',it.id+'_r'));if(ab>=1)out.push({sec,it,dir:'ab',s:ab});const ba=Math.min(val('b',it.id+'_d'),val('a',it.id+'_r'));if(ba>=1)out.push({sec,it,dir:'ba',s:ba});}else{const s=Math.min(val('a',it.id),val('b',it.id));if(s>=1)out.push({sec,it,s});}}));return out;}
function progress(u){const n=QK.filter(k=>typeof S.q[u][k]==='number').length;return Math.round(100*n/QK.length);}
function insinuaHint(o){if(!S.qdone[o])return false;const st=S.sty[o]||{};return (st.enciende||[]).includes('Que me lo insinúen')||(st.pedir||[]).includes('Insinuado, sin decirlo claro')||(st.ganas||[]).includes('Aparecer cuando me encienden');}

/* =================== ACCIONES BÁSICAS =================== */
function send(o){const s=S.me,t=ot(s);const p=Object.assign({id:uid(),from:s,to:t,st:'pend',ts:now(),used:[],tips:[]},o);S.props.unshift(p);addPts(s,5);feed(t,`✉️ ${nm(s)} te ha mandado algo ${LV[p.l].e}`);saveProp(p);notify();toast(`Enviado a ${nm(t)} · +5 por atreverte`);return p;}
function pushChat(o){const s=S.me,t=ot(s);const x=Object.assign({id:uid(),from:s,to:t,at:now()},o);S.chat.push(x);if(S.chat.length>400)S.chat.splice(0,S.chat.length-400);saveChat(x);if(x.at<=now())notify();}
function visibleChat(me){const n=now();return S.chat.filter(x=>(x.from===me||x.to===me)&&(x.from===me||x.at<=n)).sort((a,b)=>a.at-b.at);}
function unread(me){const n=now();return S.chat.filter(x=>x.to===me&&x.at<=n&&x.at>S.read[me]).length;}
function castigoPara(u){const ok=CAST.filter(k=>S.kok[u][k[0]]);return ok.length?rnd(ok):['k0',1,'Le debes un favor a elegir, dentro de vuestra lista.'];}
function until(k){const d=new Date();if(k==='1h')return now()+3600e3;if(k==='noche'){if(d.getHours()<2)d.setHours(2,0,0,0);else{d.setDate(d.getDate()+1);d.setHours(2,0,0,0);}return d.getTime();}const add=(7-d.getDay())%7;d.setDate(d.getDate()+add);d.setHours(23,59,0,0);return d.getTime();}

/* =================== PIEZAS DE INTERFAZ =================== */
function header(){return `<header><div class="logo">🔥 Llama</div><div class="hr"><span class="pill">⭐ ${S.pts[S.me]}</span><button data-a="lock" aria-label="Bloquear">🔒</button><button data-a="settings" aria-label="Ajustes">⚙️</button></div></header>`;}
/* demoBar eliminado en v2 (dos móviles reales) */
function nav(){const n=S.props.filter(p=>p.to===S.me&&p.st==='pend').length;const c=unread(S.me);const t=[['home','🔥','Inicio',n],['prop','✉️','Proponer',0],['chat','💬','Chat',c],['nos','💞','Nosotros',0],['cajon','🧰','Cajón',0]];return `<nav>${t.map(x=>`<button class="${ui.tab===x[0]?'on':''}" data-a="tab" data-v="${x[0]}"><span>${x[1]}</span>${x[2]}${x[3]?`<i class="dot">${x[3]}</i>`:''}</button>`).join('')}</nav>`;}
function lvRow(act,cur){return `<div class="lv">${[1,2,3,4,5].map(l=>`<button class="${cur===l?'on':''}" data-a="${act}" data-v="${l}"><span class="e">${LV[l].e}</span>${LV[l].n}</button>`).join('')}</div>`;}
function tri(id,cur){return `<div class="tri">${[[2,'Sí'],[1,'Quizá'],[0,'No']].map(([v,l])=>`<button class="t${v} ${cur===v?'on':''}" data-a="ans" data-v="${id}|${v}">${l}</button>`).join('')}</div>`;}
function thumbsOf(ids){const t=(ids||[]).map(id=>S.items.find(i=>i.id===id)).filter(i=>i&&i.ph).map(i=>`<img src="${esc(i.ph)}" alt="">`).join('');return t?`<div class="thumbs">${t}</div>`:'';}
function tipsHTML(arr){return arr&&arr.length?`<div class="tips">${arr.map(x=>`<span>${esc(x)}</span>`).join('')}</div>`:'';}
function catOf(k){return CATS.find(x=>x.k===k)||{e:'😈',n:'Castigo'};}
function cardHTML(p,ctx){const lv=LV[p.l]||LV[1];const cat=catOf(p.c);let act='';
 if(ctx==='in')act=`<div class="note">Si lo cumples: +${10*p.l}${p.l<5?` · si subes: +${10*(p.l+1)+10}`:''}</div><div class="row"><button class="btn p" data-a="r" data-v="${p.id}|si">✅ Sí</button>${p.l<5?`<button class="btn p" data-a="r" data-v="${p.id}|sube">🔥 Sí, y subo</button>`:''}</div><div class="row"><button class="btn" data-a="r" data-v="${p.id}|guarda">⏳ Ahora no, guárdamelo</button><button class="btn" data-a="r" data-v="${p.id}|contra">🔄 Eso no, pero esto sí</button></div><div class="row"><button class="btn s" data-a="r" data-v="${p.id}|no">Hoy no, gracias · no resta nada</button></div>`;
 else if(ctx==='run')act=`${p.d?`<div class="row"><button class="btn p" data-a="timerProp" data-v="${p.id}">⏱️ Empezar · ${durLabel(p.d)}</button></div>`:''}<div class="row"><button class="btn g" data-a="r" data-v="${p.id}|ok">✅ Hecho · +${10*p.l+(p.up?10:0)}</button><button class="btn" data-a="r" data-v="${p.id}|fail">😅 No lo cumplí</button></div>`;
 else if(ctx==='runS')act=`<div class="note">⏳ Esperando a que ${esc(nm(p.to))} lo cumpla</div>`;
 else if(ctx==='saved')act=`<div class="row"><button class="btn p" data-a="r" data-v="${p.id}|ahora">😉 Ahora sí</button><button class="btn" data-a="r" data-v="${p.id}|quita">Descartar</button></div>`;
 else if(ctx==='k')act=`${p.d?`<div class="row"><button class="btn p" data-a="timerProp" data-v="${p.id}">⏱️ Empezar · ${durLabel(p.d)}</button></div>`:''}<div class="row"><button class="btn g" data-a="r" data-v="${p.id}|kdone">✅ Castigo cumplido</button></div>`;
 const who=ctx==='in'?`${esc(nm(p.from))} te propone:`:ctx==='k'?`Te lo pone ${esc(nm(p.from))}:`:ctx==='runS'?`Le propusiste a ${esc(nm(p.to))}:`:ctx==='run'?`Aceptaste de ${esc(nm(p.from))}:`:'';
 return `<div class="card"><div class="top"><span>${cat.e} ${esc(cat.n)}</span><span>${p.d?'⏱️ '+durLabel(p.d)+' · ':''}${lv.e} ${lv.n}${p.up?' · subido':''}</span></div>${who?`<div class="who">${who}</div>`:''}<div class="txt">${esc(p.txt)}</div>${thumbsOf(p.used)}${tipsHTML(p.tips)}${act}</div>`;}

/* =================== VISTAS =================== */
function vIntro(){return `<div class="intro"><div class="e">🔥</div><h1>Llama</h1><p class="sub">Para decir lo que te apetece, aunque cueste decirlo.</p>
<div class="card">1 · Cada uno rellena su cuestionario a solas. Nadie ve los «no» del otro.</div>
<div class="card">2 · La app solo os propone lo que os gusta a los dos.</div>
<div class="card">3 · Pedid o insinuad sin miedo: decir que no es gratis.</div>
<div class="card">4 · Cumplid, sumad puntos y canjeadlos por vales.</div>
<div class="row"><button class="btn p" data-a="introOk">Empezar</button></div>
<p class="firma">${esc(FIRMA)}</p></div>`;}

function vPin(){return `<div class="lock"><div style="font-size:44px">🔥</div><div class="sub">Introduce tu PIN</div><div class="dots">${[0,1,2,3].map(i=>`<i class="${i<pinBuf.length?'on':''}"></i>`).join('')}</div><div class="pad">${['1','2','3','4','5','6','7','8','9','','0','x'].map(d=>d?`<button data-a="pk" data-v="${d}">${d==='x'?'⌫':d}</button>`:'<span></span>').join('')}</div></div>`;}

function vHome(){const me=S.me,o=ot(me),n=now();let h=`<h1>Hola, ${esc(nm(me))}</h1>`+tempHero();
 if(!S.qdone[me])h+=`<button class="big hot" data-a="quiz"><span class="e">📝</span><span><b>Tu cuestionario</b><small>Unos minutos. Solo tú ves tus respuestas.</small></span></button>`;
 if(S.match&&!S.match.seen[me])h+=`<div class="banner"><b>🔥 Coincidís: los dos tenéis ganas</b><div style="margin:6px 0 2px">Una idea para empezar: ${esc(S.match.idea)}</div><small>Ahora decidlo en voz alta 😉 · +20 puntos</small><div class="row"><button class="btn" style="background:#fff;color:#a0103d" data-a="matchOk">Vamos</button></div></div>`;
 if(S.salgo&&S.salgo.to===me&&S.salgo.at>n){const mins=Math.max(1,Math.round((S.salgo.at-n)/60000));h+=`<div class="banner blue"><b>🚗 ${esc(nm(S.salgo.from))} ya va de camino</b>Llega en unos ${mins} min (sobre las ${hhmm(S.salgo.at)})</div>`;}
 if(insinuaHint(o))h+=`<div class="hint">💡 A ${esc(nm(o))} le enciende más que se lo insinúen que pedírselo directo. Prueba con pistas a lo largo del día.<div class="row"><button class="btn p" data-a="goPista">🤫 Mandar pistas</button></div></div>`;
 const g=S.ganas[me]>n;
 h+=g?`<button class="big" data-a="ganasOff"><span class="e">😏</span><span><b>Tus ganas están puestas</b><small>Hasta las ${hhmm(S.ganas[me])}. Si ${esc(nm(o))} también, os aviso. Toca para quitarlas.</small></span></button>`
  :`<button class="big hot" data-a="sheet" data-v="ganas"><span class="e">😏</span><span><b>Tengo ganas</b><small>Solo se entera si también tiene ganas</small></span></button>`;
 h+=`<button class="big" data-a="tab" data-v="prop"><span class="e">✉️</span><span><b>Mandarle algo</b><small>Pedir o insinuar. +5 puntos por atreverte</small></span></button>`;
 h+=juegosGrid();
 h+=`<div class="row"><button class="btn" style="font-size:14.5px;padding:10px 4px" data-a="salgo">🚗 Salgo ya</button><button class="btn" style="font-size:14.5px;padding:10px 4px" data-a="sheet" data-v="shop">🎟️ Vales</button></div>`;
 const inb=S.props.filter(p=>p.to===me&&p.st==='pend');
 h+=`<h2>Te ha llegado${inb.length?` (${inb.length})`:''}</h2>`+(inb.length?inb.map(p=>cardHTML(p,'in')).join(''):`<div class="empty">Nada pendiente. ¿Le mandas algo? 😏</div>`);
 const run=S.props.filter(p=>p.st==='acc'&&!p.k&&(p.to===me||p.from===me));
 if(run.length)h+=`<h2>En marcha</h2>`+run.map(p=>cardHTML(p,p.to===me?'run':'runS')).join('');
 const ks=S.props.filter(p=>p.k&&p.st==='acc'&&p.to===me);
 if(ks.length)h+=`<h2>😈 Tus castigos</h2>`+ks.map(p=>cardHTML(p,'k')).join('');
 const sv=S.props.filter(p=>p.to===me&&p.st==='saved');
 if(sv.length)h+=`<h2>⏳ Guardado para luego</h2>`+sv.map(p=>cardHTML(p,'saved')).join('');
 const vs=S.vales.filter(v=>v.u===me&&!v.used);
 if(vs.length)h+=`<h2>🎟️ Tus vales</h2><div class="card">`+vs.map(x=>{const v=VALES.find(y=>y[0]===x.v);return `<div class="m"><span>${v[2]} ${esc(v[3])}</span><button class="btn p mini" data-a="useVale" data-v="${x.id}">Usar</button></div>`;}).join('')+`</div>`;
 const fd=S.feed.filter(f=>f.u===me).slice(0,6);
 if(fd.length)h+=`<h2>Lo último</h2><div class="feed">${fd.map(f=>`<div>${esc(f.t)} · <small>${hhmm(f.ts)}</small></div>`).join('')}</div>`;
 return h;}

function genSug(){const s=S.me,t=ot(s);ui.sug=pickSug(ui.cat,ui.lvl,s,t,3).map(c=>Object.assign({c},resolve(c,s,t)));ui.sugKey=ui.cat+ui.lvl+S.me;}
function genPistas(){const s=S.me,t=ot(s);const L=ui.lvl;const lv=[Math.max(1,L-2),Math.max(1,L-1),L];const used=new Set();const tm=['11:00','15:00','18:30'];
 return lv.map((l,i)=>{let cs=eligible('pista',l,s,t).filter(c=>!used.has(c.id));if(!cs.length)cs=eligible('pista',l,s,t);const c=cs.length?rnd(cs):null;if(c)used.add(c.id);return{tm:tm[i],l,txt:c?resolve(c,s,t).txt:''};});}
function citaOK(x,s,t){if(!both())return true;if(x.r)return x.r.every(r=>okReq(r,s,t));return x.any.some(r=>okReq(r,s,t));}
function makePlan(k,l){const s=S.me,t=ot(s);const mm=r=>m(r,s,t);const tp=CITAS.find(x=>x.k===k);
 const pick=(kind,types,fb)=>{const its=S.items.filter(i=>i.k===kind&&types.includes(i.t));if(its.length){const it=rnd(its);return tipoOf(kind,it.t)[1]+' '+it.n;}return fb;};
 let lugar,vest,jug,regla,extra='';const tp2=[];
 if(k==='romantica'){lugar=rnd(['Cena en casa con velas','Restaurante tranquilo y vuelta paseando','Picnic en el salón, con luz baja']);vest=rnd(['Algo que te quede bonito','Lo que llevabas en nuestra primera cita','Algo fácil de quitar']);jug=mm('masaje>')?pick('toy',['aceite'],'💧 Aceite para un masaje al final'):'Nada. Hoy no hace falta';regla=rnd(['Móviles fuera toda la noche','Prohibido hablar de trabajo','Un brindis por cada cosa que te gusta del otro']);}
 else if(k==='rapidito'){const ls=[['sofa','Sofá'],['cocina','Cocina'],['ducha','Ducha']].filter(x=>mm(x[0])).map(x=>x[1]);lugar=ls.length?rnd(ls):'Donde os pille';vest='Lo que llevéis puesto';jug=(mm('vibrador>')||mm('vibrador<'))?pick('toy',['vibrador'],'💜 El vibrador, si está a mano'):'Nada';regla=rnd(['Diez minutos. Ni uno más','Sin quitarse toda la ropa','Justo antes de salir de casa']);}
 else if(k==='nochelarga'){lugar=mm('hotel')?rnd(['Hotel','Casa, sin horario']):'Casa, sin horario';vest=pick('ropa',['lenceria','tacones','bata'],'Lo que más le guste al otro');jug=pick('toy',['vibrador','aceite','plumas','venda'],'Lo que haya en el cajón');regla='Nadie mira el reloj';}
 else if(k==='rol'){const rs=Object.keys(ROLN).filter(r=>mm(r));const r=rs.length?rnd(rs):'desconocidos';lugar=r==='desconocidos'?'Un bar, y luego casa':'Casa, como escenario';vest=pick('ropa',['disfraz'],'🎭 Lo que pida el personaje');jug=r==='policia'?pick('toy',['esposas'],'⛓️ Unas esposas'):'—';regla=`Papel: ${ROLN[r]}. Nadie sale del personaje hasta decir «${S.word}»`;if(r==='policia')tp2.push('🔑 La llave, siempre a la vista');}
 else if(k==='atad'){lugar='Dormitorio, con luz baja';vest=pick('ropa',['lenceria','bata'],'Lo mínimo');jug=pick('toy',['esposas','cuerdas'],'⛓️ Unas esposas o un pañuelo');regla='Antes de empezar, cada uno dice tres cosas que no';tp2.push('🚦 Semáforo activo · palabra: '+S.word);if(/esposas|pañuelo/i.test(jug))tp2.push('🔑 La llave, siempre a la vista');if(/cuerda/i.test(jug))tp2.push('✂️ Tijera a mano. Nada alrededor del cuello');}
 else{lugar=rnd(['Restaurante','Bar de cócteles','Cine','Terraza'])+' y vuelta a casa';const vs=[];if(mm('sinropa<'))vs.push('Nada debajo. Solo lo sabemos los dos');if(mm('lenceria<'))vs.push(pick('ropa',['lenceria'],'👙 Lencería debajo'));vest=vs.length?rnd(vs):'Algo que provoque sin enseñar';jug='—';regla=rnd(['Por debajo de la mesa, que solo lo sepamos los dos','Un mensaje al oído en cada plato','Lo explícito, solo donde nadie pueda veros']);
  if(l>=4){const hx=[['banyo','El baño, con pestillo, a mitad de la cena'],['coche','El coche, en un sitio escondido, de vuelta'],['aire','Un rincón escondido de camino a casa']].filter(x=>mm(x[0]));if(hx.length){extra=rnd(hx)[1];tp2.push(OCULTO);}}}
 if(!extra&&l>=4){const ex=[['nuevas','Al llegar, una postura nueva'],['ducha','Ducha juntos al volver'],['vendar>','Venda en los ojos nada más entrar'],['espejo','Delante del espejo'],['oral>','Empiezo yo con sexo oral nada más llegar']].filter(x=>mm(x[0]));if(ex.length)extra=rnd(ex)[1];}
 const txt=`${tp.e} Cita ${tp.n.toLowerCase()}\n📍 ${lugar}\n👗 ${vest}\n🧸 ${jug}\n🎯 ${regla}`+(extra?`\n🔥 Extra: ${extra}`:'');
 return{k,l,txt,tips:tp2};}

function vProp(){const s=S.me,t=ot(s);let h=`<h1>Mandarle algo</h1><p class="sub">Elige qué te apetece. Si dice que no, no pasa nada.</p>`;
 if(!both())h+=`<div class="hint">Aún sin filtrar. Cuando los dos terminéis el cuestionario, aquí solo saldrá lo que os gusta a los dos.</div>`;
 h+=`<div class="grid2">${CATS.map(c=>`<button class="tile ${ui.cat===c.k?'on':''}" data-a="cat" data-v="${c.k}"><span class="e">${c.e}</span><b>${c.n}</b><small>${c.s}</small></button>`).join('')}</div>`;
 if(ui.cat!=='mia')h+=`<h2>${ui.cat==='pista'?'¿Hasta dónde quieres llegar al final del día?':'¿Cómo de caliente?'}</h2>`+lvRow('lvl',ui.lvl);
 if(ui.cat==='pista'&&![1,2,3,4,5].some(l=>eligible('pista',l,s,t).length))h+=`<div class="empty">Las pistas no encajan con lo que habéis marcado en el cuestionario. Prueba con otra categoría o escribe la tuya.</div>`;
 else if(ui.cat==='pista'){if(!ui.pistas||ui.pistasKey!==ui.lvl+S.me){ui.pistas=genPistas();ui.pistasKey=ui.lvl+S.me;}
  h+=`<h2>Tres pistas para hoy</h2><p class="sub">Van subiendo de tono. ${esc(nm(t))} no tiene que contestar: solo es para encender. Le llegan al chat a su hora.</p>`+
  ui.pistas.map((p,i)=>`<div class="card"><div class="top"><span>🤫 Pista ${i+1} · ${LV[p.l].e} ${LV[p.l].n}</span><input type="time" value="${esc(p.tm)}" data-in="ptm" data-i="${i}" style="width:auto;padding:6px 10px"></div><textarea data-in="ptx" data-i="${i}" style="min-height:72px">${esc(p.txt)}</textarea><div class="row"><button class="btn mini" data-a="pRe" data-v="${i}">↻ Otra</button><button class="btn mini" data-a="pYa" data-v="${i}">Mandar ya</button></div></div>`).join('')+
  `<div class="row"><button class="btn p" data-a="pGo">Programar las pistas</button></div>`;}
 else if(ui.cat==='mia'){h+=`<h2>Escríbelo a tu manera</h2><p class="sub">Aquí vale todo lo explícito que queráis: lo escribís vosotros. Truco: pon {A} donde va quien lo propone y {B} donde va quien lo recibe, y salen vuestros nombres.</p><textarea data-in="mineT" placeholder="Lo que me apetece es…">${esc(ui.mine.t)}</textarea><label class="f">Tipo</label><div class="chips">${CATS.filter(c=>!['azar','mia','cita','pista'].includes(c.k)).map(c=>`<button class="chip ${ui.mine.c===c.k?'on':''}" data-a="mineC" data-v="${c.k}">${c.e} ${c.n}</button>`).join('')}</div><label class="f">Nivel</label>${lvRow('mineL',ui.mine.l)}<label class="f">Reloj</label><div class="chips">${[0,60,180,300,600].map(sx=>`<button class="chip ${ui.mine.d===sx?'on':''}" data-a="mineD" data-v="${sx}">${sx?'⏱️ '+sx/60+' min':'Sin reloj'}</button>`).join('')}</div><div class="row"><button class="btn p" data-a="mineGo">Mandar a ${esc(nm(t))}</button><button class="btn" data-a="mineSave">Guardar</button></div>
  <h2>📥 Pegar muchas de golpe</h2><p class="sub">Una por línea. Se guardan en vuestra biblioteca con el tipo y el nivel de arriba, y salen en las ideas.</p><textarea data-in="bulk" placeholder="Una idea por línea…">${esc(ui.mine.bulk)}</textarea><div class="row"><button class="btn" data-a="bulkGo">Añadir a la biblioteca</button></div><h2>📄 Importar un archivo</h2><p class="sub">Un .txt con muchos retos. La app lo reparte por categorías y niveles, pone vuestros nombres y marca qué hace falta aceptar en el cuestionario. Lo peligroso se descarta.</p><label class="photo" style="min-height:64px">📄 Elegir archivo .txt<input type="file" accept=".txt,text/plain" data-file="import" hidden></label>`;
  if(S.custom.length)h+=`<h2>Vuestra biblioteca (${S.custom.length})</h2><div class="card">`+S.custom.slice().reverse().slice(0,40).map(c=>`<div class="m"><span>${catOf(c.c).e} ${LV[c.l].e} ${esc(c.t)}</span><button class="chip" data-a="cuDel" data-v="${c.id}">✕</button></div>`).join('')+`</div>`;}
 else if(ui.cat==='cita'){const ok=CITAS.filter(x=>citaOK(x,s,t));if(!ok.find(x=>x.k===ui.citaT))ui.citaT=ok.length?ok[0].k:null;
  h+=`<h2>¿Qué cita?</h2><div class="chips">${ok.map(x=>`<button class="chip ${ui.citaT===x.k?'on':''}" data-a="citaT" data-v="${x.k}">${x.e} ${x.n}</button>`).join('')||'<span class="sub">No hay tipos de cita en común todavía.</span>'}</div>`;
  if(ui.citaT){if(!ui.plan||ui.plan.k!==ui.citaT||ui.plan.l!==ui.lvl)ui.plan=makePlan(ui.citaT,ui.lvl);h+=`<div class="card"><div class="top"><span>🍷 Plan de cita</span><span>${LV[ui.lvl].e} ${LV[ui.lvl].n}</span></div><div class="txt">${esc(ui.plan.txt)}</div>${tipsHTML(ui.plan.tips)}<div class="row"><button class="btn p" data-a="planGo">Mandar plan</button><button class="btn" data-a="planNew">↻ Otro</button></div></div>`;}}
 else{if(!ui.sug.length||ui.sugKey!==ui.cat+ui.lvl+S.me)genSug();
  h+=`<h2>Ideas para ${esc(nm(t))}</h2>`+(ui.sug.length?ui.sug.map((x,i)=>`<div class="card"><div class="top"><span>${catOf(x.c.c).e} ${LV[x.c.l].e} ${LV[x.c.l].n}</span><span>${x.d?'⏱️ '+durLabel(x.d)+' · ':''}+${10*x.c.l}</span></div><div class="txt">${esc(x.txt)}</div>${thumbsOf(x.used)}${tipsHTML(x.tips)}<div class="row"><button class="btn p" data-a="sendSug" data-v="${i}">Mandar</button><button class="btn mini" data-a="editSug" data-v="${i}">✏️ Cambiar texto</button></div></div>`).join('')+`<div class="row"><button class="btn" data-a="reshuf">↻ Otras ideas</button></div>`:`<div class="empty">Nada en este nivel con lo que habéis marcado. Prueba otro nivel o escribe la tuya.</div>`);}
 return h;}

function vChat(){const me=S.me,o=ot(me);const xs=visibleChat(me);S.read[me]=now();save();
 let h=`<h1>Chat</h1><p class="sub">Solo vosotros dos. Las fotos son de ver una vez: se borran al cerrarlas.</p><div class="chat">`;
 if(!xs.length)h+=`<div class="empty">Aún nada. Escríbele algo… o mándale una pista 🤫</div>`;
 xs.forEach(x=>{const mine=x.from===me;const tm=hhmm(x.at);let body='';
  if(x.kind==='img'){if(mine)body=`<span class="once">📸 Foto de ver una vez</span><small>${x.seen?'Vista ✓':'Sin abrir'} · ${tm}</small>`;else body=x.seen?`<span class="once">📸 Foto vista</span><small>${tm}</small>`:`<button class="once" data-a="viewImg" data-v="${x.id}">📸 Ver foto · una vez</button><small>${tm}</small>`;}
  else if(x.kind==='pista')body=`<b>🤫 Pista</b>\n${esc(x.t)}<small>${mine&&x.at>now()?'🕒 Programada para las '+tm:tm}</small>`;
  else body=`${esc(x.t)}<small>${tm}</small>`;
  h+=`<div class="bub ${mine?'me':'them'}${x.kind==='pista'?' pista':''}">${body}</div>`;});
 h+=`</div><div class="composer"><label class="cam" aria-label="Foto">📷<input type="file" accept="image/*" data-file="chat" hidden></label><input id="msg" placeholder="Escribe a ${esc(nm(o))}…" autocomplete="off"><button class="snd" data-a="sendMsg" aria-label="Enviar">➤</button></div>`;
 return h;}

function vNos(){const me=S.me,o=ot(me);let h=`<h1>Nosotros</h1>`;
 h+=`<div class="card"><div class="m"><span>📝 Tu cuestionario</span><b>${S.qdone[me]?'✓ Hecho':progress(me)+'%'}</b></div><div class="m"><span>📝 ${esc(nm(o))}</span><b>${S.qdone[o]?'✓ Hecho':'Pendiente'}</b></div><div class="row"><button class="btn ${S.qdone[me]?'':'p'}" data-a="quiz">${S.qdone[me]?'Revisar mis respuestas':'Seguir con el mío'}</button></div></div>`;
 if(both()){const ms=matches();h+=`<h2>🔥 Lo que os gusta a los dos (${ms.length})</h2><p class="sub">🔥🔥 los dos dijisteis sí · 🙂 alguno dijo quizá. Lo que no coincide no aparece.</p>`;
  SECS.forEach(sec=>{const xs=ms.filter(x=>x.sec===sec);if(!xs.length)return;h+=`<div class="card"><div class="top"><span>${sec.e} ${sec.n}</span></div>${xs.map(x=>`<div class="m"><span>${esc(x.it.n)}${x.dir?` <small class="sub">· ${esc(nm(x.dir==='ab'?'a':'b'))} → ${esc(nm(x.dir==='ab'?'b':'a'))}</small>`:''}</span><span>${x.s===2?'🔥🔥':'🙂'}</span></div>`).join('')}</div>`;});}
 else h+=`<div class="empty">Cuando los dos terminéis el cuestionario, aquí veréis solo lo que coincide. Nadie ve los «no» del otro.</div>`;
 if(S.qdone[o])h+=`<h2>Cómo es ${esc(nm(o))}</h2><div class="card">${STYLE.map(st=>`<div class="m"><span>${esc(st.n)}</span><b style="text-align:right">${esc((S.sty[o][st.id]||[]).join(', ')||'—')}</b></div>`).join('')}</div>`;
 const lims=['a','b'].map(u=>({u,l:S.lim[u],t:S.limtxt[u]})).filter(x=>x.l.length||x.t);
 h+=`<h2>🛑 Límites</h2>`+(lims.length?lims.map(x=>`<div class="card"><b>${esc(nm(x.u))}</b><div class="chips" style="margin-top:8px">${x.l.map(l=>`<span class="chip on">${esc(l)}</span>`).join('')}</div>${x.t?`<p class="sub" style="margin:8px 0 0">${esc(x.t)}</p>`:''}</div>`).join(''):`<div class="empty">Sin límites apuntados todavía.</div>`);
 const shared=S.fan[o].filter(f=>f.sh);
 h+=`<h2>✨ Fantasías</h2><div class="card"><b>Las tuyas</b> <small class="sub">· ${esc(nm(o))} solo ve las que abras</small>${fanList(me)}<div class="row"><input id="fanIn" placeholder="Escribe una fantasía…"><button class="btn p mini" data-a="fanAdd">Añadir</button></div></div>`;
 if(shared.length)h+=`<div class="card"><b>Las que te enseña ${esc(nm(o))}</b>${shared.map(f=>`<div class="m"><span>${esc(f.t)}</span></div>`).join('')}</div>`;
 const sue=['a','b'].filter(u=>S.sueno[u]);if(sue.length)h+=`<h2>🌍 Sueños juntos</h2><div class="card">${sue.map(u=>`<div class="m"><span>${esc(S.sueno[u])}</span><small class="sub">${esc(nm(u))}</small></div>`).join('')}</div>`;
 h+=`<h2>🚦 Seguridad</h2><div class="card"><div class="sem"><div style="background:#173a2c">🟢 <b>Verde</b><br>Sigue</div><div style="background:#4a3a10">🟡 <b>Amarillo</b><br>Más suave o pausa</div><div style="background:#4a1420">🔴 <b>Rojo</b><br>Se para todo, sin preguntas</div></div><p class="sub" style="margin:10px 0 0">Palabra de seguridad: <b>${esc(S.word)}</b>. Con ataduras: llave o tijera siempre a mano. Los límites nunca salen en las propuestas.</p></div>`;
 return h;}
function fanList(u){return S.fan[u].map(f=>`<div class="m"><span>${esc(f.t)}</span><span style="white-space:nowrap"><button class="chip ${f.sh?'on':''}" data-a="fanSh" data-v="${f.id}">${f.sh?'👁️ La ve':'🔒 Solo yo'}</button> <button class="chip" data-a="fanDel" data-v="${f.id}">✕</button></span></div>`).join('')||'<p class="sub" style="margin:8px 0 0">Aún ninguna.</p>';}

function vCajon(){let h=`<h1>El cajón</h1><p class="sub">Vuestros juguetes y vuestra ropa. Las propuestas los usan por su nombre y con su foto.</p>`;
 [['toy','🧸 Juguetes','juguete'],['ropa','👙 Ropa y disfraces','prenda']].forEach(([k,n,one])=>{const its=S.items.filter(i=>i.k===k);h+=`<h2>${n}</h2>`;
  h+=its.length?`<div class="items">${its.map(i=>`<button class="item" data-a="itemOpen" data-v="${i.id}"><div class="ph">${i.ph?`<img src="${esc(i.ph)}" alt="">`:tipoOf(k,i.t)[1]}</div><div class="nm">${esc(i.n)}</div></button>`).join('')}</div>`:`<div class="empty">Vacío. Mientras lo esté, las propuestas hablan de ${k==='toy'?'juguetes':'ropa'} en general.</div>`;
  h+=`<div class="row"><button class="btn p" data-a="addItem" data-v="${k}">+ Añadir ${one}</button></div>`;});
 h+=`<p class="sub" style="margin-top:18px">📸 Fotos de objetos, no de vosotros. Se quedan en este móvil.</p>`;return h;}

function vQuiz(){const u=S.me,o=ot(u),i=ui.quiz,st=QSTEPS[i];
 let h=`<div class="qhead"><button class="hbtn" data-a="quizExit" aria-label="Salir">✕</button><span>Paso ${i+1} de ${QSTEPS.length}</span><span class="pc">${progress(u)}%</span></div><div class="prog"><i style="width:${Math.round(100*(i+1)/QSTEPS.length)}%"></i></div><div class="qwrap">`;
 if(st==='style'){h+=`<h1>Cómo eres</h1><p class="sub">Esto sí lo verá ${esc(nm(o))}: le ayuda a saber cómo encenderte y cómo pedirte las cosas.</p>`+STYLE.map(q=>`<div class="qi"><div class="n">${esc(q.n)}${q.multi?' <small class="sub">(elige 2)</small>':''}</div><div class="chips">${q.o.map(op=>`<button class="chip ${(S.sty[u][q.id]||[]).includes(op)?'on':''}" data-a="sty" data-v="${q.id}|${esc(op)}">${esc(op)}</button>`).join('')}</div></div>`).join('');}
 else if(st.startsWith('sec:')){const sec=SECS[+st.slice(4)];h+=`<h1>${sec.e} ${sec.n}</h1><p class="sub">Solo tú ves esto. ${esc(nm(o))} solo verá lo que coincida.</p>`+sec.items.map(it=>`<div class="qi"><div class="n">${esc(it.n)}</div>${it.d?`<div class="dl">${esc(it.d[0])}</div>${tri(it.id+'_d',S.q[u][it.id+'_d'])}<div class="dl">${esc(it.d[1])}</div>${tri(it.id+'_r',S.q[u][it.id+'_r'])}`:tri(it.id,S.q[u][it.id])}</div>`).join('');}
 else if(st==='lim'){h+=`<h1>🛑 Tus límites</h1><p class="sub">Esto sí lo verá ${esc(nm(o))}. Lo que marques aquí nunca saldrá en una propuesta.</p><div class="chips">${LIMS.map(l=>`<button class="chip ${S.lim[u].includes(l)?'on':''}" data-a="lim" data-v="${esc(l)}">${esc(l)}</button>`).join('')}</div><label class="f">Algo más que quieras dejar claro</label><textarea data-in="limtxt" placeholder="Por ejemplo: nada de marcas en verano">${esc(S.limtxt[u])}</textarea>`;}
 else if(st==='fan'){h+=`<h1>✨ Fantasías y sueños</h1><p class="sub">Tus fantasías son solo tuyas. Tú decides si ${esc(nm(o))} las ve, y cuándo.</p><div class="card">${fanList(u)}<div class="row"><input id="fanIn" placeholder="Una fantasía…"><button class="btn p mini" data-a="fanAdd">Añadir</button></div></div><label class="f">Un sueño juntos (un viaje, un plan…). Este lo veréis los dos.</label><input data-in="sueno" value="${esc(S.sueno[u])}" placeholder="Por ejemplo: una semana en una cabaña sin cobertura">`;}
 else if(st==='cast'){h+=`<h1>😈 Castigos traviesos</h1><p class="sub">Solo salen si aceptas algo y luego no lo cumples. Marca los que aceptarías recibir.</p>`+CAST.map(k=>`<button class="qi chkrow ${S.kok[u][k[0]]?'on':''}" data-a="kok" data-v="${k[0]}"><span>${LV[k[1]].e} ${esc(k[2])}</span><b>${S.kok[u][k[0]]?'✓':''}</b></button>`).join('');}
 h+=`</div><div class="qnav"><button class="btn" data-a="qPrev" ${i===0?'disabled':''}>Atrás</button><button class="btn p" data-a="qNext">${i===QSTEPS.length-1?'Terminar':'Siguiente'}</button></div>`;
 return h;}

function vDeck(){const D=ui.deck,x=D.card;return `<div class="deck"><div class="top"><button class="hbtn" data-a="pEnd" aria-label="Salir">✕</button><span>Nivel ${D.l} de ${D.max} · carta ${D.i+1} de ${D.per}</span><span style="font-size:22px">${LV[D.l].e}</span></div><div class="turn">Turno de <b>${esc(nm(D.turn))}</b> → ${esc(nm(ot(D.turn)))}</div><div class="card"><div class="txt">${esc(x.txt)}</div>${thumbsOf(x.used)}${tipsHTML(x.tips)}</div>${x.d?`<div class="row"><button class="btn p" data-a="timerDeck">▶️ Empezar · ${durLabel(x.d)}</button></div>`:''}<div class="row"><button class="btn g" data-a="pDone">✅ Hecho</button><button class="btn" data-a="pSkip">↻ Otra</button></div><div class="row"><button class="btn s" data-a="pUp">${D.l>=D.max?'Terminar la partida':'Saltar al siguiente nivel'}</button></div></div>`;}

/* =================== RENDER =================== */
const VIEWS={home:vHome,prop:vProp,chat:vChat,nos:vNos,cajon:vCajon};
function render(keep){const y=keep?window.scrollY:0;const app=$('#app');let cls='bare';
 if(screen==='boot')app.innerHTML=vBoot();
 else if(screen==='fatal')app.innerHTML=vFatal();
 else if(screen==='pass')app.innerHTML=vPass();
 else if(screen==='pin')app.innerHTML=vPin();
 else if(!dev.get('intro'))app.innerHTML=vIntro();
 else if(ui.deck)app.innerHTML=vDeck();
 else if(ui.quiz!=null)app.innerHTML=vQuiz();
 else{app.innerHTML=header()+'<main>'+VIEWS[ui.tab]()+'</main>'+nav();cls='';}
 document.body.className=cls;if(keep)window.scrollTo(0,y);}
function openSheet(k,d){ui.sheet={k,d};renderSheet();}
function renderSheet(){const el=$('#sheet');if(!ui.sheet){el.className='sheet hidden';el.innerHTML='';return;}
 if(ui.sheet.k==='view'||ui.sheet.k==='timer')el.innerHTML=SH[ui.sheet.k]();else el.innerHTML=`<div class="scrim" data-a="closeSheet"></div><div class="panel"><div class="grab"></div><button class="x" data-a="closeSheet" aria-label="Cerrar">✕</button>${SH[ui.sheet.k](ui.sheet.d)}</div>`;
 el.className='sheet';}
function closeSheet(){ui.sheet=null;renderSheet();render(true);}

/* =================== HOJAS =================== */
SH.ganas=()=>`<h2>😏 Tengo ganas</h2><p class="sub">${esc(nm(ot(S.me)))} solo se entera si también tiene ganas en ese rato. Si no, nadie sabe nada.</p>${[['1h','En la próxima hora'],['noche','Esta noche'],['finde','Este finde']].map(x=>`<button class="big" data-a="ganasSet" data-v="${x[0]}"><span class="e">⏳</span><span><b>${x[1]}</b></span></button>`).join('')}`;
SH.salgo=()=>`<h2>🚗 Salgo ya</h2><p class="sub">¿Cuánto tardas?</p><div class="lv">${[15,30,45,60].map(n=>`<button class="${ui.salgoMin===n?'on':''}" data-a="salgoMin" data-v="${n}"><span class="e">⏱️</span>${n} min</button>`).join('')}</div><p class="sub" style="margin-top:16px">¿Y cómo quieres que te reciba? (si quieres)</p>${ui.salgoOps.map((o,i)=>`<button class="opt ${ui.salgoPick===i?'on':''}" data-a="salgoPick" data-v="${i}">${esc(o.txt)}</button>`).join('')||'<p class="sub">Sin ideas por ahora.</p>'}<div class="row"><button class="btn p" data-a="salgoGo">Avisar a ${esc(nm(ot(S.me)))}</button></div>`;
SH.shop=()=>{const me=S.me;return `<h2>🎟️ Canjear puntos</h2><p class="sub">Tienes ${S.pts[me]} puntos.</p><div class="card">${VALES.map(v=>`<div class="m"><span>${v[2]} ${esc(v[3])}</span><button class="btn mini ${S.pts[me]>=v[1]?'p':''}" data-a="buy" data-v="${v[0]}" ${S.pts[me]<v[1]?'disabled':''}>${v[1]}</button></div>`).join('')}</div>`;};
SH.set=()=>`<h2>⚙️ Ajustes</h2>
<label class="f">Tu nombre</label><input data-in="myname" value="${esc(nm(ME.slot))}">
<label class="f">Palabra de seguridad (la véis los dos)</label><input data-in="word" value="${esc(S.word)}">
<label class="f">PIN de 4 cifras en este móvil${dev.get('pin')?' (activado)':''}</label><div class="row" style="margin-top:0"><input id="pinIn" type="tel" inputmode="numeric" maxlength="4" placeholder="••••" style="flex:1"><button class="btn p mini" data-a="setPin">${dev.get('pin')?'Cambiar':'Poner'}</button>${dev.get('pin')?'<button class="btn mini" data-a="delPin">Quitar</button>':''}</div>
<label class="f">Avisos en este móvil</label><div class="row" style="margin-top:0"><button class="btn ${dev.get('push')?'':'p'}" data-a="pushOn">${dev.get('push')?'🔔 Avisos activados':'🔔 Activar avisos'}</button></div>
<h2>Cómo van los puntos</h2><div class="card">
<div class="m"><span>Proponer o mandar pistas</span><b>+5</b></div><div class="m"><span>Cumplir lo aceptado</span><b>+10 × nivel</b></div><div class="m"><span>«Sí, y subo»</span><b>+10 extra</b></div><div class="m"><span>Coincidir en ganas</span><b>+20 cada uno</b></div><div class="m"><span>Decir que no o guardarlo</span><b>0</b></div><div class="m"><span>Aceptar y no cumplir</span><b>−5 × nivel y castigo</b></div></div>
<div class="row" style="margin-top:14px"><button class="btn" data-a="intro">Ver la introducción</button></div>
<div class="row"><button class="btn s" data-a="logout">Salir de la cuenta en este móvil</button></div>
<p class="firma">${esc(FIRMA)}</p>`;
SH.contra=id=>{const p=S.props.find(x=>x.id===id);if(!p)return '';const s=S.me,t=ot(s);const cc=['rem','noche','atad','rol','obj','fuera'].includes(p.c)?p.c:'azar';let alts=[];for(let l=p.l;l>=1&&alts.length<4;l--)alts=alts.concat(pickSug(cc,l,s,t,2));ui.alts=alts.slice(0,4).map(c=>Object.assign({c},resolve(c,s,t)));
 return `<h2>🔄 Eso no, pero esto sí</h2><p class="sub">Elige algo que sí te apetezca y se lo devuelves a ${esc(nm(t))}.</p>${ui.alts.map((a,i)=>`<div class="card"><div class="top"><span>${LV[a.c.l].e} ${LV[a.c.l].n}</span></div><div class="txt">${esc(a.txt)}</div><div class="row"><button class="btn p" data-a="contraGo" data-v="${id}|${i}">Proponer esto</button></div></div>`).join('')||'<div class="empty">No encuentro alternativas. Escribe la tuya.</div>'}<label class="f">O escríbelo tú</label><textarea id="ctxt" placeholder="Hoy eso no, pero…"></textarea><div class="row"><button class="btn p" data-a="contraGo" data-v="${id}|txt">Mandar</button></div>`;};
SH.item=()=>{const f=ui.form;return `<h2>${f.k==='toy'?'Nuevo juguete':'Nueva prenda'}</h2><label class="f">¿Qué es?</label><div class="chips">${TIPO[f.k].map(x=>`<button class="chip ${f.t===x[0]?'on':''}" data-a="fT" data-v="${x[0]}">${x[1]} ${x[2]}</button>`).join('')}</div>
<label class="f">Nombre (como lo llamáis vosotros)</label><input data-in="fN" value="${esc(f.n)}" placeholder="${f.k==='toy'?'Esposas de terciopelo':'Conjunto rojo'}">
<label class="f">Foto (opcional)</label><label class="photo">${f.ph?`<img src="${esc(f.ph)}" alt="">`:'📷 Hacer o elegir foto'}<input type="file" accept="image/*" data-file="item" hidden></label>
<label class="f">¿De quién es?</label><div class="chips">${[['a',nm('a')],['b',nm('b')],['both','De los dos']].map(x=>`<button class="chip ${f.o===x[0]?'on':''}" data-a="fO" data-v="${x[0]}">${esc(x[1])}</button>`).join('')}</div>
<div class="row"><button class="btn p" data-a="fSave">Guardar</button></div>`;};
SH.itemV=id=>{const i=S.items.find(x=>x.id===id);if(!i)return '';const tp=tipoOf(i.k,i.t);return `<h2>${tp[1]} ${esc(i.n)}</h2>${i.ph?`<img class="bigph" src="${esc(i.ph)}" alt="">`:''}<p class="sub">${esc(tp[2])} · ${i.o==='both'?'De los dos':'De '+esc(nm(i.o))}</p><div class="row"><button class="btn" data-a="itemDel" data-v="${i.id}">Quitar del cajón</button></div>`;};
SH.view=()=>`<div class="viewer"><img src="${esc(ui.viewImg||'')}" alt=""><p>Se borra al cerrar. Ojo: una captura de pantalla no se puede impedir.</p><button class="btn p" style="flex:0 0 auto;min-width:200px" data-a="viewClose">Cerrar</button></div>`;
SH.partida=()=>{const d=ui.pset;return `<h2>🎲 Jugar juntos</h2><p class="sub">Empieza suave y sube nivel a nivel. Os vais turnando. Solo salen cosas que os gustan a los dos.</p>
<label class="f">Cartas por nivel</label><div class="chips">${[1,2,3].map(n=>`<button class="chip ${d.per===n?'on':''}" data-a="pset" data-v="per|${n}">${n}</button>`).join('')}</div>
<label class="f">Hasta qué nivel</label>${lvRow('psetMax',d.max)}
<label class="f">Empieza</label><div class="chips">${['a','b'].map(u=>`<button class="chip ${d.first===u?'on':''}" data-a="pset" data-v="first|${u}">${esc(nm(u))}</button>`).join('')}</div>
<div class="row"><button class="btn p" data-a="pStart">Empezar</button></div>`;};

/* =================== TEMPORIZADOR =================== */
let AC=null,WL=null;
function audioOn(){try{AC=AC||new(window.AudioContext||window.webkitAudioContext)();if(AC.state==='suspended')AC.resume();}catch(e){}}
function beep(n){try{if(AC){for(let i=0;i<n;i++){const o=AC.createOscillator(),g=AC.createGain();o.type='sine';o.frequency.value=880;o.connect(g);g.connect(AC.destination);const t0=AC.currentTime+i*0.4;g.gain.setValueAtTime(0.0001,t0);g.gain.exponentialRampToValueAtTime(0.35,t0+0.02);g.gain.exponentialRampToValueAtTime(0.0001,t0+0.32);o.start(t0);o.stop(t0+0.35);}}}catch(e){}try{if(navigator.vibrate)navigator.vibrate([250,120,250]);}catch(e){}}
async function wake(on){try{if(on){if(!WL&&navigator.wakeLock)WL=await navigator.wakeLock.request('screen');}else if(WL){await WL.release();WL=null;}}catch(e){}}
function startTimer(ph,txt,ctx){audioOn();ui.timer={ph:ph.slice(),i:0,left:ph[0]*1000,endAt:now()+ph[0]*1000,run:true,done:false,txt,ctx};wake(true);openSheet('timer');}
SH.timer=()=>{const T=ui.timer;if(!T)return '';const tot=T.ph[T.i]*1000;const left=Math.max(0,T.run?T.endAt-now():T.left);
 return `<div class="viewer timer${T.done?' done':''}"><div class="tlabel">${T.done?'⏰ ¡Tiempo!':T.ph.length>1?`Parte ${T.i+1} de ${T.ph.length}`:(T.run?'⏱️ En marcha':'⏸ En pausa')}</div><div id="tdig" class="tdig">${fmt(left/1000)}</div><div class="tbar"><i id="tbar" style="width:${T.done?100:Math.round(100*(1-left/tot))}%"></i></div><div class="ttxt">${esc(T.txt)}</div>${T.done?'':`<div class="row"><button class="btn" data-a="tPause">${T.run?'⏸ Pausa':'▶️ Seguir'}</button><button class="btn" data-a="tPlus">+1 min</button></div>`}<div class="row"><button class="btn g" data-a="tDone">✅ Hecho</button><button class="btn" data-a="tClose">Cerrar</button></div></div>`;};
setInterval(()=>{const T=ui.timer;if(!T||!T.run||T.done)return;const left=T.endAt-now();const tot=T.ph[T.i]*1000;const dg=$('#tdig'),br=$('#tbar');if(dg)dg.textContent=fmt(Math.max(0,left)/1000);if(br)br.style.width=Math.min(100,Math.round(100*(1-Math.max(0,left)/tot)))+'%';
 if(left<=0){if(T.i<T.ph.length-1){T.i++;T.endAt=now()+T.ph[T.i]*1000;beep(2);renderSheet();}else{T.done=true;T.run=false;T.left=0;beep(3);renderSheet();}}},250);
A.tPause=()=>{const T=ui.timer;if(!T)return;if(T.run){T.left=T.endAt-now();T.run=false;}else{T.endAt=now()+T.left;T.run=true;audioOn();}renderSheet();};
A.tPlus=()=>{const T=ui.timer;if(!T)return;if(T.run)T.endAt+=60000;else T.left+=60000;T.ph[T.i]+=60;renderSheet();};
function closeTimer(){ui.timer=null;if(!ui.deck)wake(false);ui.sheet=null;renderSheet();render(true);}
A.tClose=()=>closeTimer();
A.tDone=()=>{const c=ui.timer&&ui.timer.ctx;closeTimer();if(!c)return;if(c.t==='deck')A.pDone();else if(c.t==='prop')A.r(c.id+'|ok');else if(c.t==='k')A.r(c.id+'|kdone');};
A.timerDeck=()=>{const x=ui.deck&&ui.deck.card;if(x&&x.d)startTimer(x.d,x.txt,{t:'deck'});};
A.timerProp=id=>{const p=S.props.find(x=>x.id===id);if(p&&p.d)startTimer(p.d,p.txt,{t:p.k?'k':'prop',id});};

/* =================== MANEJADORES =================== */
A.tab=v=>{ui.tab=v;render();if(v==='chat')setTimeout(()=>window.scrollTo(0,document.body.scrollHeight),0);else window.scrollTo(0,0);};
A.lock=()=>{if(!dev.get('pin')){toast('Pon un PIN en ⚙️ Ajustes');return;}screen='pin';pinBuf='';ui.sheet=null;renderSheet();render();};
A.settings=()=>openSheet('set');
A.sheet=v=>openSheet(v);
A.closeSheet=()=>closeSheet();
A.introOk=()=>{dev.set('intro',1);render();};
A.intro=()=>{dev.del('intro');ui.sheet=null;renderSheet();render();};
A.goPista=()=>{ui.tab='prop';ui.cat='pista';ui.pistas=null;render();window.scrollTo(0,0);};
A.pk=d=>{if(d==='x')pinBuf=pinBuf.slice(0,-1);else if(pinBuf.length<4)pinBuf+=d;if(pinBuf.length===4){if(hsh('llama:'+pinBuf)===dev.get('pin')){pinBuf='';if(!BOOTED){enterApp();}else{screen='app';render();}return;}pinBuf='';toast('PIN incorrecto');}render();};

A.quiz=()=>{ui.quiz=0;render();window.scrollTo(0,0);};
A.quizExit=()=>{ui.quiz=null;render();};
A.qPrev=()=>{if(ui.quiz>0){ui.quiz--;render();window.scrollTo(0,0);}};
A.qNext=()=>{if(ui.quiz<QSTEPS.length-1){ui.quiz++;render();window.scrollTo(0,0);return;}
 const me=S.me,o=ot(me);S.qdone[me]=true;ui.quiz=null;ui.sug=[];ui.pistas=null;feed(o,`📝 ${nm(me)} ha terminado su cuestionario`);save();toast(both()?'¡Listo! Ya podéis ver lo que coincide':'Listo. Falta '+nm(o));ui.tab='nos';render();window.scrollTo(0,0);};
A.ans=(v,b)=>{const i=v.lastIndexOf('|');S.q[S.me][v.slice(0,i)]=+v.slice(i+1);save();b.parentElement.querySelectorAll('button').forEach(y=>y.classList.remove('on'));b.classList.add('on');const pc=document.querySelector('.qhead .pc');if(pc)pc.textContent=progress(S.me)+'%';};
A.sty=(v,b)=>{const i=v.indexOf('|');const id=v.slice(0,i),op=v.slice(i+1);const q=STYLE.find(x=>x.id===id);let cur=(S.sty[S.me][id]||[]).slice();
 if(q.multi){if(cur.includes(op))cur=cur.filter(x=>x!==op);else{cur.push(op);if(cur.length>q.multi)cur=cur.slice(-q.multi);}}else cur=[op];
 S.sty[S.me][id]=cur;save();b.parentElement.querySelectorAll('.chip').forEach(c=>{const dv=c.dataset.v;c.classList.toggle('on',cur.includes(dv.slice(dv.indexOf('|')+1)));});};
A.lim=(v,b)=>{const L=S.lim[S.me];const i=L.indexOf(v);if(i>=0)L.splice(i,1);else L.push(v);save();b.classList.toggle('on',i<0);};
A.kok=(v,b)=>{S.kok[S.me][v]=!S.kok[S.me][v];save();b.classList.toggle('on',!!S.kok[S.me][v]);b.querySelector('b').textContent=S.kok[S.me][v]?'✓':'';};
A.fanAdd=()=>{const el=$('#fanIn');const t=(el&&el.value||'').trim();if(!t){toast('Escribe algo primero');return;}S.fan[S.me].push({id:uid(),t,sh:false});save();render(true);};
A.fanSh=id=>{const f=S.fan[S.me].find(x=>x.id===id);if(f){f.sh=!f.sh;if(f.sh)feed(ot(S.me),`✨ ${nm(S.me)} te ha enseñado una fantasía`);}save();render(true);};
A.fanDel=id=>{S.fan[S.me]=S.fan[S.me].filter(x=>x.id!==id);save();render(true);};

A.cat=v=>{ui.cat=v;ui.sug=[];render(true);const el=document.querySelector('main .lv')||document.querySelector('main textarea');if(el)window.scrollTo({top:el.getBoundingClientRect().top+window.scrollY-130,behavior:'smooth'});};
A.lvl=v=>{ui.lvl=+v;ui.sug=[];render(true);};
A.reshuf=()=>{genSug();render(true);};
A.sendSug=i=>{const x=ui.sug[+i];if(!x)return;send({c:x.c.c,l:x.c.l,txt:x.txt,used:x.used,tips:x.tips,d:x.d});ui.sug=[];render(true);};
A.editSug=i=>{const x=ui.sug[+i];if(!x)return;ui.mine.t=x.txt;ui.mine.c=['rem','noche','atad','rol','obj','fuera'].includes(x.c.c)?x.c.c:'noche';ui.mine.l=x.c.l;ui.cat='mia';render();window.scrollTo(0,0);toast('Cámbialo a tu manera y mándalo');};
A.mineC=v=>{ui.mine.c=v;render(true);};
A.mineL=v=>{ui.mine.l=+v;render(true);};
function mineTips(c){return c==='atad'?['🚦 Semáforo activo · palabra: '+S.word]:c==='fuera'?[OCULTO]:[];}
const mineD=()=>ui.mine.d?[ui.mine.d]:null;
A.mineD=v=>{ui.mine.d=+v;render(true);};
A.mineGo=()=>{const t=ui.mine.t.trim();if(!t){toast('Escribe algo primero');return;}send({c:ui.mine.c,l:ui.mine.l,txt:names(t),tips:mineTips(ui.mine.c),d:mineD()});ui.mine.t='';render(true);};
A.mineSave=()=>{const t=ui.mine.t.trim();if(!t){toast('Escribe algo primero');return;}S.custom.push({id:'u'+uid(),c:ui.mine.c,l:ui.mine.l,t,r:[],by:S.me,d:mineD()});save();toast('Guardada en vuestra biblioteca');render(true);};
A.bulkGo=()=>{const lines=ui.mine.bulk.split('\n').map(x=>x.trim()).filter(Boolean);if(!lines.length){toast('Pega al menos una línea');return;}lines.forEach(t=>S.custom.push({id:'u'+uid(),c:ui.mine.c,l:ui.mine.l,t,r:[],by:S.me,d:mineD()}));ui.mine.bulk='';save();toast(`${lines.length} añadidas a vuestra biblioteca`);render(true);};
A.cuDel=id=>{S.custom=S.custom.filter(c=>c.id!==id);save();render(true);};
A.citaT=v=>{ui.citaT=v;ui.plan=null;render(true);};
A.planNew=()=>{ui.plan=makePlan(ui.citaT,ui.lvl);render(true);};
A.planGo=()=>{if(!ui.plan)return;send({c:'cita',l:ui.lvl,txt:ui.plan.txt,tips:ui.plan.tips});ui.plan=null;render(true);};
A.pRe=i=>{const s=S.me,t=ot(s);const p=ui.pistas[+i];const cs=eligible('pista',p.l,s,t).filter(c=>resolve(c,s,t).txt!==p.txt);if(cs.length)p.txt=resolve(rnd(cs),s,t).txt;render(true);};
A.pYa=i=>{const p=ui.pistas[+i];if(!p.txt.trim()){toast('Escribe algo');return;}pushChat({kind:'pista',t:p.txt.trim()});addPts(S.me,5);toast('Pista enviada al chat · +5');};
A.pGo=()=>{let n=0;ui.pistas.forEach((p,i)=>{if(!p.txt.trim())return;const hm=(p.tm||'12:00').split(':').map(Number);const d=new Date();d.setHours(hm[0]||0,hm[1]||0,0,0);let at=d.getTime();if(at<=now())at=now()+i*1000;pushChat({kind:'pista',t:p.txt.trim(),at});n++;});
 if(!n){toast('No hay pistas que mandar');return;}addPts(S.me,5);feed(S.me,`🤫 Has programado ${n} pistas para ${nm(ot(S.me))} (+5)`);toast(`${n} pistas programadas · +5`);ui.pistas=null;render(true);};

A.r=v=>{const i=v.indexOf('|');const id=v.slice(0,i),how=v.slice(i+1);const p=S.props.find(x=>x.id===id);if(!p)return;const me=S.me;
 if(how==='contra'){openSheet('contra',id);return;}
 if(how==='si'){p.st='acc';heat(4);feed(p.from,`✅ ${nm(me)} ha dicho que sí`);toast('Aceptado. Ahora, a cumplirlo 😉');}
 else if(how==='sube'){p.l=Math.min(5,p.l+1);p.up=true;p.st='acc';feed(p.from,`🔥 ${nm(me)} dice que sí… y lo sube un nivel`);toast('Sube un nivel 🔥');}
 else if(how==='guarda'){p.st='saved';feed(p.from,`⏳ ${nm(me)} lo guarda para luego 😉`);toast('Guardado para luego');}
 else if(how==='no'){p.st='no';feed(p.from,`🙂 ${nm(me)}: hoy no. Decir que no es gratis`);toast('Sin problema. No resta nada');}
 else if(how==='ok'){p.st='done';const g=10*p.l+(p.up?10:0);addPts(me,g);heat(8+p.l);confetti();feed(p.from,`🎉 ${nm(me)} lo ha cumplido`);toast(`+${g} puntos`);}
 else if(how==='fail'){p.st='fail';const l=5*p.l;addPts(me,-l);const k=castigoPara(me);const kp={id:uid(),from:p.from,to:me,c:'castigo',l:k[1],txt:k[2],st:'acc',k:true,ts:now(),used:[],tips:[],d:k[3]?[k[3]]:null};S.props.unshift(kp);saveProp(kp);feed(p.from,`😈 ${nm(me)} no lo cumplió: le toca castigo`);toast(`−${l} puntos y castigo travieso`);}
 else if(how==='ahora'){p.st='acc';feed(p.from,`😉 ${nm(me)} rescata lo que guardó: ahora sí`);toast('¡Ahora sí!');}
 else if(how==='quita'){p.st='no';}
 else if(how==='kdone'){p.st='done';feed(p.from,`✅ ${nm(me)} ha cumplido su castigo`);toast('Castigo cumplido');}
 saveProp(p);render(true);};
A.contraGo=v=>{const i=v.indexOf('|');const id=v.slice(0,i),w=v.slice(i+1);const p=S.props.find(x=>x.id===id);if(!p)return;let o;
 if(w==='txt'){const el=$('#ctxt');const t=(el&&el.value||'').trim();if(!t){toast('Escribe algo primero');return;}o={c:p.c==='castigo'?'noche':p.c,l:Math.max(1,p.l-1),txt:t,tips:mineTips(p.c),parent:id};}
 else{const a=ui.alts[+w];if(!a)return;o={c:a.c.c,l:a.c.l,txt:a.txt,used:a.used,tips:a.tips,d:a.d,parent:id};}
 p.st='counter';saveProp(p);send(o);closeSheet();};

A.ganasSet=async k=>{const me=S.me,o=ot(me);const uT=until(k);
 let ideas=[];[3,2,1].forEach(l=>{if(!ideas.length)ideas=eligible('noche',l,me,o).filter(c=>CARDS.indexOf(c)>=0);});
 const idea=ideas.length?resolve(rnd(ideas),me,o).txt:'Empezad por un beso largo. Lo demás, que siga solo.';
 S.ganas[me]=uT;closeSheet();toast('Comprobando…');
 let match=false;try{match=await setGanas(uT,idea);}catch(e){}
 if(match){notify();try{await loadAll();}catch(e){}logro('match');heat(30);confetti();toast('🔥 ¡Coincidís!');}
 else toast(`Hecho. Si ${nm(o)} también antes de las ${hhmm(uT)}, os aviso a los dos`);
 render(true);};
A.ganasOff=async()=>{S.ganas[S.me]=0;try{await sb.from('ganas').delete().eq('user_id',ME.uid);}catch(e){}render(true);toast('Quitadas. Nadie se ha enterado');};
A.matchOk=()=>{if(S.match){S.match.seen[S.me]=true;if(S.match.seen.a&&S.match.seen.b){S.match=null;putDoc('shared.match',{cleared:1});}else putDoc('shared.match',S.match);}render(true);};
A.salgo=()=>{const s=S.me,t=ot(s);ui.salgoMin=30;ui.salgoPick=-1;ui.salgoOps=pickSug('obj',2,s,t,2).concat(pickSug('noche',2,s,t,1)).map(c=>Object.assign({c},resolve(c,s,t)));openSheet('salgo');};
A.salgoMin=v=>{ui.salgoMin=+v;renderSheet();};
A.salgoPick=v=>{ui.salgoPick=ui.salgoPick===+v?-1:+v;renderSheet();};
A.salgoGo=()=>{const s=S.me,t=ot(s);const min=ui.salgoMin||30;S.salgo={from:s,to:t,at:now()+min*60000};putDoc('shared.salgo',S.salgo);feed(t,`🚗 ${nm(s)} sale ya. Llega sobre las ${hhmm(S.salgo.at)}`);
 if(ui.salgoPick>=0){const o=ui.salgoOps[ui.salgoPick];send({c:o.c.c,l:o.c.l,txt:'Cuando llegue: '+o.txt,used:o.used,tips:o.tips,d:o.d});}else{notify();toast(`Avisado: llegas sobre las ${hhmm(S.salgo.at)}`);}
 closeSheet();};
A.buy=id=>{const v=VALES.find(x=>x[0]===id);const me=S.me;if(!v||S.pts[me]<v[1]){toast('Te faltan puntos');return;}addPts(me,-v[1]);const vl={id:uid(),v:id,u:me,used:false};S.vales.push(vl);saveVale(vl);feed(ot(me),`🎟️ ${nm(me)} ha canjeado: ${v[3]}`);toast('Vale conseguido 🎟️');renderSheet();render(true);};
A.useVale=id=>{const x=S.vales.find(y=>y.id===id);if(!x)return;const v=VALES.find(y=>y[0]===x.v);x.used=true;saveVale(x);feed(ot(S.me),`🎟️ ${nm(S.me)} usa su vale: ${v[3]}. Te toca 😉`);toast('Vale usado. Avisado');render(true);};
A.setPin=()=>{const el=$('#pinIn');const v=(el&&el.value||'').trim();if(!/^\d{4}$/.test(v)){toast('Pon 4 números');return;}dev.set('pin',hsh('llama:'+v));toast('PIN puesto. Toca 🔒 para bloquear');renderSheet();};
A.delPin=()=>{dev.del('pin');toast('PIN quitado');renderSheet();};
/* herramientas de prueba (wipe, demoFill, ff) eliminadas en v2 */

A.addItem=k=>{ui.form={k,t:TIPO[k][0][0],n:'',ph:null,o:'both'};openSheet('item');};
A.fT=v=>{ui.form.t=v;renderSheet();};
A.fO=v=>{ui.form.o=v;renderSheet();};
A.fSave=()=>{const f=ui.form;const n=(f.n||'').trim()||tipoOf(f.k,f.t)[2];S.items.push({id:uid(),k:f.k,t:f.t,n,ph:f.ph,o:f.o});logro('cajon');ui.sug=[];save();toast('Guardado en el cajón');closeSheet();};
A.itemOpen=id=>openSheet('itemV',id);
A.itemDel=id=>{S.items=S.items.filter(x=>x.id!==id);ui.sug=[];save();toast('Quitado del cajón');closeSheet();};

A.sendMsg=()=>{const el=$('#msg');const t=(el&&el.value||'').trim();if(!t)return;pushChat({kind:'txt',t});save();render(true);setTimeout(()=>{window.scrollTo(0,document.body.scrollHeight);const e=$('#msg');if(e)e.focus();},0);};
A.viewImg=id=>{const x=S.chat.find(y=>y.id===id);if(!x||x.seen||!x.img){toast('Esta foto ya no está');return;}ui.viewImg=x.img;x.img=null;x.seen=true;saveChat(x);openSheet('view');};
A.viewClose=()=>{ui.viewImg=null;closeSheet();};

A.partida=()=>{if(!ui.pset)ui.pset={per:2,max:4,first:S.me};openSheet('partida');};
A.pset=v=>{const i=v.indexOf('|');const k=v.slice(0,i),x=v.slice(i+1);ui.pset[k]=k==='per'?+x:x;renderSheet();};
A.psetMax=v=>{ui.pset.max=+v;renderSheet();};
function dealCard(){const D=ui.deck;const s=D.turn,t=ot(s);let pool=eligible('noche',D.l,s,t).concat(eligible('atad',D.l,s,t),eligible('obj',D.l,s,t).filter(c=>/\{[TR]:/.test(c.t)));
 let cs=pool.filter(c=>!D.seen.includes(c.id));if(!cs.length)cs=pool;const c=cs.length?rnd(cs):null;if(c)D.seen.push(c.id);
 D.card=c?Object.assign({c},resolve(c,s,t)):{c:null,txt:'Beso largo, y que siga lo que surja.',used:[],tips:[]};}
A.pStart=()=>{const d=ui.pset;ui.deck={l:1,i:0,per:d.per,max:d.max,turn:d.first,card:null,done:0,seen:[]};wake(true);dealCard();ui.sheet=null;renderSheet();render();window.scrollTo(0,0);};
function endDeck(){const n=ui.deck.done;ui.deck=null;wake(false);if(n){feed('a',`🎲 Partida terminada: ${n} cartas cumplidas`);feed('b',`🎲 Partida terminada: ${n} cartas cumplidas`);}save();toast(n?`Fin de la partida 🔥 · ${n} cartas`:'Partida cerrada');render();}
function nextCard(){const D=ui.deck;D.i++;D.turn=ot(D.turn);if(D.i>=D.per){D.i=0;D.l++;}if(D.l>D.max){endDeck();return;}dealCard();render();}
A.pDone=()=>{const D=ui.deck;S.pts[D.turn]+=5;D.done++;save();nextCard();};
A.pSkip=()=>{dealCard();render();};
A.pUp=()=>{const D=ui.deck;if(D.l>=D.max){endDeck();return;}D.l++;D.i=0;D.turn=ot(D.turn);dealCard();render();};
A.pEnd=()=>endDeck();

IN.mineT=v=>{ui.mine.t=v;};
IN.bulk=v=>{ui.mine.bulk=v;};
IN.myname=v=>{const n=v.trim()||nm(ME.slot);S.names[ME.slot]=n;try{sb.from('members').update({name:n}).eq('user_id',ME.uid);}catch(e){}};
IN.word=v=>{S.word=v.trim()||'Rojo';save();};
IN.limtxt=v=>{S.limtxt[S.me]=v;save();};
IN.sueno=v=>{S.sueno[S.me]=v;save();};
IN.fN=v=>{ui.form.n=v;};
IN.ptm=(v,el)=>{ui.pistas[+el.dataset.i].tm=v;};
IN.ptx=(v,el)=>{ui.pistas[+el.dataset.i].txt=v;};

/* =================== EVENTOS =================== */
document.addEventListener('click',e=>{const b=e.target.closest('[data-a]');if(!b||b.disabled)return;const f=A[b.dataset.a];if(f){e.preventDefault();f(b.dataset.v,b,e);}});
document.addEventListener('input',e=>{const el=e.target;if(el&&el.dataset&&el.dataset.in&&IN[el.dataset.in])IN[el.dataset.in](el.value,el);});
document.addEventListener('keydown',e=>{if(e.key==='Enter'&&e.target&&e.target.id==='msg'){e.preventDefault();A.sendMsg();}});
function shrink(file,M,q,cb){const rd=new FileReader();rd.onload=()=>{const img=new Image();img.onload=()=>{let w=img.naturalWidth,h=img.naturalHeight;const sc=Math.min(1,M/Math.max(w,h));w=Math.round(w*sc);h=Math.round(h*sc);const cv=document.createElement('canvas');cv.width=w;cv.height=h;cv.getContext('2d').drawImage(img,0,0,w,h);cb(cv.toDataURL('image/jpeg',q));};img.onerror=()=>toast('No he podido leer la foto');img.src=rd.result;};rd.readAsDataURL(file);}
document.addEventListener('change',e=>{const el=e.target;if(!el||!el.dataset||!el.dataset.file)return;const f=el.files&&el.files[0];if(!f)return;const kind=el.dataset.file;
 if(kind==='import'){const rd=new FileReader();rd.onload=()=>applyImport(String(rd.result||''));rd.onerror=()=>toast('No he podido leer el archivo');rd.readAsText(f);el.value='';return;}
 shrink(f,kind==='chat'?1280:480,kind==='chat'?.8:.72,url=>{if(kind==='chat'){pushChat({kind:'img',img:url});save();toast('📸 Enviada · de ver una vez');render(true);window.scrollTo(0,document.body.scrollHeight);}else if(ui.form){ui.form.ph=url;renderSheet();}});el.value='';});
setInterval(()=>{const a=document.activeElement;if(screen!=='app'||ui.sheet||ui.deck||ui.quiz!=null)return;if(a&&(a.tagName==='INPUT'||a.tagName==='TEXTAREA'))return;if(ui.tab==='home'||ui.tab==='chat')render(true);},20000);

/* =================================================================
   Llama · módulo de juegos y chispa
   Dados, ruleta, verdad o reto, ruta de la noche, reto relámpago,
   temperatura de pareja, rangos, logros y animaciones.
   Usa helpers ya definidos: rnd, shuf, eligible, resolve, both, S,
   nm, ot, render, openSheet, closeSheet, renderSheet, toast, LV,
   CATS, now, startTimer, send, notify, feed, uid, esc.
   ================================================================= */

/* ---------- contenido nuevo ---------- */
const DVERBO=[['💋','Besa'],['👅','Lame'],['🫦','Mordisquea'],['💨','Sopla sobre'],['✋','Acaricia'],['💆','Masajea'],['🧊','Pasa un hielo por'],['🪶','Roza apenas'],['🔥','Recorre con la lengua'],['🤲','Agarra fuerte'],['😮‍💨','Susurra algo sucio en'],['💋','Deja una marca en']];
const DZONA=[['el cuello'],['la oreja'],['los labios'],['la nuca'],['la clavícula'],['la espalda baja'],['el interior del muslo'],['el vientre'],['las caderas'],['el pecho'],['justo donde más le gusta'],['donde no se atreve a pedir']];
const DEXTRA=[['⏱️','durante 1 minuto sin parar'],['⏱️','durante 3 minutos'],['🐢','muy despacio, hasta que suplique'],['🔁','y repite hasta que tiemble'],['🙈','con los ojos vendados'],['🔄','y luego te toca a ti'],['🗣️','mientras le cuentas lo que viene después'],['🚫','sin dejar que te toque']];

/* Verdades: invitan a abrir la boca, el picante lo ponéis vosotros */
const VERDADES=[null,
 ['¿Qué pensaste la primera vez que me viste sin ropa?','¿Cuál es el recuerdo nuestro que te pone cuando lo revives?','¿Qué gesto mío te enciende sin que yo me entere?','¿Dónde te habría gustado que te besara hoy mientras trabajabas?','¿Qué canción te recuerda a una noche conmigo?'],
 ['¿Dónde te mueres por que te bese ahora mismo?','¿Qué llevabas puesto el día que más me deseaste?','¿Prefieres mandar tú o que te manden? Sé sincero.','¿Qué me pondría a mil si me lo encontrara puesto?','¿Qué me has querido pedir alguna vez y te ha dado corte?'],
 ['¿Cuál es tu parte favorita de mi cuerpo y qué le harías ahora?','¿Qué te gustaría que te hiciera mucho más a menudo?','¿Has pensado en mí en un sitio nada apropiado? Cuéntalo con detalle.','¿Qué palabra al oído te derrite del todo?','¿Qué es lo más atrevido que hemos hecho y repetirías ya?'],
 ['¿Qué fantasía tuya no me has contado todavía?','¿Qué te mueres por probar y nunca te has atrevido a decir en voz alta?','Descríbeme tu noche perfecta conmigo, sin saltarte nada.','¿En qué sitio raro te gustaría que lo hiciéramos?','¿Qué te daría vergüenza que supiera que te pone?'],
 ['Dime al oído, sin filtro, lo que quieres que pase esta noche.','¿Hasta dónde me dejarías llegar si esta noche mandara yo?','Cuéntame tu fantasía más salvaje conmigo, sin censura.','¿Qué límite te apetece empujar un poco más conmigo?','Si no hubiera ninguna regla esta noche, ¿qué me harías primero?']];

/* Cartas suaves extra para dar variedad (se suman a la biblioteca) */
const EXTRA_RAW=[
['rem',1,'{B}, mándale a {A} un emoji y solo uno que resuma lo que le harías ahora mismo.',''],
['rem',2,'{B}, dile a {A} en una frase lo primero que le vas a arrancar al llegar.','mensajes'],
['noche',1,'Un minuto mirándoos a los ojos, muy cerca, sin tocaros. El que no aguante y bese primero, pierde y obedece.','','','60'],
['noche',2,'{A} escribe con la lengua una letra en la piel de {B}. {B} adivina. Cada acierto, un beso donde {B} elija.','masaje>'],
['noche',3,'{A} guía las manos de {B} por donde quiere que le toquen, sin una palabra. Solo gestos y ganas.','susurros<','','180'],
['noche',4,'{A} le tapa los ojos a {B} y le va diciendo al oído lo que le va a hacer, sin hacerlo todavía. Puro aguante.','vendar>','','240'],
['obj',2,'{B} elige una canción y {A} no puede dejar de besarle hasta el último segundo. Donde sea.','besos','','210'],
['fuera',2,'De camino, {A} le manda a {B} una sola instrucción para nada más cruzar la puerta de casa.','provocar'],
['rol',2,'Diez minutos tratándoos de usted, como dos desconocidos con muchas ganas. El que rompa el personaje, paga prenda.','desconocidos','','600'],
['pista',2,'Cada mensaje que me mandes hoy, acábalo con un punto. Yo sé lo que significa.','insinuar>']];

/* Rangos compartidos (por puntos sumados de los dos) */
const RANGOS=[[0,'Chispa','✨'],[120,'Brasa','🔥'],[350,'Hoguera','🔥🔥'],[700,'Incendio','🌋'],[1200,'Leyenda','👑']];
function rangoDe(p){let r=RANGOS[0];for(const x of RANGOS)if(p>=x[0])r=x;return r;}
function rangoNext(p){for(const x of RANGOS)if(p<x[0])return x;return null;}

/* Logros */
const LOGROS=[['match','🔥','Primera coincidencia','Los dos tuvisteis ganas a la vez'],
 ['dados','🎲','Manos de la suerte','Tiraste los dados diez veces'],
 ['ruleta','🎡','La ruleta manda','Giraste la ruleta diez veces'],
 ['ruta','🌙','Noche completa','Terminaste una ruta de la noche'],
 ['verdad','🎭','Sin secretos','Jugasteis a verdad o reto'],
 ['brasa','🔥','En llamas','Llegasteis al rango Brasa'],
 ['cajon','🧰','Bien surtidos','Metisteis algo en el cajón']];
function logro(id){if(!S.logros)S.logros=[];if(S.logros.indexOf(id)>=0)return;S.logros.push(id);const l=LOGROS.find(x=>x[0]===id);if(l){toast('🏅 Logro: '+l[2]);hap([30,60,30]);}save();}

/* ---------- temperatura de pareja ---------- */
function tempNow(){const t=S.temp||0,at=S.tempAt||0;if(!at)return t;const horas=(now()-at)/3600000;return Math.max(0,Math.round(t-horas*8));} // enfría ~8 por hora
function heat(d){const cur=tempNow();S.temp=Math.max(0,Math.min(100,cur+d));S.tempAt=now();const r=rangoDe(S.pts.a+S.pts.b);if(r[1]==='Brasa'||RANGOS.indexOf(r)>=1)logro('brasa');save();}
function tempEmoji(t){return t>=80?'🌋':t>=55?'🔥🔥':t>=30?'🔥':t>=10?'✨':'🫧';}

/* ---------- vibración y confeti ---------- */
function hap(p){try{if(navigator.vibrate)navigator.vibrate(p);}catch(e){}}
function confetti(){try{const C=['#ff4d6d','#ffc145','#ff6b6b','#3ddc97','#ff9a3d','#d81b60'];for(let i=0;i<26;i++){const d=document.createElement('div');d.className='cfti';d.style.left=(Math.random()*100)+'vw';d.style.background=C[i%C.length];d.style.animationDelay=(Math.random()*0.25)+'s';d.style.transform='rotate('+(Math.random()*360)+'deg)';document.body.appendChild(d);setTimeout(()=>d.remove(),1400);}}catch(e){}}

/* ================= DADOS ================= */
SH.dados=()=>{const d=ui.dado||{};
 return `<h2>🎲 Dados picantes</h2><p class="sub">Acción, zona y un extra. Tiradas infinitas.</p>
 <div class="dados">
  <div class="dado" id="d0">${d.v?DVERBO[d.v[0]][0]:'🎲'}</div>
  <div class="dado" id="d1">${d.v?'📍':'🎲'}</div>
  <div class="dado" id="d2">${d.v?DEXTRA[d.v[2]][0]:'🎲'}</div>
 </div>
 <div class="dadotxt" id="dtxt">${d.v?esc(dadoFrase(d.v)):'<span class="sub">Toca para tirar</span>'}</div>
 <div class="row"><button class="btn p" data-a="dadoRoll">🎲 ${d.v?'Otra tirada':'Tirar'}</button></div>
 ${d.v?'<div class="row"><button class="btn g" data-a="dadoHecho">✅ Hecho · sube la temperatura</button></div>':''}`;};
function dadoFrase(v){return `${DVERBO[v[0]][1]} ${DZONA[v[1]][0].toLowerCase()} ${DEXTRA[v[2]][1]}.`;}
A.dados=()=>{ui.dado={};openSheet('dados');};
A.dadoRoll=()=>{audioOn();hap(40);
 const el0=document.getElementById('d0'),el1=document.getElementById('d1'),el2=document.getElementById('d2');
 [el0,el1,el2].forEach(e=>{if(e){e.classList.remove('roll');void e.offsetWidth;e.classList.add('roll');}});
 ui.dado={v:[Math.floor(Math.random()*DVERBO.length),Math.floor(Math.random()*DZONA.length),Math.floor(Math.random()*DEXTRA.length)]};
 setTimeout(()=>{if(ui.sheet&&ui.sheet.k==='dados'){renderSheet();}},480);
 ui._dc=(ui._dc||0)+1;if(ui._dc>=10)logro('dados');};
A.dadoHecho=()=>{heat(10);beep(2);confetti();toast('🔥 +10 de temperatura');renderSheet();};

/* ================= RULETA ================= */
const RSEG=[['noche','🌙','Esta noche'],['atad','🪢','Ataduras'],['rol','🎭','Rol'],['obj','👙','Cajón'],['fuera','🌿','Fuera'],['rem','📱','A distancia'],['dados','🎲','Dados'],['verdad','🎭','Verdad']];
function ruletaColors(){return RSEG.map((s,i)=>i%2?'#2e1c2b':'#3d1527');}
SH.ruleta=()=>{const lv=ui.ruletaLvl||3;const n=RSEG.length;const seg=360/n;
 const grad=RSEG.map((s,i)=>`${ruletaColors()[i]} ${i*seg}deg ${(i+1)*seg}deg`).join(',');
 let res=ui.ruletaRes?`<div class="card" style="margin-top:14px"><div class="txt">${esc(ui.ruletaRes.txt)}</div>${ui.ruletaRes.d?`<div class="row"><button class="btn p" data-a="ruletaGo">⏱️ Empezar · ${durLabel(ui.ruletaRes.d)}</button></div>`:''}<div class="row"><button class="btn g" data-a="ruletaHecho">✅ Hecho</button></div></div>`:'';
 return `<h2>🎡 Ruleta</h2><p class="sub">Gira y que decida la suerte.</p>
 <div class="wheelwrap"><div class="wpin">▼</div><div class="wheel" id="wheel" style="background:conic-gradient(${grad})">${RSEG.map((s,i)=>`<span class="wlbl" style="transform:translate(-50%,-50%) rotate(${i*seg+seg/2}deg) translateY(-66px)">${s[1]}</span>`).join('')}</div></div>
 <div class="lv">${[1,2,3,4,5].map(l=>`<button class="${lv===l?'on':''}" data-a="ruletaLvl" data-v="${l}"><span class="e">${LV[l].e}</span>${LV[l].n}</button>`).join('')}</div>
 <div class="row"><button class="btn p" data-a="ruletaSpin" id="spinbtn">🎡 Girar</button></div>${res}`;};
A.ruleta=()=>{ui.ruletaLvl=ui.ruletaLvl||3;ui.ruletaRes=null;ui.ruletaRot=0;openSheet('ruleta');};
A.ruletaLvl=v=>{ui.ruletaLvl=+v;ui.ruletaRes=null;renderSheet();};
A.ruletaSpin=()=>{const w=document.getElementById('wheel');const btn=document.getElementById('spinbtn');if(!w)return;audioOn();hap(50);
 const n=RSEG.length,seg=360/n;const idx=Math.floor(Math.random()*n);
 const base=(ui.ruletaRot||0);const vueltas=5*360;const target=base+vueltas+ (360-(idx*seg+seg/2));
 ui.ruletaRot=target;w.style.transition='transform 3.1s cubic-bezier(.17,.67,.2,1)';w.style.transform='rotate('+target+'deg)';
 if(btn){btn.disabled=true;}
 setTimeout(()=>{resolveRuleta(RSEG[idx][0]);beep(2);confetti();hap([30,40,80]);},3200);
 ui._rc=(ui._rc||0)+1;if(ui._rc>=10)logro('ruleta');};
function resolveRuleta(cat){const s=S.me,t=ot(s);const l=ui.ruletaLvl||3;
 if(cat==='dados'){const v=[Math.floor(Math.random()*DVERBO.length),Math.floor(Math.random()*DZONA.length),Math.floor(Math.random()*DEXTRA.length)];ui.ruletaRes={txt:'🎲 '+dadoFrase(v),d:null};renderSheet();return;}
 if(cat==='verdad'){ui.ruletaRes={txt:'🎭 '+rnd(VERDADES[l]),d:null};renderSheet();return;}
 let cs=eligible(cat,l,s,t);if(!cs.length){for(let x=l;x>=1&&!cs.length;x--)cs=eligible(cat,x,s,t);}
 if(!cs.length){ui.ruletaRes={txt:'Nada en esta casilla con lo que habéis marcado. Gira otra vez o cambia de nivel.',d:null};}
 else{const r=resolve(rnd(cs),s,t);ui.ruletaRes={txt:r.txt,d:r.d,tips:r.tips};}
 renderSheet();}
A.ruletaGo=()=>{if(ui.ruletaRes&&ui.ruletaRes.d)startTimer(ui.ruletaRes.d,ui.ruletaRes.txt,{t:'free'});};
A.ruletaHecho=()=>{heat(12);confetti();toast('🔥 +12 de temperatura');ui.ruletaRes=null;renderSheet();};

/* ================= VERDAD O RETO ================= */
SH.vr=()=>{const g=ui.vr||{};const turno=g.turn||S.me;
 let body;
 if(g.card){body=`<div class="card"><div class="who">${g.card.kind==='v'?'🎭 Verdad para':'🔥 Reto para'} ${esc(nm(turno))}</div><div class="txt">${esc(g.card.txt)}</div>${g.card.d?`<div class="row"><button class="btn p" data-a="vrGo">⏱️ ${durLabel(g.card.d)}</button></div>`:''}</div><div class="row"><button class="btn g" data-a="vrDone">✅ Cumplido · cambia el turno</button></div><div class="row"><button class="btn" data-a="vrSkip">↻ Otra</button></div>`;}
 else{body=`<p class="sub">Turno de <b>${esc(nm(turno))}</b>. Elige:</p><div class="row"><button class="btn" data-a="vrPick" data-v="v">🎭 Verdad</button><button class="btn p" data-a="vrPick" data-v="r">🔥 Reto</button></div>`;}
 const lv=g.l||3;
 return `<h2>🎭 Verdad o reto</h2>
 <div class="lv">${[1,2,3,4,5].map(l=>`<button class="${lv===l?'on':''}" data-a="vrLvl" data-v="${l}"><span class="e">${LV[l].e}</span>${LV[l].n}</button>`).join('')}</div>
 ${body}`;};
A.vr=()=>{ui.vr={turn:S.me,l:3,card:null};logro('verdad');openSheet('vr');};
A.vrLvl=v=>{ui.vr.l=+v;renderSheet();};
A.vrPick=v=>{const g=ui.vr,s=g.turn,t=ot(s),l=g.l;hap(30);
 if(v==='v'){g.card={kind:'v',txt:rnd(VERDADES[l]),d:null};}
 else{let cs=eligible('azar',l,s,t).filter(c=>c.c!=='pista');if(!cs.length)for(let x=l;x>=1&&!cs.length;x--)cs=eligible('azar',x,s,t).filter(c=>c.c!=='pista');
  if(cs.length){const r=resolve(rnd(cs),s,t);g.card={kind:'r',txt:r.txt,d:r.d};}else g.card={kind:'r',txt:'Nada marcado a este nivel. Baja el nivel o tira una Verdad.',d:null};}
 renderSheet();};
A.vrSkip=()=>{const g=ui.vr;A.vrPick(g.card.kind);};
A.vrGo=()=>{const g=ui.vr;if(g.card&&g.card.d)startTimer(g.card.d,g.card.txt,{t:'free'});};
A.vrDone=()=>{const g=ui.vr;heat(6);g.turn=ot(g.turn);g.card=null;renderSheet();};

/* ================= RUTA DE LA NOCHE ================= */
function buildRuta(){const s=S.me,t=ot(s);const niveles=[1,2,3,4,5];const pasos=[];
 niveles.forEach(l=>{let cs=eligible('azar',l,s,t).filter(c=>c.c!=='pista');if(cs.length)pasos.push(resolve(rnd(cs),s,t));else{const v=[Math.floor(Math.random()*DVERBO.length),Math.floor(Math.random()*DZONA.length),Math.floor(Math.random()*DEXTRA.length)];pasos.push({txt:'🎲 '+dadoFrase(v),d:null});}});
 return pasos;}
SH.ruta=()=>{const g=ui.ruta;
 if(!g||!g.pasos){return `<h2>🌙 Ruta de la noche</h2><p class="sub">Un recorrido que empieza suave y sube de tono, paso a paso. Solo cosas que os gustan a los dos.</p><div class="row"><button class="btn p" data-a="rutaStart">Empezar la ruta</button></div>`;}
 const i=g.i,p=g.pasos[i],pct=Math.round((i)/g.pasos.length*100);
 return `<h2>🌙 Ruta de la noche</h2><div class="heatbar"><i style="width:${pct}%"></i></div><p class="sub">Paso ${i+1} de ${g.pasos.length} · ${LV[i+1]?LV[i+1].e:''}</p>
 <div class="card"><div class="txt">${esc(p.txt)}</div>${p.d?`<div class="row"><button class="btn p" data-a="rutaTimer">⏱️ ${durLabel(p.d)}</button></div>`:''}</div>
 <div class="row"><button class="btn g" data-a="rutaNext">${i>=g.pasos.length-1?'🔥 Terminar la ruta':'✅ Hecho · siguiente'}</button><button class="btn mini" data-a="rutaSwap">↻</button></div>`;};
A.ruta=()=>{ui.ruta={};openSheet('ruta');};
A.rutaStart=()=>{ui.ruta={pasos:buildRuta(),i:0};heat(5);renderSheet();};
A.rutaTimer=()=>{const g=ui.ruta,p=g.pasos[g.i];if(p&&p.d)startTimer(p.d,p.txt,{t:'free'});};
A.rutaSwap=()=>{const g=ui.ruta,s=S.me,t=ot(s),l=g.i+1;let cs=eligible('azar',l,s,t).filter(c=>c.c!=='pista');if(cs.length)g.pasos[g.i]=resolve(rnd(cs),s,t);renderSheet();};
A.rutaNext=()=>{const g=ui.ruta;heat(8);if(g.i>=g.pasos.length-1){logro('ruta');confetti();beep(3);hap([40,60,120]);toast('🌋 Ruta completa. ¡Qué noche!');closeSheet();render(true);return;}g.i++;renderSheet();};

/* ================= RETO RELÁMPAGO ================= */
A.relampago=()=>{const s=S.me,t=ot(s);let cs=[];[4,3,5,2].forEach(l=>{if(!cs.length)cs=eligible('azar',l,s,t).filter(c=>c.c!=='pista');});
 if(!cs.length){toast('Aún no hay retos que encajen. Terminad el cuestionario');return;}
 const r=resolve(rnd(cs),s,t);send({c:'noche',l:3,txt:'⚡ Reto relámpago: '+r.txt,used:r.used,tips:r.tips,d:r.d});heat(8);confetti();hap([20,40,20]);};

/* ---------- init: sumar cartas extra y arrancar logros ---------- */
EXTRA_RAW.forEach((x,i)=>CARDS.push({id:'cx'+i,c:x[0],l:x[1],t:x[2],r:x[3]?x[3].split(' '):[],g:x[4]==='g',d:x[5]?String(x[5]).split('+').map(Number):null}));

/* ---------- piezas de inicio ---------- */
function tempHero(){const t=tempNow();const p=(S.pts.a||0)+(S.pts.b||0);const r=rangoDe(p);const nx=rangoNext(p);
 return `<div class="hero"><div class="herotop"><span class="rango">${r[2]} ${esc(r[1])}</span><span class="sub">${nx?`${nx[0]-p} pts para ${esc(nx[1])} ${nx[2]}`:'Rango máximo 👑'}</span></div>`+
 `<div class="heat"><span class="flame">${tempEmoji(t)}</span><div class="heatbar"><i style="width:${t}%"></i></div><b>${t}°</b></div>`+
 `<small class="sub" style="font-size:12.5px">Vuestra temperatura sube al jugar y baja sola con el tiempo.</small></div>`;}
function juegosGrid(){const G=[['dados','🎲','Dados','Acción + zona'],['ruleta','🎡','Ruleta','La suerte decide'],['vr','🎭','Verdad o reto','Preguntas y retos'],['ruta','🌙','Ruta de la noche','Sube de tono'],['partida','🃏','Partida','Por turnos'],['relampago','⚡','Reto relámpago','Mándale uno ya']];
 return `<h2>🎮 Jugar</h2><div class="grid2">`+G.map(x=>`<button class="tile game" data-a="${x[0]}"><span class="e">${x[1]}</span><b>${esc(x[2])}</b><small>${esc(x[3])}</small></button>`).join('')+`</div>`;}
/* =================================================================
   Pantallas de arranque, importador de archivo, avisos y boot.
   ================================================================= */

/* ---------------- pantallas previas ---------------- */
function vBoot(){return `<div class="lock"><div style="font-size:48px">🔥</div><div class="sub">Abriendo…</div></div>`;}
function vFatal(){return `<div class="lock"><div style="font-size:44px">🔥</div><p class="sub" style="max-width:300px;text-align:center">${esc(fatalMsg)}</p><div class="row" style="max-width:280px"><button class="btn" data-a="logout">Salir</button></div></div>`;}
function vPass(){return `<div class="lock"><div style="font-size:46px">🔒</div><h1 style="text-align:center;margin:0">Clave de pareja</h1><p class="sub" style="max-width:330px;text-align:center">La misma en los dos móviles. Es la que cifra todo lo vuestro. No se guarda en ningún servidor: si la perdéis, no hay forma de recuperar lo de dentro.</p><div style="width:100%;max-width:330px"><input id="passIn" type="password" placeholder="Clave de pareja" autocomplete="off" autocapitalize="off"><div class="row"><button class="btn p" data-a="passGo">Entrar</button></div></div></div>`;}

A.passGo=async()=>{const el=$('#passIn');const v=(el&&el.value||'').trim();if(v.length<6){toast('Al menos 6 caracteres');return;}toast('Comprobando…');await submitPass(v);};
A.logout=()=>{if(confirm('¿Salir de la cuenta en este móvil?'))SHELL.logout();};

/* ---------------- arranque ---------------- */
async function boot(){
 try{
  const mem=await sb.from('members').select('slot,name,pts').eq('user_id',SHELL.user.id).maybeSingle();
  if(mem.error||!mem.data){fatalMsg='Tu cuenta no está vinculada a Llama. Pídeselo a quien la creó.';screen='fatal';render();return;}
  ME.slot=mem.data.slot;ME.uid=SHELL.user.id;S.me=mem.data.slot;
  CK=await idbGet('ck');
  if(CK){await afterKey();}else{screen='pass';render();}
 }catch(e){fatalMsg='No he podido abrir: '+e.message;screen='fatal';render();}
}
async function submitPass(pass){
 try{
  const key=await deriveKey(pass);CK=key;
  const chk=await sb.from('docs').select('e').eq('k','shared.check').maybeSingle();
  if(chk.data){const o=await dec(chk.data.e);if(!o){CK=null;toast('Esa clave no coincide con la del otro móvil');return;}}
  else{await putDoc('shared.check',{ok:1,v:2,at:Date.now()});}
  await idbSet('ck',key);
  await afterKey();
 }catch(e){CK=null;toast('No he podido entrar. Revisa la conexión');}
}
async function afterKey(){
 if(dev.get('pin')){screen='pin';pinBuf='';render();return;}
 await enterApp();
}
async function enterApp(){
 screen='app';render();            // muestra "Abriendo…" → app vacía mientras carga
 try{await loadAll();}catch(e){}
 BOOTED=true;render();subscribe();
 if(dev.get('push'))ensurePush();
}

/* ---------------- tiempo real + refresco ---------------- */
let _ch=null,_rf=null;
function subscribe(){
 try{
  if(_ch)return;
  _ch=sb.channel('llama-rt');
  ['docs','props','chat','vales','feed','members','fantasies'].forEach(t=>_ch.on('postgres_changes',{event:'*',schema:'public',table:t},schedRefetch));
  _ch.subscribe();
 }catch(e){}
}
function schedRefetch(){clearTimeout(_rf);_rf=setTimeout(async()=>{if(screen==='app'&&BOOTED){try{await loadAll();}catch(e){}render(true);}},600);}
setInterval(()=>{if(screen==='app'&&BOOTED&&document.visibilityState==='visible')schedRefetch();},30000);
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible'&&screen==='app'&&BOOTED)schedRefetch();});

/* ---------------- avisar al otro móvil ---------------- */
function notify(){try{sb.functions.invoke('aviso',{body:{}});}catch(e){}}

/* ---------------- activar avisos (push) en este móvil ---------------- */
function _urlB64(s){const pad='='.repeat((4-s.length%4)%4);const b=(s+pad).replace(/-/g,'+').replace(/_/g,'/');return Uint8Array.from(atob(b),c=>c.charCodeAt(0));}
async function pushOn(){
 try{
  if(!('serviceWorker'in navigator)||!('PushManager'in window)){toast('Este móvil no admite avisos. En iPhone: añade Llama a la pantalla de inicio primero');return;}
  const perm=await Notification.requestPermission();
  if(perm!=='granted'){toast('Avisos no permitidos');return;}
  await ensurePush(true);
 }catch(e){toast('No se pudo activar: '+(e.message||e));}
}
async function ensurePush(force){
 try{
  const reg=await navigator.serviceWorker.ready;
  let sub=await reg.pushManager.getSubscription();
  if(!sub){
   const cfg=await sb.from('config').select('v').eq('k','vapid_public').maybeSingle();
   let pub=cfg.data&&cfg.data.v;
   if(!pub){const r=await sb.functions.invoke('aviso',{body:{setup:true}});pub=r.data&&r.data.pub;}
   if(!pub){if(force)toast('No he podido preparar los avisos');return;}
   sub=await reg.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:_urlB64(pub)});
  }
  const j=sub.toJSON();
  await sb.from('push_subs').upsert({user_id:ME.uid,endpoint:sub.endpoint,p256dh:j.keys.p256dh,auth:j.keys.auth},{onConflict:'endpoint'});
  dev.set('push',1);if(force){toast('Avisos activados 🔔');render(true);}
 }catch(e){if(force)toast('No se pudo activar: '+(e.message||e));}
}
A.pushOn=()=>pushOn();

/* =================================================================
   IMPORTADOR DE ARCHIVO
   Lee un .txt de retos, lo reparte por categorías y niveles, pone
   nombres, saca temporizadores y marca qué hace falta aceptar en el
   cuestionario. Descarta por seguridad lo peligroso.
   ================================================================= */
const LVWORD=[[/sin filtro|s[uú]per\s*caliente/i,5],[/muy\s*caliente/i,4],[/\bcaliente/i,3],[/coqueto/i,2],[/tierno/i,2]];
function lvlFromLine(s){for(const w of LVWORD)if(w[0].test(s))return w[1];const m=s.match(/nivel\s*([1-5])/i);if(m)return Math.min(5,Math.max(1,+m[1]));return null;}
const CATWORD=[[/prelimin|caric|\bbeso/i,'noche'],[/oral|felaci|cunnil|mamad/i,'noche'],[/postur|posici/i,'noche'],[/atadur|bondage/i,'atad'],[/juguete/i,'obj'],[/\brol\b|fantas|disfraz/i,'rol'],[/fuera|p[uú]blic|exterior/i,'fuera'],[/distancia|mensaj|sexting|whatsapp/i,'rem']];
function catFromLine(s){for(const w of CATWORD)if(w[0].test(s))return w[1];return null;}
const NUMW={un:1,una:1,dos:2,tres:3,cuatro:4,cinco:5,seis:6,siete:7,ocho:8,nueve:9,diez:10,quince:15,veinte:20,treinta:30};
function timerFrom(s){let m=s.match(/(\d+)\s*minut/i);if(m)return[Math.min(60,+m[1])*60];m=s.match(/\b(un|una|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|quince|veinte|treinta)\s*minut/i);if(m)return[(NUMW[m[1].toLowerCase()]||5)*60];if(/temporizador|cron[oó]metro/i.test(s))return[300];return null;}
const DANGER=/respiraci[oó]n|aliento|asfixi|ahog|sin aire|falta de aire|mordaza|amordaz|estrangul|garganta|alrededor del cuello|aprieta.*cuello|mano.*cuello/i;
const REQMAP=[[/\banal\b|por el culo|penetraci[oó]n anal/i,'anal'],[/consolador|dildo/i,'consolador'],[/azot|nalgad|palmad|spank|f[uú]st|l[aá]tig/i,'azotes'],[/dominaci|sumis|a cuatro patas|de rodillas|obedec|[oó]rdenes|amo\b|ama\b|esclav/i,'dominacion'],[/edging|al borde|no te corras|aguanta.*orgasmo|control.*orgasmo/i,'control'],[/muerd|mordisc/i,'mordiscos'],[/mast[uú]rba|t[oó]cate|hazte/i,'masturbarse'],[/nata|chocolate|miel|fresa|comida/i,'comida'],[/foto|v[ií]deo|graba|c[aá]mara/i,'explicitas'],[/oral|boca|chup|lam|felaci|cunnil|mamad/i,'oral'],[/esposa|cuerda|ata(r|d)|mu[ñn]eca|cabecero|inmoviliz/i,'atar'],[/venda|ojos tapad|antifaz/i,'vendar'],[/vibrador/i,'vibrador'],[/ba[ñn]o del? (restaurante|bar)/i,'banyo'],[/fuera de casa|en la calle|en el coche/i,'fuera']];
function reqsOf(t){const s=t.toLowerCase();const out=[];for(const w of REQMAP)if(w[0].test(s)&&out.indexOf(w[1])<0)out.push(w[1]);return out;}
function impTips(t,req){const o=[];const s=t.toLowerCase();
 if(req.indexOf('atar')>=0||/esposa|cuerda|atad/.test(s)){o.push('🚦 Semáforo activo · palabra: '+S.word);o.push('🔑 Llave o tijera a mano. Nada alrededor del cuello');}
 if(req.indexOf('explicitas')>=0||/foto|v[ií]deo/.test(s))o.push('📸 Hazlo desde el chat de la app: se ve una vez y no va al carrete');
 if(req.indexOf('anal')>=0)o.push('💧 Lubricante y calma. Para a la mínima molestia');
 return o;}
const ITEM=/^\s*\d+\s*[.)]\s*(?:\d+\s*[—–\-:]\s*)?(.+)$/;
function parseFile(text){
 const lines=text.split(/\r?\n/);let cat='noche',lvl=3;const cards=[];let skipped=0,total=0;
 const ne=lines.filter(l=>l.trim()).length;
 const numbered=lines.filter(l=>ITEM.test(l.trim())).length;
 const mode=(numbered>=8&&numbered>=ne*0.2)?'num':'line';
 for(const raw of lines){
  const line=raw.trim();if(!line)continue;
  const c=catFromLine(line),l=lvlFromLine(line);
  const header=mode==='num'?!ITEM.test(line):((line===line.toUpperCase()&&line.length<48)||/^nivel\b/i.test(line)||((c||l)&&line.split(/\s+/).length<=4));
  if(header){if(c)cat=c;if(l)lvl=l;continue;}
  let body;
  if(mode==='num'){const mm=line.match(ITEM);if(!mm)continue;body=mm[1].trim();}
  else body=line.replace(/^\s*(?:\d+\s*[.)]\s*)?(?:\d+\s*[—–\-:]\s*)?/,'').replace(/^[-–•*]\s*/,'').trim();
  if(body.length<(mode==='num'?6:14))continue;
  total++;
  if(DANGER.test(body)){skipped++;continue;}
  body=body.replace(/\bJohn\b/g,'{A}').replace(/\bMary\b/g,'{B}').replace(/\bJuan\b/g,'{A}').replace(/\bMar[ií]a\b/g,'{B}');
  const req=reqsOf(body);
  let cc=cat;if(/esposa|cuerda|atad|inmoviliz|cabecero/i.test(body))cc='atad';
  cards.push({id:'imp'+uid(),c:cc,l:lvl,t:body,imp:true,req,g:/foto|v[ií]deo/i.test(body),d:timerFrom(body),tips:impTips(body,req),by:ME.slot});
 }
 return{cards,skipped,total,mode};
}
function openTo(slot,id){const v=S.q[slot]||{};if(typeof v[id]==='number')return v[id]>=1;if(typeof v[id+'_d']==='number'||typeof v[id+'_r']==='number')return (v[id+'_d']>=1)||(v[id+'_r']>=1);return false;}
function impOK(c){if(!both())return false;const L=S.lim.a.concat(S.lim.b);if((c.req||[]).some(id=>L.some(l=>(LIMRULE[l]||[]).indexOf(id)>=0)))return false;return (c.req||[]).every(id=>openTo('a',id)&&openTo('b',id));}
const IMPCAP=300;
function applyImport(text){
 const r=parseFile(text);
 if(!r.cards.length){toast(r.total?'Todo lo del archivo se ha descartado por seguridad':'No he encontrado retos en el archivo');return;}
 const have=new Set(S.custom.map(c=>c.t));let add=0,lleno=false;
 for(const c of r.cards){if(S.custom.length>=IMPCAP){lleno=true;break;}if(!have.has(c.t)){S.custom.push(c);have.add(c.t);add++;}}
 save();
 const faltan=both()?'':' Para que aparezcan, los dos tenéis que terminar el cuestionario.';
 const tope=lleno?` · tope de ${IMPCAP}, el resto no cabe`:'';
 toast(`${add} añadidos${r.skipped?` · ${r.skipped} descartados por seguridad`:''}${tope}.${faltan}`);
 render(true);
}
A.impExample=()=>{window.scrollTo(0,0);toast('Elige el archivo .txt con el botón de arriba');};

/* ---------------- puente de depuración ---------------- */
try{globalThis.__llama={get S(){return S;},set S(v){S=v;},ME,setCK(k){CK=k;},get CK(){return CK;},get screen(){return screen;},set screen(v){screen=v;},get ui(){return ui;},enc,dec,deriveKey,parseFile,applyImport,resolve,eligible,pickSug,impOK,matches,makePlan,genPistas,both,fresh,render,VIEWS,header,nav,CARDS,SECS,CATS,LV,SH,dadoFrase,buildRuta,tempNow,rangoDe,rangoNext,tempHero,juegosGrid,VERDADES,DVERBO,RSEG};}catch(e){}

/* ---------------- a jugar ---------------- */
boot();
