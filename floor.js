// Mesa de operações 3D: cada robô é um trader. Sentado = posição aberta; café, sinuca,
// pista ou conversa = zerado esperando sinal. Bateu o teto de drawdown, é ejetado da sala.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';

const API = '/api/floor';
const POLL_MS = 2500;
const WALK_SPEED = 2.4;
const IDLE_ROTATION_MS = 4 * 60 * 1000; // zerados trocam de atividade a cada ~4 min

// ---------- utilidades ----------
const $ = (id) => document.getElementById(id);
const nf = new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const money = (v) => (v > 0.004 ? '+' : v < -0.004 ? '−' : '') + nf.format(Math.abs(v));
const price = (v) => v.toLocaleString('pt-BR', { maximumFractionDigits: v >= 100 ? 2 : v >= 1 ? 4 : 6 });
const pct = (v) => (v >= 0 ? '+' : '−') + nf.format(Math.abs(v * 100)) + '%';
const clock = (ts) => new Date(ts).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function lerpAngle(a, b, t) {
  let d = ((b - a + Math.PI) % (Math.PI * 2)) - Math.PI;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

// ---------- renderização ----------
const container = $('scene');
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
container.appendChild(renderer.domElement);

const labelRenderer = new CSS2DRenderer();
labelRenderer.setSize(innerWidth, innerHeight);
labelRenderer.domElement.className = 'labels';
container.appendChild(labelRenderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0b0f14);
scene.fog = new THREE.Fog(0x0b0f14, 55, 120);
const camera = new THREE.PerspectiveCamera(42, innerWidth / innerHeight, 0.1, 300);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.maxPolarAngle = 1.38;
controls.minDistance = 5;

const world = new THREE.Group();
scene.add(world);

const matCache = new Map();
function mat(color, opts = {}) {
  const key = color + JSON.stringify(opts);
  if (!matCache.has(key)) matCache.set(key, new THREE.MeshStandardMaterial({ color, roughness: 0.75, metalness: 0.05, ...opts }));
  return matCache.get(key);
}
function mesh(geometry, material, x = 0, y = 0, z = 0, parent = world, shadow = true) {
  const m = new THREE.Mesh(geometry, material);
  m.position.set(x, y, z);
  m.castShadow = shadow;
  m.receiveShadow = true;
  parent.add(m);
  return m;
}
const box = (w, h, d, material, x, y, z, parent) => mesh(new THREE.BoxGeometry(w, h, d), material, x, y, z, parent);
const cyl = (rt, rb, h, material, x, y, z, parent, seg = 18) => mesh(new THREE.CylinderGeometry(rt, rb, h, seg), material, x, y, z, parent);

function textPlane(text, width, height, { color = '#e6edf3', bg = null, font = 700 } = {}) {
  const canvas = document.createElement('canvas');
  canvas.width = 512; canvas.height = Math.round(512 * height / width);
  const g = canvas.getContext('2d');
  if (bg) { g.fillStyle = bg; g.fillRect(0, 0, canvas.width, canvas.height); }
  g.fillStyle = color;
  g.font = `${font} ${Math.round(canvas.height * 0.62)}px system-ui, sans-serif`;
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(text, canvas.width / 2, canvas.height / 2 + 2);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return new THREE.Mesh(new THREE.PlaneGeometry(width, height), new THREE.MeshBasicMaterial({ map: tex, transparent: !bg, toneMapped: false }));
}

// ---------- planta da sala ----------
let L = null;           // layout
const desks = [];       // { x, z, seat, standby, screens:[mat], tag }
const zones = { cafe: [], sinuca: [], danca: [], conversa: [], hall: [] };
const danceTiles = [];
let danceLight = null, discoBall = null;

function computeLayout(n) {
  const cols = n <= 8 ? 4 : n <= 18 ? 6 : n <= 36 ? 8 : 9;
  const rows = Math.max(1, Math.ceil(n / cols));
  const DX = 2.6, DZ = 3.4;
  const deskW = cols * DX;
  const x0 = -deskW - 1.2 + DX / 2;
  const z0 = -5.6;
  const walkX = -0.4;
  const deskEndZ = z0 + (rows - 1) * DZ + 2.2;
  const lounge = { x0: 1.0, x1: 15.0, z0: -9.4, z1: Math.max(deskEndZ, 9.8) };
  const room = { x0: x0 - DX / 2 - 1.6, x1: lounge.x1 + 0.8, z0: -10.2, z1: Math.max(deskEndZ, lounge.z1) + 1.2 };
  return { n, cols, rows, DX, DZ, x0, z0, walkX, lounge, room, deskCenterX: x0 + (cols - 1) * DX / 2 };
}

function buildWorld() {
  const { room, lounge } = L;
  const W = room.x1 - room.x0, D = room.z1 - room.z0;
  const cx = (room.x0 + room.x1) / 2, cz = (room.z0 + room.z1) / 2;

  // piso: carpete na área das mesas, madeira no lounge, corredor iluminado
  mesh(new THREE.PlaneGeometry(W + 40, D + 40).rotateX(-Math.PI / 2), mat(0x0d1218, { roughness: 1 }), cx, -0.01, cz, world, false);
  mesh(new THREE.PlaneGeometry(L.walkX - 0.9 - room.x0, D).rotateX(-Math.PI / 2), mat(0x1a212b, { roughness: 0.95 }), (room.x0 + L.walkX - 0.9) / 2, 0, cz, world, false);
  mesh(new THREE.PlaneGeometry(room.x1 - lounge.x0 + 0.4, D).rotateX(-Math.PI / 2), mat(0x3a2a20, { roughness: 0.55 }), (lounge.x0 - 0.4 + room.x1) / 2, 0, cz, world, false);
  for (const dx of [-0.85, 0.85]) {
    mesh(new THREE.PlaneGeometry(0.06, D).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0x2f81f7, toneMapped: false }), L.walkX + dx + 0.45, 0.005, cz, world, false);
  }

  // paredes
  const wallMat = mat(0x151b23, { roughness: 0.9 });
  box(W, 9.6, 0.3, wallMat, cx, 4.8, room.z0 - 0.15);
  box(0.3, 9.6, D, wallMat, room.x0 - 0.15, 4.8, cz);
  const sky = skylineTexture();
  const win = mesh(new THREE.PlaneGeometry(D - 2, 3.2), new THREE.MeshBasicMaterial({ map: sky, toneMapped: false }), room.x0 + 0.02, 3.6, cz, world, false);
  win.rotation.y = Math.PI / 2;
  for (let z = room.z0 + 1; z <= room.z1 - 1; z += 3) box(0.12, 3.4, 0.12, mat(0x0c1016), room.x0 + 0.08, 3.6, z);

  buildTelao();
  for (let i = 0; i < L.n; i++) buildDesk(i);
  buildLounge();

  // luz
  scene.add(new THREE.HemisphereLight(0xcfe0ff, 0x2a2018, 1.7));
  const sun = new THREE.DirectionalLight(0xfff4e6, 2.6);
  sun.position.set(cx - 12, 26, room.z1 + 10);
  sun.target.position.set(cx, 0, cz);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  const s = Math.max(W, D) / 2 + 4;
  Object.assign(sun.shadow.camera, { left: -s, right: s, top: s, bottom: -s, near: 1, far: 90 });
  sun.shadow.bias = -0.0005;
  scene.add(sun, sun.target);
  const telaoGlow = new THREE.PointLight(0x58a6ff, 30, 18, 2);
  telaoGlow.position.set(L.deskCenterX, 4, room.z0 + 3);
  scene.add(telaoGlow);
  // luminárias sobre as fileiras de mesas
  for (let r = 0; r < L.rows; r += 2) {
    for (let c = 0; c < L.cols; c += 3) {
      const lamp = new THREE.PointLight(0xe8f0ff, 22, 11, 2);
      lamp.position.set(L.x0 + (c + 1) * L.DX, 4.2, L.z0 + r * L.DZ + 1.2);
      scene.add(lamp);
    }
  }

  // câmera enquadrando a sala
  // celular em pé enxerga pouco na horizontal: afasta a câmera para caber a sala
  const dist = Math.max(W, D) * 0.98 * (camera.aspect < 1 ? Math.min(1.6, 1 / camera.aspect) : 1);
  controls.target.set(cx, 1.2, cz - 2);
  camera.position.set(cx + dist * 0.1, dist * 0.56, cz + dist * 0.95);
  controls.maxDistance = dist * 2;
  controls.update();
}

