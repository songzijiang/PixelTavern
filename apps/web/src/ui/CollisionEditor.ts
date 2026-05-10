/**
 * 场景编辑器：碰撞体积 + 素材位置可视化编辑。
 * 支持：
 * 1. 拖动碰撞区与素材；
 * 2. 碰撞区通过 8 个控制点自由缩放；
 * 3. 素材显示边框，并通过 4 个角点等比缩放；
 * 4. 列表与场景元素双向联动高亮；
 * 5. 点击“保存”后写入服务端。
 */
import Phaser from 'phaser';
import type { CollisionZone } from '../constants';
import { bus } from '../utils/EventBus';

const API_BASE = '';
const COLLISION_CACHE_KEY = 'pixeltavern:collisions:last-saved';
const HANDLE_SIZE = 10;
const MIN_ZONE_SIZE = 16;
const MIN_PROP_WIDTH = 20;
const MAX_PROP_WIDTH = 800;

type EditableProp = {
  x: number;
  y: number;
  key: string;
  folder: string;
  file: string;
  displayW: number;
  originY: number;
  depth: number;  // 0 = 由 ySortAll 自动管理；>0 = 叠加偏移
};

type ZoneResizeDir = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';
type PropResizeDir = 'nw' | 'ne' | 'se' | 'sw';

interface HandleVis<T extends string> {
  dir: T;
  node: Phaser.GameObjects.Rectangle;
}

interface ZoneVis {
  gfx: Phaser.GameObjects.Graphics;
  label: Phaser.GameObjects.Text;
  hit: Phaser.GameObjects.Zone;
  handles: HandleVis<ZoneResizeDir>[];
}

interface PropVis {
  gfx: Phaser.GameObjects.Graphics;
  label: Phaser.GameObjects.Text;
  hit: Phaser.GameObjects.Zone;
  handles: HandleVis<PropResizeDir>[];
}

type MoveZoneDrag = {
  kind: 'move-zone';
  idx: number;
  sx: number;
  sy: number;
};

type MovePropDrag = {
  kind: 'move-prop';
  idx: number;
  sx: number;
  sy: number;
};

type ResizeZoneDrag = {
  kind: 'resize-zone';
  idx: number;
  dir: ZoneResizeDir;
  left: number;
  right: number;
  top: number;
  bottom: number;
};

type ResizePropDrag = {
  kind: 'resize-prop';
  idx: number;
  dir: PropResizeDir;
  anchorX: number;
  anchorY: number;
  ratio: number;
};

type DragTarget = MoveZoneDrag | MovePropDrag | ResizeZoneDrag | ResizePropDrag;

type PropBounds = {
  left: number;
  right: number;
  top: number;
  bottom: number;
  width: number;
  height: number;
  centerX: number;
  centerY: number;
};

export class CollisionEditor {
  private scene: Phaser.Scene;
  private zones: CollisionZone[];
  private props: EditableProp[];
  private zoneVis: ZoneVis[] = [];
  private propVis: PropVis[] = [];
  private active = false;
  private listPanel: HTMLDivElement | null = null;
  private selZone = -1;
  private selProp = -1;
  private dragTarget: DragTarget | null = null;
  private hasUnsavedChanges = false;

  onUpdate: () => void;

  private onPointerMove = (ptr: Phaser.Input.Pointer) => {
    if (!this.active || !this.dragTarget) return;
    // 跳过 DOM 面板区域的指针事件
    if (this.isPointerOverEditorUI(ptr)) return;

    const d = this.dragTarget;
    switch (d.kind) {
      case 'move-zone': {
        const z = this.zones[d.idx];
        if (!z) return;
        z.x = ptr.x + d.sx;
        z.y = ptr.y + d.sy;
        this.updateZoneVisual(d.idx);
        return;
      }

      case 'move-prop': {
        const p = this.props[d.idx];
        if (!p) return;
        p.x = ptr.x + d.sx;
        p.y = ptr.y + d.sy;
        this.updatePropVisual(d.idx);
        this.syncPropImage(p);
        return;
      }

      case 'resize-zone': {
        this.resizeZoneFromPointer(d, ptr);
        return;
      }

      case 'resize-prop': {
        this.resizePropFromPointer(d, ptr);
        return;
      }
    }
  };

