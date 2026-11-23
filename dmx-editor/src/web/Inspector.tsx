// The selection: name, transform (numeric twins of the gizmo), and for lights their fixture profile
// and where they sit on the wire.
//
// Several objects edit together, as in Unity's inspector: a field the selection disagrees on shows
// "—", and typing into one axis sets that axis on every selected object, leaving the others alone.

import { Button, Divider, Group, Select, Stack, Text, TextInput } from "@mantine/core";
import { useMemo, useSyncExternalStore } from "react";
import { buildPlan } from "../model/evaluate";
import { chainLights, rename, setLightProfile, setTransform, unchainLights, updateSurface } from "../model/ops";
import { resolveChain } from "../model/patch";
import { isLight, nodeById, type Projection, type RigNode, subtree } from "../model/rig";
import { setSurfaceUse } from "../model/sequence";
import { identityTransform, type Transform, type Vec3 } from "../model/transform";
import { mediaList } from "./api";
import { NumField, Vec3Field } from "./fields";
import { preview } from "./preview";
import { activeOf, edit, editSeq, setUi, useRig, useSeq, useUi } from "./state";

type Field = "position" | "rotation" | "scale";

export function Inspector() {
  const rig = useRig();
  const { selection } = useUi();
  const nodes = selection.map((id) => nodeById(rig, id)).filter((n): n is RigNode => !!n);
  const node = nodeById(rig, activeOf(selection) ?? "");

  if (!node) {
    return (
      <Stack p="sm" gap="xs">
        <Text size="sm" c="dimmed">
          Nothing selected.
        </Text>
        <Text size="xs" c="dimmed">
          Click a tube in the viewport or a row in the hierarchy. ⇧/⌘-click to add, drag a rectangle to select many.
          <br />
          RMB-drag to fly (WASD, Q down, E up, ⇧ faster, scroll for speed) · ⌥-drag orbit · ⌥-RMB zoom · MMB pan · F frame
          <br />Q view · W move · E rotate · R scale · Z pivot/center · X local/global · ⌘ while dragging snaps
          <br />⌘D duplicate · ⌘⌫ delete · I identify
        </Text>
      </Stack>
    );
  }

  const multi = nodes.length > 1;
  const key = (field: string) => `${selection.join(",")}.${field}`;
  const mixed = (field: Field): [boolean, boolean, boolean] => [0, 1, 2].map((i) => nodes.some((n) => n.transform[field][i] !== node.transform[field][i])) as [boolean, boolean, boolean];

  /** Set one axis of one field on every selected node. */
  const setAxis = (field: Field, label: string) => (v: Vec3, axis: number) =>
    edit(
      label,
      (d) => {
        for (const n of nodes) {
          const t: Transform = structuredClone(n.transform);
          t[field][axis] = v[axis]!;
          setTransform(d, n.id, t);
        }
      },
      key(field),
    );

  const lights = nodes.filter(isLight);
  const allLights = nodes.length > 0 && lights.length === nodes.length;
  const profiles = new Set(lights.map((n) => n.light.profile));
  const chainOf = (id: string) => rig.chains.find((c) => c.links.some((l) => l.light === id));
  const chains = new Set(lights.map((n) => chainOf(n.id)?.id ?? ""));

  const t = node.transform;
  const parent = node.parent ? nodeById(rig, node.parent) : undefined;
  const chain = chainOf(node.id);
  const resolved = chain ? resolveChain(rig, chain).find((r) => r.light === node.id) : undefined;
  const index = chain ? chain.links.findIndex((l) => l.light === node.id) : -1;
  const groupLights = multi ? [] : node.light ? [] : subtree(rig, node.id).filter(isLight);

  return (
    <Stack p="sm" gap="sm">
      {multi ? (
        <Text size="sm" fw={600}>
          {nodes.length} objects{" "}
          <Text span size="xs" c="dimmed" fw={400}>
            (active: {node.name})
          </Text>
        </Text>
      ) : (
        <TextInput size="xs" label={node.light ? "Light" : node.surface ? "Video surface" : "Group"} value={node.name} onChange={(e) => edit("Rename", (d) => rename(d, node.id, e.currentTarget.value), key("name"))} />
      )}
      {!multi && (
        <Text size="xs" c="dimmed">
          Parent:{" "}
          {parent ? (
            <a href="#" onClick={(e) => (e.preventDefault(), setUi({ selection: [parent.id] }))}>
              {parent.name}
            </a>
          ) : (
            "none (scene root)"
          )}
          {" · "}local space, metres, degrees (Y·X·Z)
        </Text>
      )}

      <Vec3Field label="Position" value={t.position} mixed={mixed("position")} step={0.01} onCommit={setAxis("position", "Move")} />
      <Vec3Field label="Rotation" value={t.rotation} mixed={mixed("rotation")} step={1} decimals={3} onCommit={setAxis("rotation", "Rotate")} />
      <Vec3Field label="Scale" value={t.scale} mixed={mixed("scale")} step={0.01} onCommit={setAxis("scale", "Scale")} />
      <Group gap={4}>
        <Button size="compact-xs" variant="subtle" onClick={() => edit("Reset rotation", (d) => nodes.forEach((n) => setTransform(d, n.id, { ...n.transform, rotation: [0, 0, 0] })))}>
          Reset rotation
        </Button>
        <Button size="compact-xs" variant="subtle" onClick={() => edit("Reset transform", (d) => nodes.forEach((n) => setTransform(d, n.id, identityTransform())))}>
          Reset all
        </Button>
      </Group>
      {lights.some((n) => n.transform.scale.some((s) => s !== 1)) && (
        <Text size="xs" c="orange">
          Scale stretches where pixels are drawn and sampled. A tube's real length comes from its profile.
        </Text>
      )}

      {allLights && (
        <>
          <Divider label={multi ? `Fixtures (${lights.length})` : "Fixture"} labelPosition="left" />
          <Select
            size="xs"
            label="Profile"
            placeholder="—"
            data={rig.profiles.map((p) => ({ value: p.id, label: `${p.name} — ${p.pixels} px, ${p.length} m` }))}
            value={profiles.size === 1 ? [...profiles][0]! : null}
            allowDeselect={false}
            onChange={(v) => v && edit("Change profile", (d) => lights.forEach((n) => setLightProfile(d, n.id, v)))}
          />
          <Select
            size="xs"
            label="Chain"
            placeholder="—"
            data={[{ value: "", label: "Not patched" }, ...rig.chains.map((c) => ({ value: c.id, label: c.name }))]}
            value={chains.size === 1 ? [...chains][0]! : null}
            allowDeselect={false}
            onChange={(v) => {
              const ids = lights.map((n) => n.id);
              edit(v ? "Move to chain" : "Unpatch", (d) => (v ? chainLights(d, v, ids) : unchainLights(d, ids)));
            }}
          />
          {!multi && resolved && (
            <Text size="xs">
              Fixture <b>{index + 1}</b> of {chain!.links.length} on {chain!.name} · universe <b>{resolved.universe}</b> channel <b>{resolved.channel}</b>
              {resolved.pinned ? " (pinned)" : ""} → next starts U{resolved.end.universe}.{resolved.end.channel}
            </Text>
          )}
          {multi && (
            <Text size="xs" c="dimmed">
              Moving several to a chain appends them in selection order.
            </Text>
          )}
        </>
      )}

      {!multi && node.surface && <SurfaceSection node={node} />}

      {groupLights.length > 0 && (
        <>
          <Divider label={`${groupLights.length} light${groupLights.length === 1 ? "" : "s"}`} labelPosition="left" />
          <Group gap={4}>
            {rig.chains.map((c) => (
              <Button key={c.id} size="compact-xs" variant="light" onClick={() => edit("Chain group", (d) => chainLights(d, c.id, groupLights.map((n) => n.id)))}>
                Append all to {c.name}
              </Button>
            ))}
            <Button size="compact-xs" variant="subtle" color="gray" onClick={() => edit("Unpatch group", (d) => unchainLights(d, groupLights.map((n) => n.id)))}>
              Unpatch all
            </Button>
          </Group>
        </>
      )}
    </Stack>
  );
}