function skylineTexture() {
  const c = document.createElement('canvas');
  c.width = 2048; c.height = 320;
  const g = c.getContext('2d');
  const grad = g.createLinearGradient(0, 0, 0, c.height);
  grad.addColorStop(0, '#0a1630'); grad.addColorStop(1, '#1d2b4a');
  g.fillStyle = grad; g.fillRect(0, 0, c.width, c.height);
  let x = 0, seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  while (x < c.width) {
    const w = 40 + rnd() * 90, h = 80 + rnd() * 220;
    g.fillStyle = `hsl(220, 25%, ${8 + rnd() * 6}%)`;
    g.fillRect(x, c.height - h, w, h);
    for (let wy = c.height - h + 8; wy < c.height - 6; wy += 12) {
      for (let wx = x + 5; wx < x + w - 6; wx += 10) {
        if (rnd() < 0.35) { g.fillStyle = rnd() < 0.8 ? '#ffd27a' : '#9fd1ff'; g.fillRect(wx, wy, 4, 5); }
      }
    }
    x += w + 4;
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// ---------- telão: curva da carteira ----------
const tel = { canvas: document.createElement('canvas'), tex: null };
tel.canvas.width = 1800; tel.canvas.height = 760;

function buildTelao() {
  const width = clamp(L.cols * L.DX + 1, 12, 18), height = width * (760 / 1800);
  const x = L.deskCenterX, y = 1.3 + height / 2, z = L.room.z0 + 0.12;
  tel.tex = new THREE.CanvasTexture(tel.canvas);
  tel.tex.colorSpace = THREE.SRGBColorSpace;
  tel.tex.anisotropy = 8;
  box(width + 0.4, height + 0.4, 0.15, mat(0x05070a, { metalness: 0.6, roughness: 0.3 }), x, y, z);
  mesh(new THREE.PlaneGeometry(width, height), new THREE.MeshBasicMaterial({ map: tel.tex, toneMapped: false }), x, y, z + 0.08, world, false);
  const strip = mesh(new THREE.BoxGeometry(width + 0.4, 0.05, 0.05), new THREE.MeshBasicMaterial({ color: 0x2f81f7, toneMapped: false }), x, y - height / 2 - 0.25, z + 0.1, world, false);
  strip.userData.glow = true;
}

function drawTelao(s) {
  const g = tel.canvas.getContext('2d');
  const W = tel.canvas.width, H = tel.canvas.height;
  const p = s.portfolio, cur = s.currency, hist = p.history || [];
  g.fillStyle = '#060a0f'; g.fillRect(0, 0, W, H);

  g.textAlign = 'left';
  g.fillStyle = '#7d8fa3'; g.font = '600 38px system-ui, sans-serif';
  const since = hist.length ? new Date(hist[0][0]).toLocaleDateString('pt-BR') : '—';
  g.fillText(`CARTEIRA  ·  desde ${since}`, 56, 70);
  g.fillStyle = '#e6edf3'; g.font = '750 96px system-ui, sans-serif';
  g.fillText(`${nf.format(p.equity)} ${cur}`, 56, 172);
  const up = p.total_pnl >= 0;
  g.fillStyle = up ? '#3fb950' : '#f85149'; g.font = '650 50px system-ui, sans-serif';
  g.fillText(`${money(p.total_pnl)}  (${pct(p.total_pnl / (p.starting_capital || 1))})`, 56, 240);

  const counts = countStates(s.robots);
  g.textAlign = 'right'; g.fillStyle = '#9fb0c2'; g.font = '600 36px system-ui, sans-serif';
  g.fillText(`${counts.working} na mesa  ·  ${counts.waiting} esperando  ·  ${counts.ejected} ejetados`, W - 56, 70);
  g.fillStyle = p.today_pnl >= 0 ? '#3fb950' : '#f85149'; g.font = '650 40px system-ui, sans-serif';
  g.fillText(`hoje ${money(p.today_pnl)} ${cur}`, W - 56, 128);
  g.fillStyle = '#7d8fa3'; g.font = '500 32px system-ui, sans-serif';
  const winrate = p.trades ? `${Math.round((p.wins / p.trades) * 100)}% de acerto` : 'sem operações fechadas';
  g.fillText(`${p.trades} operações fechadas · ${winrate}`, W - 56, 178);

  // gráfico
  const x0 = 120, x1 = W - 56, y0 = 290, y1 = H - 70;
  const killLevel = p.kill_line ? p.starting_capital - p.kill_line : null;
  const values = hist.map((h) => h[1]);
  let lo = Math.min(p.starting_capital, ...values), hi = Math.max(p.starting_capital, ...values);
  if (killLevel !== null && killLevel > lo - (hi - lo) * 0.6) lo = Math.min(lo, killLevel);
  const pad = (hi - lo) * 0.08 || 10; lo -= pad; hi += pad;
  const t0 = hist.length ? hist[0][0] : Date.now() - 1, t1 = hist.length > 1 ? hist[hist.length - 1][0] : t0 + 1;
  const X = (t) => x0 + ((t - t0) / (t1 - t0 || 1)) * (x1 - x0);
  const Y = (v) => y1 - ((v - lo) / (hi - lo)) * (y1 - y0);

  g.strokeStyle = 'rgba(125,143,163,.14)'; g.lineWidth = 2;
  g.fillStyle = '#5d6d80'; g.font = '500 26px system-ui, sans-serif'; g.textAlign = 'right';
  for (let i = 0; i <= 4; i++) {
    const v = lo + ((hi - lo) * i) / 4, y = Y(v);
    g.beginPath(); g.moveTo(x0, y); g.lineTo(x1, y); g.stroke();
    g.fillText(Math.round(v).toLocaleString('pt-BR'), x0 - 14, y + 9);
  }
  const hline = (v, color, label) => {
    g.save(); g.setLineDash([14, 12]); g.strokeStyle = color; g.lineWidth = 3;
    g.beginPath(); g.moveTo(x0, Y(v)); g.lineTo(x1, Y(v)); g.stroke(); g.restore();
    g.fillStyle = color; g.textAlign = 'left'; g.font = '700 24px system-ui, sans-serif';
    g.fillText(label, x0 + 12, Y(v) - 10);
  };
  hline(p.starting_capital, 'rgba(160,175,190,.55)', 'CAPITAL INICIAL');
  if (killLevel !== null && killLevel >= lo) hline(killLevel, '#f85149', 'KILL-LINE');

  if (hist.length > 1) {
    const color = up ? '63,185,80' : '248,81,73';
    const grad = g.createLinearGradient(0, y0, 0, y1);
    grad.addColorStop(0, `rgba(${color},.35)`); grad.addColorStop(1, `rgba(${color},0)`);
    g.beginPath(); g.moveTo(X(hist[0][0]), y1);
    for (const [t, v] of hist) g.lineTo(X(t), Y(v));
    g.lineTo(X(t1), y1); g.closePath(); g.fillStyle = grad; g.fill();
    g.beginPath();
    hist.forEach(([t, v], i) => (i ? g.lineTo(X(t), Y(v)) : g.moveTo(X(t), Y(v))));
    g.strokeStyle = `rgb(${color})`; g.lineWidth = 5; g.lineJoin = 'round'; g.stroke();
    const [lt, lv] = hist[hist.length - 1];
    g.beginPath(); g.arc(X(lt), Y(lv), 11, 0, Math.PI * 2); g.fillStyle = `rgb(${color})`; g.shadowColor = `rgb(${color})`; g.shadowBlur = 30; g.fill(); g.shadowBlur = 0;
    g.fillStyle = '#5d6d80'; g.font = '500 26px system-ui, sans-serif';
    g.textAlign = 'left'; g.fillText(new Date(t0).toLocaleDateString('pt-BR'), x0, H - 26);
    g.textAlign = 'right'; g.fillText('agora', x1, H - 26);
  } else {
    g.fillStyle = '#5d6d80'; g.textAlign = 'center'; g.font = '500 36px system-ui, sans-serif';
    g.fillText('A curva aparece quando a primeira operação fechar', (x0 + x1) / 2, (y0 + y1) / 2);
  }
  tel.tex.needsUpdate = true;
}

// ---------- mesas ----------
function buildDesk(i) {
  const col = i % L.cols, row = Math.floor(i / L.cols);
  const x = L.x0 + col * L.DX, z = L.z0 + row * L.DZ;
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  world.add(g);

  box(1.7, 0.06, 0.82, mat(0x2a3440, { roughness: 0.4 }), 0, 0.76, 0, g);
  for (const [lx, lz] of [[-0.78, -0.34], [0.78, -0.34], [-0.78, 0.34], [0.78, 0.34]]) box(0.05, 0.74, 0.05, mat(0x11161c, { metalness: 0.5 }), lx, 0.37, lz, g);
  box(0.6, 0.02, 0.2, mat(0x0d1116), 0, 0.8, 0.12, g); // teclado
  const screens = [];
  for (const sx of [-0.36, 0.36]) {
    const frame = box(0.66, 0.4, 0.04, mat(0x080a0d, { metalness: 0.4, roughness: 0.4 }), sx, 1.08, -0.22, g);
    frame.rotation.y = sx < 0 ? 0.12 : -0.12;
    const screenMat = new THREE.MeshStandardMaterial({ color: 0x05080b, emissive: 0x14202c, emissiveIntensity: 1.4, roughness: 0.3 });
    mesh(new THREE.PlaneGeometry(0.6, 0.34), screenMat, 0, 0, 0.022, frame, false);
    screens.push(screenMat);
    box(0.04, 0.22, 0.04, mat(0x11161c), sx, 0.88, -0.24, g);
  }
  // cadeira atrás da mesa, virada para o telão
  const chair = new THREE.Group(); chair.position.set(0, 0, 0.85); g.add(chair);
  box(0.5, 0.08, 0.5, mat(0x1f2730), 0, 0.43, 0, chair);
  box(0.5, 0.62, 0.07, mat(0x1f2730), 0, 0.8, 0.27, chair);
  cyl(0.04, 0.04, 0.38, mat(0x0d1116, { metalness: 0.6 }), 0, 0.2, 0, chair);
  cyl(0.28, 0.28, 0.04, mat(0x0d1116, { metalness: 0.6 }), 0, 0.03, 0, chair);

  const el = document.createElement('div');
  el.className = 'desk-tag'; el.textContent = 'ejetado'; el.hidden = true;
  const tag = new CSS2DObject(el); tag.position.set(0, 1.5, -0.2); g.add(tag);

  desks.push({ x, z, row, seat: { x, z: z + 0.85 }, standby: { x: x + 0.75, z: z + 1.35 }, screens, tag: el, chair });
}

function updateDesk(desk, r) {
  let color = 0x14202c;
  if (r.state === 'operating') color = r.open_pnl >= 0 ? 0x1f9d55 : 0xc93a3a;
  else if (r.state === 'watching') color = 0xb7891f;
  else if (r.state === 'ejected') color = 0x3d0b0b;
  else if (r.state === 'offline' || r.state === 'paused') color = 0x07090c;
  for (const m of desk.screens) m.emissive.setHex(color);
  desk.tag.hidden = r.state !== 'ejected';
}

// ---------- lounge: café, sinuca, pista e conversa ----------
function spot(zone, x, z, face, pose) { zones[zone].push({ x, z, face, pose, taken: null }); }

function buildLounge() {
  const { x0, x1, z0, z1 } = L.lounge;

  // café: balcão encostado na parede do fundo
  const ccx = x0 + 3.6, ccz = z0 + 0.75;
  box(6.2, 1.02, 0.8, mat(0x5b3d2a, { roughness: 0.6 }), ccx, 0.51, ccz);
  box(6.4, 0.06, 0.95, mat(0x24272b, { roughness: 0.25, metalness: 0.2 }), ccx, 1.05, ccz);
  box(0.55, 0.7, 0.45, mat(0x9aa4ad, { metalness: 0.7, roughness: 0.3 }), ccx - 2.1, 1.43, ccz - 0.1);
  mesh(new THREE.SphereGeometry(0.035, 10, 8), new THREE.MeshBasicMaterial({ color: 0xff3b30 }), ccx - 1.95, 1.62, ccz + 0.13, world, false);
  for (let i = 0; i < 4; i++) cyl(0.05, 0.045, 0.11, mat(0xf0f0f0), ccx - 0.6 + i * 0.45, 1.135, ccz + 0.1);
  const cafeSign = textPlane('CAFÉ', 2.2, 0.6, { color: '#ffb46b' });
  cafeSign.position.set(ccx, 3.0, L.room.z0 + 0.02); world.add(cafeSign);
  const warm = new THREE.PointLight(0xffb46b, 25, 9, 2); warm.position.set(ccx, 3, ccz + 1.2); scene.add(warm);
  for (let i = 0; i < 5; i++) spot('cafe', ccx - 2.6 + i * 1.3, ccz + 1.15, Math.PI, 'coffee');
  for (let i = 0; i < 4; i++) spot('cafe', ccx - 1.95 + i * 1.3, ccz + 2.5, Math.PI, 'coffee');

  // sinuca: duas mesas
  for (const tz of [z0 + 3.2, z0 + 7.2]) {
    const tx = x0 + 10.6;
    box(2.7, 0.16, 1.5, mat(0x4a2c1a, { roughness: 0.5 }), tx, 0.82, tz);
    box(2.45, 0.02, 1.25, mat(0x116b3a, { roughness: 0.95 }), tx, 0.91, tz);
    for (const [lx, lz] of [[-1.2, -0.6], [1.2, -0.6], [-1.2, 0.6], [1.2, 0.6]]) box(0.14, 0.78, 0.14, mat(0x3a2214), tx + lx, 0.39, tz + lz);
    const balls = [0xffffff, 0xf2c94c, 0xeb5757, 0x2f80ed, 0x111111, 0x27ae60, 0x9b51e0];
    balls.forEach((c, k) => mesh(new THREE.SphereGeometry(0.045, 12, 10), mat(c, { roughness: 0.2 }), tx - 0.5 + (k % 4) * 0.28, 0.965, tz - 0.2 + Math.floor(k / 4) * 0.35));
    const lamp = box(1.8, 0.08, 0.3, mat(0x0f3d26, { emissive: 0x2c6e49, emissiveIntensity: 0.6 }), tx, 2.6, tz);
    lamp.castShadow = false;
    spot('sinuca', tx - 1.75, tz, Math.PI / 2, 'pool');
    spot('sinuca', tx + 1.75, tz, -Math.PI / 2, 'pool');
    spot('sinuca', tx, tz - 1.15, 0, 'pool');
    spot('sinuca', tx, tz + 1.15, Math.PI, 'pool');
  }
  const poolSign = textPlane('SINUCA', 2.4, 0.6, { color: '#7ee2a8' });
  poolSign.position.set(x0 + 10.6, 3.0, L.room.z0 + 0.02); world.add(poolSign);

  // pista de dança
  const dcx = x0 + 3.6, dcz = z0 + 7.6;
  for (let i = 0; i < 5; i++) {
    for (let j = 0; j < 5; j++) {
      const m = new THREE.MeshStandardMaterial({ color: 0x111111, emissive: 0x000000, emissiveIntensity: 1.2, roughness: 0.3 });
      const tile = mesh(new THREE.BoxGeometry(0.96, 0.04, 0.96), m, dcx - 2 + i, 0.02, dcz - 2 + j, world, false);
      tile.receiveShadow = true;
      danceTiles.push({ m, i, j });
    }
  }
  discoBall = mesh(new THREE.SphereGeometry(0.32, 20, 14), mat(0xdddddd, { metalness: 1, roughness: 0.15, flatShading: true }), dcx, 4.2, dcz, world, false);
  danceLight = new THREE.PointLight(0xff00aa, 40, 9, 2); danceLight.position.set(dcx, 3.4, dcz); scene.add(danceLight);
  for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) spot('danca', dcx - 1.65 + i * 1.1, dcz - 1.65 + j * 1.1, Math.random() * 6.28, 'dance');

  // conversa: mesinhas altas com gente em volta
  const clusters = [[x0 + 9.6, z0 + 11.4], [x0 + 12.8, z0 + 11.4], [x0 + 3.0, z0 + 12.4], [x0 + 6.4, z0 + 12.4]];
  for (const [kx, kz] of clusters) {
    cyl(0.32, 0.32, 0.04, mat(0x2a3440, { roughness: 0.3 }), kx, 1.08, kz);
    cyl(0.04, 0.04, 1.06, mat(0x11161c, { metalness: 0.6 }), kx, 0.53, kz);
    cyl(0.25, 0.25, 0.03, mat(0x11161c, { metalness: 0.6 }), kx, 0.015, kz);
    for (let k = 0; k < 4; k++) {
      const a = (k / 4) * Math.PI * 2 + 0.4;
      const sx = kx + Math.sin(a) * 0.9, sz = kz + Math.cos(a) * 0.9;
      spot('conversa', sx, sz, Math.atan2(kx - sx, kz - sz), 'talk');
    }
  }
  // sofá e plantas
  box(0.9, 0.45, 3.2, mat(0x2d3a4f), x1 - 0.2, 0.225, z0 + 15.4);
  box(0.25, 0.9, 3.2, mat(0x2d3a4f), x1 + 0.2, 0.45, z0 + 15.4);
  for (const [px, pz] of [[x0 + 7.6, z0 + 0.6], [x1 - 0.2, z0 + 0.6], [x1 - 0.2, z0 + 9.4]]) {
    cyl(0.25, 0.2, 0.45, mat(0xc9b79c), px, 0.225, pz);
    mesh(new THREE.IcosahedronGeometry(0.5, 0), mat(0x2e7d4f, { flatShading: true }), px, 0.95, pz);
  }

  // corredor de espera: quem sobrar fica assistindo a pista
  for (let r = 0; r < 3; r++) for (let k = 0; k < 13; k++) spot('hall', x0 + 0.6 + k * 1.05, z1 - 0.6 - r * 0.9, Math.PI, 'stand');
}

function updateDance(t) {
  for (const tile of danceTiles) {
    const h = (tile.i * 0.12 + tile.j * 0.07 + t * 0.15) % 1;
    const on = Math.sin(t * 3 + tile.i * 1.3 + tile.j * 0.7) > 0.1;
    tile.m.emissive.setHSL(h, 0.9, on ? 0.45 : 0.08);
  }
  if (danceLight) danceLight.color.setHSL((t * 0.1) % 1, 1, 0.5);
  if (discoBall) discoBall.rotation.y = t * 0.8;
}

// ---------- trajetos (pelos corredores, sem atravessar mesas) ----------
const areaOf = (p) => (p.x > L.walkX + 0.6 ? 'lounge' : p.x < L.walkX - 0.6 ? 'desk' : 'walk');
function aisleZ(z) {
  const row = clamp(Math.round((z - L.z0 - 0.85) / L.DZ), 0, L.rows - 1);
  return L.z0 + row * L.DZ + 1.75;
}
function route(from, to) {
  const pts = [], fa = areaOf(from), ta = areaOf(to);
  const P = (x, z) => ({ x, z });
  if (fa === 'desk') {
    const az = aisleZ(from.z);
    pts.push(P(from.x, az));
    if (ta === 'desk' && aisleZ(to.z) === az) { pts.push(P(to.x, az), P(to.x, to.z)); return pts; }
    pts.push(P(L.walkX, az));
  } else if (fa === 'lounge' && ta !== 'lounge') {
    pts.push(P(L.walkX + 0.6, from.z));
  }
  if (ta === 'desk') {
    const az = aisleZ(to.z);
    pts.push(P(L.walkX, az), P(to.x, az), P(to.x, to.z));
  } else {
    if (fa !== 'lounge' && ta === 'lounge') pts.push(P(L.walkX + 0.6, to.z));
    pts.push(P(to.x, to.z));
  }
  return pts;
}

// ---------- bonecos ----------
const GEO = {
  thigh: new THREE.BoxGeometry(0.17, 0.44, 0.19).translate(0, -0.22, 0),
  shin: new THREE.BoxGeometry(0.15, 0.44, 0.17).translate(0, -0.22, 0),
  shoe: new THREE.BoxGeometry(0.17, 0.08, 0.28).translate(0, -0.04, 0.05),
  torso: new THREE.BoxGeometry(0.48, 0.62, 0.27),
  arm: new THREE.BoxGeometry(0.12, 0.56, 0.13).translate(0, -0.28, 0),
  hand: new THREE.SphereGeometry(0.065, 10, 8),
  head: new THREE.SphereGeometry(0.17, 18, 14),
  hair: new THREE.SphereGeometry(0.178, 18, 10, 0, Math.PI * 2, 0, Math.PI * 0.55),
  tie: new THREE.BoxGeometry(0.07, 0.36, 0.02),
  cup: new THREE.CylinderGeometry(0.045, 0.038, 0.11, 12),
  cue: new THREE.CylinderGeometry(0.01, 0.02, 1.45, 8),
  ring: new THREE.RingGeometry(0.42, 0.52, 40).rotateX(-Math.PI / 2),
  spark: new THREE.SphereGeometry(0.07, 6, 5),
  coin: new THREE.CylinderGeometry(0.11, 0.11, 0.025, 18).rotateX(Math.PI / 2),
  confetti: new THREE.PlaneGeometry(0.07, 0.12),
};
const SHIRTS = [0x2f81f7, 0xd29922, 0x8957e5, 0x3fb950, 0xdb61a2, 0x1f9bb5, 0xe3702c, 0xa5d6ff];
const SKINS = [0xf1c27d, 0xe0ac69, 0xc68642, 0x8d5524, 0xffdbac, 0xa86b3c];
const HAIRS = [0x1b1b1b, 0x3b2314, 0x6b4423, 0xb8860b, 0x8a8a8a, 0x2a1a10];
const strategyColor = new Map();

const traders = new Map();
const pickables = [];
let selectedId = null;
const selectRing = new THREE.Mesh(GEO.ring, new THREE.MeshBasicMaterial({ color: 0x58a6ff, transparent: true, opacity: 0.9, toneMapped: false }));
selectRing.visible = false;
scene.add(selectRing);

function buildCharacter(robot) {
  const key = robot.strategy || robot.bot || robot.id;
  if (!strategyColor.has(key)) strategyColor.set(key, SHIRTS[strategyColor.size % SHIRTS.length]);
  const h = hash(robot.id);
  const shirt = mat(strategyColor.get(key), { roughness: 0.8 });
  const skin = mat(SKINS[h % SKINS.length], { roughness: 0.7 });
  const pants = mat(0x232b37);
  const shoes = mat(0x0b0d10);

  const root = new THREE.Group();
  const body = new THREE.Group(); root.add(body);
  const parts = { root, body };
  const leg = (side) => {
    const hip = new THREE.Group(); hip.position.set(side * 0.11, 0.95, 0); body.add(hip);
    mesh(GEO.thigh, pants, 0, 0, 0, hip);
    const knee = new THREE.Group(); knee.position.y = -0.44; hip.add(knee);
    mesh(GEO.shin, pants, 0, 0, 0, knee);
    mesh(GEO.shoe, shoes, 0, -0.44, 0, knee);
    return [hip, knee];
  };
  [parts.hipL, parts.kneeL] = leg(1);
  [parts.hipR, parts.kneeR] = leg(-1);
  parts.torso = mesh(GEO.torso, shirt, 0, 1.26, 0, body);
  mesh(GEO.tie, mat(0x161b22), 0, 1.33, 0.14, body, false);
  const arm = (side) => {
    const shoulder = new THREE.Group(); shoulder.position.set(side * 0.31, 1.52, 0); body.add(shoulder);
    mesh(GEO.arm, shirt, 0, 0, 0, shoulder);
    mesh(GEO.hand, skin, 0, -0.6, 0, shoulder);
    return shoulder;
  };
  parts.armL = arm(1);
  parts.armR = arm(-1);
  parts.head = new THREE.Group(); parts.head.position.y = 1.75; body.add(parts.head);
  mesh(GEO.head, skin, 0, 0, 0, parts.head);
  mesh(GEO.hair, mat(HAIRS[(h >> 4) % HAIRS.length]), 0, 0.02, -0.01, parts.head);
  parts.cup = mesh(GEO.cup, mat(0xf4f4f4), 0, -0.62, 0.06, parts.armR, false);
  parts.cue = mesh(GEO.cue, mat(0xc8a165), 0, -1.1, 0, parts.armR, false);
  root.traverse((o) => { if (o.isMesh) pickables.push(o); });
  return parts;
}

class Trader {
  constructor(robot, desk, spawn) {
    this.id = robot.id;
    this.robot = robot;
    this.desk = desk;
    this.parts = buildCharacter(robot);
    this.parts.root.traverse((o) => { o.userData.traderId = robot.id; });
    scene.add(this.parts.root);
    this.phase = (hash(robot.id) % 1000) / 100;
    this.mode = null;
    this.pose = 'stand';
    this.goalPose = 'stand';
    this.face = 0;
    this.goalFace = 0;
    this.path = [];
    this.spot = null;
    this.slot = null;
    if (spawn) this.parts.root.position.set(spawn.x, 0, spawn.z);

    const el = document.createElement('div');
    el.innerHTML = '<span class="pnl"></span><span class="nm"></span>';
    el.addEventListener('click', (e) => { e.stopPropagation(); select(this.id); });
    this.label = { el, obj: new CSS2DObject(el), pnl: el.firstChild, nm: el.lastChild };
    this.parts.root.add(this.label.obj);
  }

  go(target, pose, face, instant) {
    if (instant) {
      this.parts.root.position.set(target.x, 0, target.z);
      this.path = [];
      this.pose = this.goalPose = pose;
      this.face = this.goalFace = face;
      return;
    }
    this.path = route(this.parts.root.position, target);
    this.goalPose = pose;
    this.goalFace = face;
    this.pose = 'walk';
  }

  setState(r, instant) {
    const prev = this.mode;
    this.robot = r;
    if (r.state === 'operating' || r.state === 'watching') {
      // vigia trabalha sentado, olhando o gráfico, como quem está operando
      if (prev !== 'operating' && prev !== 'watching') { releaseSpot(this); this.go(this.desk.seat, 'sit', Math.PI, instant); }
    } else if (r.state === 'offline' || r.state === 'paused') {
      if (prev !== r.state) { releaseSpot(this); this.go(this.desk.standby, r.state === 'paused' ? 'stand' : 'offline', Math.PI, instant); }
    } else {
      const slot = idleSlot(this.id);
      if (prev !== 'idle' || slot !== this.slot) {
        this.slot = slot;
        const s = claimSpot(this, slot);
        this.go(s, s.pose, s.face, instant);
      }
    }
    this.mode = r.state;
    this.updateLabel(r);
  }

  updateLabel(r) {
    const { el, pnl, nm } = this.label;
    nm.textContent = r.name;
    let cls;
    if (this.mode === 'ejecting') { pnl.textContent = 'EJETADO'; cls = 'out'; }
    else if (r.state === 'operating') { pnl.textContent = money(r.open_pnl); cls = (r.open_pnl >= 0 ? 'pos' : 'neg') + ' live'; }
    else if (r.state === 'watching') { pnl.textContent = r.price ? `vigiando ${price(r.price)}` : 'vigiando'; cls = 'watch'; }
    else if (r.state === 'paused') { pnl.textContent = 'pausado'; cls = 'off'; }
    else if (r.state === 'offline') { pnl.textContent = 'offline'; cls = 'off'; }
    else if (!r.trades) { pnl.textContent = r.role === 'manual' ? 'aguardando ordem' : ''; cls = r.role === 'manual' ? 'off' : 'none'; }
    else { pnl.textContent = money(r.realized_pnl); cls = (r.realized_pnl >= 0 ? 'pos' : 'neg') + ' dim'; }
    el.className = `tag ${cls}${selectedId === this.id ? ' sel' : ''}`;
  }

  startEject() {
    this.mode = 'ejecting';
    this.ejT = 0;
    this.vy = 0;
    this.path = [];
    releaseSpot(this);
    this.parts.torso.material = this.parts.torso.material.clone();
    this.parts.torso.material.emissive = new THREE.Color(0xff2a1a);
    this.updateLabel(this.robot);
    shockwave(this.parts.root.position);
    siren(this.parts.root.position);
  }

  celebrate(amount) {
    this.cheerT = 4.5;
    const root = this.parts.root;
    coinBurst(root.position);
    goldGlow(root.position);
    // a sala posiciona o elemento externo; a animação de subir fica no interno (senão uma apaga a outra)
    const el = document.createElement('div');
    const text = document.createElement('span');
    text.className = 'gain-pop';
    text.textContent = `${money(amount)} ${snap?.currency ?? ''}`;
    el.appendChild(text);
    const pop = new CSS2DObject(el);
    pop.position.y = 2.9;
    root.add(pop);
    setTimeout(() => { pop.removeFromParent(); el.remove(); }, 3200);
  }

  updateCheer(dt, t) {
    // pula de braços para cima e gira devagar; depois segue para onde estava indo
    const P = this.parts, root = P.root;
    this.cheerT -= dt;
    root.position.y = this.cheerT > 0 ? Math.abs(Math.sin(t * 8)) * 0.45 : 0;
    root.rotation.y += dt * 3.2;
    P.cup.visible = P.cue.visible = false;
    P.body.position.y = 0; P.body.rotation.x = 0;
    P.hipL.rotation.x = P.hipR.rotation.x = 0;
    P.kneeL.rotation.x = P.kneeR.rotation.x = Math.max(0, -Math.cos(t * 16)) * 0.5;
    P.armL.rotation.set(0, 0, 2.7 + Math.sin(t * 16) * 0.3);
    P.armR.rotation.set(0, 0, -2.7 - Math.sin(t * 16) * 0.3);
    P.head.rotation.x = -0.25;
    this.label.obj.position.y = 2.3;
    if (Math.random() < dt * 14) confetti(root.position);
    if (this.cheerT <= 0) this.face = root.rotation.y;
  }

  update(dt, t) {
    const root = this.parts.root;
    if (this.mode === 'ejecting') return this.updateEject(dt, t);
    if (this.cheerT > 0) return this.updateCheer(dt, t);

    if (this.path.length) {
      const target = this.path[0];
      const dx = target.x - root.position.x, dz = target.z - root.position.z;
      const d = Math.hypot(dx, dz), step = WALK_SPEED * dt;
      if (d <= step) {
        root.position.x = target.x; root.position.z = target.z;
        this.path.shift();
        if (!this.path.length) { this.pose = this.goalPose; this.face = this.goalFace; }
      } else {
        root.position.x += (dx / d) * step; root.position.z += (dz / d) * step;
        this.face = Math.atan2(dx, dz);
      }
    }
    if (this.pose === 'dance') this.face += dt * 1.1;
    root.rotation.y = lerpAngle(root.rotation.y, this.face, Math.min(1, dt * 10));
    this.applyPose(t + this.phase);
    this.label.obj.position.y = this.pose === 'sit' ? 1.9 : 2.3;
  }

  applyPose(t) {
    const P = this.parts;
    let bodyY = 0, lean = 0, hipL = 0, hipR = 0, kneeL = 0, kneeR = 0, armLx = 0, armRx = 0, armLz = 0, armRz = 0, headX = 0;
    P.cup.visible = false; P.cue.visible = false;
    switch (this.pose) {
      case 'walk': {
        const s = Math.sin(t * 9);
        hipL = s * 0.55; hipR = -s * 0.55; kneeL = Math.max(0, -s) * 0.7; kneeR = Math.max(0, s) * 0.7;
        armLx = -s * 0.5; armRx = s * 0.5; bodyY = Math.abs(Math.cos(t * 9)) * 0.035;
        break;
      }
      case 'sit':
        bodyY = -0.43; hipL = hipR = -Math.PI / 2; kneeL = kneeR = Math.PI / 2;
        armLx = -1.15 + Math.sin(t * 13) * 0.06; armRx = -1.15 + Math.sin(t * 13 + 1.7) * 0.06; headX = 0.1;
        break;
      case 'coffee': {
        P.cup.visible = true;
        const sip = (t % 5) < 1.2;
        armRx = sip ? -2.2 : -0.85; headX = sip ? -0.15 : 0; armLx = 0.05;
        break;
      }
      case 'pool':
        P.cue.visible = true; lean = 0.22;
        armRx = -1.35 + (Math.sin(t * 1.6) > 0.6 ? Math.sin(t * 14) * 0.18 : 0); armLx = -1.1; hipL = 0.15; hipR = -0.1;
        break;
      case 'dance': {
        const s = Math.sin(t * 5.5);
        bodyY = Math.abs(s) * 0.12; armLz = 2.3 + s * 0.45; armRz = -2.3 + s * 0.45; hipL = s * 0.3; hipR = -s * 0.3; kneeL = kneeR = 0.25; headX = s * 0.12;
        break;
      }
      case 'talk':
        armRx = -0.55 + Math.sin(t * 2.6) * 0.35; armLx = -0.15; headX = Math.sin(t * 1.7) * 0.08;
        break;
      case 'offline':
        headX = 0.5; armLx = armRx = 0.04;
        break;
      default:
        armLx = Math.sin(t * 1.3) * 0.04; armRx = -armLx;
    }
    P.body.position.y = bodyY; P.body.rotation.x = lean;
    P.hipL.rotation.x = hipL; P.hipR.rotation.x = hipR; P.kneeL.rotation.x = kneeL; P.kneeR.rotation.x = kneeR;
    P.armL.rotation.set(armLx, 0, armLz); P.armR.rotation.set(armRx, 0, armRz);
    P.head.rotation.x = headX;
  }

  updateEject(dt) {
    const P = this.parts, root = P.root;
    this.ejT += dt;
    P.torso.material.emissiveIntensity = 0.7 + Math.sin(this.ejT * 30) * 0.5;
    P.armL.rotation.set(0, 0, 2.6); P.armR.rotation.set(0, 0, -2.6);
    P.cup.visible = P.cue.visible = false;
    if (this.ejT < 0.9) {
      P.body.position.y = -0.18 * (this.ejT / 0.9);
      P.hipL.rotation.x = P.hipR.rotation.x = -0.6 * (this.ejT / 0.9);
      P.kneeL.rotation.x = P.kneeR.rotation.x = 1.1 * (this.ejT / 0.9);
      root.position.x += Math.sin(this.ejT * 70) * 0.012;
    } else {
      P.body.position.y = 0; P.hipL.rotation.x = P.hipR.rotation.x = 0; P.kneeL.rotation.x = P.kneeR.rotation.x = 0;
      this.vy += 20 * dt;
      root.position.y += this.vy * dt;
      root.rotation.y += dt * 13;
      spark(root.position);
    }
    if (root.position.y > 18) this.dispose();
  }

  dispose() {
    scene.remove(this.parts.root);
    this.parts.root.traverse((o) => {
      const i = pickables.indexOf(o);
      if (i >= 0) pickables.splice(i, 1);
    });
    this.label.obj.removeFromParent();
    this.label.el.remove();
    traders.delete(this.id);
  }
}

function idleSlot(id) { return Math.floor((Date.now() + (hash(id) % IDLE_ROTATION_MS)) / IDLE_ROTATION_MS); }

const ZONE_ORDER = ['cafe', 'sinuca', 'danca', 'conversa'];
function claimSpot(tr, slot) {
  releaseSpot(tr);
  const start = hash(`${tr.id}:${slot}`) % ZONE_ORDER.length;
  for (let k = 0; k < ZONE_ORDER.length; k++) {
    const s = zones[ZONE_ORDER[(start + k) % ZONE_ORDER.length]].find((x) => !x.taken);
    if (s) { s.taken = tr.id; tr.spot = s; return s; }
  }
  const s = zones.hall.find((x) => !x.taken) || zones.hall[hash(tr.id) % zones.hall.length];
  s.taken = tr.id; tr.spot = s;
  return s;
}
function releaseSpot(tr) {
  if (tr.spot && tr.spot.taken === tr.id) tr.spot.taken = null;
  tr.spot = null;
}

// ---------- efeitos de ejeção ----------
const effects = [];
const sparkMat = new THREE.MeshBasicMaterial({ color: 0xff7a3d, toneMapped: false });
function spark(pos) {
  const m = new THREE.Mesh(GEO.spark, sparkMat);
  m.position.set(pos.x + (Math.random() - 0.5) * 0.3, pos.y + 0.2, pos.z + (Math.random() - 0.5) * 0.3);
  scene.add(m);
  effects.push({ obj: m, life: 0.7, max: 0.7, kind: 'spark' });
}
function shockwave(pos) {
  const m = new THREE.Mesh(GEO.ring, new THREE.MeshBasicMaterial({ color: 0xff3b30, transparent: true, toneMapped: false }));
  m.position.set(pos.x, 0.03, pos.z);
  scene.add(m);
  effects.push({ obj: m, life: 1.4, max: 1.4, kind: 'ring' });
}
function siren(pos) {
  const light = new THREE.PointLight(0xff2020, 0, 14, 2);
  light.position.set(pos.x, 3, pos.z);
  scene.add(light);
  effects.push({ obj: light, life: 4, max: 4, kind: 'siren' });
}
// ---------- efeitos de ganho ----------
const coinMat = new THREE.MeshStandardMaterial({ color: 0xffc83d, metalness: 0.85, roughness: 0.25, emissive: 0x6b4800, emissiveIntensity: 0.6 });
const confettiMats = [0xffd54a, 0x3fb950, 0xffffff, 0x58a6ff, 0xff7ab8].map(
  (c) => new THREE.MeshBasicMaterial({ color: c, side: THREE.DoubleSide, toneMapped: false }));
function coinBurst(pos) {
  for (let i = 0; i < 40; i++) {
    const m = new THREE.Mesh(GEO.coin, coinMat);
    m.position.set(pos.x, 1.7, pos.z);
    m.rotation.set(Math.random() * 6, Math.random() * 6, 0);
    scene.add(m);
    const a = Math.random() * Math.PI * 2, r = 1 + Math.random() * 2.2;
    effects.push({ obj: m, life: 2.6, max: 2.6, kind: 'coin',
      v: new THREE.Vector3(Math.cos(a) * r, 4.5 + Math.random() * 3.5, Math.sin(a) * r), spin: 6 + Math.random() * 10 });
  }
}
function confetti(pos) {
  const m = new THREE.Mesh(GEO.confetti, confettiMats[Math.floor(Math.random() * confettiMats.length)]);
  m.position.set(pos.x + (Math.random() - 0.5) * 1.6, 3.2 + Math.random(), pos.z + (Math.random() - 0.5) * 1.6);
  scene.add(m);
  effects.push({ obj: m, life: 3, max: 3, kind: 'confetti', phase: Math.random() * 6 });
}
function goldGlow(pos) {
  const light = new THREE.PointLight(0xffc83d, 0, 12, 2);
  light.position.set(pos.x, 2.6, pos.z);
  scene.add(light);
  effects.push({ obj: light, life: 3, max: 3, kind: 'glow' });
}
let audio = null;
function chaChing() {
  // som de caixa registradora sintetizado: toques de sino, sem arquivo de áudio
  try {
    audio ??= new (window.AudioContext || window.webkitAudioContext)();
    if (audio.state === 'suspended') audio.resume();
    const t0 = audio.currentTime;
    [[1318.5, 0], [1760, 0.09], [2637, 0.09]].forEach(([freq, delay]) => {
      const osc = audio.createOscillator(), gain = audio.createGain();
      osc.type = 'triangle';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, t0 + delay);
      gain.gain.exponentialRampToValueAtTime(0.22, t0 + delay + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + delay + 0.7);
      osc.connect(gain).connect(audio.destination);
      osc.start(t0 + delay);
      osc.stop(t0 + delay + 0.75);
    });
  } catch {}
}