  private onPointerUp = (ptr: Phaser.Input.Pointer) => {
    if (!this.dragTarget) return;
    // 跳过 DOM 面板区域的指针事件
    if (this.isPointerOverEditorUI(ptr)) return;
    this.dragTarget = null;
    this.onUpdate();
    this.markUnsaved();
    this.renderList();
  };

  /** 检查指针是否位于编辑器 DOM 面板上方（避免穿透点击） */
  private isPointerOverEditorUI(ptr: Phaser.Input.Pointer): boolean {
    if (!ptr.event) return false;
    const el = document.elementFromPoint((ptr.event as PointerEvent).clientX, (ptr.event as PointerEvent).clientY);
    if (!el) return false;
    return el.closest('#editor-list') !== null || el.closest('#info-panel') !== null;
  }

  constructor(scene: Phaser.Scene, zones: CollisionZone[], props: EditableProp[], onUpdate: () => void) {
    this.scene = scene;
    this.zones = zones;
    this.props = props;
    this.onUpdate = onUpdate;

    // TavernScene 会先创建素材图片，再恢复保存数据；
    // 因此编辑器初始化时要把已保存的素材位置/尺寸重新同步到真实图片，
    // 避免刷新页面后配置已恢复、但场景图片仍停留在旧位置。
    void this.restoreSavedPropTransforms();
  }

  get isActive() {
    return this.active;
  }

