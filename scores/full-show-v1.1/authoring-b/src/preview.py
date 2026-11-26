"""Render full-track A/B comparisons and a local, video-clock-driven review player."""
from pathlib import Path
import json,base64,subprocess,math,os,shutil
import numpy as np
from PIL import Image,ImageDraw,ImageFont
ROOT=Path(__file__).resolve().parents[1]
FF=os.environ.get('FFMPEG') or shutil.which('ffmpeg') or '/Users/trentino-claw/.local/bin/ffmpeg'
FONT=os.environ.get('PREVIEW_FONT','/System/Library/Fonts/Supplemental/Arial.ttf')
F=ImageFont.truetype(FONT,22);S=ImageFont.truetype(FONT,15);H=ImageFont.truetype(FONT,28)
POS=[(11.7,1.3),(9,1.3),(5.9,1.5),(5.95,4.45),(6.05,7.05),(8.75,6.9),(11.4,7.05),(11.7,4.25)]
LUT=np.rint(255*np.where(np.arange(256)/255<=.0031308,12.92*np.arange(256)/255,1.055*(np.arange(256)/255)**(1/2.4)-.055)).astype(np.uint8)

def panel(draw,frame,x,y,w,h,label):
 draw.text((x,y-30),label,font=F,fill='#e7e9f2')
 for tube in range(8):
  tx=x+22+tube*(w-42)/7
  draw.rounded_rectangle((tx-14,y,tx+14,y+h),radius=9,fill='#212738')
  for p in range(16):
   py=y+h-(p+1)*h/16;color=tuple(int(c) for c in LUT[frame[tube,p]])
   draw.rectangle((tx-9,py,tx+9,py+h/16-1),fill=color)
  draw.text((tx-4,y+h+7),str(tube+1),font=S,fill='#a8b2c6')

def room(draw,frame,x,y,w,h,label):
 draw.rounded_rectangle((x,y,x+w,y+h),radius=14,outline='#303a4d',width=2)
 draw.line((x+40,y+15,x+w-40,y+15),fill='#73839c',width=3)
 draw.text((x+w/2-27,y+23),'SCREEN',font=S,fill='#a8b2c6')
 for i,(px,pz) in enumerate(POS):
  tx=x+35+(px-5.9)/5.8*(w-70);ty=y+65+(pz-1.3)/5.75*(h-100)
  color=tuple(int(c) for c in LUT[np.rint(frame[i].mean(axis=0)).astype(np.uint8)])
  draw.ellipse((tx-13,ty-13,tx+13,ty+13),fill=color,outline='#59677d');draw.text((tx-4,ty+17),str(i+1),font=S,fill='#a8b2c6')
 draw.text((x+12,y+h+7),label,font=S,fill='#a8b2c6')

def draw_frame(tr,t,video,a,b):
 im=Image.new('RGB',(1280,720),'#080c16');d=ImageDraw.Draw(im)
 d.text((28,18),tr['name']+'  /  LIGHTING A–B',font=H,fill='#f1f0fb')
 d.text((1000,25),f'{int(t)//60:02}:{t%60:05.2f}',font=F,fill='#d7dbea')
 im.paste(video,(320,75));d=ImageDraw.Draw(im)
 room(d,a,25,77,265,322,'A · Screen Echo');room(d,b,990,77,265,322,'B · Immersive Pulse')
 d.text((320,443),'Completed scene playblast · reference audio · simulated room',font=S,fill='#a8b2c6')
 panel(d,a,30,515,585,150,'A  /  '+tr['looks'][0]);panel(d,b,670,515,585,150,'B  /  '+tr['looks'][1])
 d.text((28,698),'8 × 16 pixels · 40 Hz score / 15 fps preview · estimated light at 50% client cap · no hardware output',font=S,fill='#77849d')
 return im

def html(tracks):
 payload=[]
 for tr in tracks:
  d=dict(tr)
  for v in ['a','b']:d[v]=base64.b64encode((ROOT/'preview'/f"{tr['id']}-{v}.dmx8").read_bytes()).decode()
  payload.append(d)
 template=(ROOT/'src/review-template.html').read_text()
 (ROOT/'Review.html').write_text(template.replace('__TRACK_DATA__',json.dumps(payload,separators=(',',':'))))

def main():
 tracks=json.loads((ROOT/'preview/index.json').read_text());html(tracks)
 for tr in tracks:
  sid=tr['id'];a=np.frombuffer((ROOT/'preview'/f'{sid}-a.dmx8').read_bytes(),np.uint8).reshape(-1,8,16,3);b=np.frombuffer((ROOT/'preview'/f'{sid}-b.dmx8').read_bytes(),np.uint8).reshape(-1,8,16,3)
  source=ROOT/'preview'/tr['context'];out=ROOT/'preview'/f'{sid}-AB.mp4'
  decoder=subprocess.Popen([FF,'-v','error','-threads','2','-i',str(source),'-vf','fps=15,scale=640:360','-f','rawvideo','-pix_fmt','rgb24','-'],stdout=subprocess.PIPE)
  encoder=subprocess.Popen([FF,'-v','error','-y','-f','rawvideo','-pix_fmt','rgb24','-s','1280x720','-r','15','-i','-','-i',str(source),'-map','0:v','-map','1:a:0','-c:v','libx264','-threads','2','-preset','veryfast','-crf','22','-pix_fmt','yuv420p','-c:a','copy','-shortest','-movflags','+faststart',str(out)],stdin=subprocess.PIPE)
  size=640*360*3;i=0;marks=[15.,tr['jumps'][min(2,len(tr['jumps'])-1)],tr['duration']*.65];saved=set()
  while True:
   raw=decoder.stdout.read(size)
   if not raw:break
   if len(raw)!=size:raise RuntimeError('Short preview frame')
   t=i/15;fi=min(len(a)-1,int(t*40));im=draw_frame(tr,t,Image.frombytes('RGB',(640,360),raw),a[fi],b[fi]);encoder.stdin.write(im.tobytes())
   for j,mark in enumerate(marks):
    if j not in saved and t>=mark:im.save(ROOT/'preview'/f'{sid}-review-{j}.jpg',quality=92);saved.add(j)
   i+=1
  decoder.stdout.close();encoder.stdin.close();assert decoder.wait()==0 and encoder.wait()==0
  print('Rendered A/B',sid,i,'frames',flush=True)

if __name__=='__main__':main()
