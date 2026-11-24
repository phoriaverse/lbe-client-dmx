#!/bin/bash
set -eu
cd "$(dirname "$0")/.."
stage=$(mktemp -d "./.dmx-build.XXXXXX")
trap 'rm -rf "$stage"' EXIT
name="SoundSpace DMX.app"
app="$stage/$name"
bin="$app/Contents/MacOS"
resources="$app/Contents/Resources"
mkdir -p "$bin" "$resources/web"
cp macos/Info.plist "$app/Contents/"
cp macos/DMX.icns src/serial-worker.mjs "$resources/"
cp src/web/{index.html,icon.png} "$resources/web/"

# Package the default fixture patch and the Node serial driver. Shows live beside the app.
bun -e '
  const preset = await Bun.file("config.pavotube.json").json();
  await Bun.write(process.argv[1] + "/rig.json", Bun.file(preset.rigFile));
  await Bun.write(process.argv[1] + "/config.pavotube.json", JSON.stringify({ ...preset, rigFile: "rig.json" }));
' "$resources"
mkdir "$stage/usb"
cp package.json bun.lock .npmrc "$stage/usb/"
(cd "$stage/usb" && bun install --production --frozen-lockfile --linker isolated --backend copyfile)
mv "$stage/usb/node_modules" "$resources/"

bun build src/index.ts --compile --outfile "$bin/dmx-server"
swiftc macos/main.swift -o "$bin/SoundSpace DMX"
codesign --force --sign - "$bin/dmx-server"
codesign --force --sign - "$app"
codesign --verify --deep --strict "$app"
if [[ -d "$name" ]]; then mv "$name" "$stage/previous.app"; fi
if ! mv "$app" .; then
  if [[ -d "$stage/previous.app" ]]; then mv "$stage/previous.app" "$name"; fi
  exit 1
fi
