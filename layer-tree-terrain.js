import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
export function addTreeTerrainLayer(lmap, maplibregl) {
  if (typeof THREE === 'undefined') return;
  if (!GLTFLoader) {
    console.warn('[tree] GLTFLoader 未加载');
    return;
  }

  const TOTAL_MAX = 10000;   // 视野内树数上限
  const GRID_M = 12;         // 网格树距（米）
  const JITTER_M = 3;       // 每棵树极坐标随机偏移最大距离（米）
  const ROW_SPACING_M = 12;
  const TREE_CLEARANCE_M = 4;
  const VARIANTS = 3;       // 树模型变体数

  const MODEL_URLS = [
    'models/tree-deciduous-a.glb',
    'models/tree-deciduous-b.glb',
    'models/tree-evergreen.glb'
  ];

  let treeData = [];
  let started = false;
  let variants = null;
  let originMerc = null;       
  let originLng = 0, originLat = 0;
  // 种树网格使用 originMerc；以下状态只用于绘制。
  let renderMerc = null;
  let renderEast = 0;
  let renderNorth = 0;
  const RENDER_REBASE_M = 256;
  let layer = null;
  let refreshTimer = null;
  const TREE_MIN_ZOOM = 17;

  function hash2(gx, gy, salt) {
    let h = (gx * 374761393) ^ (gy * 668265263) ^ (salt * 982451653);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    h = h ^ (h >>> 16);
    return (h >>> 0) / 4294967295;
  }

  function toEastNorth(lng, lat) {
    const m = maplibregl.MercatorCoordinate.fromLngLat([lng, lat], 0);
    const unit = originMerc.meterInMercatorCoordinateUnits();
    return [(m.x - originMerc.x) / unit, (originMerc.y - m.y) / unit];
  }
 
  function updateRenderOrigin(centerMerc) {
    const unit = originMerc.meterInMercatorCoordinateUnits();
    const east = (centerMerc.x - originMerc.x) / unit;
    const north = (originMerc.y - centerMerc.y) / unit;
    const distance2 = (east - renderEast) ** 2 + (north - renderNorth) ** 2;
    if (renderMerc && distance2 < RENDER_REBASE_M ** 2) return false;

    renderMerc = centerMerc;
    renderEast = east;
    renderNorth = north;
    return true;
  }

  function inRing(x, y, ring) {
    let ins = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const xi = ring[i][0], yi = ring[i][1];
      const xj = ring[j][0], yj = ring[j][1];
      if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) ins = !ins;
    }
    return ins;
  }
  function inPolyMeters(x, y, outer, holes) {
    if (!inRing(x, y, outer)) return false;
    for (let h = 0; h < holes.length; h++) if (inRing(x, y, holes[h])) return false;
    return true;
  }

  const TILE_EXTENT = 8192;
  let lastCoverage = null;
  let lastTreeData = null;
  let lastExaggeration = null;
  let lastMeshSize = null;
  let warnedTerrainAPI = false;

  // 与地形网格一致：每格沿左上到右下的对角线分成两个三角形。
  function sampleTerrainTriangle(sampler, x, y, meshSize) {
    const step = TILE_EXTENT / meshSize;
    const column = Math.min(meshSize - 1, Math.max(0, Math.floor(x / step)));
    const row = Math.min(meshSize - 1, Math.max(0, Math.floor(y / step)));
    const x0 = column * step;
    const y0 = row * step;
    const u = Math.min(1, Math.max(0, (x - x0) / step));
    const v = Math.min(1, Math.max(0, (y - y0) / step));
    const topLeft = sampler(x0, y0, TILE_EXTENT);
    const bottomRight = sampler(x0 + step, y0 + step, TILE_EXTENT);

    if (v >= u) {
      const bottomLeft = sampler(x0, y0 + step, TILE_EXTENT);
      return topLeft * (1 - v) + bottomLeft * (v - u) + bottomRight * u;
    }

    const topRight = sampler(x0 + step, y0, TILE_EXTENT);
    return topLeft * (1 - u) + topRight * (u - v) + bottomRight * v;
  }

  function updateTerrainHeights() {
    // getTerrain() 返回配置。实际渲染瓦片索引在 Terrain 对象上。
    const terrain = lmap.terrain;
    if (!terrain?.getCoverageIndex && lmap.getTerrain() && !warnedTerrainAPI) {
      warnedTerrainAPI = true;
      console.warn('[tree] 当前 MapLibre 版本未提供地形覆盖索引，暂不显示无可用高程的树');
    }
    const meshSize = terrain?.meshSize;
    const usableMesh = Number.isInteger(meshSize) && meshSize > 0;
    const coverage = usableMesh ? terrain?.getCoverageIndex?.() ?? null : null;
    const exaggeration = terrain?.exaggeration ?? 1;
    if (coverage === lastCoverage && treeData === lastTreeData &&
        exaggeration === lastExaggeration && meshSize === lastMeshSize) return false;

    lastCoverage = coverage;
    lastTreeData = treeData;
    lastExaggeration = exaggeration;
    lastMeshSize = meshSize;
    let changed = false;
    for (const tree of treeData) {
      let sampler = null;
      let x = 0;
      let y = 0;
      if (coverage) {
        const wrap = Math.floor(tree.worldX);
        for (const z of coverage.zooms) {
          const scale = 2 ** z;
          const scaledX = (tree.worldX - wrap) * scale;
          const scaledY = tree.worldY * scale;
          const tx = Math.floor(scaledX);
          const ty = Math.floor(scaledY);
          const key = wrap + '/' + z + '/' + tx + '/' + ty;
          const match = coverage.samplerPerTile.get(key);
          if (match === undefined) continue;
          sampler = match;
          x = (scaledX - tx) * TILE_EXTENT;
          y = (scaledY - ty) * TILE_EXTENT;
          break;
        }
      }

      if (tree.terrainSampler === sampler && tree.exaggeration === exaggeration &&
          tree.terrainMeshSize === meshSize) continue;
      tree.terrainSampler = sampler;
      tree.exaggeration = exaggeration;
      tree.terrainMeshSize = meshSize;
      const sample = sampler
        ? sampleTerrainTriangle(sampler, x, y, meshSize) * exaggeration
        : null;
      const elev = Number.isFinite(sample) ? sample : null;
      if (elev !== tree.elev) {
        tree.elev = elev;
        changed = true;
      }
    }
    return changed;
  }

  function loadGLBModels() {
    const loader = new GLTFLoader();
    const tasks = MODEL_URLS.map(url => new Promise((resolve, reject) => {
      loader.load(url,
        g => {
          const meshes = [];
          g.scene.traverse(o => {
            if (o.isMesh) meshes.push({ geometry: o.geometry, material: o.material });
          });
          resolve({ meshes });
        },
        undefined,
        err => reject(err)
      );
    }));
    return Promise.all(tasks);
  }

  function gridCandidate(gx, gy) {
    const angle = hash2(gx, gy, 0) * Math.PI * 2 - Math.PI;
    const radius = hash2(gx, gy, 1) * JITTER_M;
    return {
      key: 'wood:' + gx + ',' + gy,
      gx, gy, kind: 'wood', priority: 2,
      east: gx + radius * Math.cos(angle),
      north: gy + radius * Math.sin(angle)
    };
  }

  function createTree(candidate) {
    const { key, east, north, kind, priority } = candidate;
    const unit = originMerc.meterInMercatorCoordinateUnits();
    // 外观按地理位置生成，点位不加随机偏移。
    const seedX = kind === 'wood' ? candidate.gx : Math.round(east * 10);
    const seedY = kind === 'wood' ? candidate.gy : Math.round(north * 10);
    return {
      key, east, north, kind, priority,
      worldX: originMerc.x + east * unit,
      worldY: originMerc.y - north * unit,
      elev: null, terrainSampler: null, exaggeration: null,
      sc: 0.8 + hash2(seedX, seedY, 2) * 0.6,
      rotY: hash2(seedX, seedY, 3) * Math.PI * 2,
      v: Math.floor(hash2(seedX, seedY, 4) * VARIANTS)
    };
  }

  function readFeatures(source, sourceLayer, filter) {
    if (!lmap.getSource(source)) return [];
    const options = { sourceLayer };
    if (filter) options.filter = filter;
    return lmap.querySourceFeatures(source, options);
  }

  function addMappedTree(lngLat, kind, area, candidates) {
    if (!Array.isArray(lngLat) || !lngLat.slice(0, 2).every(Number.isFinite)) return;
    const [east, north] = toEastNorth(lngLat[0], lngLat[1]);
    addMappedPosition(east, north, kind, area, candidates);
  }

  function addMappedPosition(east, north, kind, area, candidates) {
    if (east < area.minX || east > area.maxX || north < area.minY || north > area.maxY) return;
    // 去除瓦片缓冲区内重复返回的点，精度约 10 厘米。
    const key = kind + ':' + Math.round(east * 10) + ',' + Math.round(north * 10);
    candidates.set(key, {
      key, east, north, kind,
      priority: kind === 'point' ? 0 : 1
    });
  }

  // 把线段先裁到视野范围，长线也只扫描附近的一段。
  function clipSegment(ax, ay, bx, by, area) {
    const dx = bx - ax;
    const dy = by - ay;
    let first = 0, last = 1;
    const edges = [
      [-dx, ax - area.minX], [dx, area.maxX - ax],
      [-dy, ay - area.minY], [dy, area.maxY - ay]
    ];
    for (const [direction, distance] of edges) {
      if (direction === 0) {
        if (distance < 0) return null;
        continue;
      }
      const t = distance / direction;
      if (direction < 0) first = Math.max(first, t);
      else last = Math.min(last, t);
      if (first > last) return null;
    }
    return [first, last];
  }

  function collectRow(line, area, candidates) {
    for (let i = 1; i < line.length; i++) {
      let [ax, ay] = toEastNorth(line[i - 1][0], line[i - 1][1]);
      let [bx, by] = toEastNorth(line[i][0], line[i][1]);
      // 统一方向，防止重复线反向返回时改变树位。
      if (ax > bx || (ax === bx && ay > by)) {
        [ax, bx] = [bx, ax];
        [ay, by] = [by, ay];
      }
      const length = Math.hypot(bx - ax, by - ay);
      if (length < 0.01) continue;
      const clipped = clipSegment(ax, ay, bx, by, area);
      if (!clipped) continue;
      const ux = (bx - ax) / length;
      const uy = (by - ay) / length;
      // 用固定网格坐标确定间距相位；直线被瓦片切开也沿用同一序列。
      const phase = ax * ux + ay * uy;
      const first = phase + clipped[0] * length;
      const last = phase + clipped[1] * length;
      if (length < ROW_SPACING_M) {
        addMappedPosition((ax + bx) / 2, (ay + by) / 2, 'row', area, candidates);
        continue;
      }
      for (let d = Math.ceil(first / ROW_SPACING_M) * ROW_SPACING_M;
           d <= last + 1e-7; d += ROW_SPACING_M) {
        const distance = d - phase;
        addMappedPosition(ax + distance * ux, ay + distance * uy, 'row', area, candidates);
      }
    }
  }

  function collectMappedTrees(area, candidates) {
    for (const feature of readFeatures('補自然元素', '獨木')) {
      const geometry = feature.geometry;
      if (geometry.type === 'Point') {
        addMappedTree(geometry.coordinates, 'point', area, candidates);
      } else if (geometry.type === 'MultiPoint') {
        for (const point of geometry.coordinates) addMappedTree(point, 'point', area, candidates);
      }
    }
    for (const feature of readFeatures('補自然元素', '行木')) {
      const geometry = feature.geometry;
      if (geometry.type === 'LineString') {
        collectRow(geometry.coordinates, area, candidates);
      } else if (geometry.type === 'MultiLineString') {
        for (const line of geometry.coordinates) collectRow(line, area, candidates);
      }
    }
  }

  function collectTreeCells(co, area, candidates) {
    if (!co[0]?.length) return;
    const outer = co[0].map(([lng, lat]) => toEastNorth(lng, lat));
    let minX = Infinity, maxX = -Infinity;
    let minY = Infinity, maxY = -Infinity;
    for (const [x, y] of outer) {
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }

    const x0 = Math.ceil(Math.max(minX, area.minX) / GRID_M) * GRID_M;
    const x1 = Math.min(maxX, area.maxX);
    const y0 = Math.ceil(Math.max(minY, area.minY) / GRID_M) * GRID_M;
    const y1 = Math.min(maxY, area.maxY);
    if (![x0, x1, y0, y1].every(Number.isFinite) || x0 > x1 || y0 > y1) return;

    const holes = co.slice(1).map(ring =>
      ring.map(([lng, lat]) => toEastNorth(lng, lat))
    );
    for (let gx = x0; gx <= x1; gx += GRID_M) {
      for (let gy = y0; gy <= y1; gy += GRID_M) {
        const key = 'wood:' + gx + ',' + gy;
        if (candidates.has(key) || !inPolyMeters(gx, gy, outer, holes)) continue;
        candidates.set(key, gridCandidate(gx, gy));
      }
    }
  }

  function growTreesInView() {
    if (!originMerc || lmap.getZoom() < TREE_MIN_ZOOM) return;
    const feats = readFeatures('開放免費地圖', 'landcover',
      ['==', ['get', 'class'], 'wood']);

    const center = lmap.getCenter();
    const [curE, curN] = toEastNorth(center.lng, center.lat);
    const bounds = lmap.getBounds();
    const sw = bounds.getSouthWest();
    const ne = bounds.getNorthEast();
    const [swE, swN] = toEastNorth(sw.lng, sw.lat);
    const [neE, neN] = toEastNorth(ne.lng, ne.lat);
    const width = Math.abs(neE - swE);
    const height = Math.abs(neN - swN);
    const padX = Math.max(GRID_M, width * 0.15);
    const padY = Math.max(GRID_M, height * 0.15);
    const area = {
      minX: Math.min(swE, neE) - padX,
      maxX: Math.max(swE, neE) + padX,
      minY: Math.min(swN, neN) - padY,
      maxY: Math.max(swN, neN) + padY
    };

    const recycleR2 = 4 * (width * width + height * height);
    const distance2 = (x, y) => (x - curE) ** 2 + (y - curN) ** 2;
    const candidates = new Map();
    for (const t of treeData) {
      if (distance2(t.east, t.north) <= recycleR2) {
        candidates.set(t.key, t);
      }
    }

    collectMappedTrees(area, candidates);

    for (const f of feats) {
      const g = f.geometry;
      if (g.type === 'Polygon') {
        collectTreeCells(g.coordinates, area, candidates);
      } else if (g.type === 'MultiPolygon') {
        for (const polygon of g.coordinates) {
          collectTreeCells(polygon, area, candidates);
        }
      }
    }

    const sorted = [...candidates.values()];
    sorted.sort((a, b) =>
      a.priority - b.priority ||
      distance2(a.east, a.north) - distance2(b.east, b.north) ||
      a.key.localeCompare(b.key)
    );

    // 独树优先于树排，树排优先于树林填充。
    const occupied = new Map();
    const selected = [];
    const cellSize = TREE_CLEARANCE_M;
    for (const candidate of sorted) {
      const cx = Math.floor(candidate.east / cellSize);
      const cy = Math.floor(candidate.north / cellSize);
      let crowded = false;
      for (let dx = -1; dx <= 1 && !crowded; dx++) {
        for (let dy = -1; dy <= 1 && !crowded; dy++) {
          const neighbors = occupied.get((cx + dx) + ',' + (cy + dy)) || [];
          crowded = neighbors.some(other =>
            // 真实独树点保留，空间避让用于树排和树林填充。
            candidate.kind !== 'point' &&
            Math.hypot(candidate.east - other.east, candidate.north - other.north) < cellSize
          );
        }
      }
      if (crowded) continue;
      selected.push(candidate);
      const bucketKey = cx + ',' + cy;
      if (!occupied.has(bucketKey)) occupied.set(bucketKey, []);
      occupied.get(bucketKey).push(candidate);
      if (selected.length === TOTAL_MAX) break;
    }

    const previous = new Map(treeData.map(tree => [tree.key, tree]));
    const sameKeys = selected.length === treeData.length &&
      selected.every(candidate => previous.has(candidate.key));
    if (sameKeys) return;

    const added = selected.filter(candidate => !previous.has(candidate.key)).length;
    const recycled = treeData.length - (selected.length - added);
    treeData = selected.map(candidate => previous.get(candidate.key) || createTree(candidate));

    layer?.onTreesChanged?.();
    const counts = { point: 0, row: 0, wood: 0 };
    for (const tree of treeData) counts[tree.kind]++;
    console.log('[tree]', { added, recycled, total: treeData.length, ...counts });
  }

  async function main() {
    if (started) return;
    started = true;

    try {
      variants = await loadGLBModels();
    } catch (e) {
      console.error('[tree] GLB 模型加载失败，停止种树:', e);
      return;
    }

    const c = lmap.getCenter();
    originLng = c.lng;
    originLat = c.lat;
    originMerc = maplibregl.MercatorCoordinate.fromLngLat([c.lng, c.lat], 0);
    renderMerc = originMerc;
    renderEast = 0;
    renderNorth = 0;

    layer = {
      id: 'trees-3d',
      type: 'custom',
      renderingMode: '3d',
      minzoom: TREE_MIN_ZOOM,
      onAdd(map, gl) {
        this.map = map;
        this.camera = new THREE.Camera();
        this.scene = new THREE.Scene();
        this.scene.rotateX(Math.PI / 2);
        this.scene.scale.multiply(new THREE.Vector3(1, 1, -1));

        this.scene.add(new THREE.AmbientLight(0xffffff, 0.7));
        const sun = new THREE.DirectionalLight(0xfff5e0, 1.6);
        sun.position.set(300, 500, 200);
        sun.target.position.set(0, 0, 0);
        this.scene.add(sun);
        this.scene.add(sun.target);

        this.instanced = [];
        this.capacityPerVariant = [0, 0, 0];
        this.dummy = new THREE.Object3D();

        this.renderer = new THREE.WebGLRenderer({ canvas: map.getCanvas(), context: gl, antialias: false });
        this.renderer.autoClear = false;
      },
      onTreesChanged() {
        if (!this.scene) return;
        const counts = new Array(VARIANTS).fill(0);
        for (const t of treeData) counts[t.v]++;

        let needRebuild = false;
        for (let v = 0; v < VARIANTS; v++) {
          if (counts[v] > this.capacityPerVariant[v]) needRebuild = true;
        }

        if (needRebuild) {
          // 销毁旧的InstancedMesh
          if (this.instanced) {
            for (const arr of this.instanced) {
              if (!arr) continue;
              for (const m of arr) { if (m) { this.scene.remove(m); m.dispose(); } }
            }
          }
          this.instanced = [];
          this.capacityPerVariant = counts.slice();

          for (let v = 0; v < VARIANTS; v++) {
            this.instanced[v] = [];
            if (!counts[v] || !variants[v]) continue;
            for (const mesh of variants[v].meshes) {
              const inst = new THREE.InstancedMesh(mesh.geometry, mesh.material, counts[v]);
              inst.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
              this.instanced[v].push(inst);
              this.scene.add(inst);
            }
          }
        }
        this.applyMatrices();
        if (this.map) this.map.triggerRepaint();
      },
      applyMatrices() {
        if (!this.dummy || !this.instanced) return;
        const d = this.dummy;
        const idx = new Array(VARIANTS).fill(0);
        for (const meshes of this.instanced) {
          if (!meshes) continue;
          for (const inst of meshes) inst.count = 0;
        }
        for (let i = 0; i < treeData.length; i++) {
          const t = treeData[i];
          if (t.elev == null) continue;
          const k = idx[t.v]++;
          d.position.set(
            t.east - renderEast,
            t.elev,
            t.north - renderNorth
          );
          d.scale.setScalar(t.sc * 0.4);
          d.rotation.set(0, t.rotY, 0);
          d.updateMatrix();
          if (this.instanced[t.v]) {
            for (const inst of this.instanced[t.v]) {
              inst.setMatrixAt(k, d.matrix);
              inst.count = idx[t.v];
            }
          }
        }
        for (const arr of this.instanced) {
          if (!arr) continue;
          for (const inst of arr) {
            if (!inst) continue;
            inst.instanceMatrix.needsUpdate = true;
            inst.boundingSphere = null;
          }
        }
      },
      render(gl, args) {
        if (!originMerc) return;
        if (lmap.getZoom() < TREE_MIN_ZOOM) return;
        const viewCenter = maplibregl.MercatorCoordinate.fromLngLat(lmap.getCenter(), 0);
        const originChanged = updateRenderOrigin(viewCenter);
        const heightsChanged = treeData.length > 0 && updateTerrainHeights();
        // 原点和实例矩阵在同一帧一起提交，避免重定位时跳动。
        if (originChanged || heightsChanged) this.applyMatrices();
        const mm = Array.isArray(args)
          ? args
          : (args.defaultProjectionData ? args.defaultProjectionData.mainMatrix : args.projectionMatrix);
        const m = new THREE.Matrix4().fromArray(mm);
        const horizontalUnit = originMerc.meterInMercatorCoordinateUnits();
        // 水平单位沿用种树网格，高程单位跟随当前视图。
        const heightUnit = viewCenter.meterInMercatorCoordinateUnits();
        const l = new THREE.Matrix4()
          .makeTranslation(renderMerc.x, renderMerc.y, 0)
          .scale(new THREE.Vector3(horizontalUnit, -horizontalUnit, heightUnit));
        this.camera.projectionMatrix = m.multiply(l);
        this.renderer.state.reset();
        this.renderer.render(this.scene, this.camera);
      }
    };

    try {
      lmap.addLayer(layer);
    } catch (e) {
      console.error(e);
      return;
    }
    function scheduleGrow() {
      if (refreshTimer) return;
      refreshTimer = setTimeout(() => {
        refreshTimer = null;
        growTreesInView();
      }, 100);
    }
    lmap.on('idle', scheduleGrow);
    lmap.on('moveend', scheduleGrow);
    lmap.on('sourcedata', (event) => {
      if (event.sourceDataType !== 'content') return;
      if (event.sourceId === '補自然元素' || event.sourceId === '開放免費地圖') scheduleGrow();
    });
    lmap.once('remove', () => clearTimeout(refreshTimer));

    // 初始长一次
    growTreesInView();
    if (layer && layer.onTreesChanged) layer.onTreesChanged();
  }

  if (lmap.loaded && lmap.loaded()) {
    main();
  } else if (lmap.isStyleLoaded && lmap.isStyleLoaded()) {
    main();
  } else {
    lmap.once('load', main);
  }
}
