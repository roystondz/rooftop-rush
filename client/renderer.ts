// Draws the world with Three.js. It only reads the simulation; it never changes it.
import * as THREE from 'three';
import { BALL, PITCH, PLAYER } from '../shared/constants';
import { clamp, lerp, mulberry32 } from '../shared/math';
import { penaltyCameraForward } from '../shared/control';
import type { World } from '../shared/types';

const HALF_L = PITCH.length / 2;
const HALF_W = PITCH.width / 2;
const GOAL_HALF = PITCH.goalWidth / 2;
const WALL_H = 4.5;

export const TEAM_COLORS = [0x22d3ee, 0xf472b6] as const;
const KEEPER_COLORS = [0xfacc15, 0xfb923c] as const;

/** Positions from the previous tick, so drawing can blend smoothly between ticks. */
export interface Snapshot {
  players: Float64Array; // x, z, facing per player
  ball: Float64Array; // x, y, z
}

export function takeSnapshot(w: World, into?: Snapshot): Snapshot {
  const s = into ?? { players: new Float64Array(w.players.length * 3), ball: new Float64Array(3) };
  w.players.forEach((p, i) => {
    s.players[i * 3] = p.x;
    s.players[i * 3 + 1] = p.z;
    s.players[i * 3 + 2] = p.facing;
  });
  s.ball[0] = w.ball.x;
  s.ball[1] = w.ball.y;
  s.ball[2] = w.ball.z;
  return s;
}

interface PlayerView {
  root: THREE.Group;
  body: THREE.Mesh;
  legL: THREE.Group;
  legR: THREE.Group;
  armL: THREE.Group;
  armR: THREE.Group;
  stride: number;
}

export class Renderer {
  readonly renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(48, 1, 0.1, 400);
  private playerViews: PlayerView[] = [];
  private ball!: THREE.Mesh;
  private ballShadow!: THREE.Mesh;
  private marker!: THREE.Group;
  private ghost!: THREE.Mesh;
  private aimLine!: THREE.Mesh;
  private switchHint!: THREE.Sprite;
  private switchHintId = -1;
  private trail!: THREE.InstancedMesh;
  private trailPoints: THREE.Vector3[] = [];
  private confetti!: THREE.Points;
  private confettiVel = new Float32Array(0);
  private confettiLife = 0;
  private nets: THREE.Group[] = [];
  private netPulse = [0, 0];
  private camX = 0;
  /** Penalty camera, eased between kicks so it glides from one end to the other. */
  private penCam: { pos: THREE.Vector3; look: THREE.Vector3 } | null = null;
  private shake = 0;
  private time = 0;
  private tmp = new THREE.Vector3();
  private dummy = new THREE.Object3D();

  /** `lowPower`: phones and tablets get a lower resolution and smaller shadows, to stay smooth. */
  constructor(
    canvas: HTMLCanvasElement,
    private lowPower = false,
  ) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, lowPower ? 1.5 : 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.1;

    this.scene.background = new THREE.Color(0x070b1c);
    this.scene.fog = new THREE.Fog(0x070b1c, 60, 190);

    this.buildLights();
    this.buildArena();
    this.buildCity();
    this.buildBall();
    this.buildEffects();

    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  /** Creates the six player models. Call again when a new match starts. */
  setupPlayers(w: World): void {
    for (const v of this.playerViews) this.scene.remove(v.root);
    this.playerViews = w.players.map((p) =>
      this.makePlayer(p.role === 'keeper' ? KEEPER_COLORS[p.team] : TEAM_COLORS[p.team], p.team),
    );
    for (const v of this.playerViews) this.scene.add(v.root);
    this.camX = 0;
    this.trailPoints.length = 0;
    this.ghost.visible = false;
  }

  /** Marks the teammate the switch button (Q) would give you; -1 hides it. */
  setSwitchHint(playerId: number): void {
    this.switchHintId = playerId;
  }

  /** Debug view: a ring where the server last confirmed your player was (null hides it). */
  setGhost(pos: { x: number; z: number } | null): void {
    this.ghost.visible = pos !== null;
    if (pos) this.ghost.position.set(pos.x, 0.04, pos.z);
  }

  addShake(amount: number): void {
    this.shake = Math.min(1.2, this.shake + amount);
  }

