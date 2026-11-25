"""Offline authoring. Rebuild the fixture-independent lighting feed from source envelopes."""
from pathlib import Path
import json, math, hashlib, argparse, csv, base64
import numpy as np
ROOT=Path(__file__).resolve().parents[1]
def smooth(a,b,t):
 x=np.clip((t-a)/(b-a),0,1);return x*x*(3-2*x)
def envelope(d,t):
 a=np.array(d['samples']);return np.interp(t,np.arange(len(a))/d['fps'],a,left=0,right=0)
def norm(x):
 p=np.percentile(x[x>0],95) if np.any(x>0) else 1
 return np.clip(x/max(.001,p),0,1)
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def main():
 cfg=json.loads((ROOT/'settings.json').read_text());fps=cfg['fps'];pix=cfg['pixelsPerTube'];tubes=8
 data={key:json.loads((ROOT/'data'/name).read_text()) for key,name in cfg['envelopes'].items()}
 segs=cfg['segments'];y=np.linspace(0,1,pix)[None,:];x=np.arange(8)[:,None]/7;all_frames=[];all_metrics=[];absolute=0;events=[]
 purple=np.array([.52,.06,1.]);pink=np.array([1.,.16,.52]);white=np.array([.9,.94,1.]);ice=np.array([.34,.62,1.])
 rain=data['rain'];times=np.array(rain['times']);strength=norm(np.array(rain['strength']))
 for s in segs:
  count=round(s['duration']*fps);s['frameCount']=count;s['offsetFrame']=len(all_frames);s['start']=absolute;s['duration']=count/fps
  ts=np.arange(count)/fps;stage=s['id'];raw=np.zeros((count,8,pix,3),np.float32);meta=[]
  cloud=norm(envelope(data['cloud'],ts));kick=norm(envelope(data['kick'],ts));summon=norm(envelope(data['summon'],ts));mix=norm(envelope(data['mix'],ts))
  # Attack/release filters are baked from t=0 for deterministic seeks.
  def follow(a,attack=12,release=5):
   out=np.zeros_like(a);v=0
   for i,z in enumerate(a):v+=(z-v)*(1-math.exp(-(attack if z>v else release)/fps));out[i]=v
   return out
  kick=follow(kick,18,9);mix=follow(mix,8,3)
  for i,t in enumerate(ts):
   c=np.zeros((8,pix,3));energy=0;form='';rain_gain=0
   if stage in ('waiting','intro'):
    rt=t if stage=='intro' else t%10
    rain_gain=(.12+.88*smooth(11,31,rt))*(1-smooth(71,79,rt)) if stage=='intro' else .12
    c+=ice*.007
    if stage=='intro':c+=(purple*.014+ice*.008)*cloud[i]
    lo=np.searchsorted(times,rt-.5);hi=np.searchsorted(times,rt+cfg['rainFallSeconds'])
    for j in range(lo,hi):
     age=rt-times[j];tube=(j*5+(j*j)//7+cfg['seed'])%8;v=(.2+.8*strength[j])*rain_gain*cfg['rainGain']
     if age<0:
      height=np.clip(-age/cfg['rainFallSeconds'],0,1)
      head=np.exp(-((y[0]-height)/.045)**2);trail=np.exp(-((y[0]-height-.08)/.1)**2)*.25
      c[tube]+=(head+trail)[:,None]*ice*v
     else:
      splash=math.exp(-age*9)*np.exp(-(y[0]/(.05+age*.15))**2)
      c[tube]+=splash[:,None]*white*v*.9
      # A small bottom-zone echo in adjacent tubes suggests a floor splatter.
      for n in (tube-1,tube+1):
       if 0<=n<8:c[n]+=splash[:,None]*ice*v*.2
    if stage=='intro':
     for q in range(4):
      onset=39.94+.9*q;age=t-onset
      if 0<=age<.5:
       flash=math.sin(math.pi*age/.5)**2;mask=np.ones((8,1)) if q==3 else ((x<.5) if q in (0,2) else (x>=.5))
       c+=mask[:,:,None]*white*flash*.65
     if t>=42.64:
      u=t-42.64;step=min(11,int(u/(107.36/12)));form=cfg['forms'][step%6]
      active=smooth(42.64,45.64,t)*(.3+.7*min(1,float(np.max(summon[:i+1]))*1.4))
      energy=np.clip(.18+.42*mix[i]+.4*kick[i],0,1)
      # A continuous sine crest reads across the row; its height, width and speed breathe with energy.
      freq={'Breathing halo':.6,'Double helix':1.1,'Orbital weave':.8,'Standing wave':1.35,'Resonant knot':1.7,'SoundSpace original':.65}[form]
      old=cfg['forms'][(step-1)%6];oldfreq={'Breathing halo':.6,'Double helix':1.1,'Orbital weave':.8,'Standing wave':1.35,'Resonant knot':1.7,'SoundSpace original':.65}[old]
      blend=smooth(0,3.895792,u-step*(107.36/12));freq=oldfreq+(freq-oldfreq)*blend if step else freq
      phase=u*.85;centre=.5+(.12+.28*energy)*np.sin(x*math.tau*freq-phase)
      band=np.exp(-((y-centre)/(.055+.08*energy))**2)
      # Counter-moving echo is restrained for calm circular states.
      echo=np.exp(-((y-(1-centre))/(.07+.03*energy))**2)*(.12+.28*energy)
      colour=purple[None,None,:]*(1-x[:,:,None])+pink[None,None,:]*x[:,:,None]
      light=(band+echo)[:,:,None]*colour*(.15+.62*energy)*active*cfg['waveGain']
      light+=band[:,:,None]*white*kick[i]*.16*active
      c+=light
   elif stage=='rise':
    z=smooth(0,s['duration'],t);centre=.5+.5*z
    c+=np.exp(-((y-centre)/.11)**2)[:,:,None]*((1-z)*pink+z*white)*.7
    c+=purple*.04*(1-z)
   elif stage=='reveal':
    z=1-smooth(0,5,t);centre=.5+.5*z
    c+=np.exp(-((y-centre)/.11)**2)[:,:,None]*(pink*.35+white*.25)
    wave=np.exp(-((y-(1-t/17))/.16)**2)
    c+=wave[:,:,None]*purple*.32+c*.0
    c+=purple*.05*smooth(0,17,t)
   elif stage in ('aurora','return_delay'):
    level=.09+.025*math.sin(t*1.5);c+=(purple[None,None,:]*(1-x[:,:,None])+pink[None,None,:]*x[:,:,None])*level
   elif stage=='bass':
    b=norm(envelope(data['bass'],ts));energy=float(b[i]);fade=1-smooth(31.6,35.6,t)
    centre=.5+.24*np.sin(x*math.tau-t*1.9)*(.35+.65*energy)
    band=np.exp(-((y-centre)/(.08+.08*energy))**2)
    c+=band[:,:,None]*(purple*.6+pink*.4)*(.14+.55*energy)*fade
    c+=white*band[:,:,None]*energy*.1*fade
    c+=band[:,:,None]*(purple*.04)*(1-fade)
   elif stage=='idle':
    energy=float(envelope(data['idle'],np.array([t%10]))[0]);energy=min(1,energy)
    centre=.5+.06*np.sin(x*math.tau-t*.3)
    c+=np.exp(-((y-centre)/.13)**2)[:,:,None]*(purple*.7+pink*.3)*(.05+.14*energy)
   elif stage=='blackout':pass
   raw[i]=np.clip(c*cfg['master'],0,1)
   meta.append({'time':round(absolute+t,6),'stageTime':round(t,6),'stage':stage,'energy':round(float(energy),4),'rain':round(float(rain_gain),4),'form':form})
  # Gentle stage-entry handovers; retain authored short lightning peaks inside intro.
  if all_frames and stage!='blackout':
   last=np.array(all_frames[-1],dtype=float)/255
   for i in range(min(count,round(.4*fps))):
    b=smooth(0,.4,i/fps);raw[i]=last*(1-b)+raw[i]*b
  encoded=np.round(np.power(np.clip(raw,0,1),1/2.2)*65535).astype('<u2')
  (ROOT/'data'/f'{stage}.rgb16').write_bytes(encoded.tobytes())
  frames=np.round(np.clip(raw,0,1)*255).astype(np.uint8)
  (ROOT/'data'/f'{stage}.rgb8').write_bytes(frames.tobytes());all_frames.extend(frames);all_metrics.extend(meta);absolute+=s['duration']
  events.append({'time':round(s['start'],6),'stage':stage,'action':'enter','duration':s['duration']})
 all_frames=np.array(all_frames,dtype=np.uint8);(ROOT/'data/show.rgb8').write_bytes(all_frames.tobytes())
 for q in range(4):events.append({'time':10+39.94+q*.9,'stage':'intro','action':'lightning','side':['left','right','left','both'][q]})
 manifest={'schema':'io.phoria.lbe.lighting.v1','version':'1.0.0','sourceBuild':'0.13.0 (13)','fps':fps,'tubes':8,'pixelsPerTube':pix,'components':'RGB','pixelOrder':'tube 1 to 8 left to right, pixel 0 bottom to last top','frameBytes':8*pix*3,'encoding':'uint8 linear RGB intensity, authored master baked; client cap applied separately; not lux','duration':absolute,'segments':segs,'showFile':'data/show.rgb8','frameCount':len(all_frames),'timingPolicy':'Reference composite only. Live integration follows stage-local playback clock; reveal is geometry gated. Idle uses live energy or reference loop.','files':{f'data/{s["id"]}.rgb8':{'bytes':(ROOT/'data'/f'{s["id"]}.rgb8').stat().st_size,'sha256':sha(ROOT/'data'/f'{s["id"]}.rgb8')} for s in segs}}
 manifest['files']['data/show.rgb8']={'bytes':len(all_frames.tobytes()),'sha256':sha(ROOT/'data/show.rgb8')}
 (ROOT/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n');(ROOT/'data/cues.json').write_text(json.dumps(sorted(events,key=lambda x:x['time']),indent=2)+'\n')
 with (ROOT/'data/metrics.csv').open('w') as f:
  w=csv.DictWriter(f,fieldnames=all_metrics[0].keys());w.writeheader();w.writerows(all_metrics)
 with (ROOT/'data/frames.jsonl').open('w') as f:
  for frame,m in zip(all_frames,all_metrics):f.write(json.dumps({'t':m['time'],'stage':m['stage'],'stageTime':m['stageTime'],'rgb':frame.reshape(-1).tolist()},separators=(',',':'))+'\n')
 print('Generated',len(all_frames),'frames',absolute,'seconds')
if __name__=='__main__':main()