function updateEffects(dt, t) {
  for (let i = effects.length - 1; i >= 0; i--) {
    const e = effects[i];
    e.life -= dt;
    const k = Math.max(0, e.life / e.max);
    if (e.kind === 'spark') e.obj.scale.setScalar(k);
    if (e.kind === 'ring') { e.obj.scale.setScalar(1 + (1 - k) * 7); e.obj.material.opacity = k; }
    if (e.kind === 'siren') e.obj.intensity = (Math.sin(t * 18) > 0 ? 60 : 5) * k;
    if (e.kind === 'glow') e.obj.intensity = 70 * k * (0.75 + Math.sin(t * 10) * 0.25);
    if (e.kind === 'coin') {
      e.v.y -= 11 * dt;
      e.obj.position.addScaledVector(e.v, dt);
      if (e.obj.position.y < 0.02) { e.obj.position.y = 0.02; e.v.y *= -0.35; e.v.x *= 0.6; e.v.z *= 0.6; }
      e.obj.rotation.x += e.spin * dt;
      e.obj.scale.setScalar(Math.min(1, k * 3));
    }
    if (e.kind === 'confetti') {
      e.obj.position.y -= 1.1 * dt;
      e.obj.position.x += Math.sin(t * 3 + e.phase) * 0.6 * dt;
      e.obj.rotation.set(t * 4 + e.phase, t * 3, 0);
    }
    if (e.life <= 0) {
      scene.remove(e.obj);
      if (e.kind === 'ring') e.obj.material.dispose();
      effects.splice(i, 1);
    }
  }
}

