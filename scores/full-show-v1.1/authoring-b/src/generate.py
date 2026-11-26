"""Six deterministic, source-driven eight-tube scores in native LBESHOW1 format."""
from pathlib import Path
import json, hashlib, struct, datetime, shutil
import numpy as np
from analyze import smooth
ROOT=Path(__file__).resolve().parents[1]
FPS=40
POSITIONS=np.array([[11.7,1.3],[9,1.3],[5.9,1.5],[5.95,4.45],[6.05,7.05],[8.75,6.9],[11.4,7.05],[11.7,4.25]])

def ramp(x):
 x=np.clip(x,0,1);return x*x*(3-2*x)

def interp(a,t,rate):
 a=np.asarray(a);shape=a.shape[1:];flat=a.reshape(len(a),-1)
 return np.stack([np.interp(t,np.arange(len(a))/rate,flat[:,j]) for j in range(flat.shape[1])],axis=1).reshape((len(t),)+shape)

def pulses(t,events,width=.18):
 out=np.zeros_like(t)
 for e in events:
  dt=t-e['seconds'];out+=e['strength']*np.exp(-.5*(dt/width)**2)
 return np.clip(out,0,1)

def encode_show(path,linear,header):
 raw=np.floor(np.clip(linear.astype(np.float64),0,1)**(1/2.2)*65535+.5).astype('<u2').tobytes()
 header=dict(header,frameCount=len(linear),hashes={'sequence':hashlib.sha256(raw).hexdigest(),'rig':hashlib.sha256(json.dumps(header['patch'],sort_keys=True).encode()).hexdigest()})
 j=json.dumps(header,separators=(',',':')).encode();pad=(-(12+len(j)))%8
 path.write_bytes(b'LBESHOW1'+struct.pack('<I',len(j)+pad)+j+b' '*pad+raw)
 return hashlib.sha256(path.read_bytes()).hexdigest()

