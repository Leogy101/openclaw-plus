// Original pixel drawing. This module presents observations; it does not infer work.
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
const COLORS = ['#679bb0','#c47c72','#94a66d','#a98fbc','#c99d58','#6dada1','#9b90c4','#be819d'];
const hash = value => [...String(value)].reduce((sum,c)=>(sum*31+c.charCodeAt(0))>>>0,7);
const cleanAgents = agents => {
  const seen=new Set();return (Array.isArray(agents)?agents:[]).filter(agent=>agent&&typeof agent.id==='string'&&!seen.has(agent.id)&&seen.add(agent.id));
};
const palettes = {
  dark:{back:'#292429',edge:'#3c3031',wall:'#bcb099',wallTop:'#d9cbb0',wallShade:'#8d7e6b',floor:'#8d705c',plank:'#9b7b63',seam:'#7e6253',hall:'#b9a38a',tile:'#c7b399',tileLine:'#ac957c',rug:'#6b7c78',wood:'#785040',woodLight:'#b18258',woodEdge:'#503d36',glass:'#516b79',glassLight:'#8aa3a5',ink:'#342e32',paper:'#e9dec3',green:'#9fca9a',gold:'#d1aa5c',goldLight:'#ebce89',goldDark:'#96733f',shadow:'#685348'},
  light:{back:'#e8ded2',edge:'#665148',wall:'#e5d8bf',wallTop:'#fff0d5',wallShade:'#bcaa8c',floor:'#c19d78',plank:'#cdab84',seam:'#b38e6f',hall:'#d8c5a5',tile:'#e7d5b7',tileLine:'#c7b391',rug:'#8caaa1',wood:'#97704d',woodLight:'#c69b67',woodEdge:'#72533e',glass:'#a1c2ca',glassLight:'#d1e2d5',ink:'#4c3c35',paper:'#fff3d7',green:'#5f8c65',gold:'#c59a48',goldLight:'#f3d58c',goldDark:'#9f7836',shadow:'#a48263'},
};