// ---------- dados ----------
let snap = null;
let lastTs = null;
const deskOf = new Map();
const robotsById = new Map();

function countStates(robots) {
  const c = { operating: 0, idle: 0, ejected: 0, offline: 0, watching: 0, paused: 0 };
  for (const r of robots) c[r.state] = (c[r.state] || 0) + 1;
  c.working = c.operating + c.watching; // na mesa: operando ou vigiando
  c.waiting = c.idle + c.paused;        // fora da mesa: zerados ou pausados
  return c;
}

// demonstração online: tudo vive na memória do navegador, então recarregar a página apagaria a sala.
// Por isso ela nasce com mesas de reserva para os funcionários contratados.
const SPARE_DESKS = 4;
function init(s) {
  s.robots.forEach((r, i) => deskOf.set(r.id, i));
  L = computeLayout(s.robots.length + SPARE_DESKS);
  buildWorld();
}

function applySnapshot(s) {
  const first = !L;
  if (first) init(s);
  else seatChanges(s);
  snap = s;

  for (const r of s.robots) {
    if (!deskOf.has(r.id)) continue;
    robotsById.set(r.id, r);
    const desk = desks[deskOf.get(r.id)];
    updateDesk(desk, r);
    let tr = traders.get(r.id);
    if (r.state === 'ejected') {
      if (tr && tr.mode !== 'ejecting') {
        tr.robot = r;
        tr.startEject();
        showBanner(`ROBÔ EJETADO: ${r.name}  ·  ${r.ejected?.reason ?? ''}`);
      }
      continue;
    }
    if (!tr) {
      const spawn = first ? null : { x: L.walkX, z: L.room.z1 - 0.5 };
      tr = new Trader(r, desk, spawn);
      traders.set(r.id, tr);
      tr.setState(r, first);
    } else if (tr.mode !== 'ejecting') {
      tr.setState(r, false);
    }
  }

  if (s.portfolio.killed && !document.body.classList.contains('killed')) {
    document.body.classList.add('killed');
    showBanner('KILL-LINE ATINGIDA: carteira desligada', true);
  } else if (!s.portfolio.killed) {
    document.body.classList.remove('killed');
  }

  // avisos dos vigias que chegaram desde a última leitura
  const newest = Math.max(0, ...s.events.map((e) => e.ts));
  if (!first) {
    const fresh = s.events.filter((e) => e.type === 'alert' && e.ts > lastEventTs);
    if (fresh.length) showBanner(fresh[0].text, false, 'alert');
    const gains = s.events.filter((e) => e.type === 'close' && e.pnl > 0 && e.ts > lastEventTs).slice(0, 4);
    for (const e of gains) traders.get(e.robot)?.celebrate(e.pnl);
    if (gains.length) {
      const g = gains[0], name = robotsById.get(g.robot)?.name ?? g.robot;
      showBanner(`${g.simulated ? 'SIMULAÇÃO · ' : ''}${name} lucrou ${money(g.pnl)} ${s.currency}`, false, 'gain');
      chaChing();
    }
  }
  lastEventTs = Math.max(lastEventTs, newest);

  updateHud(s);
  drawTelao(s);
  renderEvents(s);
  renderEjected(s);
  // não redesenha o painel enquanto a pessoa digita o valor da compra
  const typing = document.activeElement?.tagName === 'INPUT' && $('detail').contains(document.activeElement);
  if (selectedId && !typing) renderDetail(robotsById.get(selectedId));
  if (first) {
    let flash = null;
    try { flash = sessionStorage.getItem('mesa-flash'); sessionStorage.removeItem('mesa-flash'); } catch {}
    if (flash) showBanner(flash, false, 'ok');
  }
}
let lastEventTs = 0;