  goalBurst(team: 0 | 1, x: number): void {
    this.netPulse[x > 0 ? 1 : 0] = 1;
    const pos = this.confetti.geometry.getAttribute('position') as THREE.BufferAttribute;
    const col = this.confetti.geometry.getAttribute('color') as THREE.BufferAttribute;
    const c = new THREE.Color(TEAM_COLORS[team]);
    const gold = new THREE.Color(0xfacc15);
    const rnd = mulberry32(Math.floor(this.time * 1000));
    for (let i = 0; i < pos.count; i++) {
      pos.setXYZ(i, Math.sign(x) * HALF_L, 2, (rnd() - 0.5) * 4);
      this.confettiVel[i * 3] = -Math.sign(x) * (2 + rnd() * 8);
      this.confettiVel[i * 3 + 1] = 6 + rnd() * 10;
      this.confettiVel[i * 3 + 2] = (rnd() - 0.5) * 14;
      const cc = rnd() < 0.3 ? gold : c;
      col.setXYZ(i, cc.r, cc.g, cc.b);
    }
    pos.needsUpdate = true;
    col.needsUpdate = true;
    this.confettiLife = 3;
    this.confetti.visible = true;
  }

  render(w: World, prev: Snapshot | null, alpha: number, frameDt: number, controlledId: number): void {
    this.time += frameDt;
    const ip = (cur: number, i: number, arr: Float64Array | undefined) => (arr ? lerp(arr[i], cur, alpha) : cur);

    // Players
    w.players.forEach((p, i) => {
      const v = this.playerViews[i];
      if (!v) return;
      const x = ip(p.x, i * 3, prev?.players);
      const z = ip(p.z, i * 3 + 1, prev?.players);
      v.root.position.set(x, 0, z);
      v.root.rotation.y = -p.facing;

      const speed = Math.hypot(p.vx, p.vz);
      const run = clamp(speed / PLAYER.sprintSpeed, 0, 1);
      v.stride += frameDt * (4 + speed * 1.6);
      const swing = Math.sin(v.stride) * 0.9 * run;
      v.legL.rotation.z = swing;
      v.legR.rotation.z = -swing;
      v.armL.rotation.z = -swing * 0.8;
      v.armR.rotation.z = swing * 0.8;
      v.body.position.y = 1.08 + Math.abs(Math.sin(v.stride)) * 0.06 * run;
      v.root.rotation.z = p.stun > 0 ? -0.5 : -0.12 * run; // lean into the run, wobble when stunned
      if (p.dive > 0 || (w.mode === 'penalties' && p.role === 'keeper' && p.stun > 0)) {
        // Keeper diving (or lying after a dive): lay the body over sideways.
        v.root.rotation.x = Math.sign(p.vz || 1) * -1.2;
        v.root.position.y = 0.35;
      } else {
        v.root.rotation.x = 0;
      }

      // The scoring team jumps. During the goal phase the ball sits in the net it went into.
      const celebrating = w.phase === 'goal' && p.team === (w.ball.x > 0 ? 0 : 1);
      v.root.position.y = celebrating ? Math.abs(Math.sin(this.time * 7 + i)) * 0.6 : 0;
    });

    // Controlled-player marker
    const cp = w.players[controlledId];
    if (cp && this.playerViews[controlledId]) {
      const root = this.playerViews[controlledId].root;
      this.marker.visible = true;
      this.marker.position.set(root.position.x, 0.03, root.position.z);
      this.marker.rotation.y = -cp.facing;
      const s = cp.charging ? 1 + (cp.charge / PLAYER.maxCharge) * 0.5 : 1;
      this.marker.scale.setScalar(s);
    } else {
      this.marker.visible = false;
    }

    const hinted = this.playerViews[this.switchHintId];
    this.switchHint.visible = !!hinted && this.switchHintId !== controlledId;
    if (hinted) {
      this.switchHint.position.set(hinted.root.position.x, 2.8 + Math.sin(this.time * 6) * 0.1, hinted.root.position.z);
    }

    // Ball
    const bx = ip(w.ball.x, 0, prev?.ball);
    const by = ip(w.ball.y, 1, prev?.ball);
    const bz = ip(w.ball.z, 2, prev?.ball);
    const dx = bx - this.ball.position.x;
    const dz = bz - this.ball.position.z;
    const rolled = Math.hypot(dx, dz);
    if (rolled > 1e-4 && rolled < 3) {
      this.tmp.set(dz, 0, -dx).normalize();
      this.ball.rotateOnWorldAxis(this.tmp, rolled / BALL.radius);
    }
    this.ball.position.set(bx, by, bz);
    this.ballShadow.position.set(bx, 0.02, bz);
    const h = clamp((by - BALL.radius) / 6, 0, 1);
    this.ballShadow.scale.setScalar(1 - h * 0.5);
    (this.ballShadow.material as THREE.MeshBasicMaterial).opacity = 0.45 * (1 - h);

    this.updateTrail(w, frameDt);
    this.updateConfetti(frameDt);
    this.updateNets(frameDt);
    this.updateAimLine(w, controlledId);
    this.updateCamera(bx, bz, frameDt, w);
    this.renderer.render(this.scene, this.camera);
  }