export function createOfficeScene(canvas) {
  const ctx=canvas.getContext('2d',{alpha:false});
  if(!ctx)throw new Error('The Office illustration needs a canvas context.');
  const rect=(x,y,w,h,color)=>{ctx.fillStyle=color;ctx.fillRect(Math.round(x),Math.round(y),Math.round(w),Math.round(h));};
  function text(value,x,y,color,maxWidth=Infinity){
    const label=String(value??'').normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toUpperCase();let cursor=x;
    for(const letter of label){const rows=(GLYPHS[letter]||GLYPHS['?']).split('/'),width=rows[0].length;if(cursor+width>x+maxWidth)break;
      rows.forEach((row,dy)=>[...row].forEach((pixel,dx)=>{if(pixel==='1')rect(cursor+dx,y+dy,1,1,color);}));cursor+=width+1;}
  }
  function layout(input){
    const agents=cleanAgents(input),narrow=(canvas.clientWidth||640)<520,width=narrow?360:640,columns=narrow?2:4;
    const capacity=columns*2,floors=Math.max(1,Math.ceil((agents.length+1)/capacity)),roomWidth=(width-76)/columns-6,rooms=[];
    const room=(slot,agent,owner=false)=>{
      const floor=Math.floor(slot/capacity),cell=slot%capacity,bottom=cell>=columns,column=cell%columns;
      const x=18+column*(roomWidth+6),y=30+floor*292+(bottom?156:0),hall=30+floor*292+136;
      const home={x:x+Math.floor(roomWidth*.48),y:y+78},door={x:x+roomWidth-22,y:bottom?y-1:y+116};
      return {x,y,w:roomWidth,h:116,floor,bottom,home,door,hall,agent,owner};
    };
    agents.forEach((agent,i)=>rooms.push(room(i<capacity-1?i:i+1,agent)));
    const owner=room(capacity-1,{id:'',name:'Owner',state:'idle'},true);rooms.push(owner);
    return {width,height:30+floors*292,columns,floors,rooms,owner,trunk:width-34};
  }
  function route(event,plan){
    if(!event||!['delegation','handoff','report'].includes(event.kind))return null;
    const from=plan.rooms.find(room=>!room.owner&&room.agent.id===event.from);
    const to=event.to==null?(event.kind==='report'?plan.owner:null):plan.rooms.find(room=>!room.owner&&room.agent.id===event.to);
    if(!from||!to||from===to)return null;
    const points=[from.home,{x:from.door.x,y:from.home.y},from.door,{x:from.door.x,y:from.hall}];
    if(from.floor!==to.floor)points.push({x:plan.trunk,y:from.hall},{x:plan.trunk,y:to.hall});
    points.push({x:to.door.x,y:to.hall},to.door,{x:to.door.x,y:to.home.y},{x:to.home.x+17,y:to.home.y});
    const length=points.slice(1).reduce((sum,point,i)=>sum+Math.abs(point.x-points[i].x)+Math.abs(point.y-points[i].y),0);
    return {from,to,points,length,travel:Math.max(700,length*8)};
  }
  function position(points,distance){
    for(let i=1;i<points.length;i++){const a=points[i-1],b=points[i],length=Math.abs(b.x-a.x)+Math.abs(b.y-a.y);
      if(distance<=length&&length>0)return {x:a.x+(b.x-a.x)*distance/length,y:a.y+(b.y-a.y)*distance/length,side:Math.sign(b.x-a.x)||1};distance-=length;}
    return {...points.at(-1),side:1};
  }
  function plant(x,y,p){
    rect(x+3,y+11,8,6,p.woodEdge);rect(x+2,y+9,10,3,p.woodLight);rect(x+6,y+2,2,9,'#42664d');
    rect(x,y+3,7,4,'#658967');rect(x+7,y,6,5,'#789a70');rect(x+5,y+5,9,4,'#4e7456');rect(x+1,y+2,3,2,'#9eb287');
  }
  function parcel(x,y,p){rect(x-1,y+1,10,8,p.woodEdge);rect(x,y,8,7,p.goldLight);rect(x+3,y,2,7,p.gold);rect(x,y+2,8,1,p.goldDark);}
  function sprite(x,y,color,{walking=false,working=false,frame=0,owner=false,carrying=false,side=1}={},p){
    x=Math.round(x);y=Math.round(y);const step=walking?(frame%2?1:-1):0,hand=working&&frame%2?1:0;
    rect(x-7,y+11,15,3,p.shadow);rect(x-4,y+5,3,7+step,'#38383c');rect(x+2,y+5,3,7-step,'#38383c');
    rect(x-5,y+11+step,4,2,p.ink);rect(x+2,y+11-step,4,2,p.ink);rect(x-5,y-3,11,10,color);
    rect(x-7,y-1+hand,2,6,'#d6a77c');rect(x+6,y-1-hand,2,6,'#d6a77c');rect(x-2,y-5,5,3,'#d6a77c');
    rect(x-4,y-12,9,8,'#e2b78b');rect(x-5,y-13,10,3,owner?'#b9ac92':'#493937');rect(x-5,y-11,2,4,owner?'#b9ac92':'#493937');
    rect(x-2,y-8,1,1,p.ink);rect(x+3,y-8,1,1,p.ink);rect(x,y-4,2,1,'#ba815f');rect(x-2,y-2,5,2,owner?p.goldLight:'#d4c8b2');
    if(owner){rect(x,y,1,5,p.goldLight);rect(x-7,y-10,2,3,p.goldDark);rect(x+5,y-10,2,3,p.goldDark);}
    if(carrying)parcel(x+(side<0?-13:7),y+1,p);
  }
  function room(room,p,time,reducedMotion,moving){
    const {x,y,w,h,owner,agent}=room,working=agent.state==='working',color=COLORS[hash(agent.id)%COLORS.length];
    rect(x+2,y+5,w,h,p.shadow);rect(x,y,w,h,p.edge);rect(x+4,y+5,w-8,h-9,owner?p.goldDark:p.floor);
    for(let dy=13;dy<h-4;dy+=12){rect(x+4,y+dy,w-8,1,p.seam);for(let dx=(dy%24?17:36);dx<w-8;dx+=39)rect(x+dx,y+dy+1,1,11,p.seam);}
    if(owner){rect(x+16,y+66,w-32,29,p.gold);rect(x+19,y+69,w-38,23,p.goldLight);rect(x+23,y+73,w-46,15,p.gold);}
    else {rect(x+20,y+67,w-40,24,p.rug);rect(x+23,y+70,w-46,1,'#a0afa0');rect(x+23,y+87,w-46,1,'#647e77');}
    rect(x+1,y+1,w-2,8,owner?p.gold:p.wall);rect(x+1,y+1,w-2,2,owner?p.goldLight:p.wallTop);
    rect(x+1,y+9,3,h-13,p.wallShade);rect(x+w-4,y+9,3,h-13,p.wallShade);rect(x,y+h-5,w,5,owner?p.gold:p.wall);
    // Window, two panes and sill. A cutaway wall leaves the interior visible.
    rect(x+12,y+12,36,21,p.woodEdge);rect(x+14,y+14,32,15,p.glass);rect(x+15,y+15,29,2,p.glassLight);
    rect(x+22,y+18,3,8,p.glassLight);rect(x+31,y+14,2,16,p.wall);rect(x+11,y+30,38,3,owner?p.goldLight:p.wallTop);
    // Shelves, books and a small framed print give each office a lived-in edge.
    rect(x+w-37,y+13,24,21,p.woodEdge);rect(x+w-35,y+15,20,7,p.woodLight);rect(x+w-35,y+25,20,7,p.woodLight);
    for(let i=0;i<4;i++){rect(x+w-34+i*4,y+15+(i%2),3,6-i%2,COLORS[(hash(agent.id)+i)%COLORS.length]);rect(x+w-33+i*4,y+26,2,5,p.paper);}
    const deskX=room.home.x-29,deskY=y+43;
    rect(deskX+3,deskY+17,4,12,p.woodEdge);rect(deskX+49,deskY+17,4,12,p.woodEdge);rect(deskX-1,deskY+2,58,19,p.woodEdge);
    rect(deskX,deskY,56,17,owner?p.goldLight:p.woodLight);rect(deskX+2,deskY+2,52,1,owner?'#fff0ba':'#d3ad78');
    rect(deskX+16,deskY-10,24,16,p.ink);rect(deskX+18,deskY-8,20,11,working?'#425e57':'#40505a');
    rect(deskX+26,deskY+6,4,3,p.ink);rect(deskX+23,deskY+9,10,2,p.ink);rect(deskX+18,deskY+12,22,3,p.paper);
    if(working){const shift=reducedMotion?0:Math.floor(time/400)%3;rect(deskX+20,deskY-5,8+shift*2,1,p.green);rect(deskX+20,deskY-2,13,1,'#a3c3a2');rect(deskX+20,deskY+1,5+shift,1,p.green);}
    else {rect(deskX+22,deskY-4,11,1,p.glass);rect(deskX+22,deskY-1,7,1,p.glass);}
    rect(deskX+5,deskY+6,6,7,p.paper);rect(deskX+11,deskY+7,2,4,p.paper);rect(deskX+6,deskY+6,4,2,p.woodEdge);
    rect(room.home.x-7,y+70,15,14,owner?'#715239':'#5b6664');rect(room.home.x-8,y+79,17,4,owner?p.goldDark:'#465653');
    plant(x+8,y+h-34,p);if(owner){plant(x+11,y+42,p);rect(x+55,y+16,14,11,p.goldDark);rect(x+57,y+18,10,7,p.goldLight);rect(x+60,y+19,4,5,p.gold);}
    // A real opening connects each room to the central corridor.
    const doorY=room.bottom?y:y+h-5;rect(room.door.x-8,doorY,17,6,p.hall);rect(room.door.x-9,doorY,2,6,p.woodEdge);rect(room.door.x+8,doorY,2,6,p.woodEdge);
    if(room.bottom)rect(room.door.x-7,y+6,14,2,p.tile);else rect(room.door.x-7,y+h-7,14,2,p.tile);
    if(room!==moving)sprite(room.home.x,room.home.y,owner?'#806550':color,{owner,working:working&&!reducedMotion,frame:Math.floor(time/360)},p);
    const max=w-60;rect(x+26,y+h-18,max,11,owner?p.goldLight:p.paper);text(owner?'OWNER':agent.name||agent.id,x+29,y+h-16,p.ink,max-6);
    rect(x+17,y+h-15,4,4,owner?p.goldLight:working?p.green:agent.state==='idle'?p.paper:p.wallShade);
  }
  function draw({agents=[],event=null,elapsedMs=0,reducedMotion=false,theme='dark'}={}){
    const plan=layout(agents),p=palettes[theme==='light'?'light':'dark'],trip=route(event,plan),time=Math.max(0,Number(elapsedMs)||0);
    if(canvas.width!==plan.width||canvas.height!==plan.height){canvas.width=plan.width;canvas.height=plan.height;}
    ctx.imageSmoothingEnabled=false;rect(0,0,plan.width,plan.height,p.back);
    rect(18,14,plan.width-36,2,p.wallShade);rect(24,14,20,2,p.gold);rect(plan.width-44,14,20,2,p.gold);
    // Hallways are continuous; the right edge joins additional floors.
    rect(10,25,plan.width-20,plan.height-33,p.edge);rect(14,29,plan.width-28,plan.height-41,p.hall);
    for(let floor=0;floor<plan.floors;floor++){
      const y=30+floor*292;rect(14,y+116,plan.width-28,40,p.hall);
      for(let x=18;x<plan.width-18;x+=16){rect(x,y+118,14,15,p.tile);rect(x+7,y+135,14,15,p.tile);}
      rect(15,y+116,plan.width-30,2,p.tileLine);rect(15,y+154,plan.width-30,2,p.tileLine);
      text('LEVEL '+String(floor+1).padStart(2,'0'),23,y+132,p.woodEdge);
      if(floor<plan.floors-1){rect(plan.trunk-13,y+158,25,132,p.wallShade);for(let step=0;step<13;step++)rect(plan.trunk-10,y+163+step*9,19,4,p.wallTop);rect(14,y+277,plan.width-65,9,p.edge);}
      rect(plan.width-23,y+14,9,24,p.woodEdge);rect(plan.width-21,y+16,5,19,p.glass);rect(plan.width-21,y+25,5,2,p.wall);rect(plan.width-24,y+37,11,3,p.wallTop);
    }
    const moving=trip&&!reducedMotion&&time<350+trip.travel*2+900?trip.from:null;
    plan.rooms.forEach(item=>room(item,p,time,reducedMotion,moving));
    if(trip){
      const progress=time-350,outbound=progress<trip.travel,arrived=progress>=trip.travel,returning=progress>=trip.travel+900;
      if(reducedMotion||arrived)parcel(trip.to.home.x+10,trip.to.home.y+4,p);
      if(moving){const traveled=outbound?Math.max(0,progress)/trip.travel:!returning?1:1-(progress-trip.travel-900)/trip.travel;
        const point=position(trip.points,Math.min(1,Math.max(0,traveled))*trip.length);
        sprite(point.x,point.y,COLORS[hash(trip.from.agent.id)%COLORS.length],{walking:progress>0&&(outbound||returning),frame:Math.floor(time/150),carrying:outbound,side:returning?-point.side:point.side},p);}
    }
  }
  return {draw,duration(event,agents){const trip=route(event,layout(agents));return trip?Math.ceil(350+trip.travel*2+900):0;}};
}
