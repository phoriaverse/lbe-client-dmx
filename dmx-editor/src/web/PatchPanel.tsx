// Gateways and chains. Patching follows chain order automatically: each fixture starts on the
// channel after the previous one ends. A link can be PINNED to an explicit address (the manual
// override), and the chain carries on from there. The compiled result is exactly the Patch the
// client plays — shown at the bottom with anything that would make it wrong.

import { ActionIcon, Alert, Badge, Button, Card, Group, Radio, Select, Stack, Text, TextInput, Tooltip } from "@mantine/core";
import { compilePatch, describePatch } from "../../../dmx-client/src/shared/patch";
import { addChain, addGateway, chainLights, deleteChain, deleteGateway, moveLink, reverseChain, setLinkStart, unchainLights, updateChain, updateGateway } from "../model/ops";
import { compileRigPatch, resolveChain, rigProblems } from "../model/patch";
import { isLight, nodeById, subtree } from "../model/rig";
import { NumField } from "./fields";
import { activeChainId, edit, setUi, useRig, useUi } from "./state";

export function PatchPanel() {
  const rig = useRig();
  const ui = useUi();
  const problems = rigProblems(rig);
  const patch = compileRigPatch(rig);
  const summary = problems.length ? null : describePatch(compilePatch(patch));
  const active = activeChainId(rig, ui.activeChain);
  const patched = new Set(rig.chains.flatMap((c) => c.links.map((l) => l.light)));
  const unpatched = rig.nodes.filter((n) => isLight(n) && !patched.has(n.id));
  // Every light in the selection, in selection order (a selected rail contributes its tubes in order).
  const selectedLights = [...new Set(ui.selection.flatMap((id) => subtree(rig, id).filter(isLight).map((n) => n.id)))];

  return (
    <Stack p="sm" gap="sm">
      <Group justify="space-between">
        <Text fw={600} size="sm">
          Gateways
        </Text>
        <Button size="compact-xs" variant="light" onClick={() => edit("Add gateway", (d) => void addGateway(d))}>
          + Gateway
        </Button>
      </Group>
      {rig.gateways.map((g) => (
        <Card key={g.id} p="xs" withBorder>
          <Group gap={6} align="end" wrap="nowrap">
            <TextInput size="xs" label="Name" value={g.name ?? ""} w={110} onChange={(e) => edit("Rename gateway", (d) => updateGateway(d, g.id, { name: e.currentTarget.value }), `${g.id}.name`)} />
            <TextInput size="xs" label="IP" value={g.host} style={{ flex: 1 }} onChange={(e) => edit("Gateway address", (d) => updateGateway(d, g.id, { host: e.currentTarget.value.trim() }), `${g.id}.host`)} />
            <NumField label="Port" integer min={1} max={65535} w={70} value={g.port ?? 6454} onCommit={(v) => edit("Gateway port", (d) => updateGateway(d, g.id, { port: v === 6454 ? undefined : v }))} />
            <Tooltip label={rig.chains.some((c) => c.gateway === g.id) ? "A chain uses it" : "Remove"}>
              <ActionIcon variant="subtle" color="red" disabled={rig.chains.some((c) => c.gateway === g.id)} onClick={() => edit("Remove gateway", (d) => deleteGateway(d, g.id))}>
                ✕
              </ActionIcon>
            </Tooltip>
          </Group>
          <Text size="xs" c="dimmed" mt={4}>
            id <code>{g.id}</code> · port 6454 for real hardware; the simulator listens on 6455
          </Text>
        </Card>
      ))}

      <Group justify="space-between" mt="xs">
        <Text fw={600} size="sm">
          Chains
        </Text>
        <Button size="compact-xs" variant="light" onClick={() => edit("Add chain", (d) => void addChain(d))}>
          + Chain
        </Button>
      </Group>
      <Radio.Group value={active ?? ""} onChange={(v) => setUi({ activeChain: v || null })}>
        <Stack gap="sm">
          {rig.chains.map((chain) => {
            const resolved = resolveChain(rig, chain);
            return (
              <Card key={chain.id} p="xs" withBorder>
                <Group gap={6} align="end" wrap="nowrap">
                  <TextInput size="xs" label="Chain" value={chain.name} style={{ flex: 1 }} onChange={(e) => edit("Rename chain", (d) => updateChain(d, chain.id, { name: e.currentTarget.value }), `${chain.id}.name`)} />
                  <Select size="xs" label="Gateway" w={110} allowDeselect={false} data={rig.gateways.map((g) => ({ value: g.id, label: g.name || g.id }))} value={chain.gateway} onChange={(v) => v && edit("Chain gateway", (d) => updateChain(d, chain.id, { gateway: v }))} />
                  <NumField label="Universe" integer min={0} max={32767} w={66} value={chain.universe} onCommit={(v) => edit("Chain start", (d) => updateChain(d, chain.id, { universe: v }))} />
                  <NumField label="Channel" integer min={1} max={512} w={62} value={chain.channel} onCommit={(v) => edit("Chain start", (d) => updateChain(d, chain.id, { channel: v }))} />
                </Group>
                <Group gap={6} mt={6}>
                  <Radio size="xs" value={chain.id} label="New lights go here" />
                  <div style={{ flex: 1 }} />
                  <Button size="compact-xs" variant="subtle" disabled={!selectedLights.length} onClick={() => edit("Add to chain", (d) => chainLights(d, chain.id, selectedLights))}>
                    Add selected
                  </Button>
                  <Button size="compact-xs" variant="subtle" disabled={chain.links.length < 2} onClick={() => edit("Reverse chain", (d) => reverseChain(d, chain.id))}>
                    Reverse
                  </Button>
                  <Button size="compact-xs" variant="subtle" color="red" disabled={rig.chains.length < 2} onClick={() => edit("Remove chain", (d) => deleteChain(d, chain.id))}>
                    Remove
                  </Button>
                </Group>

                {chain.links.length > 0 && (
                  <table className="links">
                    <thead>
                      <tr>
                        <th>#</th>
                        <th>Light</th>
                        <th>Universe</th>
                        <th>Channel</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {chain.links.map((link, i) => {
                        const r = resolved[i]!;
                        const node = nodeById(rig, link.light);
                        const pin = (u: number, c: number) => edit("Pin address", (d) => setLinkStart(d, chain.id, i, { universe: u, channel: c }));
                        return (
                          <tr key={link.light} className={ui.selection.includes(link.light) ? "selected" : ""} onClick={() => setUi({ selection: [link.light] })}>
                            <td>{i + 1}</td>
                            <td>{node?.name ?? "(missing)"}</td>
                            <td onClick={(e) => e.stopPropagation()}>
                              {r.pinned ? <NumField integer min={0} max={32767} w={56} value={r.universe} onCommit={(v) => pin(v, r.channel)} /> : r.universe}
                            </td>
                            <td onClick={(e) => e.stopPropagation()}>
                              {r.pinned ? <NumField integer min={1} max={512} w={56} value={r.channel} onCommit={(v) => pin(r.universe, v)} /> : r.channel}
                            </td>
                            <td className="link-actions" onClick={(e) => e.stopPropagation()}>
                              <Tooltip label={r.pinned ? "Follow the chain again" : "Pin this address (manual override)"}>
                                <ActionIcon size="xs" variant={r.pinned ? "filled" : "subtle"} color={r.pinned ? "orange" : "gray"} style={{ opacity: r.pinned ? 1 : 0.35 }} onClick={() => edit(r.pinned ? "Unpin address" : "Pin address", (d) => setLinkStart(d, chain.id, i, r.pinned ? null : { universe: r.universe, channel: r.channel }))}>
                                  📌
                                </ActionIcon>
                              </Tooltip>
                              <ActionIcon size="xs" variant="subtle" disabled={i === 0} onClick={() => edit("Reorder chain", (d) => moveLink(d, chain.id, i, i - 1))}>
                                ↑
                              </ActionIcon>
                              <ActionIcon size="xs" variant="subtle" disabled={i === chain.links.length - 1} onClick={() => edit("Reorder chain", (d) => moveLink(d, chain.id, i, i + 1))}>
                                ↓
                              </ActionIcon>
                              <ActionIcon size="xs" variant="subtle" color="red" onClick={() => edit("Unpatch", (d) => unchainLights(d, [link.light]))}>
                                ✕
                              </ActionIcon>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                )}
              </Card>
            );
          })}
          <Radio size="xs" value="" label="Leave new lights unpatched" />
        </Stack>
      </Radio.Group>

      {unpatched.length > 0 && (
        <Text size="xs" c="dimmed">
          Not on any chain (drawn, never sent): {unpatched.map((n) => n.name).join(", ")}
        </Text>
      )}

      <Card p="xs" withBorder>
        <Text fw={600} size="sm" mb={4}>
          Compiled patch
        </Text>
        {summary ? (
          <Group gap={6}>
            <Badge color="teal" variant="light">
              valid
            </Badge>
            <Text size="xs">{summary}</Text>
          </Group>
        ) : (
          <Alert color="red" p="xs" title="This patch would light the wrong pixels">
            <Stack gap={2}>
              {problems.map((p) => (
                <Text key={p} size="xs">
                  {p}
                </Text>
              ))}
            </Stack>
          </Alert>
        )}
        <details>
          <summary>
            <Text span size="xs" c="dimmed">
              Show the Patch JSON the client receives
            </Text>
          </summary>
          <pre className="patch-json">{JSON.stringify(patch, null, 1)}</pre>
        </details>
      </Card>
    </Stack>
  );
}
