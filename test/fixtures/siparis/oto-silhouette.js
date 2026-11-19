'use strict';
const {createCanvas}=require('@napi-rs/canvas');
// Invented, front-facing garment: 260px hem and 360px shoulder-to-hem.
// Sleeve gaps are only 3px wide near the bottom, so closing must not merge cuffs.
function silhouetteMockup({recolor=false,pale=false,shadow=false,hood=false,wrinkles=false}={}) {
  const d=createCanvas(160,100),ink=d.getContext('2d');ink.fillStyle='#131313';
  ink.fillRect(12,12,27,76);ink.fillRect(104,12,27,76);ink.fillRect(30,40,82,20);
  ink.beginPath();ink.arc(74,22,14,0,Math.PI*2);ink.fill();
  const c=createCanvas(600,600),x=c.getContext('2d');x.fillStyle='#fcfcfc';x.fillRect(0,0,600,600);
  if(shadow){x.fillStyle='#ededed';x.beginPath();x.ellipse(300,464,220,14,0,0,Math.PI*2);x.fill();}
  x.fillStyle=pale?'#e7e7e7':'#14683c';
  x.beginPath();const points=[[210,90],[390,90],[445,130],[480,448],[433,448],[433,210],[430,210],[430,450],[170,450],[170,210],[167,210],[167,448],[120,448],[155,130]];
  points.forEach(([a,b],i)=>i?x.lineTo(a,b):x.moveTo(a,b));x.closePath();x.fill();
  if(hood){x.beginPath();x.ellipse(300,70,60,65,0,0,Math.PI*2);x.fill();}
  if(wrinkles){x.fillStyle='#1d7145';for(let left=185;left<420;left+=20)x.fillRect(left,330,4,95);}
  // A disconnected corner wordmark must never become the product mask.
  x.fillStyle='#15284e';x.fillRect(540,545,25,4);x.fillRect(545,552,18,3);
  if(recolor){const white=createCanvas(160,100),w=white.getContext('2d');w.drawImage(d,0,0);w.globalCompositeOperation='source-in';w.fillStyle='white';w.fillRect(0,0,160,100);x.drawImage(white,12,8,120,80,240,240,120,80);}
  else x.drawImage(d,12,8,120,80,240,240,120,80);
  return {image:c.toBuffer('image/png'),design:d.toBuffer('image/png')};
}
module.exports={silhouetteMockup};
