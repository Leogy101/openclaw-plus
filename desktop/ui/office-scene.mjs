// Original pixel drawing. This module presents observations; it does not infer work.
import { OFFICE_NAME } from '../shared/office-cast.mjs';

const GLYPHS = {
  A:'01110/10001/10001/11111/10001/10001/10001',B:'11110/10001/10001/11110/10001/10001/11110',C:'01111/10000/10000/10000/10000/10000/01111',
  D:'11110/10001/10001/10001/10001/10001/11110',E:'11111/10000/10000/11110/10000/10000/11111',F:'11111/10000/10000/11110/10000/10000/10000',
  G:'01111/10000/10000/10111/10001/10001/01111',H:'10001/10001/10001/11111/10001/10001/10001',I:'111/010/010/010/010/010/111',
  J:'00111/00010/00010/00010/10010/10010/01100',K:'10001/10010/10100/11000/10100/10010/10001',L:'10000/10000/10000/10000/10000/10000/11111',
  M:'10001/11011/10101/10101/10001/10001/10001',N:'10001/11001/10101/10011/10001/10001/10001',O:'01110/10001/10001/10001/10001/10001/01110',
  P:'11110/10001/10001/11110/10000/10000/10000',Q:'01110/10001/10001/10001/10101/10010/01101',R:'11110/10001/10001/11110/10100/10010/10001',
  S:'01111/10000/10000/01110/00001/00001/11110',T:'11111/00100/00100/00100/00100/00100/00100',U:'10001/10001/10001/10001/10001/10001/01110',
  V:'10001/10001/10001/10001/10001/01010/00100',W:'10001/10001/10001/10101/10101/10101/01010',X:'10001/10001/01010/00100/01010/10001/10001',
  Y:'10001/10001/01010/00100/00100/00100/00100',Z:'11111/00001/00010/00100/01000/10000/11111',
  0:'01110/10001/10011/10101/11001/10001/01110',1:'00100/01100/00100/00100/00100/00100/01110',2:'01110/10001/00001/00010/00100/01000/11111',
  3:'11110/00001/00001/01110/00001/00001/11110',4:'00010/00110/01010/10010/11111/00010/00010',5:'11111/10000/10000/11110/00001/00001/11110',
  6:'01110/10000/10000/11110/10001/10001/01110',7:'11111/00001/00010/00100/01000/01000/01000',8:'01110/10001/10001/01110/10001/10001/01110',9:'01110/10001/10001/01111/00001/00001/01110',
  '-':'000/000/000/111/000/000/000','+':'00000/00100/00100/11111/00100/00100/00000','.':'0/0/0/0/0/1/1','?':'1110/0001/0010/0100/0100/0000/0100',' ':'000/000/000/000/000/000/000',
};
const WIDTH=576,HEIGHT=324,LANE=158;
const TEAM=[
  {id:'main',name:'Tom',color:'#709fbc',home:{x:94,y:96},gate:170,break:{x:355,y:291,gate:329},hair:'#655044'},
  {id:'spike',name:'Spike',color:'#d78667',home:{x:65,y:267},gate:106,break:{x:405,y:241,gate:465},hair:'#3e3532'},
  {id:'athena',name:'Athena',color:'#b5a0d4',home:{x:165,y:267},gate:206,break:{x:500,y:247,gate:530},hair:'#484459'},
  {id:'goose',name:'Goose',color:'#a5bb70',home:{x:265,y:267},gate:306,break:{x:417,y:291,gate:465},hair:'#906a46'},
];
const BOSS={id:'boss',name:'The Boss',color:'#b79b60',home:{x:464,y:96},gate:396,hair:'#b8b29a',owner:true};
const palettes={
  dark:{back:'#202823',edge:'#394339',wall:'#b9b49a',wallTop:'#d8d1b4',wallShade:'#8b8d72',floor:'#96795b',plank:'#a18461',seam:'#806b51',hall:'#c3b18a',tile:'#d0c19d',tileLine:'#a49673',rug:'#6c7c62',wood:'#79573e',woodLight:'#b28c5d',woodEdge:'#534731',glass:'#6b8d98',glassLight:'#adc4ba',ink:'#30392e',paper:'#e9e4c9',green:'#abc886',gold:'#c6a45b',goldLight:'#e4ca86',goldDark:'#927640',shadow:'#695b45',olive:'#68774c'},
  light:{back:'#e6e4d5',edge:'#5a634c',wall:'#e2dcc4',wallTop:'#faf0d4',wallShade:'#b4b396',floor:'#c4a27c',plank:'#cfaf86',seam:'#b59673',hall:'#ded1ab',tile:'#eee3c3',tileLine:'#c6b98f',rug:'#9eae88',wood:'#97744d',woodLight:'#c9a36a',woodEdge:'#76603f',glass:'#a2c8ca',glassLight:'#d9e8d5',ink:'#3d4935',paper:'#fff7db',green:'#64844b',gold:'#c8a24f',goldLight:'#f2d995',goldDark:'#a0823d',shadow:'#a78e6d',olive:'#7e8c59'},
};
const clock=value=>Number.isFinite(value)?Math.max(0,value):0;
const roster=input=>TEAM.map(person=>({...person,state:['working','idle'].includes(input?.find?.(agent=>agent?.id===person.id)?.state)?input.find(agent=>agent?.id===person.id).state:'unknown'}));