function seatChanges(s) {
  // quem saiu libera a mesa; quem entrou senta na primeira mesa livre
  const ids = new Set(s.robots.map((r) => r.id));
  for (const [id, i] of [...deskOf]) {
    if (ids.has(id)) continue;
    traders.get(id)?.dispose();
    deskOf.delete(id);
    robotsById.delete(id);
    updateDesk(desks[i], { state: 'idle' });
  }
  for (const r of s.robots) {
    if (deskOf.has(r.id)) continue;
    const taken = new Set(deskOf.values());
    const free = desks.findIndex((_, i) => !taken.has(i));
    if (free < 0) { showBanner('A sala lotou: demita alguém para contratar outro.', false, 'alert'); continue; }
    deskOf.set(r.id, free);
  }
}

async function fetchSnapshot(force = false) {
  const res = await fetch(API, { cache: 'no-store' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  setConn(true);
  if (data.loading) { $('loading-text').textContent = 'Primeira leitura dos robôs…'; return; }
  if (force || data.ts !== lastTs) {
    lastTs = data.ts;
    applySnapshot(data);
    $('loading').classList.add('done');
  }
}

async function poll() {
  try {
    await fetchSnapshot();
  } catch (err) {
    setConn(false, err.message);
  } finally {
    setTimeout(poll, POLL_MS);
  }
}

// ---------- ordens e contratação (só funcionam neste computador) ----------
async function sendOrder(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Mesa': '1' },
    body: JSON.stringify(body || {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `A mesa recusou a ordem (erro ${res.status}).`);
  return data.message;
}
function flashAfterReload(text) {
  try { sessionStorage.setItem('mesa-flash', text); } catch {}
}

// ---------- painel ----------
function setConn(ok, msg) {
  const el = $('conn');
  el.className = 'conn ' + (ok ? 'ok' : 'bad');
  el.title = ok ? 'conectado ao servidor da mesa' : `sem conexão com o servidor: ${msg}`;
  if (!ok) $('k-next').textContent = 'servidor da mesa fora do ar';
}

const MODE_LABEL = { demo: 'demo', dry_run: 'simulação', live: 'conta real', offline: 'bots offline' };
function updateHud(s) {
  const p = s.portfolio, cur = s.currency;
  const mode = $('mode');
  mode.textContent = MODE_LABEL[s.mode] || s.mode;
  mode.className = `badge ${s.mode}`;
  $('enforce').hidden = s.enforce || s.mode === 'demo';

  $('k-equity').textContent = `${nf.format(p.equity)} ${cur}`;
  const total = $('k-total');
  total.textContent = `${money(p.total_pnl)} (${pct(p.total_pnl / (p.starting_capital || 1))}) desde o início`;
  total.className = p.total_pnl >= 0 ? 'pos' : 'neg';

  const open = $('k-open');
  open.textContent = money(p.open_pnl);
  open.className = p.open_pnl >= 0 ? 'pos' : 'neg';
  const openCount = s.robots.reduce((n, r) => n + (r.state === 'operating' ? r.open_trades.length : 0), 0);
  $('k-open-n').textContent = `${openCount} posição(ões) aberta(s)`;

  const today = $('k-today');
  today.textContent = money(p.today_pnl);
  today.className = p.today_pnl >= 0 ? 'pos' : 'neg';
  $('k-winrate').textContent = p.trades ? `${Math.round((p.wins / p.trades) * 100)}% de acerto em ${p.trades}` : 'nenhuma operação fechada';

  const c = countStates(s.robots);
  $('k-robots').textContent = `${c.working} · ${c.waiting} · ${c.ejected}`;
  $('hire-open').hidden = !s.hire;
  measureHud();

  if (p.kill_line) {
    const used = clamp(p.kill_line_used || 0, 0, 1);
    $('k-kill-bar').style.width = `${used * 100}%`;
    $('k-kill').textContent = `${Math.round(used * 100)}% usado de ${nf.format(p.kill_line)} ${cur}`;
  } else {
    $('k-kill-bar').style.width = '0';
    $('k-kill').textContent = 'não configurada';
  }
  const offline = s.bots.filter((b) => !b.online);
  $('k-updated').textContent = `leitura ${clock(s.ts)}` + (offline.length ? ` · offline: ${offline.map((b) => `${b.name} (${b.error || 'sem resposta'})`).join(', ')}` : '');
}

// os painéis laterais começam logo abaixo do topo, que muda de altura conforme a largura da tela
function measureHud() {
  const hud = $('hud');
  document.documentElement.style.setProperty('--hud-h', `${hud.offsetTop + hud.offsetHeight}px`);
}
addEventListener('resize', measureHud);

function tickCountdown() {
  if (!snap || $('conn').classList.contains('bad')) return;
  const left = Math.max(0, Math.ceil((snap.next_tick_at - Date.now()) / 1000));
  $('k-next').textContent = left > 0 ? `próxima leitura em ${left}s` : 'lendo os robôs…';
}
setInterval(tickCountdown, 250);

function renderEvents(s) {
  const list = $('event-list');
  list.innerHTML = s.events.slice(0, 9).map((e) => `<li class="${esc(e.type)}"><time>${clock(e.ts)}</time><span>${esc(e.text)}</span></li>`).join('')
    || '<li><span>Aguardando o primeiro movimento…</span></li>';
}

function renderEjected(s) {
  const out = s.robots.filter((r) => r.state === 'ejected').sort((a, b) => b.ejected.at - a.ejected.at);
  $('ejected-count').textContent = out.length;
  $('ejected-list').innerHTML = out.length
    ? out.map((r) => `<li data-id="${esc(r.id)}"><b>${esc(r.name)}</b><small>${esc(r.ejected.reason)} · ${new Date(r.ejected.at).toLocaleString('pt-BR')}</small></li>`).join('')
    : '<li class="empty">Nenhum até agora.</li>';
}
$('ejected-list').addEventListener('click', (e) => {
  const li = e.target.closest('li[data-id]');
  if (li) select(li.dataset.id);
});

const STATE_LABEL = { operating: 'operando', idle: 'zerado', ejected: 'ejetado', offline: 'offline', watching: 'vigiando', paused: 'pausado' };
let pending = null;             // { id, action, until }: segundo clique confirma compra, venda ou demissão
let orderMsg = null;            // { id, text, err }
const stakeDraft = new Map();   // valor digitado para a próxima compra, por funcionário

function ordersHtml(r) {
  if (!snap.hire || !r.pair) return '';
  const cur = snap.currency;
  const isPending = (action) => pending && pending.id === r.id && pending.action === action && Date.now() < pending.until;
  const open = r.open_trades.length > 0;
  const blocked = r.state === 'ejected' || snap.portfolio.killed;
  const cantBuy = blocked || open || r.role === 'watch' || r.state === 'offline';
  const stake = stakeDraft.get(r.id) ?? r.stake ?? snap.hire.default_stake;
  const roles = Object.entries(snap.hire.roles)
    .map(([key, label]) => `<button type="button" class="btn ghost${r.role === key ? ' on' : ''}" data-act="role" data-role="${key}">${esc(label)}</button>`).join('');
  const why = r.state === 'ejected' ? 'Ejetado: não pode comprar.' : snap.portfolio.killed ? 'Kill-line atingida: compras bloqueadas.'
    : r.role === 'watch' ? 'Vigia não compra. Mude a função para operar.' : open ? 'Já está posicionado: venda antes de comprar de novo.' : '';
  const msg = orderMsg && orderMsg.id === r.id ? orderMsg : null;
  return `
    <div class="orders">
      <h3>Dar uma ordem</h3>
      <div class="sub">Preço agora: <b class="price-now">${r.price ? price(r.price) : '—'}</b> ${esc(r.pair)}</div>
      <div class="row">
        <label class="stake">Valor <input type="number" data-stake min="1" max="${snap.hire.max_stake}" step="1" value="${esc(stake)}"> ${esc(cur)}</label>
      </div>
      <div class="row">
        <button type="button" class="btn buy${isPending('buy') ? ' confirm' : ''}" data-act="buy" ${cantBuy ? 'disabled' : ''}>${isPending('buy') ? `Confirmar compra de ${esc(stake)} ${esc(cur)}` : 'Comprar agora'}</button>
        <button type="button" class="btn sell${isPending('sell') ? ' confirm' : ''}" data-act="sell" ${open ? '' : 'disabled'}>${isPending('sell') ? 'Confirmar venda' : 'Vender tudo agora'}</button>
      </div>
      ${why ? `<div class="sub">${esc(why)}</div>` : ''}
      <h3>Função</h3>
      <div class="roles">${roles}</div>
      ${r.role === 'watch' ? `<div class="sub">Avisa ${r.alert_above ? `acima de ${price(r.alert_above)}` : ''}${r.alert_above && r.alert_below ? ' ou ' : ''}${r.alert_below ? `abaixo de ${price(r.alert_below)}` : ''}.</div>` : ''}
      <div class="row">
        <button type="button" class="btn ghost" data-act="${r.paused ? 'resume' : 'pause'}">${r.paused ? 'Voltar a trabalhar' : 'Pausar'}</button>
        ${r.employee ? `<button type="button" class="btn danger${isPending('fire') ? ' confirm' : ''}" data-act="fire">${isPending('fire') ? 'Confirmar demissão' : 'Demitir'}</button>` : ''}
      </div>
      ${snap.orders?.live_blocked ? '<div class="sub">Conta real detectada: compra e venda bloqueadas nesta fase do projeto.</div>' : ''}
      <p class="order-msg${msg?.err ? ' err' : ''}" role="status">${msg ? esc(msg.text) : ''}</p>
    </div>`;
}

$('detail-body').addEventListener('input', (e) => {
  if (e.target.matches('[data-stake]') && selectedId) stakeDraft.set(selectedId, e.target.value);
});
$('detail-body').addEventListener('click', async (e) => {
  const button = e.target.closest('button[data-act]');
  if (!button || !selectedId) return;
  const id = selectedId, action = button.dataset.act;
  const needsConfirm = ['buy', 'sell', 'fire'].includes(action);
  if (needsConfirm && !(pending && pending.id === id && pending.action === action && Date.now() < pending.until)) {
    pending = { id, action, until: Date.now() + 6000 };
    renderDetail(robotsById.get(id));
    setTimeout(() => { if (pending && Date.now() >= pending.until) { pending = null; renderDetail(robotsById.get(selectedId)); } }, 6100);
    return;
  }
  pending = null;
  const params = action === 'role' ? { role: button.dataset.role }
    : action === 'buy' ? { stake: Number(stakeDraft.get(id) ?? robotsById.get(id)?.stake ?? snap.hire.default_stake) } : {};
  button.disabled = true;
  try {
    const message = await sendOrder(`/api/employees/${encodeURIComponent(id)}/${action}`, params);
    orderMsg = { id, text: message, err: false };
    if (action === 'fire') { showBanner(message, false, 'ok'); select(null); }
    else showBanner(message, false, 'ok');
  } catch (err) {
    orderMsg = { id, text: err.message, err: true };
  }
  try { await fetchSnapshot(true); } catch {}
  if (selectedId === id) renderDetail(robotsById.get(id));
});
function renderDetail(r) {
  const panel = $('detail');
  if (!r) { panel.hidden = true; return; }
  const cur = snap.currency;
  const cls = (v) => (v >= 0 ? 'pos' : 'neg');
  const ddUsed = r.drawdown_used == null ? null : clamp(r.drawdown_used, 0, 1);
  const trades = r.open_trades.map((t) => `<tr><td>${esc(t.pair)} ${t.side === 'short' ? '(short)' : ''}</td><td>${t.open_rate != null ? nf.format(t.open_rate) : '—'}</td><td>${t.current_rate != null ? nf.format(t.current_rate) : '—'}</td><td class="${cls(t.pnl)}">${money(t.pnl)} (${pct(t.ratio)})</td></tr>`).join('');
  $('detail-body').innerHTML = `
    <h2>${esc(r.name)}<span class="chip ${r.state}">${STATE_LABEL[r.state] || r.state}</span></h2>
    <div class="sub">${esc(r.employee ? (snap.hire?.roles[r.role] || 'funcionário') : (r.strategy || '—'))} · ${esc(r.pair || 'todos os pares')} · bot ${esc(r.bot)}</div>
    <dl>
      <dt>Resultado aberto</dt><dd class="${cls(r.open_pnl)}">${money(r.open_pnl)} ${cur}</dd>
      <dt>Realizado</dt><dd class="${cls(r.realized_pnl)}">${money(r.realized_pnl)} ${cur}</dd>
      <dt>Total desde que entrou</dt><dd class="${cls(r.total_pnl)}">${money(r.total_pnl)} ${cur}</dd>
      <dt>Operações fechadas</dt><dd>${r.trades}${r.trades ? ` · ${Math.round((r.wins / r.trades) * 100)}% acerto` : ''}</dd>
    </dl>
    <div class="sub" style="margin:0">Drawdown atual: <b>${nf.format(r.drawdown)}</b> ${r.max_drawdown ? `de teto ${nf.format(r.max_drawdown)} ${cur}` : '(sem teto definido)'}</div>
    ${ddUsed == null ? '' : `<div class="ddbar"><i style="width:${ddUsed * 100}%"></i></div><div class="sub">${Math.round(ddUsed * 100)}% do teto usado</div>`}
    ${trades ? `<table><thead><tr><th>Par</th><th>Entrada</th><th>Atual</th><th>Resultado</th></tr></thead><tbody>${trades}</tbody></table>` : ''}
    ${r.ejected ? `<div class="note">Ejetado em ${new Date(r.ejected.at).toLocaleString('pt-BR')}: ${esc(r.ejected.reason)}. ${esc(r.ejected.enforced || '')}<br>Para voltar: <code>py -3 server.py reinstate ${esc(r.id)}</code></div>` : ''}
    ${r.error ? `<div class="note">${esc(r.error)}</div>` : ''}
    ${ordersHtml(r)}`;
  panel.hidden = false;
}

function select(id) {
  selectedId = id;
  for (const tr of traders.values()) tr.updateLabel(tr.robot);
  renderDetail(id ? robotsById.get(id) : null);
}
$('detail-close').addEventListener('click', () => select(null));
$('show-names').addEventListener('change', (e) => document.body.classList.toggle('hide-names', !e.target.checked));

let bannerTimer = null;
function showBanner(text, sticky = false, kind = '') {
  const b = $('banner');
  b.textContent = text;
  b.className = kind;
  b.hidden = false;
  clearTimeout(bannerTimer);
  if (!sticky) bannerTimer = setTimeout(() => { b.hidden = true; }, 7000);
}

// janela "Contratar funcionário"
const hireForm = $('hire-form');
function hireRole() { return hireForm.querySelector('input[name="role"]:checked').value; }
function updateHireForm() {
  const watch = hireRole() === 'watch';
  hireForm.querySelectorAll('.trade-only').forEach((el) => { el.hidden = watch; });
  hireForm.querySelector('.watch-only').hidden = !watch;
  const pair = $('hire-pair').value;
  const known = snap?.robots.find((r) => r.pair === pair && r.price);
  $('hire-price').textContent = known ? `Preço agora de ${pair}: ${price(known.price)}` : '';
}
function openHire() {
  if (!snap?.hire) return;
  const h = snap.hire;
  const select = $('hire-pair');
  if (!select.options.length) select.innerHTML = h.pairs.map((p) => `<option value="${esc(p)}">${esc(p)}</option>`).join('');
  $('hire-stake').max = h.max_stake;
  if (!$('hire-stake').value) $('hire-stake').value = h.default_stake;
  if (!$('hire-limit').value) $('hire-limit').value = Math.round(h.default_stake * 0.3);
  $('hire-error').textContent = '';
  updateHireForm();
  $('hire').hidden = false;
  $('hire-name').focus();
}
function closeHire() { $('hire').hidden = true; }
$('hire-open').addEventListener('click', openHire);
$('simulate-gain').addEventListener('click', async (e) => {
  const button = e.currentTarget;
  button.disabled = true;
  try {
    await sendOrder('/api/simulate/gain', selectedId ? { robot: selectedId } : {});
    await fetchSnapshot(true);
  } catch (err) {
    showBanner(err.message, false, 'alert');
  } finally {
    button.disabled = false;
  }
});
$('hire-close').addEventListener('click', closeHire);
$('hire-cancel').addEventListener('click', closeHire);
$('hire').addEventListener('click', (e) => { if (e.target === $('hire')) closeHire(); });
addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('hire').hidden) closeHire(); });
hireForm.addEventListener('change', updateHireForm);
hireForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const data = Object.fromEntries(new FormData(hireForm));
  const button = $('hire-submit');
  button.disabled = true;
  button.textContent = 'Contratando…';
  try {
    const message = await sendOrder('/api/employees', data);
    closeHire();
    hireForm.reset();
    button.disabled = false;
    button.textContent = 'Contratar';
    showBanner(message, false, 'ok');
    await fetchSnapshot(true);
  } catch (err) {
    $('hire-error').textContent = err.message;
    button.disabled = false;
    button.textContent = 'Contratar';
  }
});

