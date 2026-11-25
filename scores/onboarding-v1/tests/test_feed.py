import unittest,sys,json,hashlib,socket,struct,math
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1];sys.path.insert(0,str(ROOT/'src'))
from feed import Feed,Clock,patch_frame,artdmx,validate_patch
class LightingTests(unittest.TestCase):
 @classmethod
 def setUpClass(cls):cls.f=Feed(ROOT);cls.p=json.loads((ROOT/'patch.example.json').read_text())
 def test_lengths_and_hashes(self):
  for name,info in self.f.manifest['files'].items():
   b=(ROOT/name).read_bytes();self.assertEqual(len(b),info['bytes']);self.assertEqual(hashlib.sha256(b).hexdigest(),info['sha256'])
  self.assertEqual(len((ROOT/'data/show.rgb8').read_bytes()),self.f.manifest['frameCount']*384)
 def test_deterministic_seek(self):
  a=self.f.frame('intro',107.35);self.f.frame('intro',5);self.assertEqual(a,self.f.frame('intro',107.35));self.assertEqual(len(a),384)
 def test_out_of_range_blacks_out(self):
  for st,t in [('missing',2),('intro',float('nan')),('intro',-1),('blackout',0)]:self.assertEqual(max(self.f.frame(st,t)),0)
 def test_rain_falls_down(self):
  times=json.loads((ROOT/'data/order-object25-09.json').read_text())['times'];t=times[0];tube=13%8
  def peak(at):
   f=self.f.frame('intro',at);v=[sum(f[(tube*16+i)*3:(tube*16+i+1)*3]) for i in range(16)];return max(range(16),key=lambda i:v[i])
  self.assertGreater(peak(t-1),peak(t-.2))
 def test_rise_moves_up(self):
  def height(t):
   f=self.f.frame('rise',t);w=[sum(f[i*3:i*3+3]) for i in range(16)];return sum(i*v for i,v in enumerate(w))/sum(w)
  self.assertGreater(height(3.8),height(.6)+4)
 def test_rain_stops_and_bass_fades(self):
  import csv
  with (ROOT/'data/metrics.csv').open() as f:rows=list(csv.DictReader(f))
  self.assertTrue(all(float(r['rain'])==0 for r in rows if r['stage']=='intro' and float(r['stageTime'])>=79))
  def avg(t):return sum(self.f.frame('bass',t))/384
  self.assertLess(avg(35.5),max(avg(t) for t in (24,27,30)))
 def test_virtual_patch_and_reverse(self):
  f=bytes(i%256 for i in range(384));v=patch_frame(f,self.p);self.assertEqual(bytes(v[0][:384]),f)
  p=json.loads(json.dumps(self.p));p['fixtures'][0]['reverse']=True;v=patch_frame(f,p);self.assertEqual(bytes(v[0][:3]),f[45:48])
 def test_patch_overlap_rejected(self):
  p=json.loads(json.dumps(self.p));p['fixtures'][1]['pixels'][0]['r']=1
  with self.assertRaises(AssertionError):validate_patch(p)
 def test_blackout_includes_control_slots(self):
  p=json.loads(json.dumps(self.p));p['constants']=[{'universe':0,'channel':500,'value':255}]
  self.assertEqual(max(patch_frame(bytes([255]*384),p,blackout=True)[0]),0)
 def test_packet_over_loopback(self):
  s=socket.socket(socket.AF_INET,socket.SOCK_DGRAM);s.bind(('127.0.0.1',0));s.settimeout(1);out=socket.socket(socket.AF_INET,socket.SOCK_DGRAM)
  packet=artdmx(257,bytes(range(256))*2,9);out.sendto(packet,s.getsockname());b,_=s.recvfrom(1024);s.close();out.close()
  self.assertEqual(b[:8],b'Art-Net\0');self.assertEqual(struct.unpack('<H',b[8:10])[0],0x5000);self.assertEqual(b[10:14],bytes([0,14,9,0]));self.assertEqual(struct.unpack('<H',b[14:16])[0],257);self.assertEqual(struct.unpack('>H',b[16:18])[0],512);self.assertEqual(len(b),530)
 def test_clock_pause_seek_timeout_and_order(self):
  c=Clock();p={'session':'test','sequence':1,'stage':'intro','seconds':50.,'playing':True};self.assertTrue(c.accept(p,10));self.assertAlmostEqual(c.state(10.2)[1],50.2)
  p.update(sequence=2,playing=False,seconds=12.);self.assertTrue(c.accept(p,10.2));self.assertEqual(c.state(10.4)[1],12.)
  self.assertFalse(c.accept(dict(p,sequence=1,seconds=80),10.4));self.assertEqual(c.state(10.8)[0],'blackout')
 def test_invalid_packet_does_not_refresh_clock(self):
  c=Clock();self.assertFalse(c.accept({'seconds':float('inf')},1));self.assertEqual(c.state(1)[0],'blackout')
if __name__=='__main__':unittest.main(verbosity=2)