/** A video surface: its shape (the rig's), and what plays on it in the open sequence (the sequence's). */
function SurfaceSection({ node }: { node: RigNode }) {
  const rig = useRig();
  const seq = useSeq();
  const media = useSyncExternalStore(mediaList.subscribe, mediaList.get);
  const snap = useSyncExternalStore(preview.subscribe, () => preview.snapshot);
  const s = node.surface!;
  const use = seq.surfaces[node.id];
  const set = (label: string, patch: Parameters<typeof updateSurface>[2]) => edit(label, (d) => updateSurface(d, node.id, patch));
  const plan = useMemo(() => buildPlan(rig, seq), [rig, seq]);
  const covered = plan.surfaces.find((p) => p.surface === node.id)?.pixels.length;
  const video = use?.video ? snap.videos[use.video] : undefined;

  const options = [{ value: "", label: "None" }, ...media.videos.map((v) => ({ value: v.name, label: `${v.name} — ${v.source}/` }))];
  if (use?.video && !media.videos.some((v) => v.name === use.video)) options.push({ value: use.video, label: `${use.video} (missing)` });

  return (
    <>
      <Divider label="Surface" labelPosition="left" />
      <Select
        size="xs"
        label="Projection"
        allowDeselect={false}
        data={[
          { value: "planar", label: "Planar — projects straight along its Z" },
          { value: "dome", label: "Dome — fisheye, centre straight up (+Y)" },
          { value: "equirect", label: "Equirect — 360°, centre at the front (−Z)" },
        ]}
        value={s.projection}
        onChange={(v) => v && set("Surface projection", { projection: v as Projection })}
      />
      {s.projection === "planar" ? (
        <Group gap={6} align="end" wrap="nowrap">
          <NumField label="Width (m)" min={0.01} w={90} value={s.width} onCommit={(v) => set("Surface width", { width: v })} />
          <NumField label="Height (m)" min={0.01} w={90} value={s.height} onCommit={(v) => set("Surface height", { height: v })} />
          {video?.width ? (
            <Button size="compact-xs" variant="subtle" onClick={() => set("Fit surface to video", { height: Math.round(((s.width * video.height) / video.width) * 1000) / 1000 })}>
              Fit height to video
            </Button>
          ) : null}
        </Group>
      ) : (
        <Group gap={6} align="end" wrap="nowrap">
          <NumField label="Radius (m)" min={0.01} w={90} value={s.radius} onCommit={(v) => set("Surface radius", { radius: v })} />
          {s.projection === "dome" && <NumField label="Field of view (°)" min={1} max={360} step={5} decimals={1} w={110} value={s.fov} onCommit={(v) => set("Dome field of view", { fov: v })} />}
        </Group>
      )}
      <Text size="xs" c="dimmed">
        {s.projection === "planar"
          ? "Lights take the colour straight in front of or behind them on this rectangle (along its blue axis). Seen from the +Z side the picture reads the right way round."
          : "Only a light's direction from this surface's origin matters. The radius is what is drawn, and what “nearest” measures to."}
      </Text>

      <Divider label={`In “${seq.name}”`} labelPosition="left" />
      <Select size="xs" label="Video" data={options} value={use?.video ?? ""} allowDeselect={false} searchable onChange={(v) => editSeq("Surface video", (d) => setSurfaceUse(d, node.id, { video: v || null }))} />
      <NumField label="Gain" min={0} max={16} step={0.05} w={90} value={use?.gain ?? 1} onCommit={(v) => editSeq("Surface gain", (d) => setSurfaceUse(d, node.id, { gain: v }))} />
      {video?.error && (
        <Text size="xs" c="red">
          {video.error}
        </Text>
      )}
      {use?.video && (
        <Text size="xs" c={covered ? "dimmed" : "orange"}>
          {covered ? `Lights ${covered} of ${plan.pixelCount} pixels.` : seq.sampling === "projection" ? "No pixel is inside this surface's projection. Move it over the lights, or switch the sequence to nearest-surface sampling." : "No pixel is nearest to this surface."}
        </Text>
      )}
    </>
  );
}