  // --- building the scene -----------------------------------------------------

  private resize(): void {
    const width = window.innerWidth;
    const height = window.innerHeight;
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.fov = width / height < 1 ? 70 : 48;
    this.camera.updateProjectionMatrix();
  }

  private buildLights(): void {
    this.scene.add(new THREE.HemisphereLight(0x8aa0ff, 0x1a1530, 1.1));
    const moon = new THREE.DirectionalLight(0xdfe6ff, 2.2);
    moon.position.set(-12, 30, 18);
    moon.castShadow = true;
    const shadowSize = this.lowPower ? 1024 : 2048;
    moon.shadow.mapSize.set(shadowSize, shadowSize);
    const sc = moon.shadow.camera;
    sc.left = -26;
    sc.right = 26;
    sc.top = 18;
    sc.bottom = -18;
    sc.near = 1;
    sc.far = 80;
    moon.shadow.bias = -0.0005;
    this.scene.add(moon);

    // Floodlights at the corners: visible lamps plus soft coloured fill.
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const pole = new THREE.Mesh(
          new THREE.CylinderGeometry(0.12, 0.15, 9, 8),
          new THREE.MeshStandardMaterial({ color: 0x2a2f45, metalness: 0.6, roughness: 0.4 }),
        );
        pole.position.set(sx * (HALF_L + 3), 4.5, sz * (HALF_W + 3));
        const lamp = new THREE.Mesh(
          new THREE.BoxGeometry(1.4, 0.5, 0.8),
          new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xfff4d6, emissiveIntensity: 3 }),
        );
        lamp.position.set(sx * (HALF_L + 3), 9.2, sz * (HALF_W + 3));
        lamp.lookAt(0, 0, 0);
        this.scene.add(pole, lamp);
      }
    }
    const fill0 = new THREE.PointLight(TEAM_COLORS[0], 40, 30, 1.6);
    fill0.position.set(-HALF_L, 5, 0);
    const fill1 = new THREE.PointLight(TEAM_COLORS[1], 40, 30, 1.6);
    fill1.position.set(HALF_L, 5, 0);
    this.scene.add(fill0, fill1);
  }

  private buildArena(): void {
    // The building the pitch sits on.
    const building = new THREE.Mesh(
      new THREE.BoxGeometry(PITCH.length + 14, 60, PITCH.width + 14),
      new THREE.MeshStandardMaterial({ color: 0x1b1f2e, roughness: 0.9 }),
    );
    building.position.y = -30.05;
    building.receiveShadow = true;
    this.scene.add(building);

    const pitch = new THREE.Mesh(
      new THREE.PlaneGeometry(PITCH.length, PITCH.width),
      new THREE.MeshStandardMaterial({ map: pitchTexture(), roughness: 0.95 }),
    );
    pitch.rotation.x = -Math.PI / 2;
    pitch.receiveShadow = true;
    this.scene.add(pitch);

    // Cage walls: see-through mesh panels with neon strips along the bottom and top.
    const netTex = netTexture();
    const wallMat = new THREE.MeshBasicMaterial({
      map: netTex,
      transparent: true,
      opacity: 0.35,
      side: THREE.DoubleSide,
      depthWrite: false,
      color: 0x9fb4ff,
    });
    const addPanel = (w: number, h: number, x: number, y: number, z: number, rotY: number, opacity = 0.35) => {
      const tex = netTex.clone();
      tex.repeat.set(w / 1.2, h / 1.2);
      tex.needsUpdate = true;
      const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), wallMat.clone());
      (m.material as THREE.MeshBasicMaterial).map = tex;
      (m.material as THREE.MeshBasicMaterial).opacity = opacity;
      m.position.set(x, y, z);
      m.rotation.y = rotY;
      this.scene.add(m);
    };
    for (const sz of [-1, 1]) {
      // The wall nearest the camera is kept faint so it never hides the play.
      addPanel(PITCH.length, WALL_H, 0, WALL_H / 2, sz * HALF_W, 0, sz > 0 ? 0.06 : 0.35);
      this.addNeon(PITCH.length, 0, sz * HALF_W, 0, 0x6d7cff);
    }
    for (const team of [0, 1] as const) {
      const sx = team === 0 ? -1 : 1;
      const sideLen = HALF_W - GOAL_HALF;
      for (const sz of [-1, 1]) {
        addPanel(sideLen, WALL_H, sx * HALF_L, WALL_H / 2, sz * (GOAL_HALF + sideLen / 2), Math.PI / 2);
        this.addNeon(sideLen, sx * HALF_L, sz * (GOAL_HALF + sideLen / 2), Math.PI / 2, TEAM_COLORS[team]);
      }
      const topH = WALL_H - PITCH.goalHeight;
      addPanel(PITCH.goalWidth, topH, sx * HALF_L, PITCH.goalHeight + topH / 2, 0, Math.PI / 2);
      this.nets.push(this.buildGoal(sx, team));
    }

    // Top rail
    const railMat = new THREE.MeshStandardMaterial({ color: 0x8b95c9, metalness: 0.8, roughness: 0.3 });
    for (const sz of [-1, 1]) {
      const rail = new THREE.Mesh(new THREE.BoxGeometry(PITCH.length, 0.08, 0.08), railMat);
      rail.position.set(0, WALL_H, sz * HALF_W);
      this.scene.add(rail);
    }
    for (const sx of [-1, 1]) {
      const rail = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.08, PITCH.width), railMat);
      rail.position.set(sx * HALF_L, WALL_H, 0);
      this.scene.add(rail);
    }
  }

  private addNeon(length: number, x: number, z: number, rotY: number, color: number): void {
    const strip = new THREE.Mesh(
      new THREE.BoxGeometry(length, 0.12, 0.12),
      new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 2.5 }),
    );
    strip.position.set(x, 0.06, z);
    strip.rotation.y = rotY;
    this.scene.add(strip);
  }

  private buildGoal(sx: number, team: 0 | 1): THREE.Group {
    const postMat = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xffffff, emissiveIntensity: 0.4 });
    const r = PITCH.postRadius;
    for (const sz of [-1, 1]) {
      const post = new THREE.Mesh(new THREE.CylinderGeometry(r, r, PITCH.goalHeight, 12), postMat);
      post.position.set(sx * HALF_L, PITCH.goalHeight / 2, sz * GOAL_HALF);
      post.castShadow = true;
      this.scene.add(post);
    }
    const bar = new THREE.Mesh(new THREE.CylinderGeometry(r, r, PITCH.goalWidth + r * 2, 12), postMat);
    bar.rotation.x = Math.PI / 2;
    bar.position.set(sx * HALF_L, PITCH.goalHeight, 0);
    bar.castShadow = true;
    this.scene.add(bar);

    // The net is grouped so it can bulge when a goal goes in.
    const net = new THREE.Group();
    net.position.set(sx * HALF_L, 0, 0);
    const mat = new THREE.MeshBasicMaterial({
      map: netTexture(),
      color: TEAM_COLORS[team],
      transparent: true,
      opacity: 0.8,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const d = PITCH.goalDepth;
    const h = PITCH.goalHeight;
    const back = new THREE.Mesh(new THREE.PlaneGeometry(PITCH.goalWidth, h), mat);
    back.rotation.y = Math.PI / 2;
    back.position.set(sx * d, h / 2, 0);
    const top = new THREE.Mesh(new THREE.PlaneGeometry(d, PITCH.goalWidth), mat);
    top.rotation.x = Math.PI / 2;
    top.position.set((sx * d) / 2, h, 0);
    net.add(back, top);
    for (const sz of [-1, 1]) {
      const side = new THREE.Mesh(new THREE.PlaneGeometry(d, h), mat);
      side.position.set((sx * d) / 2, h / 2, sz * GOAL_HALF);
      net.add(side);
    }
    this.scene.add(net);
    return net;
  }

  private buildCity(): void {
    const rnd = mulberry32(2024);
    const windows = windowTexture();
    const geo = new THREE.BoxGeometry(1, 1, 1);
    const count = 140;
    const mat = new THREE.MeshStandardMaterial({
      color: 0x0d1120,
      emissive: 0xffffff,
      emissiveMap: windows,
      emissiveIntensity: 1.2,
      roughness: 0.8,
    });
    const city = new THREE.InstancedMesh(geo, mat, count);
    const m = new THREE.Matrix4();
    let placed = 0;
    for (let i = 0; i < count * 3 && placed < count; i++) {
      const angle = rnd() * Math.PI * 2;
      const dist = 48 + rnd() * 90;
      const x = Math.cos(angle) * dist;
      const z = Math.sin(angle) * dist * 0.8;
      if (z > 20 && Math.abs(x) < 70) continue; // keep the camera's view of the pitch clear
      const w = 6 + rnd() * 12;
      const d = 6 + rnd() * 12;
      const top = -12 + rnd() * 50;
      const height = top + 60;
      m.compose(
        new THREE.Vector3(x, top - height / 2, z),
        new THREE.Quaternion(),
        new THREE.Vector3(w, height, d),
      );
      city.setMatrixAt(placed++, m);
    }
    city.count = placed;
    this.scene.add(city);

    // Stars
    const starGeo = new THREE.BufferGeometry();
    const stars = new Float32Array(600 * 3);
    for (let i = 0; i < 600; i++) {
      const theta = rnd() * Math.PI * 2;
      const phi = rnd() * Math.PI * 0.45;
      stars[i * 3] = Math.cos(theta) * Math.sin(phi) * 300;
      stars[i * 3 + 1] = Math.cos(phi) * 300 + 20;
      stars[i * 3 + 2] = Math.sin(theta) * Math.sin(phi) * 300;
    }
    starGeo.setAttribute('position', new THREE.BufferAttribute(stars, 3));
    this.scene.add(new THREE.Points(starGeo, new THREE.PointsMaterial({ color: 0xffffff, size: 1.2, fog: false })));

    const moon = new THREE.Mesh(
      new THREE.SphereGeometry(8, 24, 16),
      new THREE.MeshBasicMaterial({ color: 0xf5f1e1, fog: false }),
    );
    moon.position.set(-120, 90, -220);
    this.scene.add(moon);
  }

  private buildBall(): void {
    this.ball = new THREE.Mesh(
      new THREE.SphereGeometry(BALL.radius, 24, 16),
      new THREE.MeshStandardMaterial({ map: ballTexture(), roughness: 0.5 }),
    );
    this.ball.castShadow = true;
    this.scene.add(this.ball);

    this.ballShadow = new THREE.Mesh(
      new THREE.CircleGeometry(0.4, 20),
      new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.45, depthWrite: false }),
    );
    this.ballShadow.rotation.x = -Math.PI / 2;
    this.scene.add(this.ballShadow);
  }

  private buildEffects(): void {
    // Ring and arrow under the player you control.
    this.marker = new THREE.Group();
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.62, 0.78, 32),
      new THREE.MeshBasicMaterial({ color: 0xfacc15, transparent: true, opacity: 0.9, depthWrite: false }),
    );
    ring.rotation.x = -Math.PI / 2;
    const arrow = new THREE.Mesh(
      new THREE.ConeGeometry(0.22, 0.45, 3),
      new THREE.MeshBasicMaterial({ color: 0xfacc15 }),
    );
    arrow.rotation.z = -Math.PI / 2;
    arrow.position.set(1.05, 0.02, 0);
    arrow.scale.y = 1;
    this.marker.add(ring, arrow);
    this.scene.add(this.marker);

    this.ghost = new THREE.Mesh(
      new THREE.RingGeometry(0.45, 0.55, 32),
      new THREE.MeshBasicMaterial({ color: 0xff3b6b, transparent: true, opacity: 0.9, depthWrite: false }),
    );
    this.ghost.rotation.x = -Math.PI / 2;
    this.ghost.visible = false;
    this.scene.add(this.ghost);

    this.aimLine = new THREE.Mesh(
      new THREE.PlaneGeometry(3.2, 0.14),
      new THREE.MeshBasicMaterial({ color: 0xfacc15, transparent: true, opacity: 0.8, depthWrite: false }),
    );
    this.aimLine.visible = false;
    this.scene.add(this.aimLine);

    // A "Q" badge over the teammate the switch button would give you.
    this.switchHint = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: switchBadgeTexture(), depthTest: false, transparent: true }),
    );
    this.switchHint.scale.set(1.5, 1.5, 1);
    this.switchHint.renderOrder = 10;
    this.switchHint.visible = false;
    this.scene.add(this.switchHint);

    // Power-shot trail: glowing spheres left behind the ball.
    this.trail = new THREE.InstancedMesh(
      new THREE.SphereGeometry(BALL.radius, 10, 8),
      new THREE.MeshBasicMaterial({ color: 0xffa53d, transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false }),
      24,
    );
    this.trail.count = 0;
    this.scene.add(this.trail);

    // Goal confetti
    const n = 400;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    this.confetti = new THREE.Points(geo, new THREE.PointsMaterial({ size: 0.25, vertexColors: true }));
    this.confetti.visible = false;
    this.confetti.frustumCulled = false;
    this.confettiVel = new Float32Array(n * 3);
    this.scene.add(this.confetti);
  }

  private makePlayer(color: number, team: 0 | 1): PlayerView {
    const root = new THREE.Group();
    const shirt = new THREE.MeshStandardMaterial({ color, roughness: 0.6 });
    const shorts = new THREE.MeshStandardMaterial({ color: team === 0 ? 0x0e2a4a : 0x3b0d2c, roughness: 0.7 });
    const skin = new THREE.MeshStandardMaterial({ color: 0xe0b089, roughness: 0.8 });

    const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.32, 0.5, 4, 12), shirt);
    body.position.y = 1.08;
    body.castShadow = true;
    root.add(body);

    const head = new THREE.Mesh(new THREE.SphereGeometry(0.22, 16, 12), skin);
    head.position.set(0, 0.55, 0);
    head.castShadow = true;
    body.add(head);
    const visor = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.08, 0.3), new THREE.MeshStandardMaterial({ color: 0x111122 }));
    visor.position.set(0.19, 0.04, 0);
    head.add(visor);

    const limb = (len: number, thick: number, mat: THREE.Material, x: number, y: number, z: number) => {
      const pivot = new THREE.Group();
      pivot.position.set(x, y, z);
      const m = new THREE.Mesh(new THREE.BoxGeometry(thick, len, thick), mat);
      m.position.y = -len / 2;
      m.castShadow = true;
      pivot.add(m);
      root.add(pivot);
      return pivot;
    };
    const legL = limb(0.72, 0.17, shorts, 0, 0.75, -0.14);
    const legR = limb(0.72, 0.17, shorts, 0, 0.75, 0.14);
    const armL = limb(0.55, 0.12, shirt, 0, 1.45, -0.42);
    const armR = limb(0.55, 0.12, shirt, 0, 1.45, 0.42);
    return { root, body, legL, legR, armL, armR, stride: 0 };
  }

  // --- per-frame effects --------------------------------------------------------

  private updateTrail(w: World, frameDt: number): void {
    const b = w.ball;
    const speed = Math.hypot(b.vx, b.vy, b.vz);
    const active = b.owner < 0 && (b.power || speed > 22);
    if (active) {
      this.trailPoints.unshift(this.ball.position.clone());
      if (this.trailPoints.length > 24) this.trailPoints.pop();
    } else if (this.trailPoints.length > 0 && frameDt > 0) {
      this.trailPoints.pop();
    }
    const mat = this.trail.material as THREE.MeshBasicMaterial;
    mat.color.set(b.power ? 0xffa53d : 0x9fd8ff);
    this.trail.count = this.trailPoints.length;
    this.trailPoints.forEach((pt, i) => {
      this.dummy.position.copy(pt);
      this.dummy.scale.setScalar(1 - i / 26);
      this.dummy.updateMatrix();
      this.trail.setMatrixAt(i, this.dummy.matrix);
    });
    this.trail.instanceMatrix.needsUpdate = true;
  }

  private updateConfetti(dt: number): void {
    if (this.confettiLife <= 0) return;
    this.confettiLife -= dt;
    const pos = this.confetti.geometry.getAttribute('position') as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      this.confettiVel[i * 3 + 1] -= 14 * dt;
      this.confettiVel[i * 3] *= 0.99;
      this.confettiVel[i * 3 + 2] *= 0.99;
      const y = Math.max(0.05, pos.getY(i) + this.confettiVel[i * 3 + 1] * dt);
      if (y <= 0.05) this.confettiVel[i * 3 + 1] = 0;
      pos.setXYZ(i, pos.getX(i) + this.confettiVel[i * 3] * dt, y, pos.getZ(i) + this.confettiVel[i * 3 + 2] * dt);
    }
    pos.needsUpdate = true;
    if (this.confettiLife <= 0) this.confetti.visible = false;
  }

  private updateNets(dt: number): void {
    this.nets.forEach((net, i) => {
      this.netPulse[i] = Math.max(0, this.netPulse[i] - dt * 1.5);
      const k = Math.sin(this.netPulse[i] * Math.PI * 3) * this.netPulse[i];
      net.scale.x = 1 + k * 0.35;
    });
  }

  /** Penalties: a line from the ball showing where you're aiming. */
  private updateAimLine(w: World, controlledId: number): void {
    const so = w.shootout;
    const me = w.players[controlledId];
    const show = !!so && !so.kicked && w.phase === 'playing' && w.ball.owner === controlledId && !!me;
    this.aimLine.visible = show;
    if (!show || !me) return;
    const len = 3.2;
    this.aimLine.position.set(w.ball.x + Math.cos(me.facing) * len * 0.5, 0.04, w.ball.z + Math.sin(me.facing) * len * 0.5);
    this.aimLine.rotation.set(-Math.PI / 2, 0, me.facing);
  }

  private updateCamera(bx: number, bz: number, dt: number, w: World): void {
    const portrait = this.camera.aspect < 1;
    this.shake = Math.max(0, this.shake - dt * 2.5);
    const sx = (Math.sin(this.time * 61) * 0.3 + Math.sin(this.time * 37) * 0.2) * this.shake;
    const sy = Math.sin(this.time * 53) * 0.3 * this.shake;

    const forward = penaltyCameraForward(w);
    if (forward !== null) {
      // Penalties: behind the taker at about head height, looking straight at the goal.
      const goalX = forward * (PITCH.length / 2);
      const spotX = goalX - forward * 4.5;
      const back = portrait ? 11 : 7.5;
      const pos = new THREE.Vector3(spotX - forward * back, portrait ? 5 : 3.4, 0);
      const look = new THREE.Vector3(goalX, 1.1, 0);
      if (!this.penCam) this.penCam = { pos: pos.clone(), look: look.clone() };
      const k = 1 - Math.exp(-3.5 * dt);
      this.penCam.pos.lerp(pos, k);
      this.penCam.look.lerp(look, k);
      this.camera.position.set(this.penCam.pos.x + sx * 0.4, this.penCam.pos.y + sy * 0.4, this.penCam.pos.z);
      this.camera.lookAt(this.penCam.look);
      return;
    }
    this.penCam = null;

    this.camX = lerp(this.camX, clamp(bx * 0.85, -11, 11), 1 - Math.exp(-3 * dt));
    const height = portrait ? 36 : 21;
    const back = portrait ? 28 : 25;
    this.camera.position.set(this.camX + sx, height + sy, back + bz * 0.15);
    this.camera.lookAt(this.camX, 0, bz * 0.3 + 0.5);
  }
}

