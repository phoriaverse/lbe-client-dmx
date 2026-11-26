"""Bake the separate 30 s instructions score; never modifies the selected B scores."""
from pathlib import Path
import datetime, hashlib, json, math, struct
import numpy as np

ROOT = Path(__file__).resolve().parents[1]

def ramp(x):
    x = np.clip(x, 0, 1)
    return x * x * (3 - 2 * x)

def main():
    cfg = json.loads((ROOT / 'onboarding-settings.json').read_text())
    duration = float(cfg['durationSeconds'])
    fps = int(cfg['fps'])
    assert duration > 0 and 1 <= fps <= 1000
    assert 0 <= cfg['floorLinear'] <= cfg['peakLinear'] <= 1
    assert cfg['wavePeriodSeconds'] > 0 and cfg['verticalSpread'] > 0
    assert 0 < cfg['fadeInSeconds'] <= duration / 2
    assert 0 < cfg['fadeOutSeconds'] <= duration / 2
    n = math.ceil(duration * fps)
    t = np.arange(n, dtype=np.float64) / fps
    y = np.linspace(0, 1, 16)
    light = np.zeros((n, 8, 16, 3))
    for tube in range(8):
        # Adjacent fixtures share a broad crest, slowly circulating around the office ring.
        phase = 2 * np.pi * (t / cfg['wavePeriodSeconds'] - tube / 8)
        crest = .5 + cfg['verticalTravel'] * np.sin(phase)
        wave = np.exp(-.5 * ((y[None, :] - crest[:, None]) / cfg['verticalSpread']) ** 2)
        local = .72 + .28 * (.5 + .5 * np.sin(phase - .6))
        intensity = cfg['floorLinear'] + (cfg['peakLinear'] - cfg['floorLinear']) * wave * local[:, None]
        light[:, tube] = intensity[:, :, None]  # Equal RGB, no colour or flash channel.
    fade = ramp(t / cfg['fadeInSeconds']) * ramp((duration - 1 / fps - t) / cfg['fadeOutSeconds'])
    light *= fade[:, None, None, None]
    light[0] = light[-1] = 0
    encoded = np.floor(np.clip(light, 0, 1) ** (1 / 2.2) * 65535 + .5).astype('<u2')
    raw = encoded.tobytes()
    patch = json.loads((ROOT / 'hardware/patch.native.json').read_text())
    header = dict(version=1, name='Onboarding / Gentle White Waves', experience='Onboarding',
                  fps=fps, bits=16, pixelCount=128, frameCount=n, transfer=2.2, loop=False,
                  patch=patch, bakedAt=datetime.datetime.now(datetime.timezone.utc).isoformat(),
                  bakedBy='SoundSpace selected DMX 1.1.0', hashes={
                      'sequence': hashlib.sha256(raw).hexdigest(),
                      'rig': hashlib.sha256(json.dumps(patch, sort_keys=True).encode()).hexdigest()})
    body = json.dumps(header, separators=(',', ':')).encode()
    padding = (-(12 + len(body))) % 8
    target = ROOT / 'media/Onboarding.show'
    target.write_bytes(b'LBESHOW1' + struct.pack('<I', len(body) + padding) + body + b' ' * padding + raw)
    output = np.floor((encoded.astype(np.float64) / 65535) ** 2.2 * .5 * 255 + .5).astype(np.uint8)
    (ROOT / 'preview/onboarding.dmx8').write_bytes(output.tobytes())
    record = dict(file='media/Onboarding.show', state='Onboarding', track='onboarding',
                  variation='gentle-white', name='Gentle White Waves', duration=n / fps,
                  sourceDuration=duration, frames=n, bytes=target.stat().st_size,
                  sha256=hashlib.sha256(target.read_bytes()).hexdigest(),
                  peakDmxAt50PercentCap=int(output.max()), meanDmx=round(float(output.mean()), 2),
                  preview='preview/onboarding.dmx8')
    (ROOT / 'source/onboarding-record.json').write_text(json.dumps(record, indent=2) + '\n')
    manifest_path = ROOT / 'manifest.json'
    if manifest_path.exists():
        manifest = json.loads(manifest_path.read_text())
        manifest['shows'] = [s for s in manifest['shows'] if s['state'] != 'Onboarding'] + [record]
        manifest['instructionVideo'] = cfg
        manifest_path.write_text(json.dumps(manifest, indent=2) + '\n')
    print(json.dumps(record, indent=2))

if __name__ == '__main__':
    main()
