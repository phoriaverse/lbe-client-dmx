"""Analyze actual track video and synchronized review audio. No hardware output."""
from pathlib import Path
import json, hashlib, subprocess, os, shutil
import numpy as np

ROOT=Path(__file__).resolve().parents[1]
FF=os.environ.get('FFMPEG') or shutil.which('ffmpeg') or '/Users/trentino-claw/.local/bin/ffmpeg'
PROBE=os.environ.get('FFPROBE') or shutil.which('ffprobe') or '/Users/trentino-claw/.local/bin/ffprobe'
MEDIA=Path(os.environ.get('SOUNDSPACE_MEDIA','/Users/trentino-claw/Developer/SoundSpace-AVP-Build85-Local/Assets/StreamingAssets/SoundSpaceAVP'))
DELIVERY=Path(os.environ.get('SOUNDSPACE_REVIEW_MEDIA','/Volumes/AVP-Build-Archive/AgentWorkspaces/LBE-Three-Track-Composites-20261125/delivery'))
TRACKS=[
 {'id':'tsom','name':'The Shape of Memory','chapter':2,'file':'tsom-aac.mp4','crop':'crop=iw/2:ih:0:0,','duration':278.266667,'cueStarts':[37.15,42.5,54.65,60,89.65,95,114.65,120,139.65,145,164.65,170,183.333333,209.65,215,229.65,235,251.016667],'looks':['Memory Echo','Neural Current']},
 {'id':'satf','name':'Sit Around the Fire','chapter':3,'file':'satf-video.mp4','crop':'','duration':506.033333,'cueStarts':[],'looks':['Ember Halo','Rising Embers']},
 {'id':'second-nature','name':'Second Nature','chapter':1,'file':'second-nature-silent-preview.mp4','crop':'','duration':195.0,'cueStarts':[],'looks':['Tidal Reflection','Chromatic Rapids']},
]

def sha(p):
 h=hashlib.sha256()
 with Path(p).open('rb') as f:
  for b in iter(lambda:f.read(4*1024*1024),b''):h.update(b)
 return h.hexdigest()

def run(args):
 subprocess.run([FF,'-hide_banner','-v','error','-nostdin',*args],check=True)

def valid_proxy(path,duration):
 if not path.exists():return False
 try:
  probe=json.loads(subprocess.check_output([PROBE,'-v','error','-show_entries','stream=codec_type,duration','-of','json',str(path)]))
  video=next(s for s in probe['streams'] if s['codec_type']=='video')
  return abs(float(video['duration'])-duration)<.15
 except (subprocess.CalledProcessError,ValueError,KeyError,StopIteration):return False

def norm(a):
 return np.clip(a/max(float(np.percentile(a,95)),1e-7),0,1)

def smooth(a,rate,attack,release):
 out=np.empty_like(a); prev=np.zeros_like(a[0])
 for i,x in enumerate(a):
  k=1-np.exp(-1/rate/np.where(x>prev,attack,release));prev=prev+(x-prev)*k;out[i]=prev
 return out

