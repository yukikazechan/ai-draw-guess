import {createCanvas} from '@napi-rs/canvas';
import {paint,W,H} from '../public/drawing.mjs';

// Render privately on the server: another player's drawing never has to visit the human's browser.
export function renderRelayDrawing(shapes){const canvas=createCanvas(W,H);paint(canvas,shapes);return canvas.toDataURL('image/png');}
export function drawingHasInk(shapes){
  if(!shapes?.length)return false;
  const canvas=createCanvas(W,H);paint(canvas,shapes);const pixels=canvas.getContext('2d').getImageData(0,0,W,H).data;
  for(let i=0;i<pixels.length;i+=4)if(pixels[i]<245||pixels[i+1]<245||pixels[i+2]<245)return true;
  return false;
}
