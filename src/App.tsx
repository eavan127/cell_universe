import React, { useMemo, useRef, useState } from 'react';
import { Canvas, useFrame, useThree, extend } from '@react-three/fiber';
import { ScrollControls, useScroll, shaderMaterial } from '@react-three/drei';
import { EffectComposer, Bloom, Noise, Vignette } from '@react-three/postprocessing';
import * as THREE from 'three';

// --- A. 工具函数与配置 ---
const COUNT = 20000; // 粒子数量，电脑卡顿可调小
const r = () => Math.random() * 2 - 1;

// --- B. 6个世界的坐标生成逻辑 (这是数学核心) ---

// 1. RNA (螺旋)
const genLayer1 = (count: number) => {
  const pos = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const t = i * 0.1;
    const radius = 2 + Math.random() * 0.5;
    const angle = t * 0.5;
    const branch = i % 2 === 0 ? 1 : -1;
    pos[i * 3] = Math.cos(angle) * radius + r() * 0.2;
    pos[i * 3 + 1] = (i * 0.02) - 20;
    pos[i * 3 + 2] = Math.sin(angle) * radius * branch + r() * 0.2;
  }
  return pos;
};

// 2. 分子 (随机团簇)
const genLayer2 = (count: number) => {
  const pos = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const radius = Math.random() * 12;
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(Math.random() * 2 - 1);
    pos[i * 3] = radius * Math.sin(phi) * Math.cos(theta);
    pos[i * 3 + 1] = radius * Math.sin(phi) * Math.sin(theta);
    pos[i * 3 + 2] = radius * Math.cos(phi);
  }
  return pos;
};

// 3. 细胞 (噪波球体)
const genLayer3 = (count: number) => {
  const pos = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(Math.random() * 2 - 1);
    const nx = Math.sin(phi) * Math.cos(theta);
    const ny = Math.sin(phi) * Math.sin(theta);
    const nz = Math.cos(phi);
    // 简易模拟噪波
    const noise = Math.sin(nx * 8) * Math.cos(ny * 8); 
    const r = 10 + noise * 1.5;
    pos[i * 3] = r * nx;
    pos[i * 3 + 1] = r * ny;
    pos[i * 3 + 2] = r * nz;
  }
  return pos;
};

// 4. 神经网络 (管状)
const genLayer4 = (count: number) => {
  const pos = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const t = (i / count) * 60 - 30;
    const offset = Math.sin(t * 0.2) * 5;
    pos[i * 3] = t;
    pos[i * 3 + 1] = Math.sin(t * 0.5) * 6 + r();
    pos[i * 3 + 2] = Math.cos(t * 0.5) * 6 + r();
  }
  return pos;
};

// 5. 地球 (球体)
const genLayer5 = (count: number) => {
  const pos = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(Math.random() * 2 - 1);
    const r = 18;
    pos[i * 3] = r * Math.sin(phi) * Math.cos(theta);
    pos[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta);
    pos[i * 3 + 2] = r * Math.cos(phi);
  }
  return pos;
};

// 6. 银河 (漩涡)
const genLayer6 = (count: number) => {
  const pos = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const angle = i * 0.05;
    const rBase = i * 0.0015 * 30;
    const armOffset = (i % 3) * (Math.PI * 2 / 3);
    pos[i * 3] = Math.cos(angle + armOffset) * rBase + r();
    pos[i * 3 + 1] = r() * 1.5;
    pos[i * 3 + 2] = Math.sin(angle + armOffset) * rBase + r();
  }
  return pos;
};

// --- C. Shader Material (视觉核心) ---
const CellUniverseMaterial = shaderMaterial(
  {
    uTime: 0,
    uColorA: new THREE.Color('#ff0055'),
    uColorB: new THREE.Color('#00ffff'),
    uMix: 0,
    uPixelRatio: 1,
  },
  // Vertex Shader
  `
    uniform float uPixelRatio;
    uniform vec3 uColorA;
    uniform vec3 uColorB;
    uniform float uMix;
    attribute float aSize;
    varying vec3 vColor;
    void main() {
      vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
      gl_PointSize = aSize * uPixelRatio * (50.0 / -mvPosition.z);
      gl_Position = projectionMatrix * mvPosition;
      vColor = mix(uColorA, uColorB, uMix);
    }
  `,
  // Fragment Shader
  `
    varying vec3 vColor;
    void main() {
      vec2 xy = gl_PointCoord.xy - vec2(0.5);
      float ll = length(xy);
      if(ll > 0.5) discard;
      float glow = 1.0 - smoothstep(0.0, 0.5, ll);
      float core = 1.0 - smoothstep(0.0, 0.15, ll);
      gl_FragColor = vec4(vColor * glow + vec3(1.0) * core * 0.6, glow);
    }
  `
);
extend({ CellUniverseMaterial });