  // ==== 持久化 ====
  private async save(): Promise<boolean> {
    const data = {
      zones: this.zones.map((z) => ({
        x: Math.round(z.x),
        y: Math.round(z.y),
        halfW: Math.round(z.halfW),
        halfH: Math.round(z.halfH),
      })),
      props: this.props.map((p) => ({
        key: p.key,
        folder: p.folder,
        file: p.file,
        x: Math.round(p.x),
        y: Math.round(p.y),
        displayW: Math.round(p.displayW),
        originY: p.originY,
        depth: p.depth || 0,
        ...((p as any)._ambient ? { _ambient: true } : {}),
      })),
    };

    try {
      const r = await fetch(`${API_BASE}/api/world/collisions`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      if (!r.ok) return false;
      CollisionEditor.saveLocalCache(data);
      this.hasUnsavedChanges = false;
      bus.emit('prompt:updated');
      return true;
    } catch {
      return false;
    }
  }

  static async load() {
    // 优先读取服务端 collisions.json；后端重启窗口期或返回空配置时，再用本地缓存兜底。
    try {
      const r = await fetch(`${API_BASE}/api/world/collisions`);
      if (r.ok) {
        const data = await r.json();
        if (CollisionEditor.hasSavedContent(data)) {
          CollisionEditor.saveLocalCache(data);
          return data;
        }
      }
    } catch {}

    return CollisionEditor.loadLocalCache();
  }

  private static hasSavedContent(data: any): boolean {
    return Boolean(
      (Array.isArray(data?.zones) && data.zones.length > 0) ||
      (Array.isArray(data?.props) && data.props.length > 0),
    );
  }

  private static saveLocalCache(data: unknown) {
    try {
      window.localStorage.setItem(COLLISION_CACHE_KEY, JSON.stringify(data));
    } catch {}
  }

  private static loadLocalCache() {
    try {
      const raw = window.localStorage.getItem(COLLISION_CACHE_KEY);
      if (!raw) return null;
      const data = JSON.parse(raw);
      return CollisionEditor.hasSavedContent(data) ? data : null;
    } catch {
      return null;
    }
  }

  private static clearLocalCache() {
    try {
      window.localStorage.removeItem(COLLISION_CACHE_KEY);
    } catch {}
  }

  private markUnsaved() {
    this.hasUnsavedChanges = true;
    const saveBtn = this.listPanel?.querySelector('#editor-save') as HTMLButtonElement | null;
    if (saveBtn) saveBtn.textContent = '保存';
  }

  private async restoreSavedPropTransforms() {
    const saved = await CollisionEditor.load();
    if (!saved?.props) return;

    let synced = false;
    for (const savedProp of saved.props) {
      const p = this.props.find((item) => item.key === savedProp.key);
      if (!p) continue;

      if (typeof savedProp.x === 'number') p.x = savedProp.x;
      if (typeof savedProp.y === 'number') p.y = savedProp.y;
      if (typeof savedProp.displayW === 'number') p.displayW = savedProp.displayW;
      if (typeof savedProp.depth === 'number') p.depth = savedProp.depth;

      this.syncPropImage(p);
      synced = true;
    }

    if (synced) this.onUpdate();
  }

  // ==== 开关 ====
  toggle() {
    this.active = !this.active;
    if (this.active) {
      this.buildAll();
      this.showList();
    } else {
      this.destroyAll();
      this.hideList();
    }
  }

  // ==== 可视化构建 ====
  private buildAll() {
    this.zoneVis = [];
    this.propVis = [];
    // 控制点与主体命中区重叠时，只让最上层对象接收点击，避免缩放被主体拖动覆盖。
    this.scene.input.setTopOnly(true);
    this.buildZones();
    this.buildProps();
    this.scene.input.on('pointermove', this.onPointerMove);
    this.scene.input.on('pointerup', this.onPointerUp);
  }

  private destroyAll() {
    this.scene.input.setTopOnly(true);
    this.scene.input.off('pointermove', this.onPointerMove);
    this.scene.input.off('pointerup', this.onPointerUp);
    this.dragTarget = null;

    this.zoneVis.forEach((v) => {
      v.gfx.destroy();
      v.label.destroy();
      v.hit.destroy();
      v.handles.forEach((h) => h.node.destroy());
    });
    this.propVis.forEach((v) => {
      v.gfx.destroy();
      v.label.destroy();
      v.hit.destroy();
      v.handles.forEach((h) => h.node.destroy());
    });

    this.zoneVis = [];
    this.propVis = [];
  }

  private buildZones() {
    const colors = [0x4488ff, 0x44aaff, 0x4488dd, 0x4499ee, 0x44aadd, 0x4499ff, 0x44bbff];
    this.zones.forEach((z, i) => this.buildZone(z, colors[i % colors.length]));
  }

  private buildZone(z: CollisionZone, color: number) {
    const idx = this.zoneVis.length;
    const gfx = this.scene.add.graphics().setDepth(102);
    const label = this.scene.add
      .text(z.x, z.y - z.halfH - 14, `🛑碰撞#${idx}`, {
        fontSize: '13px',
        color: '#aaccff',
        stroke: '#000',
        strokeThickness: 3,
      })
      .setOrigin(0.5)
      .setDepth(103);
    const hit = this.scene.add
      .zone(z.x, z.y, z.halfW * 2 + 24, z.halfH * 2 + 24)
      .setDepth(101)
      .setInteractive({ useHandCursor: true });

    const handles = this.createZoneHandles(idx);
    this.zoneVis.push({ gfx, label, hit, handles });
    this.redrawZoneGfx(idx, color);
    this.updateZoneVisual(idx);

    hit.on('pointerdown', (ptr: Phaser.Input.Pointer) => {
      if (this.isPointerOverEditorUI(ptr)) return;
      this.dragTarget = { kind: 'move-zone', idx, sx: z.x - ptr.x, sy: z.y - ptr.y };
      this.selectZone(idx, false);
    });
  }

  private createZoneHandles(idx: number): HandleVis<ZoneResizeDir>[] {
    const dirs: ZoneResizeDir[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
    return dirs.map((dir) => {
      const node = this.createHandleNode(0x66bbff);
      node.on('pointerdown', (ptr: Phaser.Input.Pointer) => {
        const z = this.zones[idx];
        if (!z) return;
        if (this.isPointerOverEditorUI(ptr)) return;
        ptr.event?.stopPropagation?.();
        this.selectZone(idx, false);
        this.dragTarget = {
          kind: 'resize-zone',
          idx,
          dir,
          left: z.x - z.halfW,
          right: z.x + z.halfW,
          top: z.y - z.halfH,
          bottom: z.y + z.halfH,
        };
      });
      return { dir, node };
    });
  }

  private redrawZoneGfx(idx: number, explicitColor?: number) {
    const v = this.zoneVis[idx];
    const z = this.zones[idx];
    if (!v || !z) return;

    const color =
      explicitColor ??
      [0x4488ff, 0x44aaff, 0x4488dd, 0x4499ee, 0x44aadd, 0x4499ff, 0x44bbff][idx % 7];
    const sel = this.selZone === idx;

    v.gfx.clear();
    if (sel) {
      v.gfx.fillStyle(0xffcc00, 0.12);
      v.gfx.fillRect(z.x - z.halfW - 5, z.y - z.halfH - 5, z.halfW * 2 + 10, z.halfH * 2 + 10);
    }
    v.gfx.fillStyle(color, 0.15);
    v.gfx.fillRect(z.x - z.halfW, z.y - z.halfH, z.halfW * 2, z.halfH * 2);
    v.gfx.lineStyle(sel ? 3 : 2, sel ? 0xffcc00 : color, sel ? 1 : 0.7);
    v.gfx.strokeRect(z.x - z.halfW, z.y - z.halfH, z.halfW * 2, z.halfH * 2);
  }

  private updateZoneVisual(idx: number) {
    const v = this.zoneVis[idx];
    const z = this.zones[idx];
    if (!v || !z) return;

    v.label.setPosition(z.x, z.y - z.halfH - 14);
    v.hit.setPosition(z.x, z.y);
    v.hit.setSize(z.halfW * 2 + 24, z.halfH * 2 + 24);
    this.redrawZoneGfx(idx);
    this.updateZoneHandles(idx);
  }

  private updateZoneHandles(idx: number) {
    const v = this.zoneVis[idx];
    const z = this.zones[idx];
    if (!v || !z) return;

    const left = z.x - z.halfW;
    const right = z.x + z.halfW;
    const top = z.y - z.halfH;
    const bottom = z.y + z.halfH;
    const midX = z.x;
    const midY = z.y;
    const visible = this.selZone === idx;

    const positions: Record<ZoneResizeDir, [number, number]> = {
      nw: [left, top],
      n: [midX, top],
      ne: [right, top],
      e: [right, midY],
      se: [right, bottom],
      s: [midX, bottom],
      sw: [left, bottom],
      w: [left, midY],
    };

    for (const h of v.handles) {
      const [x, y] = positions[h.dir];
      h.node.setPosition(x, y);
      this.setHandleActive(h.node, visible);
    }
  }

  private resizeZoneFromPointer(d: ResizeZoneDrag, ptr: Phaser.Input.Pointer) {
    const z = this.zones[d.idx];
    if (!z) return;

    let left = d.left;
    let right = d.right;
    let top = d.top;
    let bottom = d.bottom;

    if (d.dir.includes('w')) left = Math.min(ptr.x, right - MIN_ZONE_SIZE);
    if (d.dir.includes('e')) right = Math.max(ptr.x, left + MIN_ZONE_SIZE);
    if (d.dir.includes('n')) top = Math.min(ptr.y, bottom - MIN_ZONE_SIZE);
    if (d.dir.includes('s')) bottom = Math.max(ptr.y, top + MIN_ZONE_SIZE);

    z.x = (left + right) / 2;
    z.y = (top + bottom) / 2;
    z.halfW = Math.max(MIN_ZONE_SIZE / 2, (right - left) / 2);
    z.halfH = Math.max(MIN_ZONE_SIZE / 2, (bottom - top) / 2);

    this.updateZoneVisual(d.idx);
  }

  private buildProps() {
    this.props.forEach((p) => this.buildProp(p));
  }

  private buildProp(p: EditableProp) {
    const idx = this.propVis.length;
    const bounds = this.getPropBounds(p);
    const gfx = this.scene.add.graphics().setDepth(102);
    const label = this.scene.add
      .text(p.x, bounds.top - 14, `${p.key}`, {
        fontSize: '13px',
        color: '#ffcc66',
        stroke: '#000',
        strokeThickness: 3,
      })
      .setOrigin(0.5)
      .setDepth(103);
    const hit = this.scene.add
      .zone(bounds.centerX, bounds.centerY, bounds.width + 24, bounds.height + 24)
      .setDepth(101)
      .setInteractive({ useHandCursor: true });

    const handles = this.createPropHandles(idx);
    this.propVis.push({ gfx, label, hit, handles });
    this.updatePropVisual(idx);

    hit.on('pointerdown', (ptr: Phaser.Input.Pointer) => {
      if (this.isPointerOverEditorUI(ptr)) return;
      this.dragTarget = { kind: 'move-prop', idx, sx: p.x - ptr.x, sy: p.y - ptr.y };
      this.selectProp(idx, false);
    });
  }

  private createPropHandles(idx: number): HandleVis<PropResizeDir>[] {
    const dirs: PropResizeDir[] = ['nw', 'ne', 'se', 'sw'];
    return dirs.map((dir) => {
      const node = this.createHandleNode(0xffcc66);
      node.on('pointerdown', (ptr: Phaser.Input.Pointer) => {
        const p = this.props[idx];
        if (!p) return;
        if (this.isPointerOverEditorUI(ptr)) return;
        ptr.event?.stopPropagation?.();
        const bounds = this.getPropBounds(p);
        const ratio = bounds.width / Math.max(1, bounds.height);
        const anchors: Record<PropResizeDir, [number, number]> = {
          nw: [bounds.right, bounds.bottom],
          ne: [bounds.left, bounds.bottom],
          se: [bounds.left, bounds.top],
          sw: [bounds.right, bounds.top],
        };
        const [anchorX, anchorY] = anchors[dir];
        this.selectProp(idx, false);
        this.dragTarget = { kind: 'resize-prop', idx, dir, anchorX, anchorY, ratio };
      });
      return { dir, node };
    });
  }

  private updatePropVisual(idx: number) {
    const p = this.props[idx];
    const v = this.propVis[idx];
    if (!p || !v) return;

    const bounds = this.getPropBounds(p);
    const sel = this.selProp === idx;

    v.gfx.clear();
    v.gfx.fillStyle(sel ? 0xffcc00 : 0xffcc66, sel ? 0.08 : 0.03);
    v.gfx.fillRect(bounds.left, bounds.top, bounds.width, bounds.height);
    v.gfx.lineStyle(sel ? 3 : 2, sel ? 0xffcc00 : 0xffcc66, sel ? 1 : 0.75);
    v.gfx.strokeRect(bounds.left, bounds.top, bounds.width, bounds.height);

    v.label.setPosition(p.x, bounds.top - 14);
    v.hit.setPosition(bounds.centerX, bounds.centerY);
    v.hit.setSize(bounds.width + 24, bounds.height + 24);
    this.updatePropHandles(idx, bounds);
  }

  private updatePropHandles(idx: number, bounds = this.getPropBounds(this.props[idx])) {
    const v = this.propVis[idx];
    if (!v || !bounds) return;

    const visible = this.selProp === idx;
    const positions: Record<PropResizeDir, [number, number]> = {
      nw: [bounds.left, bounds.top],
      ne: [bounds.right, bounds.top],
      se: [bounds.right, bounds.bottom],
      sw: [bounds.left, bounds.bottom],
    };

    for (const h of v.handles) {
      const [x, y] = positions[h.dir];
      h.node.setPosition(x, y);
      this.setHandleActive(h.node, visible);
    }
  }

  private resizePropFromPointer(d: ResizePropDrag, ptr: Phaser.Input.Pointer) {
    const p = this.props[d.idx];
    if (!p) return;

    const rawW = Math.abs(ptr.x - d.anchorX);
    const rawH = Math.abs(ptr.y - d.anchorY);
    const widthFromY = rawH * d.ratio;
    const nextWidth = Phaser.Math.Clamp(Math.max(rawW, widthFromY), MIN_PROP_WIDTH, MAX_PROP_WIDTH);
    const nextHeight = nextWidth / Math.max(0.0001, d.ratio);

    let left = 0;
    let right = 0;
    let top = 0;
    let bottom = 0;

    switch (d.dir) {
      case 'nw':
        right = d.anchorX;
        bottom = d.anchorY;
        left = right - nextWidth;
        top = bottom - nextHeight;
        break;
      case 'ne':
        left = d.anchorX;
        bottom = d.anchorY;
        right = left + nextWidth;
        top = bottom - nextHeight;
        break;
      case 'se':
        left = d.anchorX;
        top = d.anchorY;
        right = left + nextWidth;
        bottom = top + nextHeight;
        break;
      case 'sw':
        right = d.anchorX;
        top = d.anchorY;
        left = right - nextWidth;
        bottom = top + nextHeight;
        break;
    }

    p.displayW = nextWidth;
    p.x = (left + right) / 2;
    p.y = top + nextHeight * p.originY;

    this.updatePropVisual(d.idx);
    this.syncPropImage(p);
  }

  private getPropBounds(p: EditableProp): PropBounds {
    const width = Math.max(MIN_PROP_WIDTH, p.displayW);
    const height = width * this.getPropAspectHeightRatio(p);
    const left = p.x - width / 2;
    const right = p.x + width / 2;
    const top = p.y - height * p.originY;
    const bottom = top + height;

    return {
      left,
      right,
      top,
      bottom,
      width,
      height,
      centerX: (left + right) / 2,
      centerY: (top + bottom) / 2,
    };
  }

  private getPropAspectHeightRatio(p: EditableProp): number {
    const image = this.findPropImage(p);
    if (image?.texture?.key) {
      const tex = this.scene.textures.get(image.texture.key)?.getSourceImage() as
        | HTMLImageElement
        | HTMLCanvasElement
        | undefined;
      if (tex && tex.width > 0) return tex.height / tex.width;
    }

    const tk = `${p.folder}_${p.file.replace('.png', '')}`;
    const tex = this.scene.textures.get(tk)?.getSourceImage() as HTMLImageElement | HTMLCanvasElement | undefined;
    if (tex && tex.width > 0) return tex.height / tex.width;

    return 1;
  }

  private findPropImage(p: EditableProp): Phaser.GameObjects.Image | Phaser.GameObjects.Sprite | undefined {
    return this.scene.children.list.find((obj) => {
      const maybeDef = (obj as any)?._propDef || (obj as any)?._ambientDef;
      return maybeDef?.key === p.key;
    }) as Phaser.GameObjects.Image | Phaser.GameObjects.Sprite | undefined;
  }

  private syncPropImage(p: EditableProp) {
    const image = this.findPropImage(p);
    if (!image) return;

    const ratio = this.getPropAspectHeightRatio(p);
    image.setDisplaySize(p.displayW, p.displayW * ratio);
    image.setPosition(p.x, p.y);
    // 实时同步 depth 到引擎：写入底层 def 对象供 ySortAll 读取
    const def = (image as any)._propDef || (image as any)._ambientDef;
    if (def) (def as any).depth = p.depth || 0;
    if (p.depth) image.setDepth(p.depth);

    const shadow = (image as any)._propShadow as Phaser.GameObjects.Ellipse | undefined;
    if (shadow) {
      const bounds = this.getPropBounds(p);
      const w = Math.max(28, bounds.width * (p.file === '椅子.png' ? 0.58 : 0.72));
      const h = Math.max(8, w * 0.22);
      shadow.setPosition(p.x, bounds.bottom - 3);
      shadow.setDisplaySize(w, h);
    }

    // 同步氛围对象的发光
    const glow = (image as any)._ambientGlow as { node: Phaser.GameObjects.Arc } | undefined;
    const ambientDef = (image as any)._ambientDef as { glow?: { offsetX?: number; offsetY?: number } } | undefined;
    if (glow && ambientDef?.glow) {
      glow.node.setPosition(p.x + (ambientDef.glow.offsetX ?? 0), p.y + (ambientDef.glow.offsetY ?? 0));
    }
  }

  private createHandleNode(color: number): Phaser.GameObjects.Rectangle {
    const node = this.scene.add
      .rectangle(0, 0, HANDLE_SIZE, HANDLE_SIZE, color, 1)
      .setStrokeStyle(2, 0x111111, 1)
      .setDepth(105)
      .setVisible(false);
    node.disableInteractive();
    return node;
  }

  private setHandleActive(node: Phaser.GameObjects.Rectangle, active: boolean) {
    node.setVisible(active);
    if (active) {
      node.setInteractive({ useHandCursor: true });
    } else {
      node.disableInteractive();
    }
  }

  // ==== 选择联动 ====
  selectZone(i: number, toggle = true) {
    const prevZone = this.selZone;
    const prevProp = this.selProp;
    this.selProp = -1;
    this.selZone = toggle && this.selZone === i ? -1 : i;

    if (prevZone >= 0) this.updateZoneVisual(prevZone);
    if (this.selZone >= 0) this.updateZoneVisual(this.selZone);
    if (prevProp >= 0) this.updatePropVisual(prevProp);
    this.highlightList();
  }

  selectProp(i: number, toggle = true) {
    const prevZone = this.selZone;
    const prevProp = this.selProp;
    this.selZone = -1;
    this.selProp = toggle && this.selProp === i ? -1 : i;

    if (prevZone >= 0) this.updateZoneVisual(prevZone);
    if (prevProp >= 0) this.updatePropVisual(prevProp);
    if (this.selProp >= 0) this.updatePropVisual(this.selProp);
    this.highlightList();
  }

  private highlightList() {
    if (!this.listPanel) return;

    this.listPanel.querySelectorAll('.ed-sel').forEach((e) => e.classList.remove('ed-sel'));

    if (this.selZone >= 0) {
      const r = this.listPanel.querySelector(`[data-zidx="${this.selZone}"]`);
      if (r) r.classList.add('ed-sel');
    }
    if (this.selProp >= 0) {
      const r = this.listPanel.querySelector(`[data-pidx="${this.selProp}"]`);
      if (r) r.classList.add('ed-sel');
    }
  }

  // ==== 管理列表（嵌入场景编辑选项卡） ====
  private showList() {
    if (this.listPanel) return;

    const container = document.getElementById('info-tab-scene-edit');
    if (!container) return;

    const p = document.createElement('div');
    p.id = 'editor-list';
    this.listPanel = p;
    this.renderList();
    container.appendChild(p);
  }

  private hideList() {
    if (!this.listPanel) return;
    this.listPanel.remove();
    this.listPanel = null;
  }

  private renderList() {
    if (!this.listPanel) return;

    const p = this.listPanel;
    p.innerHTML =
      '<div style="display:flex;align-items:center;gap:6px;margin-bottom:4px"><span style="color:#c9a96e;font-weight:bold;flex:1">场景编辑器</span><button id="editor-save" style="padding:1px 6px;font-size:9px;border:1px solid #5a8;border-radius:2px;background:transparent;color:#8dc;cursor:pointer">保存</button><button id="editor-reset" style="padding:1px 6px;font-size:9px;border:1px solid #a44;border-radius:2px;background:transparent;color:#c88;cursor:pointer">重置</button></div>' +
      '<div style="color:#777;font-size:9px;margin-bottom:4px;line-height:1.45">拖动主体 = 移动；选中后拖动控制点 = 缩放。<br>碰撞区可自由拉伸，素材角点保持等比缩放。</div>';

    p.querySelector('#editor-save')?.addEventListener('click', async () => {
      const saveBtn = p.querySelector('#editor-save') as HTMLButtonElement | null;
      if (saveBtn) saveBtn.textContent = '保存中';
      const ok = await this.save();
      if (saveBtn) saveBtn.textContent = ok ? '已保存' : '保存失败';
    });

    p.querySelector('#editor-reset')?.addEventListener('click', () => {
      CollisionEditor.clearLocalCache();
      fetch(`${API_BASE}/api/world/collisions`, { method: 'DELETE' }).catch(() => {});
      location.reload();
    });

    p.appendChild(hdr('碰撞区'));
    this.zones.forEach((z, i) => {
      const cls = this.selZone === i ? ' ed-sel' : '';
      const r = row(
        `🛑#${i}`,
        `(${Math.round(z.x)},${Math.round(z.y)}) ${Math.round(z.halfW * 2)}×${Math.round(z.halfH * 2)}`,
        cls,
        () => {
          this.selZone = -1;
          this.zones.splice(i, 1);
          this.destroyAll();
          this.buildAll();
          this.onUpdate();
          this.markUnsaved();
          this.renderList();
        },
      );
      r.dataset.zidx = String(i);
      r.addEventListener('click', (e) => {
        if ((e.target as HTMLElement).tagName !== 'BUTTON') this.selectZone(i);
      });
      p.appendChild(r);
    });

    p.appendChild(
      btn('+ 碰撞区', '#5a8', () => {
        this.zones.push({ x: 480, y: 320, halfW: 40, halfH: 30 });
        this.destroyAll();
        this.buildAll();
        this.onUpdate();
        this.markUnsaved();
        this.renderList();
      }),
    );

    p.appendChild(hdr('素材（depth: 0=自动, 越大越靠前）'));
    this.props.forEach((m, i) => {
      const cls = this.selProp === i ? ' ed-sel' : '';
      const bounds = this.getPropBounds(m);
      const d = m.depth || 0;
      const depthLabel = d > 0 ? ` d:${d}` : '';
      const r = row(
        `📦${m.key}${depthLabel}`,
        `(${Math.round(m.x)},${Math.round(m.y)}) ${Math.round(bounds.width)}×${Math.round(bounds.height)}`,
        cls,
        () => {
          this.selProp = -1;
          this.props.splice(i, 1);
          this.destroyAll();
          this.buildAll();
          this.markUnsaved();
          this.renderList();
        },
      );
      // depth 调节按钮
      const depthCtl = document.createElement('span');
      depthCtl.style.cssText = 'display:inline-flex;align-items:center;gap:2px;margin-left:6px;font-size:10px';
      const btnDec = document.createElement('button');
      btnDec.textContent = '−';
      btnDec.style.cssText = 'padding:0 4px;font-size:10px;border:1px solid #555;border-radius:2px;background:transparent;color:#aaa;cursor:pointer;line-height:14px';
      btnDec.addEventListener('click', (e) => { e.stopPropagation(); m.depth = Math.max(0, (m.depth || 0) - 10); this.syncPropImage(m); this.markUnsaved(); this.renderList(); });
      const btnInc = document.createElement('button');
      btnInc.textContent = '+';
      btnInc.style.cssText = 'padding:0 4px;font-size:10px;border:1px solid #555;border-radius:2px;background:transparent;color:#aaa;cursor:pointer;line-height:14px';
      btnInc.addEventListener('click', (e) => { e.stopPropagation(); m.depth = (m.depth || 0) + 10; this.syncPropImage(m); this.markUnsaved(); this.renderList(); });
      depthCtl.appendChild(btnDec);
      depthCtl.appendChild(btnInc);
      const infoSpan = r.querySelector('span');
      if (infoSpan) infoSpan.appendChild(depthCtl);
      r.dataset.pidx = String(i);
      r.addEventListener('click', (e) => {
        if ((e.target as HTMLElement).tagName !== 'BUTTON') this.selectProp(i);
      });
      p.appendChild(r);
    });

    p.appendChild(
      btn('+ 素材', '#c96', () => {
        const folder = prompt('素材目录名（如 物体、桌椅）:', '物体');
        const file = prompt('文件名（如 酒桶.png）:', '酒桶.png');
        if (!folder || !file) return;

        const tk = `${folder}_${file.replace('.png', '')}`;
        const newProp: EditableProp = {
          key: `prop_${tk}`,
          folder,
          file,
          x: 480,
          y: 320,
          displayW: 80,
          originY: 0,
          depth: 0,
        };
        this.props.push(newProp);

        if (this.scene.textures.exists(tk)) {
          const img = this.scene.add.image(480, 320, tk).setOrigin(0.5, 0).setDepth(100);
          const tex = this.scene.textures.get(tk)?.getSourceImage() as HTMLImageElement | HTMLCanvasElement | undefined;
          const ratio = tex && tex.width > 0 ? tex.height / tex.width : 1;
          img.setDisplaySize(80, 80 * ratio);
          (img as any)._propDef = newProp;
        }

        this.destroyAll();
        this.buildAll();
        this.markUnsaved();
        this.renderList();
      }),
    );
  }
}

function hdr(t: string): HTMLElement {
  const d = document.createElement('div');
  d.style.cssText = 'color:#888;font-size:10px;margin-top:6px;border-top:1px solid #222;padding-top:4px';
  d.textContent = t;
  return d;
}

function row(label: string, info: string, cls: string, onDel: () => void): HTMLElement {
  const d = document.createElement('div');
  d.className = 'ed-row' + cls;
  d.style.cssText =
    'display:flex;align-items:center;gap:4px;padding:2px 4px;color:#aaa;cursor:pointer;border-radius:3px;transition:background .15s';
  d.innerHTML = `<span style="min-width:58px;font-size:10px">${label}</span><span style="flex:1;font-size:9px">${info}</span>`;

  const del = document.createElement('button');
  del.textContent = '✕';
  del.style.cssText =
    'padding:0 3px;font-size:8px;border:1px solid #633;border-radius:2px;background:transparent;color:#c88;cursor:pointer';
  del.addEventListener('click', (e) => {
    e.stopPropagation();
    onDel();
  });
  d.appendChild(del);

  return d;
}

function btn(text: string, color: string, onClick: () => void): HTMLElement {
  const b = document.createElement('button');
  b.textContent = text;
  b.style.cssText = `margin-top:4px;padding:3px 8px;font-size:10px;border:1px solid ${color};border-radius:3px;background:transparent;color:${color};cursor:pointer;width:100%`;
  b.addEventListener('click', onClick);
  return b;
}
