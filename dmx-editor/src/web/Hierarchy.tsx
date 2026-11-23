// The outliner: the scene hierarchy, Unity-style. Click to select, drag onto a group to parent
// (world position is kept), drag onto the empty area to unparent. Lights show their place in the
// frame / chain so "is this the 7th tube on the wire?" is answerable at a glance.

import { ActionIcon, Badge, Button, Group, Menu, ScrollArea, Text, Tooltip } from "@mantine/core";
import type React from "react";
import { useState } from "react";
import { addGroup, addRail, addSurface, addTube, deleteNodes, duplicateNode, reparent } from "../model/ops";
import { resolveChain } from "../model/patch";
import { childrenOf, hierarchyOrder, type RigDocument, type RigNode, subtree } from "../model/rig";
import { identityTransform } from "../model/transform";
import { activeChainId, edit, setUi, useRig, useUi } from "./state";

export interface Placement {
  placementPoint(): [number, number, number];
  frameSelection(ids?: string[]): void;
}

export function Hierarchy({ place }: { place: () => Placement | null }) {
  const rig = useRig();
  const ui = useUi();
  const [dragging, setDragging] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);

  // "Chain 1 · 7" and the address, per light.
  const chainInfo = new Map<string, { chain: string; index: number; address: string }>();
  for (const chain of rig.chains) {
    resolveChain(rig, chain).forEach((r, i) => {
      if (!chainInfo.has(r.light)) chainInfo.set(r.light, { chain: chain.name, index: i + 1, address: `U${r.universe}.${r.channel}` });
    });
  }

  const at = () => ({ ...identityTransform(), position: place()?.placementPoint() ?? [0, 2, 0] });
  const chain = activeChainId(rig, ui.activeChain);
  const select = (ids: string[]) => setUi({ selection: ids });
  const visible = hierarchyOrder(rig).map((n) => n.id);

  /** Unity's hierarchy: click selects, ⌘-click toggles, ⇧-click selects the range from the active row. */
  const clickRow = (id: string, e: React.MouseEvent) => {
    const sel = ui.selection;
    if (e.metaKey || e.ctrlKey) {
      select(sel.includes(id) ? sel.filter((x) => x !== id) : [...sel, id]);
    } else if (e.shiftKey && sel.length) {
      const from = visible.indexOf(sel[sel.length - 1]!);
      const to = visible.indexOf(id);
      const range = visible.slice(Math.min(from, to), Math.max(from, to) + 1);
      // Keep the anchor active-adjacent: the clicked row becomes the active one.
      select([...sel.filter((x) => !range.includes(x)), ...range.filter((x) => x !== id), id]);
    } else select([id]);
  };

  const add = (label: string, fn: (d: RigDocument) => string) => {
    let id = "";
    if (edit(label, (d) => void (id = fn(d)))) select([id]);
  };

  const drop = (target: string | null) => {
    const id = dragging;
    setDragging(null);
    setDropTarget(null);
    if (!id || id === target) return;
    // Dragging a selected row drags the whole selection, as in Unity.
    const ids = ui.selection.includes(id) ? ui.selection : [id];
    edit(target ? "Parent" : "Unparent", (d) => ids.filter((x) => x !== target).forEach((x) => reparent(d, x, target)));
  };

  const renderNode = (node: RigNode, depth: number): React.ReactNode => {
    const kids = childrenOf(rig, node.id);
    const info = chainInfo.get(node.id);
    const selected = ui.selection.includes(node.id);
    const active = ui.selection[ui.selection.length - 1] === node.id;
    const lights = node.light ? 0 : subtree(rig, node.id).filter((n) => n.light).length;
    return (
      <div key={node.id}>
        <div
          className={`tree-row${selected ? " selected" : ""}${active ? " active" : ""}${dropTarget === node.id ? " drop" : ""}`}
          style={{ paddingLeft: 8 + depth * 14 }}
          draggable
          onDragStart={(e) => {
            e.dataTransfer.effectAllowed = "move";
            setDragging(node.id);
          }}
          onDragEnd={() => {
            setDragging(null);
            setDropTarget(null);
          }}
          onDragOver={(e) => {
            if (!dragging || node.light || node.surface) return;
            e.preventDefault();
            e.stopPropagation();
            setDropTarget(node.id);
          }}
          onDragLeave={() => setDropTarget((t) => (t === node.id ? null : t))}
          onDrop={(e) => {
            e.preventDefault();
            e.stopPropagation();
            drop(node.id);
          }}
          onClick={(e) => clickRow(node.id, e)}
          onDoubleClick={() => {
            select([node.id]);
            place()?.frameSelection([node.id]);
          }}
        >
          <span className="tree-icon">{node.light ? "▬" : node.surface ? "▦" : "▸"}</span>
          <span className="tree-name">{node.name}</span>
          {info ? (
            <Tooltip label={`${info.chain}, fixture ${info.index}, starts ${info.address}`} openDelay={400}>
              <span className="tree-badge">#{info.index}</span>
            </Tooltip>
          ) : node.light ? (
            <span className="tree-badge unpatched">—</span>
          ) : node.surface ? (
            <span className="tree-badge group">{node.surface.projection}</span>
          ) : (
            <span className="tree-badge group">{lights}</span>
          )}
        </div>
        {kids.map((k) => renderNode(k, depth + 1))}
      </div>
    );
  };

  const roots = rig.nodes.filter((n) => n.parent === null || !rig.nodes.some((p) => p.id === n.parent));

  return (
    <div className="panel">
      <Group gap={4} p={8} wrap="wrap">
        <Button size="compact-xs" variant="light" onClick={() => add("Add tube", (d) => addTube(d, { transform: at(), chain }))}>
          + Tube
        </Button>
        <Menu shadow="md" position="bottom-start">
          <Menu.Target>
            <Button size="compact-xs" variant="light">
              + Rail ▾
            </Button>
          </Menu.Target>
          <Menu.Dropdown>
            {[3, 5].flatMap((tubes) => [
              <Menu.Item key={`${tubes}i`} onClick={() => add(`Add ${tubes}-tube rail`, (d) => addRail(d, { tubes, transform: at(), chain }))}>
                {tubes} tubes, end to end
              </Menu.Item>,
              <Menu.Item key={`${tubes}p`} onClick={() => add(`Add ${tubes}-tube rail`, (d) => addRail(d, { tubes, layout: "parallel", transform: at(), chain }))}>
                {tubes} tubes, side by side
              </Menu.Item>,
            ])}
          </Menu.Dropdown>
        </Menu>
        <Button size="compact-xs" variant="subtle" onClick={() => add("Add group", (d) => addGroup(d, { transform: at() }))}>
          + Group
        </Button>
        <Menu shadow="md" position="bottom-start">
          <Menu.Target>
            <Button size="compact-xs" variant="subtle">
              + Surface ▾
            </Button>
          </Menu.Target>
          <Menu.Dropdown>
            <Menu.Item onClick={() => add("Add video surface", (d) => addSurface(d, { projection: "planar", transform: at() }))}>Planar — a flat screen</Menu.Item>
            <Menu.Item onClick={() => add("Add video surface", (d) => addSurface(d, { projection: "dome", transform: at() }))}>Dome — a fisheye picture overhead</Menu.Item>
            <Menu.Item onClick={() => add("Add video surface", (d) => addSurface(d, { projection: "equirect", transform: at() }))}>Equirect — a 360° picture all round</Menu.Item>
          </Menu.Dropdown>
        </Menu>
        <div style={{ flex: 1 }} />
        <Tooltip label="Duplicate (⌘D)">
          <ActionIcon
            size="sm"
            variant="subtle"
            disabled={!ui.selection.length}
            onClick={() => {
              const copies: string[] = [];
              if (edit("Duplicate", (d) => ui.selection.forEach((id) => { const c = duplicateNode(d, id); if (c) copies.push(c); }))) select(copies);
            }}
          >
            ⧉
          </ActionIcon>
        </Tooltip>
        <Tooltip label="Delete (⌘⌫)">
          <ActionIcon size="sm" variant="subtle" color="red" disabled={!ui.selection.length} onClick={() => edit("Delete", (d) => deleteNodes(d, ui.selection)) && select([])}>
            ✕
          </ActionIcon>
        </Tooltip>
      </Group>
      <Text size="xs" c="dimmed" px={8} pb={6}>
        New lights go on <b>{rig.chains.find((c) => c.id === chain)?.name ?? "no chain"}</b>, in the order you place them.
      </Text>
      <ScrollArea
        className="tree"
        onDragOver={(e) => {
          if (dragging) {
            e.preventDefault();
            setDropTarget("root");
          }
        }}
        onDrop={(e) => {
          e.preventDefault();
          drop(null);
        }}
        onClick={(e) => e.target === e.currentTarget && select([])}
      >
        {roots.map((n) => renderNode(n, 0))}
        {!rig.nodes.length && (
          <Text size="xs" c="dimmed" p="md">
            No lights yet. Place them in the order they are wired — the first tube off the gateway first.
          </Text>
        )}
        <div className={`tree-root-drop${dropTarget === "root" ? " drop" : ""}`}>{dragging ? "drop here to unparent" : ""}</div>
      </ScrollArea>
    </div>
  );
}