// --- D. React 组件 ---

const COLORS = ['#FF4757', '#2ED573', '#3742FA', '#FFA502', '#5352ED', '#A29BFE'].map(c => new THREE.Color(c));

const Particles = () => {
  const scroll = useScroll();
  const pointsRef = useRef<THREE.Points>(null!);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const materialRef = useRef<any>(null!);
  
  // 仅在初始时生成一次数据
  const [coords] = useState(() => [
    genLayer1(COUNT), genLayer2(COUNT), genLayer3(COUNT), 
    genLayer4(COUNT), genLayer5(COUNT), genLayer6(COUNT)
  ]);

  const sizes = useMemo(() => {
    const arr = new Float32Array(COUNT);
    for(let i=0; i<COUNT; i++) arr[i] = Math.random() * 2 + 0.5;
    return arr;
  }, []);

  const currentPositions = useMemo(() => new Float32Array(COUNT * 3), []);

  useFrame((state) => {
    if (!pointsRef.current || !materialRef.current) return;

    // 滚动逻辑：将 0-1 的滚动进度映射到 0-5 的层级索引
    const totalOffset = scroll.offset * 5; 
    const index = Math.floor(totalOffset); 
    const progress = totalOffset % 1; 
    const safeIndex = Math.min(index, 4);
    const nextIndex = Math.min(index + 1, 5);

    // 核心：线性插值 (Morphing)
    const posA = coords[safeIndex];
    const posB = coords[nextIndex];
    for (let i = 0; i < COUNT * 3; i++) {
      currentPositions[i] = THREE.MathUtils.lerp(posA[i], posB[i], progress);
    }
    pointsRef.current.geometry.attributes.position.needsUpdate = true;

    // 颜色与旋转
    materialRef.current.uColorA.lerpColors(COLORS[safeIndex], COLORS[nextIndex], progress);
    materialRef.current.uColorB.lerp(COLORS[nextIndex], 0.1);
    materialRef.current.uMix = progress;
    materialRef.current.uTime = state.clock.elapsedTime;
    
    pointsRef.current.rotation.y = state.clock.elapsedTime * 0.05;
  });

  return (
    <points ref={pointsRef}>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" count={COUNT} array={currentPositions} itemSize={3} />
        <bufferAttribute attach="attributes-aSize" count={COUNT} array={sizes} itemSize={1} />
      </bufferGeometry>
      {/* @ts-ignore */}
      <cellUniverseMaterial
        ref={materialRef}
        transparent
        depthWrite={false}
        blending={THREE.AdditiveBlending}
        uPixelRatio={Math.min(window.devicePixelRatio, 2)}
      />
    </points>
  );
};

export default function App() {
  return (
    <>
      <Canvas camera={{ position: [0, 0, 40], fov: 35 }} gl={{ antialias: false }}>
        <color attach="background" args={['#050505']} />
        <ScrollControls pages={6} damping={0.2}>
          <Particles />
        </ScrollControls>
        <EffectComposer disableNormalPass>
          <Bloom luminanceThreshold={0.1} mipmapBlur intensity={1.5} radius={0.5} />
          <Noise opacity={0.08} />
          <Vignette eskil={false} offset={0.1} darkness={1.1} />
        </EffectComposer>
      </Canvas>
      
      {/* UI 文字层 */}
      <div className="absolute top-0 left-0 w-full h-full pointer-events-none flex flex-col justify-between p-8 z-10 text-white mix-blend-difference">
        <div>
          <h1 className="text-3xl font-bold tracking-tighter">CELL IS UNIVERSE</h1>
          <p className="text-sm opacity-70">Interactive Particle System</p>
        </div>
        <div className="text-center animate-pulse text-xs">SCROLL TO MORPH</div>
      </div>
    </>
  );
}