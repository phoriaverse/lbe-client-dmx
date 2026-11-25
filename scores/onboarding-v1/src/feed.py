"""Frame reader, explicit fixture patching and ArtDmx packet encoder. No dependencies."""
from pathlib import Path
import json,math,struct
class Feed:
 def __init__(self,root):
  self.root=Path(root);self.manifest=json.loads((self.root/'manifest.json').read_text());self.stride=self.manifest['frameBytes'];self.fps=self.manifest['fps'];self.segments={s['id']:s for s in self.manifest['segments']};self.frames={k:(self.root/'data'/f'{k}.rgb8').read_bytes() for k in self.segments}
 def frame(self,stage,seconds):
  if stage=='blackout':return bytes(self.stride)
  if stage not in self.segments or not math.isfinite(seconds) or seconds<0:return bytes(self.stride)
  s=self.segments[stage];n=s['frameCount'];f=seconds*self.fps
  if s['loop']:f%=n
  else:f=min(f,n-1)
  a=int(f);b=(a+1)%n if s['loop'] else min(a+1,n-1);u=f-a;raw=self.frames[stage]
  return bytes(round(raw[a*self.stride+j]*(1-u)+raw[b*self.stride+j]*u) for j in range(self.stride))
def validate_patch(p):
 used=set();tubes=[]
 for f in p['fixtures']:
  t=f['tube'];u=f['universe'];assert 0<=t<8 and 0<=u<32768;tubes.append(t)
  for pixel in f['pixels']:
   assert all(c in pixel for c in ('r','g','b'))
   for c,ch in pixel.items():
    assert c in ('r','g','b','w','dimmer') and type(ch)==int and 1<=ch<=512
    assert (u,ch) not in used,'Overlapping DMX slots';used.add((u,ch))
 for x in p.get('constants',[]):
  u,ch,v=x['universe'],x['channel'],x['value'];assert 0<=u<32768 and 1<=ch<=512 and 0<=v<=255;assert (u,ch) not in used;used.add((u,ch))
 assert sorted(tubes)==list(range(8)),'Patch exactly eight tubes'
 assert 0<=p.get('whiteMix',0)<=1
 return True
def patch_frame(rgb,p,master=1,blackout=False):
 validate_patch(p);master=max(0,min(1,master));out={f['universe']:bytearray(512) for f in p['fixtures']}
 for x in p.get('constants',[]):out.setdefault(x['universe'],bytearray(512))[x['channel']-1]=0 if blackout else x['value']
 if blackout:return out
 source_pixels=len(rgb)//24
 for f in p['fixtures']:
  n=len(f['pixels'])
  for i,channels in enumerate(f['pixels']):
   y=(n-1-i if f.get('reverse') else i)/max(1,n-1)*(source_pixels-1);a=int(y);b=min(source_pixels-1,a+1);v=y-a
   color=[(rgb[(f['tube']*source_pixels+a)*3+c]*(1-v)+rgb[(f['tube']*source_pixels+b)*3+c]*v)*master for c in range(3)]
   w=min(color)*p.get('whiteMix',0) if 'w' in channels else 0
   values={'r':color[0]-w,'g':color[1]-w,'b':color[2]-w,'w':w,'dimmer':255}
   for c,ch in channels.items():out[f['universe']][ch-1]=round(values[c])
 return out
def artdmx(universe,channels,sequence=1):
 if not 0<=universe<32768 or not 1<=sequence<=255:raise ValueError('ArtDmx address or sequence invalid')
 if not 2<=len(channels)<=512 or len(channels)%2:raise ValueError('DMX payload must be even, 2..512 slots')
 return b'Art-Net\0'+struct.pack('<H',0x5000)+struct.pack('>H',14)+bytes([sequence,0])+struct.pack('<H',universe)+struct.pack('>H',len(channels))+bytes(channels)
class Clock:
 """Monotonic host packet sequence; stalled host blacks out after 0.5s."""
 def __init__(self):self.packet=None;self.received=-1;self.session=None;self.sequence=-1
 def accept(self,p,now):
  if not isinstance(p,dict):return False
  if not isinstance(p.get('session'),str) or not p['session']:return False
  if type(p.get('sequence'))!=int or p['sequence']<0:return False
  if type(p.get('seconds')) not in (float,int) or not math.isfinite(p['seconds']) or p['seconds']<0:return False
  if not isinstance(p.get('stage'),str) or type(p.get('playing'))!=bool:return False
  if p['session']==self.session and p['sequence']<=self.sequence:return False
  self.session=p['session'];self.sequence=p['sequence'];self.packet=p;self.received=now;return True
 def state(self,now):
  if self.packet is None or now-self.received>.5:return 'blackout',0,True
  p=self.packet
  if p.get('blackout',False):return 'blackout',0,True
  return p['stage'],p['seconds']+(now-self.received if p['playing'] else 0),False