def main():
 tracks=json.loads((ROOT/'tracks.json').read_text())
 settings={'version':'1.0.0','fps':40,'clientMaster':1,'clientCap':.5,'sourceMaster':{'a':.78,'b':.90},'smoothingSeconds':{'colourAttack':.35,'colourRelease':.6,'intensityAttack':.12,'intensityRelease':.35},'screenToRearTravelSeconds':{'a':1.2,'b':.8},'fadeInSeconds':1.5,'fadeOutSeconds':2.5,'hardwareOutput':False}
 if (ROOT/'settings.json').exists():settings.update(json.loads((ROOT/'settings.json').read_text()))
 (ROOT/'settings.json').write_text(json.dumps(settings,indent=2)+'\n')
 patch={'pixelCount':128,'gateways':[{'id':'enttec','name':'ENTTEC Mk2 / TimoLink TX','host':'enttec-usb'}],'runs':[{'first':i*16,'count':16,'gateway':'enttec','universe':1,'channel':1+48*i,'order':'RGB','gamma':2.2} for i in range(8)]}
 (ROOT/'hardware/patch.native.json').write_text(json.dumps(patch,indent=2)+'\n')
 (ROOT/'hardware/positions.json').write_text(json.dumps({'tubeNumbers':list(range(1,9)),'xzMetres':POSITIONS.tolist(),'screenEnd':'low z','screenOrderLeftToRight':[3,2,1],'rearOrderLeftToRight':[5,6,7],'pixelOrder':'bottom to top'},indent=2)+'\n')
 shows=[];review=[]
 for tr in tracks:
  sid=tr['id'];f=np.load(ROOT/'analysis'/f'{sid}.npz');n=int(np.ceil(tr['duration']*FPS));t=np.arange(n)/FPS
  en=interp(f['energy'],t,40);bands=interp(f['bands'],t,40);bright=interp(f['brightness'],t,10);motion=interp(f['motion'],t,10)
  palette=interp(f['palette'],t,10)
  live=np.zeros(n)
  if sid=='tsom':
   for a,b in [(42.5,60),(95,120),(145,170),(215,235)]: live=np.maximum(live,ramp((t-a+2)/2)*ramp((b-t)/2))
   scene=interp(f['scenePalette'],t,10)
   palette=palette*(1-live[:,None,None])+scene*live[:,None,None]
  if sid=='satf':en=smooth(en,FPS,1.6,3);bands=smooth(bands,FPS,.6,1.6)
  phase=2*np.pi*np.cumsum(.11+(.10 if sid!='satf' else .025)*en)/FPS
  for v,label in zip(['a','b'],tr['looks']):
   frame=np.zeros((n,8,16,3),np.float32);y=np.linspace(0,1,16)[None,:];travel=settings['screenToRearTravelSeconds'][v]
   for tube,(px,pz) in enumerate(POSITIONS):
    x=(px-5.9)/(11.7-5.9);z=(pz-1.3)/(7.05-1.3);delay=z*travel
    colorAll=interp(palette,np.maximum(t-delay,0),FPS)
    k=min(1,int(x*2));blend=x*2-k;color=colorAll[:,k]*(1-blend)+colorAll[:,k+1]*blend
    delayedEnergy=interp(en,np.maximum(t-delay,0),FPS);localPhase=phase-x*2.2-z*1.6
    pulse=pulses(t-delay,tr['onsets'],.24 if sid=='satf' else .16)
    if v=='a':
     wrap=.62+.30*live if sid=='tsom' else .75
     roomGain=1-z*(1-wrap)
     power=(.025+.19*delayedEnergy+.09*bright+.035*motion)*roomGain
     crest=.50+.28*np.sin(localPhase*.65)
     shape=.56+.44*np.exp(-.5*((y-crest[:,None])/.23)**2)
     intensity=power[:,None]*shape+.055*pulse[:,None]*np.exp(-.5*((y-.55)/.28)**2)
    else:
     roomGain=1-.12*z
     crest=.5+.37*np.sin(localPhase)
     sweep=np.exp(-.5*((y-crest[:,None])/(.10+.10*en[:,None]))**2)
     intensity=(.035+.13*delayedEnergy[:,None])*np.ones((1,16))
     intensity+=(.12+.28*bands[:,0,None]+.12*motion[:,None])*sweep
     intensity+=.25*pulse[:,None]*np.exp(-.5*((y-(.22+.55*bands[:,2,None]))/.18)**2)
     if sid=='tsom':
      portals=pulses(t-delay,[{'seconds':a,'strength':1} for a in [42.5,95,145,215,251.016667]],.65)
      intensity+=.28*portals[:,None]*sweep
      intensity*=1+.22*live[:,None]
     elif sid=='satf':
      # Individual soft rising ember heads, not fixture strobe commands.
      embers=np.zeros((n,16))
      for i,e in enumerate(tr['onsets']):
       if i%4 != tube%4:continue
       dt=t-e['seconds']-z*.18;life=ramp(dt/.18)*ramp((2.5-dt)/.8)
       embers+=life[:,None]*np.exp(-.5*((y-dt[:,None]/2.5)/.10)**2)*e['strength']
      intensity=.065+.12*delayedEnergy[:,None]+.12*sweep+.22*np.clip(embers,0,1)
     else:
      counter=np.exp(-.5*((y-(1-crest[:,None]))/.12)**2)
      intensity+=.12*bands[:,2,None]*counter
     intensity*=roomGain
    # Warm paper/fire remains warm; the other scores keep the source's chroma.
    if sid=='satf':color=.82*color+.18*np.array([1,.31,.07])
    white=.07 if v=='a' else .13
    frame[:,tube]=intensity[:,:,None]*(color[:,None,:]*(1-white)+white)
   frame=smooth(frame,FPS,settings['smoothingSeconds']['intensityAttack'],settings['smoothingSeconds']['intensityRelease'])
   fade=ramp(t/settings['fadeInSeconds'])*ramp((tr['duration']-t)/settings['fadeOutSeconds'])
   frame*=fade[:,None,None,None]*settings['sourceMaster'][v];frame=np.clip(frame,0,.95);frame[0]=0;frame[-1]=0
   header={'version':1,'name':tr['name']+' / '+label,'experience':sid+'-'+v,'fps':FPS,'bits':16,'pixelCount':128,'transfer':2.2,'loop':False,'patch':patch,'bakedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'bakedBy':'SoundSpace three-track DMX 1.0.0'}
   path=ROOT/'native'/f'{sid}-{v}.show';h=encode_show(path,frame,header)
   # Exact reference output: decode quantized show samples, apply client cap, then RGB8.
   encoded=np.floor(frame.astype(np.float64)**(1/2.2)*65535+.5);drive=np.floor((encoded/65535)**2.2*.5*255+.5).astype(np.uint8)
   (ROOT/'preview'/f'{sid}-{v}.dmx8').write_bytes(drive.tobytes())
   rec={'file':str(path.relative_to(ROOT)),'track':sid,'variation':v,'name':label,'duration':n/FPS,'sourceDuration':tr['duration'],'frames':n,'bytes':path.stat().st_size,'sha256':h,'peakDmxAt50PercentCap':int(drive.max()),'meanDmx':round(float(drive.mean()),2)};shows.append(rec)
   print('Baked',sid,v,n,'frames',flush=True)
  # Useful review jumps are measured high-energy moments separated by at least 20 seconds.
  candidates=np.argsort(en+.5*motion)[::-1];chosen=[]
  for i in candidates:
   at=float(t[i])
   if at<8 or at>tr['duration']-8 or any(abs(at-c)<20 for c in chosen):continue
   chosen.append(at)
   if len(chosen)==5:break
  jumps=sorted(set([0.,*tr['cueStarts'],*map(lambda x:round(x,2),chosen)]))
  review.append({'id':sid,'name':tr['name'],'duration':tr['duration'],'looks':tr['looks'],'context':sid+'-context.mp4','jumps':jumps,'measuredEnergyJumps':sorted(chosen)})
 index={'version':'1.0.0','format':'LBESHOW1','fps':FPS,'sampleBits':16,'transfer':2.2,'fixtureOutputBits':8,'clientMaster':1,'clientCap':.5,'sourceRepo':'https://github.com/phoriaverse/lbe-client-dmx','shows':shows}
 (ROOT/'native/index.json').write_text(json.dumps(index,indent=2)+'\n');(ROOT/'preview/index.json').write_text(json.dumps(review,indent=2)+'\n')
 (ROOT/'analysis/cues.json').write_text(json.dumps({'tsomAuthoredNeuralWindows':[[42.5,60],[95,120],[145,170],[215,235]],'tsomSource':'TheShapeOfMemory.playable / NeuralNetwork and Transition Splat tracks','reviewJumps':review,'otherTracks':'Measured audio envelopes and video colour/motion; no claimed manually authored Unity cue correspondence.'},indent=2)+'\n')

if __name__=='__main__':main()
