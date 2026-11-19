'use strict';
const {createCanvas}=require('@napi-rs/canvas');
function mockup({width=120,position='gogus',missing=false,perspective=false,repeated=false,offset=0}={}) {
  const design=createCanvas(180,120),d=design.getContext('2d');
  // Transparent padding and holes exercise the content aspect ratio.
  d.fillStyle='#ec3156';d.fillRect(10,10,160,90);
  d.fillStyle='#fbd744';d.fillRect(20,20,45,30);d.fillRect(95,55,60,25);
  d.fillStyle='#25327c';d.beginPath();d.arc(100,32,16,0,Math.PI*2);d.fill();
  d.clearRect(25,65,28,20);
  const c=createCanvas(600,650),x=c.getContext('2d');
  x.fillStyle='#fafafa';x.fillRect(0,0,600,650);x.fillStyle='#244c77';
  x.beginPath();
  const points=perspective?[[190,45],[375,60],[520,175],[465,250],[390,200],[440,605],[150,590],[180,200],[95,260],[55,190]]:[[200,45],[400,45],[540,175],[475,250],[450,215],[450,605],[150,605],[150,215],[125,250],[60,175]];
  points.forEach(([a,b],i)=>i?x.lineTo(a,b):x.moveTo(a,b));x.closePath();x.fill();
  if(!missing){const y=position==='sirt'?300:265;x.drawImage(design,10,10,160,90,300-width/2+offset,y,width,width*90/160);if(repeated)x.drawImage(design,10,10,160,90,240,420,width,width*90/160);}
  return {image:c.toBuffer('image/png'),design:design.toBuffer('image/png'),expectedWidth:Math.round(width/300*600),expectedHeight:Math.round(width/300*600*90/160)};
}
module.exports={mockup};