// clique no boneco (sem confundir com arrastar a câmera)
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
let downAt = null;
renderer.domElement.addEventListener('pointerdown', (e) => { downAt = [e.clientX, e.clientY]; });
renderer.domElement.addEventListener('pointerup', (e) => {
  if (!downAt || Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 5) return;
  pointer.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
  raycaster.setFromCamera(pointer, camera);
  const hit = raycaster.intersectObjects(pickables, false)[0];
  select(hit ? hit.object.userData.traderId : null);
});

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  labelRenderer.setSize(innerWidth, innerHeight);
});

// ---------- loop ----------
const timer = new THREE.Clock();
let rotationCheck = 0;
function frame() {
  const dt = Math.min(timer.getDelta(), 0.1);
  const t = timer.elapsedTime;
  for (const tr of [...traders.values()]) tr.update(dt, t);
  updateEffects(dt, t);
  updateDance(t);

  // zerados trocam de atividade de tempos em tempos
  rotationCheck -= dt;
  if (rotationCheck <= 0) {
    rotationCheck = 3;
    for (const tr of traders.values()) {
      if (tr.mode === 'idle' && !tr.path.length && idleSlot(tr.id) !== tr.slot) tr.setState(tr.robot, false);
    }
  }

  const sel = selectedId && traders.get(selectedId);
  selectRing.visible = !!sel && sel.mode !== 'ejecting';
  if (sel) selectRing.position.set(sel.parts.root.position.x, 0.02, sel.parts.root.position.z);

  controls.update();
  renderer.render(scene, camera);
  labelRenderer.render(scene, camera);
  requestAnimationFrame(frame);
}

poll();
frame();