def main():
 (ROOT/'analysis').mkdir(exist_ok=True);(ROOT/'preview').mkdir(exist_ok=True)
 manifest=[]
 for tr in TRACKS:
  sid=tr['id'];src=MEDIA/tr['file'];review=next((DELIVERY/f"track-{tr['chapter']}").glob('*Review-V01.mp4'))
  print('Analyzing',sid,flush=True)
  proxy=ROOT/'analysis'/f'{sid}-sampling.mp4'
  if not valid_proxy(proxy,tr['duration']):
   # Retain one TSOM eye; black pixels are excluded from palette estimation.
   vf=tr['crop']+'fps=10,scale=320:320,colorspace=all=bt709:trc=srgb:format=yuv420p'
   temporary=proxy.with_suffix('.partial.mp4')
   hw=['-hwaccel',os.environ['FFMPEG_HWACCEL']] if os.environ.get('FFMPEG_HWACCEL') else []
   run([*hw,'-threads','2','-i',str(src),'-t',str(tr['duration']),'-vf',vf,'-an','-c:v','libx264','-threads','2','-preset','veryfast','-crf','16','-movflags','+faststart','-y',str(temporary)])
   if not valid_proxy(temporary,tr['duration']):raise RuntimeError('Incomplete analysis proxy: '+sid)
   temporary.replace(proxy)
  raw=subprocess.check_output([FF,'-v','error','-threads','2','-i',str(proxy),'-vf','scale=96:96','-f','rawvideo','-pix_fmt','rgb24','-'])
  frames=np.frombuffer(raw,np.uint8).reshape(-1,96,96,3)/255
  linear=np.where(frames<=.04045,frames/12.92,((frames+.055)/1.055)**2.4).astype(np.float32)
  lum=linear@np.array([.2126,.7152,.0722],np.float32)
  brightness=np.percentile(lum,85,axis=(1,2)); motion=np.r_[0,np.mean(np.abs(np.diff(lum,axis=0)),axis=(1,2))]
  palettes=[];previous=np.tile(np.array([.6,.45,.26]),(3,1))
  for i,f in enumerate(linear):
   colors=[]
   for c in range(3):
    region=f[12:84,c*32:(c+1)*32];l=lum[i,12:84,c*32:(c+1)*32];w=np.sqrt(l)*np.clip((l-.002)/.02,0,1)
    color=np.sum(region*w[...,None],axis=(0,1))/max(float(np.sum(w)),1e-6)
    if color.max()<.008:color=previous[c] # keep chroma through live-only/black-video passages
    else:color=color/max(float(color.max()),.05)
    colors.append(color)
   previous=np.array(colors);palettes.append(previous.copy())
  palettes=smooth(np.asarray(palettes),10,.35,.6)
  pcm=subprocess.check_output([FF,'-v','error','-threads','2','-i',str(review),'-t',str(tr['duration']),'-vn','-ac','1','-ar','22050','-f','f32le','-'])
  audio=np.frombuffer(pcm,np.float32);n=int(np.ceil(tr['duration']*40));fft=[];rms=[];window=np.hanning(2048)
  freqs=np.fft.rfftfreq(2048,1/22050)
  for i in range(n):
   center=int(i*22050/40);segment=np.zeros(2048);a=max(0,center-1024);b=min(len(audio),center+1024);off=a-(center-1024);segment[off:off+b-a]=audio[a:b]
   rms.append(np.sqrt(np.mean(segment**2)));fft.append(np.abs(np.fft.rfft(segment*window))**2)
  fft=np.asarray(fft);bands=np.stack([np.sqrt(fft[:,(freqs>=a)&(freqs<b)].sum(axis=1)) for a,b in [(30,160),(160,1500),(1500,8000)]],axis=1)
  energy=smooth(norm(np.asarray(rms)),40,.08,.38);band=np.stack([smooth(norm(bands[:,i]),40,.06,.30) for i in range(3)],axis=1)
  flux=norm(np.maximum(0,np.diff(np.sqrt(fft),axis=0,prepend=np.sqrt(fft[:1]))).sum(axis=1))
  # Refractory interval avoids turning every high-frequency peak into a flash.
  onset=[];last=-100
  for i in range(2,n-2):
   if flux[i]>.58 and flux[i]>=max(flux[i-2:i+3]) and energy[i]>.16 and i/40-last>1.1:
    onset.append({'seconds':round(i/40,3),'strength':round(float(flux[i]),4)});last=i/40
  np.savez_compressed(ROOT/'analysis'/f'{sid}.npz',palette=palettes,brightness=norm(brightness),motion=norm(motion),energy=energy,bands=band,flux=flux)
  # Review movie is a completed scene composite, not the currently running refinement job.
  pv=ROOT/'preview'/f'{sid}-context.mp4'
  if not valid_proxy(pv,tr['duration']):
   temporary=pv.with_suffix('.partial.mp4')
   run(['-threads','2','-i',str(review),'-t',str(tr['duration']),'-vf','fps=15,scale=640:360','-c:v','libx264','-threads','2','-preset','veryfast','-crf','24','-c:a','aac','-b:a','128k','-ac','2','-movflags','+faststart','-y',str(temporary)])
   if not valid_proxy(temporary,tr['duration']):raise RuntimeError('Incomplete context proxy: '+sid)
   temporary.replace(pv)
  rec=dict(tr,sourceVideo=str(src),sourceVideoSHA256=sha(src),reviewSource=str(review),reviewSourceSHA256=sha(review),samplingFps=10,audioFeatureFps=40,onsets=onset)
  (ROOT/'analysis'/f'{sid}-provenance.json').write_text(json.dumps(rec,indent=2)+'\n');manifest.append(rec)
  print('Complete',sid,'onsets',len(onset),flush=True)
 (ROOT/'tracks.json').write_text(json.dumps(manifest,indent=2)+'\n')

if __name__=='__main__':main()
