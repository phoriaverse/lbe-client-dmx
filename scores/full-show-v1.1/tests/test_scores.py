"""Verify immutable selections, timing, patch, smooth white output and preview evidence."""
from pathlib import Path
import hashlib, json, os, shutil, struct, subprocess
import numpy as np

ROOT = Path(__file__).resolve().parents[1]
ORIGINAL = {
    'tsom': 'a8e838c59a30915beeef10353e5cd4154df141250da4d0ec9db1b29040976381',
    'satf': 'c70cdb170e55ac221723bd99e8985f8448bfb814892ff34f95c61df7f34f4a69',
    'second-nature': '5b438e980c6c5b6ee73bc621fa97fc89c0445b3f38ae433ba8a761362439434b',
}
manifest = json.loads((ROOT/'manifest.json').read_text())
assert {s['state'] for s in manifest['shows']} == {'The Shape of Memory', 'Sit Around the Fire', 'Second Nature', 'Onboarding'}
results = []
for rec in manifest['shows']:
    raw = (ROOT/rec['file']).read_bytes()
    assert raw[:8] == b'LBESHOW1'
    offset = 12 + struct.unpack('<I', raw[8:12])[0]
    h = json.loads(raw[12:offset])
    assert hashlib.sha256(raw).hexdigest() == rec['sha256']
    if rec['track'] in ORIGINAL:
        assert rec['sha256'] == ORIGINAL[rec['track']], 'Selected B changed'
    assert h['hashes']['sequence'] == hashlib.sha256(raw[offset:]).hexdigest()
    assert len(raw)-offset == h['frameCount']*128*3*2
    assert h['fps'] == 40 and h['bits'] == 16 and not h['loop']
    assert [p['channel'] for p in h['patch']['runs']] == [1, 49, 97, 145, 193, 241, 289, 337]
    assert 0 <= rec['duration']-rec['sourceDuration'] < .025
    values = np.frombuffer(raw, '<u2', offset=offset).reshape(-1, 8, 16, 3)
    assert not values[0].any() and not values[-1].any()
    drive = np.frombuffer((ROOT/rec['preview']).read_bytes(), np.uint8).reshape(values.shape)
    assert drive.max() <= 128 and len(values) == rec['frames']
    step = int(np.abs(np.diff(drive.astype(np.int16), axis=0)).max())
    assert step <= 7
    if rec['state'] == 'Onboarding':
        assert rec['duration'] == 30 and len(values) == 1200
        assert np.array_equal(values[..., 0], values[..., 1]) and np.array_equal(values[..., 1], values[..., 2])
        assert 15 <= drive.max() <= 22 and step <= 1
        assert drive[120:1000].min() > 0, 'Unexpected blackout during instructions'
        assert np.std(drive[120:1000, 0, 8, 0]) > 2, 'Wave is static'
        assert np.mean(np.abs(drive[120:1000, 0].astype(float)-drive[120:1000, 4])) > 1, 'No travelling phase'
    results.append(dict(state=rec['state'], frames=len(values), peakDmx=int(drive.max()), maximumFrameStep=step, firstAndLastFrameBlack=True, sha256Verified=True))
cfg = manifest['instructionVideo']
video = ROOT/'reference'/cfg['sourceVideo']
assert hashlib.sha256(video.read_bytes()).hexdigest() == cfg['sourceSha256']
FF = os.environ.get('FFMPEG') or shutil.which('ffmpeg') or '/Users/trentino-claw/.local/bin/ffmpeg'
FP = os.environ.get('FFPROBE') or shutil.which('ffprobe') or '/Users/trentino-claw/.local/bin/ffprobe'
for path in [video, ROOT/'preview/Onboarding-Gentle-White-Waves.mp4']:
    meta = json.loads(subprocess.check_output([FP, '-v', 'error', '-show_format', '-show_streams', '-of', 'json', str(path)]))
    assert float(meta['format']['duration']) == 30
    assert len(meta['streams']) == 1 and meta['streams'][0]['codec_type'] == 'video'
    subprocess.run([FF, '-v', 'error', '-i', str(path), '-f', 'null', '-'], check=True, capture_output=True)
(ROOT/'tests/metrics.json').write_text(json.dumps(dict(status='passed', scores=results, totalFrames=sum(r['frames'] for r in results), instructionSourceSeconds=30, previewSeconds=30, hardwareOutput=False), indent=2)+'\n')
print(json.dumps(results, indent=2))
