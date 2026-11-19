'use strict';
const {createCanvas}=require('@napi-rs/canvas');
// Invented geometry only: two hoodies, piping, lining, cords, pocket and ink.
// Each body has a 260px hem and 355px shoulder length (2mm/px L reference).
function multiMockup({swap=false,ambiguous=false,backScale=1,missing=false,repeated=false,touching=false}={}) {
  const c=createCanvas(1100,610),x=c.getContext('2d');x.fillStyle='#fafafa';x.fillRect(0,0,c.width,c.height);
  x.fillStyle='#14234b';x.fillRect(15,15,45,5);x.fillRect(20,25,35,4);
  for(const front of [true,false]) {
    const cx=(front!==swap)?270:(touching?650:810),s=front?1:backScale;
    x.save();x.translate(cx,50);x.scale(s,s);x.fillStyle='#172e58';
    x.beginPath();for(const [i,[a,b]] of [[-120,100],[120,100],[175,145],[205,425],[147,425],[132,200],[130,455],[-130,455],[-132,200],[-147,425],[-205,425],[-175,145]].entries())i?x.lineTo(a,b):x.moveTo(a,b);x.closePath();x.fill();
    x.beginPath();x.ellipse(0,75,75,75,0,0,Math.PI*2);x.fill();
    x.strokeStyle='white';x.lineWidth=3;
    for(const side of [-1,1]){x.beginPath();x.moveTo(side*170,155);x.lineTo(side*200,416);x.stroke();}
    if(front&&!ambiguous) {
      x.fillStyle='white';x.beginPath();x.ellipse(0,52,53,28,0,0,Math.PI*2);x.fill();
      x.fillRect(-32,128,3,95);x.fillRect(29,128,3,95);
      x.strokeStyle='#587295';x.beginPath();x.moveTo(-80,300);x.lineTo(80,300);x.lineTo(100,400);x.lineTo(-100,400);x.closePath();x.stroke();
    }
    if(!missing) {
      const width=front?70:135,height=front?40:60,left=front?35:-width/2,top=185;
      const print=y=>{x.fillStyle='white';x.fillRect(left,y,width*.24,height*.65);x.fillRect(left+width*.32,y,width*.68,height*.65);x.fillRect(left+width*.16,y+height*.78,width*.84,height*.22);};
      print(top);if(repeated) {x.save();x.translate(front?-120:0,70);print(top);x.restore();}
    }
    x.restore();
  }
  return {image:c.toBuffer('image/png'),design:null};
}
module.exports={multiMockup};