export function createOfficeScene(canvas){
  const ctx=canvas.getContext('2d',{alpha:false});
  if(!ctx)throw new Error('The Office illustration needs a canvas context.');
  let boundEvent=null,boundRoute=null;
  const rect=(x,y,w,h,color)=>{ctx.fillStyle=color;ctx.fillRect(Math.round(x),Math.round(y),Math.round(w),Math.round(h));};
  function text(value,x,y,color,maxWidth,alignment='left'){
    const label=String(value??'').normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toUpperCase();
    const letters=[];
    let width=0;
    for(const letter of label){
      const rows=(GLYPHS[letter]||GLYPHS['?']).split('/');
      const offset=letters.length ? width+1 : 0;
      if(offset+rows[0].length>maxWidth)break;
      letters.push({rows,offset});
      width=offset+rows[0].length;
    }
    const start=alignment==='center' ? x+Math.floor((maxWidth-width)/2) : x;
    for(const {rows,offset} of letters){
      rows.forEach((row,dy)=>[...row].forEach((pixel,dx)=>{
        if(pixel==='1')rect(start+offset+dx,y+dy,1,1,color);
      }));
    }
  }
  function label(value,x,y,width,p,color=p.paper){
    rect(x,y,width,12,color);
    text(value,x+4,y+3,p.ink,width-8,'center');
  }
  function plant(x,y,p,large=false){
    const scale=large?2:1;
    rect(x+3*scale,y+11*scale,8*scale,6*scale,p.woodEdge);rect(x+2*scale,y+9*scale,10*scale,3*scale,p.woodLight);
    rect(x+6*scale,y+2*scale,2*scale,9*scale,'#426448');rect(x,y+3*scale,7*scale,4*scale,'#77936a');
    rect(x+7*scale,y,6*scale,5*scale,'#97ab76');rect(x+5*scale,y+5*scale,9*scale,4*scale,'#52734e');rect(x+scale,y+2*scale,3*scale,2*scale,'#b1bd83');
  }
  function parcel(x,y,p){rect(x-1,y+1,10,8,p.woodEdge);rect(x,y,8,7,p.goldLight);rect(x+3,y,2,7,p.gold);rect(x,y+2,8,1,p.goldDark);}
  function mug(x,y,p){rect(x,y,5,5,p.paper);rect(x+5,y+1,2,3,p.paper);rect(x+1,y,3,1,p.woodEdge);}
  function sprite(point,person,{walking=false,working=false,sip=false,idlePose=0,frame=0,carrying=false,side=1}={},p){
    const x=Math.round(point.x),y=Math.round(point.y),hx=x+idlePose,step=walking?(frame%2?1:-1):0,hand=working&&frame%2?1:0;
    rect(x-7,y+11,15,3,p.shadow);rect(x-4,y+5,3,7+step,'#39413b');rect(x+2,y+5,3,7-step,'#39413b');
    rect(x-5,y+11+step,4,2,p.ink);rect(x+2,y+11-step,4,2,p.ink);rect(x-5,y-3,11,10,person.color);
    rect(x-7,y-1+hand,2,6,'#d6a77c');rect(x+6,y-1-hand,2,6,'#d6a77c');rect(x-2,y-5,5,3,'#d6a77c');
    rect(hx-4,y-12,9,8,'#e2b78b');rect(hx-5,y-13,10,3,person.hair);rect(hx-5,y-11,2,4,person.hair);
    rect(hx-2,y-8,1,1,p.ink);rect(hx+3,y-8,1,1,p.ink);rect(hx,y-4,2,1,'#ba815f');rect(x-2,y-2,5,2,person.owner?p.goldLight:'#e5ddbe');
    if(person.id==='athena'){rect(hx-5,y-16,5,4,person.hair);rect(hx-3,y-9,3,2,p.paper);rect(hx+2,y-9,3,2,p.paper);rect(hx,y-9,2,1,p.ink);}
    if(person.id==='goose'){rect(hx-5,y-14,10,3,person.color);rect(hx+3,y-12,4,2,person.color);}
    if(person.owner){rect(x,y,1,5,p.goldLight);rect(x-7,y-10,2,3,p.goldDark);rect(x+5,y-10,2,3,p.goldDark);}
    if(sip){rect(x+5,y-5,3,5,'#d6a77c');mug(x+3,y-8,p);}
    if(carrying)parcel(x+(side<0?-13:7),y+1,p);
  }
  function desk(x,y,person,p,time,reducedMotion,boss=false){
    const working=person.state==='working',wood=boss?p.goldLight:p.woodLight;
    rect(x+3,y+17,4,13,p.woodEdge);rect(x+57,y+17,4,13,p.woodEdge);rect(x-1,y+2,66,19,p.woodEdge);
    rect(x,y,64,17,wood);rect(x+2,y+2,60,1,boss?'#fff0b2':'#dabb81');
    rect(x+20,y-13,28,19,p.ink);rect(x+22,y-11,24,14,working?'#425b48':'#4f6362');
    rect(x+32,y+6,3,3,p.ink);rect(x+28,y+9,12,2,p.ink);rect(x+22,y+12,25,3,p.paper);
    if(working){const shift=reducedMotion?0:Math.floor(time/400)%3;rect(x+25,y-7,10+shift*2,1,p.green);rect(x+25,y-3,15,1,'#c1d3a5');rect(x+25,y+1,6+shift,1,p.green);}
    else {rect(x+27,y-6,12,1,p.glass);rect(x+27,y-2,8,1,p.glass);}
    mug(x+6,y+7,p);rect(x+53,y+6,7,9,p.paper);rect(x+54,y+8,5,1,p.wallShade);rect(x+54,y+11,5,1,p.wallShade);
    rect(person.home.x-7,person.home.y-8,15,16,boss?'#79613b':'#596953');rect(person.home.x-8,person.home.y+2,17,4,boss?p.goldDark:'#485b47');
  }
  function windowPane(x,y,w,p){rect(x,y,w,23,p.woodEdge);rect(x+2,y+2,w-4,18,p.glass);rect(x+3,y+3,w-7,3,p.glassLight);rect(x+Math.floor(w/2),y+2,2,18,p.wall);rect(x-1,y+21,w+2,3,p.wallTop);}
  function shelves(x,y,p){
    rect(x,y,29,29,p.woodEdge);rect(x+2,y+2,25,10,p.woodLight);rect(x+2,y+16,25,10,p.woodLight);
    for(let i=0;i<5;i++){rect(x+3+i*4,y+3+i%2,3,8-i%2,TEAM[i%4].color);rect(x+3+i*4,y+18,2,7,p.paper);}
  }
  function office(person,p,time,reducedMotion){
    const boss=person.owner,x=boss?376:20,y=20,w=180,h=116;
    rect(x+2,y+5,w,h,p.shadow);rect(x,y,w,h,p.edge);rect(x+4,y+5,w-8,h-9,boss?p.olive:p.floor);
    for(let row=13;row<h-4;row+=13){rect(x+4,y+row,w-8,1,boss?p.rug:p.seam);for(let col=row%26?18:40;col<w-8;col+=42)rect(x+col,y+row+1,1,12,boss?p.rug:p.seam);}
    rect(x+1,y+1,w-2,8,boss?p.gold:p.wall);rect(x+1,y+1,w-2,2,boss?p.goldLight:p.wallTop);
    rect(x+1,y+9,3,h-13,p.wallShade);rect(x+w-4,y+9,3,h-13,p.wallShade);rect(x,y+h-5,w,5,boss?p.gold:p.wall);
    windowPane(x+12,y+13,54,p);shelves(x+w-43,y+13,p);
    if(boss){rect(x+88,y+15,20,17,p.goldDark);rect(x+90,y+17,16,13,p.goldLight);rect(x+95,y+19,6,9,p.gold);}
    rect(person.home.x-38,y+67,80,32,boss?p.gold:p.rug);rect(person.home.x-35,y+70,74,26,boss?p.goldLight:p.rug);
    if(boss)rect(person.home.x-31,y+74,66,18,p.gold);
    desk(person.home.x-31,y+43,person,p,time,reducedMotion,boss);plant(boss?x+w-24:x+9,y+81,p);
    const door=person.gate;rect(door-10,y+h-5,21,6,p.hall);rect(door-11,y+h-5,2,6,p.woodEdge);rect(door+10,y+h-5,2,6,p.woodEdge);rect(door-9,y+h-7,19,2,p.tile);
    // Nameplates sit away from each doorway; only these two rooms have walls.
    label(boss?'THE BOSS':'TOM',boss?448:43,y+h-18,boss?75:54,p,boss?p.goldLight:p.paper);
  }
  function breakArea(p){
    // A change in floor finish, not a partition: the whole lower floor stays open.
    rect(340,184,215,124,p.hall);for(let y=185;y<303;y+=16)for(let x=342;x<548;x+=16)rect(x,y,14,14,p.tile);
    rect(359,211,95,20,p.woodEdge);rect(361,213,91,16,p.woodLight);rect(357,208,99,5,p.paper);
    for(let i=0;i<3;i++){rect(363+i*29,215,26,12,p.wood);rect(373+i*29,217,6,1,p.goldLight);}
    // Drip machine, dark coffee pot, handle, hotplate and three ceramic mugs.
    rect(368,193,21,15,p.ink);rect(370,195,17,4,p.woodLight);rect(370,201,4,7,p.ink);rect(382,201,5,7,p.ink);
    rect(375,200,8,7,'#b5bbaa');rect(376,203,6,4,'#654b35');rect(383,201,3,4,p.paper);rect(373,207,14,2,p.ink);
    rect(375,190,1,2,p.paper);rect(378,187,1,3,p.paper);mug(398,202,p);mug(410,202,p);mug(422,202,p);rect(438,198,9,10,p.goldDark);text('T',440,200,p.paper,5);
    // Blue bottle, shoulder, tap, drip tray and stacked paper cups.
    rect(496,200,14,13,'#699fb6');rect(498,198,10,3,'#9fc5d4');rect(498,201,3,9,'#b1d4de');rect(499,213,8,3,'#6590a1');
    rect(493,216,20,22,p.paper);rect(496,220,14,9,'#aec1c2');rect(498,221,3,3,'#617d8a');rect(505,221,3,3,'#c58b70');rect(496,232,14,3,p.ink);
    rect(517,217,6,10,p.woodEdge);rect(518,215,4,9,p.paper);rect(518,217,4,1,p.wallShade);rect(518,220,4,1,p.wallShade);
    // Low lounge seating leaves a generous passage around the coffee counter.
    rect(346,261,93,26,p.shadow);rect(348,258,89,22,p.olive);rect(350,254,85,10,p.rug);rect(347,262,8,20,p.olive);rect(430,262,8,20,p.olive);
    rect(357,266,31,12,p.rug);rect(393,266,33,12,p.rug);rect(360,267,6,3,p.wall);rect(352,282,4,4,p.woodEdge);rect(431,282,4,4,p.woodEdge);
    plant(537,272,p);rect(476,270,39,18,p.woodEdge);rect(478,268,35,16,p.woodLight);mug(482,273,p);rect(495,271,12,8,p.paper);rect(497,273,8,1,p.olive);
  }
  function background(people,p,time,reducedMotion){
    rect(0,0,WIDTH,HEIGHT,p.back);rect(10,12,556,304,p.edge);rect(14,16,548,296,p.floor);
    for(let y=20;y<310;y+=13){rect(15,y,546,1,p.seam);for(let x=y%26?25:48;x<560;x+=43)rect(x,y+1,1,Math.min(12,311-y),p.seam);}
    rect(14,140,548,37,p.hall);rect(14,141,548,2,p.tile);rect(14,174,548,2,p.tileLine);
    rect(21,157,534,1,p.tileLine);for(let x=24;x<552;x+=27)rect(x,151,14,1,p.tile);
    office(people[0],p,time,reducedMotion);office(BOSS,p,time,reducedMotion);
    // An olive-and-gold foyer sign and notice board mark the shared space.
    windowPane(233,22,110,p);rect(239,56,99,24,p.olive);rect(241,58,95,1,p.goldLight);text(OFFICE_NAME,239,64,p.goldLight,99,'center');
    rect(248,88,83,33,p.woodEdge);rect(251,91,77,27,p.goldDark);rect(256,95,18,18,p.paper);rect(280,94,18,20,'#d3bd85');rect(305,96,15,17,'#a7bc97');
    rect(263,94,3,2,p.ink);rect(287,93,3,2,p.ink);rect(310,95,3,2,p.ink);rect(258,101,12,1,p.wallShade);rect(258,105,10,1,p.wallShade);
    plant(217,108,p);plant(342,108,p);
    rect(24,209,293,90,p.rug);rect(27,212,287,1,'#9aa985');rect(27,295,287,1,'#536a4a');
    text('OPEN STUDIO',36,192,p.paper,145);
    for(const person of people.slice(1)){desk(person.home.x-31,226,person,p,time,reducedMotion);label(person.name,person.home.x-27,286,60,p);rect(person.home.x+25,289,3,6,person.color);}
    breakArea(p);
  }
  function ambient(person,time,reducedMotion){
    if(person.owner||person.state!=='idle')return {...person.home,zone:person.owner||person.id==='main'?'office':'desk',walking:false,sip:false};
    const anchor=person.break,offset=TEAM.findIndex(item=>item.id===person.id)*1800,phase=reducedMotion?0:(time+offset)%14000;
    let dx=0,dy=0,walking=false;
    if(!reducedMotion&&phase<2600){walking=true;const progress=phase/2600;
      if(progress<.25)dx=progress*24;else if(progress<.5){dx=6;dy=(progress-.25)*12;}else if(progress<.75){dx=6-(progress-.5)*24;dy=3;}else dy=3-(progress-.75)*12;}
    return {x:anchor.x+dx,y:anchor.y+dy,zone:'break',gate:anchor.gate,walking,sip:!reducedMotion&&['spike','athena'].includes(person.id)&&phase>5200&&phase<6900};
  }
  function entrance(person,point){
    if(point.zone==='office')return [point,{x:person.gate,y:point.y},{x:person.gate,y:135},{x:person.gate,y:LANE}];
    const gate=point.zone==='break'?person.break.gate:person.gate;
    return [point,{x:gate,y:point.y},{x:gate,y:LANE}];
  }
  function routeFor(event,people,time){
    if(!event||!['delegation','handoff','report'].includes(event.kind))return null;
    if(boundEvent&&(event===boundEvent||event.id!=null&&event.id===boundEvent.id)&&event.from===boundEvent.from&&event.to===boundEvent.to&&event.kind===boundEvent.kind)return boundRoute;
    const from=people.find(person=>person.id===event.from),to=event.kind==='report'&&event.from==='main'&&event.to==null?BOSS:people.find(person=>person.id===event.to);
    if(!from||!to||from.id===to.id||event.kind==='report'&&to!==BOSS)return null;
    const start=ambient(from,time,false),recipient=ambient(to,time,false),visit={...recipient,x:recipient.x+(to.owner||to.id==='main'&&recipient.zone==='break'?-18:18)};
    const exit=entrance(from,start),entry=entrance(to,visit).reverse(),points=[...exit,...entry];
    const length=points.slice(1).reduce((sum,point,i)=>sum+Math.abs(point.x-points[i].x)+Math.abs(point.y-points[i].y),0);
    boundEvent=event;boundRoute={from,to,start,recipient,points,length,travel:Math.max(700,length*8)};return boundRoute;
  }
  function position(points,distance){
    for(let i=1;i<points.length;i++){const a=points[i-1],b=points[i],length=Math.abs(b.x-a.x)+Math.abs(b.y-a.y);
      if(distance<=length&&length>0)return {x:a.x+(b.x-a.x)*distance/length,y:a.y+(b.y-a.y)*distance/length,side:Math.sign(b.x-a.x)||1};distance-=length;}
    return {...points.at(-1),side:1};
  }
  function draw({agents=[],event=null,elapsedMs=0,timeMs=0,reducedMotion=false,theme='dark'}={}){
    const people=roster(agents),p=palettes[theme==='light'?'light':'dark'],time=clock(timeMs),elapsed=clock(elapsedMs),trip=routeFor(event,people,time);
    if(canvas.width!==WIDTH||canvas.height!==HEIGHT){canvas.width=WIDTH;canvas.height=HEIGHT;}
    ctx.imageSmoothingEnabled=false;background(people,p,time,reducedMotion);
    const running=trip&&!reducedMotion&&elapsed<350+trip.travel*2+1000;
    const actors=people.map(person=>({person,point:running&&trip.to.id===person.id?{...trip.recipient,walking:false,sip:false}:ambient(person,time,reducedMotion)}));
    actors.push({person:BOSS,point:ambient(BOSS,time,true)});
    for(const {person,point} of actors.filter(actor=>!running||actor.person.id!==trip.from.id).sort((a,b)=>a.point.y-b.point.y)){
      const idlePose=person.state==='idle'&&!reducedMotion&&!point.walking?[0,1,0,-1][Math.floor(time/850)%4]:0;
      sprite(point,person,{working:person.state==='working'&&!reducedMotion,walking:point.walking,sip:point.sip,idlePose,frame:Math.floor(time/180)},p);
    }
    if(trip){
      const progress=elapsed-350,outbound=progress<trip.travel,arrived=progress>=trip.travel,returning=progress>=trip.travel+1000;
      if(reducedMotion){const target=ambient(trip.to,time,true);parcel(target.x+10,target.y+4,p);}
      else if(arrived)parcel(trip.recipient.x+10,trip.recipient.y+4,p);
      if(running){const fraction=outbound?Math.max(0,progress)/trip.travel:!returning?1:1-(progress-trip.travel-1000)/trip.travel;
        const point=position(trip.points,Math.min(1,Math.max(0,fraction))*trip.length);
        sprite(point,trip.from,{walking:progress>0&&(outbound||returning),frame:Math.floor(elapsed/150),carrying:outbound,side:returning?-point.side:point.side},p);}
    }
  }
  return {draw,duration(event,agents,timeMs=0){const trip=routeFor(event,roster(agents),clock(timeMs));return trip?Math.ceil(350+trip.travel*2+1000):0;}};
}