// --- generated textures ---------------------------------------------------------

function canvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return [c, c.getContext('2d')!];
}

function pitchTexture(): THREE.CanvasTexture {
  const ppm = 40; // pixels per metre
  const [c, g] = canvas(PITCH.length * ppm, PITCH.width * ppm);
  const X = (x: number) => (x + HALF_L) * ppm;
  const Z = (z: number) => (z + HALF_W) * ppm;
  for (let i = 0; i < 10; i++) {
    g.fillStyle = i % 2 ? '#1f6f3a' : '#237d42';
    g.fillRect(i * 4 * ppm, 0, 4 * ppm, c.height);
  }
  g.strokeStyle = 'rgba(255,255,255,0.85)';
  g.lineWidth = 0.12 * ppm;
  const inset = 0.3;
  g.strokeRect(X(-HALF_L + inset), Z(-HALF_W + inset), (PITCH.length - inset * 2) * ppm, (PITCH.width - inset * 2) * ppm);
  g.beginPath();
  g.moveTo(X(0), Z(-HALF_W + inset));
  g.lineTo(X(0), Z(HALF_W - inset));
  g.stroke();
  g.beginPath();
  g.arc(X(0), Z(0), 3 * ppm, 0, Math.PI * 2);
  g.stroke();
  g.fillStyle = 'rgba(255,255,255,0.85)';
  g.beginPath();
  g.arc(X(0), Z(0), 0.2 * ppm, 0, Math.PI * 2);
  g.fill();
  for (const s of [-1, 1]) {
    const x0 = s < 0 ? X(-HALF_L + inset) : X(HALF_L - inset - PITCH.boxDepth);
    g.strokeRect(x0, Z(-PITCH.boxHalfWidth), PITCH.boxDepth * ppm, PITCH.boxHalfWidth * 2 * ppm);
    g.beginPath();
    g.arc(X(s * (HALF_L - 4.5)), Z(0), 0.18 * ppm, 0, Math.PI * 2);
    g.fill();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

function switchBadgeTexture(): THREE.CanvasTexture {
  const [c, g] = canvas(128, 128);
  g.fillStyle = 'rgba(7, 11, 28, 0.85)';
  g.strokeStyle = '#facc15';
  g.lineWidth = 8;
  g.beginPath();
  g.arc(64, 56, 44, 0, Math.PI * 2);
  g.fill();
  g.stroke();
  g.fillStyle = '#facc15';
  g.beginPath(); // little pointer underneath
  g.moveTo(50, 98);
  g.lineTo(78, 98);
  g.lineTo(64, 122);
  g.closePath();
  g.fill();
  g.font = '900 56px system-ui, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText('Q', 64, 58);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function netTexture(): THREE.CanvasTexture {
  const [c, g] = canvas(64, 64);
  g.strokeStyle = 'rgba(255,255,255,0.9)';
  g.lineWidth = 3;
  g.beginPath();
  g.moveTo(0, 0);
  g.lineTo(64, 64);
  g.moveTo(64, 0);
  g.lineTo(0, 64);
  g.stroke();
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(6, 2);
  return tex;
}

function windowTexture(): THREE.CanvasTexture {
  const rnd = mulberry32(7);
  const [c, g] = canvas(128, 256);
  g.fillStyle = '#000';
  g.fillRect(0, 0, c.width, c.height);
  const colors = ['#ffd889', '#ffe7b0', '#9ad7ff', '#c4b5fd'];
  for (let y = 4; y < c.height; y += 12) {
    for (let x = 4; x < c.width; x += 10) {
      if (rnd() < 0.35) {
        g.fillStyle = colors[Math.floor(rnd() * colors.length)];
        g.globalAlpha = 0.4 + rnd() * 0.6;
        g.fillRect(x, y, 5, 7);
      }
    }
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function ballTexture(): THREE.CanvasTexture {
  const [c, g] = canvas(256, 128);
  g.fillStyle = '#f5f5f5';
  g.fillRect(0, 0, 256, 128);
  g.fillStyle = '#1b1b2a';
  const spots: [number, number][] = [
    [32, 32], [96, 64], [160, 32], [224, 64], [32, 96], [160, 96], [96, 8], [224, 120],
  ];
  for (const [x, y] of spots) {
    g.beginPath();
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2 - Math.PI / 2;
      g.lineTo(x + Math.cos(a) * 14, y + Math.sin(a) * 14);
    }
    g.closePath();
    g.fill();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
