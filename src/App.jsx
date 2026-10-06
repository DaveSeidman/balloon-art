import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { Environment, OrbitControls, useCubeCamera, useGLTF } from '@react-three/drei'
import { BallCollider, MeshCollider, Physics, RigidBody, useBeforePhysicsStep } from '@react-three/rapier'
import { Leva, useControls } from 'leva'
import { DepthOfField, EffectComposer, ToneMapping } from '@react-three/postprocessing'
import { ToneMappingMode } from 'postprocessing'
import * as THREE from 'three'

import ROOF_URL from './assets/roof1.glb'
import BALLOON_URL from './assets/balloon1.glb'
import VENICE_SUNSET_HDR from './assets/venice_sunset_2k.hdr'
import CAT_SAMPLER_IMAGE from './assets/cat-sampler.jpg'
import { decodeSamples, encodeSamples, readShareParams, samplesPreview, SIMULATION_DEFAULTS } from './share.js'
import { quantizeSamples } from './palette.js'

const ReflectionMapContext = createContext(null)
const MAX_BALLOONS = 1000
const SAMPLE_GRID = 32

function PlaybackRunner({ playing, frames, bodyRegistry, visualRegistry, onComplete }) {
  const cursor = useRef(0)
  const frameIndex = useRef(0)
  const completed = useRef(false)
  const fromRotation = useMemo(() => new THREE.Quaternion(), [])
  const toRotation = useMemo(() => new THREE.Quaternion(), [])
  useEffect(() => {
    if (!playing) return
    cursor.current = 0
    frameIndex.current = 0
    completed.current = false
    visualRegistry.current.forEach(({ balloon, ribbon }) => {
      if (balloon.current) balloon.current.visible = false
      if (ribbon.current) ribbon.current.visible = false
    })
  }, [playing, frames, visualRegistry])
  useFrame((_, dt) => {
    if (!playing || frames.length === 0 || completed.current) return
    cursor.current = Math.min(cursor.current + dt, frames[frames.length - 1].time)
    while (frameIndex.current < frames.length - 1 && frames[frameIndex.current + 1].time <= cursor.current) frameIndex.current += 1
    const current = frames[frameIndex.current]
    const next = frames[Math.min(frameIndex.current + 1, frames.length - 1)]
    const alpha = next.time > current.time ? (cursor.current - current.time) / (next.time - current.time) : 0
    for (let offset = 0; offset < current.poses.length; offset += 8) {
      const poses = current.poses
      const id = poses[offset]
      const x = poses[offset + 1], y = poses[offset + 2], z = poses[offset + 3]
      const qx = poses[offset + 4], qy = poses[offset + 5], qz = poses[offset + 6], qw = poses[offset + 7]
      const body = bodyRegistry.current.get(id)?.current
      if (!body) continue
      const later = next.poses[offset] === id ? next.poses : poses
      fromRotation.set(qx, qy, qz, qw)
      toRotation.set(later[offset + 4], later[offset + 5], later[offset + 6], later[offset + 7])
      fromRotation.slerp(toRotation, alpha)
      const translation = { x: THREE.MathUtils.lerp(x, later[offset + 1], alpha), y: THREE.MathUtils.lerp(y, later[offset + 2], alpha), z: THREE.MathUtils.lerp(z, later[offset + 3], alpha) }
      body.setTranslation(translation, false)
      body.setRotation({ x: fromRotation.x, y: fromRotation.y, z: fromRotation.z, w: fromRotation.w }, false)
      const visuals = visualRegistry.current.get(id)
      const renderBody = visuals?.balloon.current?.parent
      if (renderBody) {
        renderBody.position.set(translation.x, translation.y, translation.z)
        renderBody.quaternion.copy(fromRotation)
      }
      if (visuals?.balloon.current) visuals.balloon.current.visible = true
      if (visuals?.ribbon.current) visuals.ribbon.current.visible = true
    }
    if (cursor.current >= frames[frames.length - 1].time) {
      completed.current = true
      onComplete()
    }
  }, -1)
  return null
}

function PointerBalloonForce({ bodyRegistry, gl, enabled = true }) {
  const dragging = useRef(false)
  useEffect(() => {
    if (!enabled) dragging.current = false
    const start = () => { if (enabled) dragging.current = true }
    const stop = () => { dragging.current = false }
    gl.domElement.addEventListener('pointerdown', start)
    window.addEventListener('pointerup', stop)
    window.addEventListener('pointercancel', stop)
    return () => {
      gl.domElement.removeEventListener('pointerdown', start)
      window.removeEventListener('pointerup', stop)
      window.removeEventListener('pointercancel', stop)
    }
  }, [gl, enabled])
  useFrame((state, delta) => {
    if (!enabled || !dragging.current) return
    const raycaster = state.raycaster
    raycaster.setFromCamera(state.pointer, state.camera)
    const origin = raycaster.ray.origin
    const direction = raycaster.ray.direction
    bodyRegistry.current.forEach((bodyRef) => {
      const body = bodyRef.current
      if (!body) return
      const position = body.translation()
      const relativeX = position.x - origin.x
      const relativeY = position.y - origin.y
      const relativeZ = position.z - origin.z
      const alongRay = relativeX * direction.x + relativeY * direction.y + relativeZ * direction.z
      if (alongRay < 0) return
      let awayX = relativeX - direction.x * alongRay
      let awayY = relativeY - direction.y * alongRay
      let awayZ = relativeZ - direction.z * alongRay
      const distance = Math.hypot(awayX, awayY, awayZ)
      const radius = 0.9
      if (distance >= radius) return
      if (distance < 0.001) { awayX = 1; awayY = 0.15; awayZ = 0 }
      else { awayX /= distance; awayY /= distance; awayZ /= distance }
      const strength = body.mass() * 0.12 * (1 - distance / radius) * Math.min(delta * 60, 1.5)
      body.applyImpulse({ x: awayX * strength, y: awayY * strength + body.mass() * 0.01, z: awayZ * strength }, true)
    })
  })
  return null
}

function BalloonReturnMotion({ balloons, bodyRegistry, enabled }) {
  const quietTimes = useRef(new Map())
  const rotation = useMemo(() => new THREE.Quaternion(), [])
  const targetRotation = useMemo(() => new THREE.Quaternion(), [])
  useEffect(() => { quietTimes.current.clear() }, [enabled, balloons])
  useBeforePhysicsStep((world) => {
    if (!enabled) return
    const dt = Math.min(world.timestep, 1 / 20)
    const returnAmount = 1 - Math.exp(-1.3125 * dt)
    const linearDecay = Math.exp(-3 * dt)
    const angularDecay = Math.exp(-5 * dt)
    for (const balloon of balloons) {
      const body = bodyRegistry.current.get(balloon.id)?.current
      if (!body || !balloon.restPosition) continue
      const position = body.translation()
      const velocity = body.linvel()
      const angularVelocity = body.angvel()
      const currentRotation = body.rotation()
      const [x, y, z] = balloon.restPosition
      const distance = Math.hypot(x - position.x, y - position.y, z - position.z)
      rotation.set(currentRotation.x, currentRotation.y, currentRotation.z, currentRotation.w)
      targetRotation.fromArray(balloon.restRotation)
      const angle = rotation.angleTo(targetRotation)
      if (body.isSleeping()) {
        if (distance < balloon.scale * 0.08 && angle < 0.05) {
          continue
        }
        // Rapier may sleep before the algebraic return has reached its destination.
        body.wakeUp()
        quietTimes.current.delete(balloon.id)
      }
      body.resetForces(false)
      body.resetTorques(false)
      body.setLinvel({ x: velocity.x * linearDecay, y: velocity.y * linearDecay, z: velocity.z * linearDecay }, false)
      body.setAngvel({ x: angularVelocity.x * angularDecay, y: angularVelocity.y * angularDecay, z: angularVelocity.z * angularDecay }, false)
      body.setTranslation({
        x: position.x + (x - position.x) * returnAmount,
        y: position.y + (y - position.y) * returnAmount,
        z: position.z + (z - position.z) * returnAmount,
      }, false)
      rotation.slerp(targetRotation, returnAmount)
      body.setRotation({ x: rotation.x, y: rotation.y, z: rotation.z, w: rotation.w }, false)
      const quiet = distance < balloon.scale * 0.08 && angle < 0.05
        && Math.hypot(velocity.x, velocity.y, velocity.z) < 0.025
        && Math.hypot(angularVelocity.x, angularVelocity.y, angularVelocity.z) < 0.05
      const quietTime = quiet ? (quietTimes.current.get(balloon.id) || 0) + dt : 0
      quietTimes.current.set(balloon.id, quietTime)
      if (quietTime > 0.35) {
        body.setTranslation({ x, y, z }, false)
        body.setRotation({ x: targetRotation.x, y: targetRotation.y, z: targetRotation.z, w: targetRotation.w }, false)
        body.sleep()
        quietTimes.current.delete(balloon.id)
      }
    }
  })
  return null
}

function PhotoDropzone({ src, onFile, large = false }) {
  const [dragOver, setDragOver] = useState(false)
  const input = useRef()
  const accept = (file) => { if (file?.type.startsWith('image/')) onFile(file) }
  return <div className={`photo-dropzone${dragOver ? ' is-dragover' : ''}${large ? ' is-large' : ''}`} role="button" tabIndex={0}
    onClick={(event) => { if (event.target !== input.current) input.current?.click() }}
    onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); input.current?.click() } }}
    onDragOver={(event) => { event.preventDefault(); setDragOver(true) }}
    onDragLeave={() => setDragOver(false)}
    onDrop={(event) => { event.preventDefault(); setDragOver(false); accept(event.dataTransfer.files[0]) }}>
    <input ref={input} type="file" accept="image/*" onChange={(event) => { accept(event.target.files?.[0]); event.target.value = '' }} />
    {src && <img src={src} alt="Photo used for balloon colors" />}
    <div><strong>{large ? 'Drop your photo here' : 'Upload another photo'}</strong><span>or click to choose an image</span></div>
  </div>
}

function CameraRig({ mode, idle }) {
  const { camera, gl } = useThree()
  const pointer = useRef(new THREE.Vector2())
  const target = useRef(new THREE.Vector2())
  useEffect(() => {
    camera.up.set(0, 1, 0)
    camera.updateProjectionMatrix()
  }, [camera, mode])
  useEffect(() => {
    const move = (event) => {
      if (mode !== 'Pointer tilt') return
      const rect = gl.domElement.getBoundingClientRect()
      pointer.current.set(((event.clientX - rect.left) / rect.width) * 2 - 1, 1 - ((event.clientY - rect.top) / rect.height) * 2)
    }
    gl.domElement.addEventListener('pointermove', move)
    return () => gl.domElement.removeEventListener('pointermove', move)
  }, [mode, gl])
  useFrame(({ clock }) => {
    if (mode !== 'Pointer tilt') return
    target.current.x = THREE.MathUtils.lerp(target.current.x, idle ? Math.sin(clock.elapsedTime * 0.18) * 0.25 : pointer.current.x, 0.045)
    target.current.y = THREE.MathUtils.lerp(target.current.y, idle ? Math.cos(clock.elapsedTime * 0.14) * 0.12 : pointer.current.y, 0.045)
    camera.position.set(0, 1.35, 2)
    camera.lookAt(target.current.x * 0.8, 3.1 + target.current.y * 0.9, 0)
  })
  return null
}

function CameraControls({ mode, idle }) {
  return <>
    <CameraRig mode={idle ? 'Pointer tilt' : mode} idle={idle} />
    {!idle && mode === 'Orbit' && <OrbitControls target={[0, 2.6, 0]} enablePan minDistance={0.25} maxDistance={8} minPolarAngle={0.05} maxPolarAngle={Math.PI - 0.05} />}
  </>
}

function UpwardShadowLight({ intensity, shadows, mapSize }) {
  const target = useMemo(() => {
    const object = new THREE.Object3D()
    object.position.set(0, 3.1, 0)
    return object
  }, [])
  return <>
    <primitive object={target} />
    <directionalLight key={mapSize} target={target} position={[0, 0.15, 0]} intensity={intensity} castShadow={shadows}
      shadow-mapSize={[mapSize, mapSize]} shadow-camera-left={-3.5} shadow-camera-right={3.5}
      shadow-camera-top={3.5} shadow-camera-bottom={-3.5} shadow-camera-near={0.1} shadow-camera-far={6}
      shadow-bias={-0.0002} shadow-normalBias={0.01} />
  </>
}

function RendererSettings({ exposure, shadows }) {
  const { gl } = useThree()
  useEffect(() => {
    gl.toneMappingExposure = exposure
    gl.shadowMap.enabled = shadows
    gl.shadowMap.needsUpdate = true
  }, [gl, exposure, shadows])
  return null
}

function ReflectionProbe({ children, resolution, refreshSeconds, live, visualRegistry }) {
  const { fbo, camera: probeCamera, update } = useCubeCamera({ resolution, near: 0.1, far: 24 })
  const captured = useRef(false)
  const wasLive = useRef(false)
  const lastCapture = useRef(0)
  useEffect(() => { probeCamera.position.set(0, 1.25, 0); captured.current = false }, [probeCamera, resolution])
  useFrame(({ clock }) => {
    const justFinished = live && !wasLive.current
    wasLive.current = live
    if (!captured.current || justFinished || (live && refreshSeconds > 0 && clock.elapsedTime - lastCapture.current >= refreshSeconds)) {
      // Capture the room without feeding the probe's own balloon reflections back into it.
      const hidden = []
      visualRegistry.current.forEach(({ balloon, ribbon }) => {
        for (const mesh of [balloon.current, ribbon.current]) {
          if (mesh?.visible) { mesh.visible = false; hidden.push(mesh) }
        }
      })
      try { update() } finally { for (const mesh of hidden) mesh.visible = true }
      captured.current = true
      lastCapture.current = clock.elapsedTime
    }
  })
  return <ReflectionMapContext.Provider value={fbo.texture}>
    <primitive object={probeCamera} />
    {children}
  </ReflectionMapContext.Provider>
}

function Roof({ debug, onGeometry }) {
  const { scene, nodes } = useGLTF(ROOF_URL)
  const geometryReported = useRef(false)
  const view = useMemo(() => {
    const clone = scene.clone(true)
    const ceilingMesh = clone.getObjectByName('ceiling')
    if (ceilingMesh) {
      ceilingMesh.visible = debug
      ceilingMesh.receiveShadow = false
    }
    const modelMesh = clone.getObjectByName('model')
    if (modelMesh) modelMesh.receiveShadow = true
    if (debug) clone.traverse((object) => {
      if (!object.isMesh) return
      const wireframe = (material) => { const copy = material.clone(); copy.wireframe = true; return copy }
      object.material = Array.isArray(object.material) ? object.material.map(wireframe) : wireframe(object.material)
    })
    return clone
  }, [scene, debug])
  const ceiling = nodes.ceiling
  const collisionGeometry = useMemo(() => {
    const geometry = ceiling.geometry.clone()
    if (geometry.index) {
      const indices = geometry.index.array.slice()
      for (let i = 0; i < indices.length; i += 3) [indices[i + 1], indices[i + 2]] = [indices[i + 2], indices[i + 1]]
      geometry.setIndex(new THREE.BufferAttribute(indices, 1))
    } else {
      const indexed = geometry.toNonIndexed()
      const position = indexed.attributes.position
      const normal = indexed.attributes.normal
      for (let i = 0; i < position.count; i += 3) {
        for (const attribute of Object.values(indexed.attributes)) {
          const values = attribute.array.slice(i * attribute.itemSize, (i + 3) * attribute.itemSize)
          for (let component = 0; component < attribute.itemSize; component++) {
            attribute.array[(i + 1) * attribute.itemSize + component] = values[2 * attribute.itemSize + component]
            attribute.array[(i + 2) * attribute.itemSize + component] = values[attribute.itemSize + component]
          }
        }
      }
      if (normal) normal.array.forEach((value, i) => { normal.array[i] = -value })
      geometry.dispose()
      return indexed
    }
    if (geometry.attributes.normal) geometry.attributes.normal.array.forEach((value, i, array) => { array[i] = -value })
    return geometry
  }, [ceiling.geometry])
  useEffect(() => {
    if (!onGeometry || geometryReported.current) return
    geometryReported.current = true
    const vertices = new Float32Array(collisionGeometry.attributes.position.array)
    const indices = collisionGeometry.index
      ? Uint32Array.from(collisionGeometry.index.array)
      : Uint32Array.from({ length: collisionGeometry.attributes.position.count }, (_, index) => index)
    onGeometry({ vertices, indices, ceilingPosition: ceiling.position.toArray() })
  }, [ceiling, collisionGeometry, onGeometry])
  return <>
    <primitive object={view} />
    <RigidBody type="fixed" colliders={false}>
      <MeshCollider type="trimesh">
        <mesh geometry={collisionGeometry} position={ceiling.position} rotation={ceiling.rotation} scale={ceiling.scale}>
          <meshBasicMaterial transparent opacity={0} colorWrite={false} />
        </mesh>
      </MeshCollider>
    </RigidBody>
  </>
}

function BalloonRibbon({ body, id, scale, restColor, mesh, initialVisible, reflectionStrength }) {
  const wasVisible = useRef(true)
  const reflectionMap = useContext(ReflectionMapContext)
  const ribbon = useMemo(() => {
    const random = (seed) => {
      const value = Math.sin((id + 1) * seed) * 43758.5453
      return value - Math.floor(value)
    }
    const segments = 10 + Math.floor((((id * 0.754877666) % 1) + 1) % 1 * 11)
    const points = Array.from({ length: segments + 1 }, () => new THREE.Vector3())
    const previous = points.map((point) => point.clone())
    const positions = new Float32Array((segments + 1) * 2 * 3)
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    const indices = []
    for (let i = 0; i < segments; i++) {
      const a = i * 2
      indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2)
    }
    geometry.setIndex(indices)
    return {
      segments, points, previous, geometry, initialized: false,
      length: (0.42 + random(13.37) * 0.24) * (scale / 0.12),
      curlX: (0.014 + random(29.43) * 0.022) * (random(41.17) < 0.5 ? -1 : 1),
      curlZ: (0.012 + random(53.29) * 0.022) * (random(67.83) < 0.5 ? -1 : 1),
      phase: random(73.91) * Math.PI * 2,
      swayRate: 0.6 + random(89.57) * 1.25,
      damping: 0.975 + random(97.13) * 0.018,
      rotation: new THREE.Quaternion(), anchor: new THREE.Vector3(), translation: new THREE.Vector3(),
      cameraDirection: new THREE.Vector3(), tangent: new THREE.Vector3(), side: new THREE.Vector3(),
    }
  }, [id, scale])
  const material = useMemo(() => new THREE.MeshPhysicalMaterial({
    color: restColor ? new THREE.Color(restColor) : new THREE.Color().setHSL((id * 0.61803398875) % 1, 0.9, 0.5), metalness: 0.48, roughness: 0.18,
    clearcoat: 1, clearcoatRoughness: 0.12, envMap: reflectionMap, envMapIntensity: reflectionStrength * 1.12,
    side: THREE.DoubleSide,
  }), [id, reflectionMap, restColor])
  useEffect(() => { material.envMapIntensity = reflectionStrength * 1.12 }, [material, reflectionStrength])

  useFrame((state, dt) => {
    const rigidBody = body.current
    if (!rigidBody || !mesh.current) return
    if (!mesh.current.visible) { wasVisible.current = false; return }
    if (!wasVisible.current) { ribbon.initialized = false; wasVisible.current = true }
    const { segments, points, previous, length, geometry, curlX, curlZ, phase, swayRate, damping } = ribbon
    const rotation = rigidBody.rotation()
    const translation = rigidBody.translation()
    ribbon.rotation.set(rotation.x, rotation.y, rotation.z, rotation.w)
    ribbon.translation.set(translation.x, translation.y, translation.z)
    const anchor = ribbon.anchor.set(0, scale * 0.09, 0).applyQuaternion(ribbon.rotation).add(ribbon.translation)
    if (!ribbon.initialized) {
      for (let i = 0; i <= segments; i++) {
        const t = i / segments
        const curl = Math.max(0, (t - 0.72) / 0.28)
        points[i].set(anchor.x + Math.sin(curl * Math.PI * 1.5) * curlX, anchor.y - length * t, anchor.z + (1 - Math.cos(curl * Math.PI * 1.5)) * curlZ)
        previous[i].copy(points[i])
      }
      ribbon.initialized = true
    }

    const step = Math.min(dt, 1 / 30)
    const elapsed = state.clock.elapsedTime
    const breezeX = Math.sin(elapsed * swayRate + phase) * 0.45 + Math.sin(elapsed * swayRate * 1.73 + phase * 1.4) * 0.15
    const breezeZ = Math.cos(elapsed * swayRate * 0.83 + phase * 1.7) * 0.36
    for (let i = 1; i <= segments; i++) {
      const point = points[i]
      const velocityX = (point.x - previous[i].x) * damping
      const velocityY = (point.y - previous[i].y) * damping
      const velocityZ = (point.z - previous[i].z) * damping
      previous[i].copy(point)
      const t = i / segments
      const curl = Math.max(0, (t - 0.72) / 0.28)
      point.x += velocityX + breezeX * step * step * t
      point.y += velocityY - 1.5 * step * step
      point.z += velocityZ + breezeZ * step * step * t
      point.x += (anchor.x + Math.sin(curl * Math.PI * 1.5) * curlX - point.x) * curl * step * 1.5
      point.z += (anchor.z + (1 - Math.cos(curl * Math.PI * 1.5)) * curlZ - point.z) * curl * step * 1.5
    }

    const segmentLength = length / segments
    for (let iteration = 0; iteration < 5; iteration++) {
      points[0].copy(anchor)
      for (let i = 0; i < segments; i++) {
        const first = points[i], second = points[i + 1]
        const dx = second.x - first.x, dy = second.y - first.y, dz = second.z - first.z
        const distance = Math.max(Math.hypot(dx, dy, dz), 1e-6)
        const correction = (distance - segmentLength) / distance
        if (i === 0) {
          second.x -= dx * correction; second.y -= dy * correction; second.z -= dz * correction
        }
        else {
          const half = correction * 0.5
          first.x += dx * half; first.y += dy * half; first.z += dz * half
          second.x -= dx * half; second.y -= dy * half; second.z -= dz * half
        }
      }
    }

    const cameraDirection = state.camera.getWorldDirection(ribbon.cameraDirection)
    const vertices = geometry.attributes.position
    for (let i = 0; i <= segments; i++) {
      const tangent = ribbon.tangent.subVectors(points[Math.min(i + 1, segments)], points[Math.max(i - 1, 0)]).normalize()
      const side = ribbon.side.copy(tangent).cross(cameraDirection).normalize()
      if (side.lengthSq() < 1e-5) side.set(1, 0, 0)
      const taper = 0.0015 * (scale / 0.12) * (1 - Math.max(0, i / segments - 0.8) * 2)
      vertices.setXYZ(i * 2, points[i].x - side.x * taper, points[i].y - side.y * taper, points[i].z - side.z * taper)
      vertices.setXYZ(i * 2 + 1, points[i].x + side.x * taper, points[i].y + side.y * taper, points[i].z + side.z * taper)
    }
    vertices.needsUpdate = true
    geometry.computeVertexNormals()
  })

  useEffect(() => () => ribbon.geometry.dispose(), [ribbon])
  useEffect(() => () => material.dispose(), [material])
  return <mesh ref={mesh} geometry={ribbon.geometry} material={material} visible={initialVisible} frustumCulled={false} />
}

function Balloon({ id, position, scale, balloonGeometry, balloonOffset, debug, friction, bodyRegistry, visualRegistry, restColor, restPosition, playbackActive, initialVisible, reflectionStrength }) {
  const body = useRef()
  const balloonMesh = useRef()
  const ribbonMesh = useRef()
  useEffect(() => {
    bodyRegistry.current.set(id, body)
    visualRegistry.current.set(id, { balloon: balloonMesh, ribbon: ribbonMesh })
    return () => { bodyRegistry.current.delete(id); visualRegistry.current.delete(id) }
  }, [bodyRegistry, visualRegistry, id])
  const reflectionMap = useContext(ReflectionMapContext)
  const material = useMemo(() => new THREE.MeshPhysicalMaterial({
    color: restColor ? new THREE.Color(restColor) : new THREE.Color().setHSL((id * 0.61803398875) % 1, 0.92, 0.5),
    roughness: 0.2,
    metalness: 0.04,
    clearcoat: 1,
    clearcoatRoughness: 0.08,
    envMap: reflectionMap,
    envMapIntensity: reflectionStrength,
    wireframe: debug,
  }), [id, debug, reflectionMap, restColor])
  const shadowFade = useMemo(() => ({ value: 0 }), [])
  const depthMaterial = useMemo(() => {
    const depth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking })
    depth.onBeforeCompile = (shader) => {
      shader.uniforms.balloonShadowOpacity = shadowFade
      shader.fragmentShader = 'uniform float balloonShadowOpacity;\n' + shader.fragmentShader
      shader.fragmentShader = shader.fragmentShader.replace('#include <clipping_planes_fragment>', `
        #include <clipping_planes_fragment>
        float shadowThreshold = fract(dot(floor(gl_FragCoord.xy), vec2(0.754877666, 0.569840296)));
        if (balloonShadowOpacity <= shadowThreshold) discard;
      `)
    }
    depth.customProgramCacheKey = () => 'balloon-shadow-fade-v1'
    return depth
  }, [shadowFade])
  useEffect(() => { material.envMapIntensity = reflectionStrength }, [material, reflectionStrength])
  useEffect(() => () => material.dispose(), [material])
  useEffect(() => () => depthMaterial.dispose(), [depthMaterial])
  useFrame(() => {
    if (!body.current) return
    if (balloonMesh.current) {
      const gap = restPosition ? Math.max(0, restPosition[1] - body.current.translation().y) : Infinity
      shadowFade.value = 1 - THREE.MathUtils.smoothstep(gap, scale * 1.5, scale * 10)
      balloonMesh.current.castShadow = balloonMesh.current.visible && shadowFade.value > 0.001
    }
    if (playbackActive || initialVisible || body.current.isSleeping()) return

    // Gently torque the balloon's local up axis back toward world up.
    const rotation = body.current.rotation()
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(new THREE.Quaternion(rotation.x, rotation.y, rotation.z, rotation.w))
    const correction = up.clone().cross(new THREE.Vector3(0, 1, 0))
    const angularVelocity = body.current.angvel()
    const linearVelocity = body.current.linvel()
    const maxLinearSpeed = 3.5
    const maxAngularSpeed = 4
    const linearSpeed = Math.hypot(linearVelocity.x, linearVelocity.y, linearVelocity.z)
    const angularSpeed = Math.hypot(angularVelocity.x, angularVelocity.y, angularVelocity.z)
    if (linearSpeed > maxLinearSpeed) {
      const scaleVelocity = maxLinearSpeed / linearSpeed
      body.current.setLinvel({ x: linearVelocity.x * scaleVelocity, y: linearVelocity.y * scaleVelocity, z: linearVelocity.z * scaleVelocity }, true)
    }
    if (angularSpeed > maxAngularSpeed) {
      const scaleVelocity = maxAngularSpeed / angularSpeed
      body.current.setAngvel({ x: angularVelocity.x * scaleVelocity, y: angularVelocity.y * scaleVelocity, z: angularVelocity.z * scaleVelocity }, true)
    }
    if (correction.lengthSq() > 0.0016 || angularVelocity.x ** 2 + angularVelocity.y ** 2 + angularVelocity.z ** 2 > 0.0004) {
      body.current.addTorque({
        x: correction.x * 0.000006 - angularVelocity.x * 0.000004,
        y: -angularVelocity.y * 0.000004,
        z: correction.z * 0.000006 - angularVelocity.z * 0.000004,
      }, true)
    }
  })
  return <>
    <RigidBody ref={body} colliders={false} position={position} enabledRotations={[true, true, true]} gravityScale={initialVisible ? 0 : 1} linearDamping={initialVisible ? 1.5 : 0.2} angularDamping={initialVisible ? 2 : 0.65} restitution={initialVisible ? 0 : 0.2} friction={friction}>
      <BallCollider args={[scale]} density={0.22} />
      <BallCollider args={[scale * 0.13]} position={[0, -scale * 1.18, 0]} density={8} />
      <mesh ref={balloonMesh} geometry={balloonGeometry} position={[balloonOffset.x * scale, balloonOffset.y * scale, balloonOffset.z * scale]} scale={scale} material={material} customDepthMaterial={depthMaterial} visible={initialVisible} castShadow={false} receiveShadow />
    </RigidBody>
    <BalloonRibbon body={body} id={id} scale={scale} restColor={restColor} mesh={ribbonMesh} initialVisible={initialVisible} reflectionStrength={reflectionStrength} />
  </>
}

function Balloons({ settings, balloons, bodyRegistry, visualRegistry, playbackActive, initialVisible, reflectionStrength }) {
  const { nodes } = useGLTF(BALLOON_URL)
  const geometry = nodes.Sphere.geometry
  return balloons.map((balloon) => <Balloon key={balloon.id} {...balloon} balloonGeometry={geometry} balloonOffset={nodes.Sphere.position} debug={settings.debugPhysics} friction={settings.friction} bodyRegistry={bodyRegistry} visualRegistry={visualRegistry} playbackActive={playbackActive} initialVisible={initialVisible} reflectionStrength={reflectionStrength} />)
}

function CeilingDepthOfField({ settings }) {
  const effect = useRef()
  const { scene, nodes } = useGLTF(ROOF_URL)
  const probe = useMemo(() => {
    scene.updateMatrixWorld(true)
    // Use the hidden ceiling's geometry and world transform without rendering it.
    const mesh = new THREE.Mesh(nodes.ceiling.geometry, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }))
    mesh.matrixAutoUpdate = false
    mesh.matrix.copy(nodes.ceiling.matrixWorld)
    mesh.updateMatrixWorld(true)
    return mesh
  }, [scene, nodes.ceiling])
  const raycaster = useMemo(() => new THREE.Raycaster(), [])
  const center = useMemo(() => new THREE.Vector2(0, 0), [])
  const tracking = useRef({
    matrix: new THREE.Matrix4(), projection: new THREE.Matrix4(),
    effect: null, focus: settings.focusDistance, initialized: false,
  })
  useEffect(() => () => probe.material.dispose(), [probe])
  useEffect(() => { tracking.current.initialized = false }, [settings.autoFocus])
  useFrame(({ camera }, dt) => {
    if (!settings.autoFocus || !effect.current) return
    camera.updateWorldMatrix(true, false)
    const state = tracking.current
    const freshEffect = state.effect !== effect.current
    if (!state.initialized || freshEffect || !state.matrix.equals(camera.matrixWorld) || !state.projection.equals(camera.projectionMatrix)) {
      raycaster.setFromCamera(center, camera)
      const hit = raycaster.intersectObject(probe, false)[0]
      if (hit) state.focus = effect.current.calculateFocusDistance(hit.point)
      else if (!state.initialized) state.focus = settings.focusDistance
      state.matrix.copy(camera.matrixWorld)
      state.projection.copy(camera.projectionMatrix)
      state.effect = effect.current
      if (!state.initialized || freshEffect) effect.current.cocMaterial.focusDistance = state.focus
      state.initialized = true
    }
    // Smooth focus changes, keeping the last ceiling hit when the view misses it.
    const material = effect.current.cocMaterial
    material.focusDistance = THREE.MathUtils.lerp(material.focusDistance, state.focus, 1 - Math.exp(-8 * dt))
  })
  return <DepthOfField ref={effect} focusDistance={settings.focusDistance} focusRange={settings.focusRange} bokehScale={settings.blurStrength} height={settings.effectResolution} />
}

function Scene({ settings, rendering, postEffects, balloons, bodyRegistry, visualRegistry, phase, onRoofGeometry, playbackFrames, onPlaybackComplete }) {
  const { gl } = useThree()
  const playing = phase === 'playing'
  return <>
    <RendererSettings exposure={rendering.exposure} shadows={rendering.shadows} />
    <PointerBalloonForce bodyRegistry={bodyRegistry} gl={gl} enabled={phase === 'finished'} />
    <ambientLight intensity={rendering.ambientLight} />
    <directionalLight position={[4, 7, 5]} intensity={rendering.keyLight} />
    <UpwardShadowLight intensity={rendering.uplight} shadows={rendering.shadows} mapSize={rendering.shadowQuality} />
    <Environment files={VENICE_SUNSET_HDR} background backgroundBlurriness={rendering.backgroundBlur} />
    <ReflectionProbe resolution={rendering.reflectionQuality} refreshSeconds={rendering.reflectionRefresh} live={phase === 'finished'} visualRegistry={visualRegistry}>
      <Physics gravity={[0, settings.lift, 0]} timeStep="vary" paused={phase !== 'finished'} interpolate debug={settings.debugPhysics}>
        <BalloonReturnMotion balloons={balloons} bodyRegistry={bodyRegistry} enabled={phase === 'finished'} />
        <Roof debug={settings.debugPhysics} onGeometry={onRoofGeometry} />
        <Balloons settings={settings} balloons={balloons} bodyRegistry={bodyRegistry} visualRegistry={visualRegistry} playbackActive={playing} initialVisible={phase === 'finished'} reflectionStrength={rendering.reflectionStrength} />
      </Physics>
    </ReflectionProbe>
    <PlaybackRunner playing={playing} frames={playbackFrames} bodyRegistry={bodyRegistry} visualRegistry={visualRegistry} onComplete={onPlaybackComplete} />
    <CameraControls mode={settings.cameraMode} idle={phase === 'upload' || phase === 'preparing'} />
    {postEffects.enabled && (playing || phase === 'finished') && <EffectComposer multisampling={0} enableNormalPass={false}>
      <CeilingDepthOfField settings={postEffects} />
      <ToneMapping mode={ToneMappingMode.ACES_FILMIC} />
    </EffectComposer>}
  </>
}

export default function App() {
  const [initialShare] = useState(() => {
    try { return readShareParams(window.location.search) }
    catch { return { error: 'This share link could not be opened. Choose an image to start again.' } }
  })
  const [seed] = useState(() => initialShare?.seed ?? crypto.getRandomValues(new Uint32Array(1))[0])
  const initialSettings = SIMULATION_DEFAULTS
  const [toolsVisible, setToolsVisible] = useState(false)
  const [shareUrl, setShareUrl] = useState('')
  const [shareStatus, setShareStatus] = useState('')
  const [balloons, setBalloons] = useState([])
  const [imageSelection, setImageSelection] = useState(null)
  const [imageSamples, setImageSamples] = useState([])
  const [phase, setPhase] = useState('upload')
  const [uploadError, setUploadError] = useState('')
  const [playbackFrames, setPlaybackFrames] = useState([])
  const [simulation, setSimulation] = useState(null)
  const [simulationError, setSimulationError] = useState('')
  const [roofGeometry, setRoofGeometry] = useState(null)
  const phaseRef = useRef(phase)
  phaseRef.current = phase
  const bodyRegistry = useRef(new Map())
  const visualRegistry = useRef(new Map())
  const roofGeometryRef = useRef(null)
  const uploadedUrl = useRef(null)
  const selectionId = useRef(0)
  const samplerCamera = useMemo(() => {
    const camera = new THREE.OrthographicCamera(-1.75, 1.75, 1.75, -1.75, 0.01, 10)
    camera.position.set(0, 0, 0)
    camera.up.set(0, 0, 1)
    camera.lookAt(0, 1, 0)
    camera.updateProjectionMatrix()
    camera.updateMatrixWorld(true)
    return camera
  }, [])
  const [settings, set] = useControls('Simulation', () => ({
    lift: { value: initialSettings.lift, min: 0.1, max: 8, step: 0.1, label: 'Upward gravity' },
    releaseInterval: { value: initialSettings.releaseInterval, min: 0.01, max: 0.025, step: 0.001, label: 'Release rate (seconds)' },
    maxBalloons: { value: initialSettings.maxBalloons, min: 5, max: MAX_BALLOONS, step: 5, label: 'Balloon limit' },
    spawnRadius: { value: initialSettings.spawnRadius, min: 0.2, max: 2.8, step: 0.05, label: 'Spawn radius' },
    spawnHeight: { value: initialSettings.spawnHeight, min: -0.5, max: 1.8, step: 0.1, label: 'Spawn height' },
    balloonSize: { value: initialSettings.balloonSize, min: 0.025, max: 0.17, step: 0.005, label: 'Balloon size' },
    friction: { value: initialSettings.friction, min: 0, max: 2, step: 0.05, label: 'Balloon friction' },
    debugPhysics: { value: false, label: 'Wireframe + physics debug' },
    cameraMode: { value: 'Pointer tilt', options: ['Pointer tilt', 'Orbit'], label: 'Camera mode' },
  }), [])
  const [rendering] = useControls('Rendering', () => ({
    pixelRatio: { value: 0.75, min: 0.5, max: 1.5, step: 0.05, label: 'Pixel ratio' },
    exposure: { value: 0.95, min: 0.4, max: 2, step: 0.05, label: 'Exposure' },
    ambientLight: { value: 0.5, min: 0, max: 3, step: 0.1, label: 'Ambient light' },
    keyLight: { value: 3.4, min: 0, max: 5, step: 0.1, label: 'Directional light' },
    uplight: { value: 0.75, min: 0, max: 10, step: 0.25, label: 'Upward directional light' },
    backgroundBlur: { value: 0.06, min: 0, max: 0.8, step: 0.02, label: 'Background blur' },
    shadows: { value: true, label: 'Balloon shadows' },
    shadowQuality: { value: 512, options: { Low: 512, Medium: 1024, High: 2048 }, label: 'Shadow quality' },
    reflectionStrength: { value: 1.05, min: 0, max: 3, step: 0.05, label: 'Reflection strength' },
    reflectionQuality: { value: 32, options: { Low: 32, Medium: 64, High: 128 }, label: 'Reflection quality' },
    reflectionRefresh: { value: 2, options: { 'At rest only': 0, 'Every 5 seconds': 5, 'Every 2 seconds': 2 }, label: 'Live reflections' },
  }), [])
  const [postEffects] = useControls('Depth of field', () => ({
    enabled: { value: true, label: 'Enable DOF' },
    autoFocus: { value: true, label: 'Auto focus ceiling' },
    focusDistance: { value: 2.65, min: 0.2, max: 8, step: 0.05, label: 'Focus distance' },
    focusRange: { value: 1.6, min: 0.1, max: 5, step: 0.05, label: 'Focus range' },
    blurStrength: { value: 2, min: 0, max: 8, step: 0.1, label: 'Blur strength' },
    effectResolution: { value: 360, options: { Low: 360, Medium: 540, High: 720 }, label: 'DOF quality' },
  }), [])
  const onRoofGeometry = useCallback((geometry) => {
    if (roofGeometryRef.current) return
    roofGeometryRef.current = geometry
    setRoofGeometry(geometry)
  }, [])
  useEffect(() => {
    if (!roofGeometry) return
    const worker = new Worker(new URL('./simulation.worker.js', import.meta.url), { type: 'module' })
    setSimulation(null)
    setSimulationError('')
    worker.onmessage = ({ data }) => {
      if (data.type === 'complete') {
        setSimulation({ balloons: data.balloons, frames: data.frames })
        if (phaseRef.current === 'upload' || phaseRef.current === 'preparing') setBalloons(data.balloons)
      }
      if (data.type === 'error') setSimulationError(data.message)
    }
    worker.onerror = (error) => setSimulationError(error.message || 'The balloon simulation could not be prepared.')
    worker.postMessage({ type: 'simulate', ...roofGeometry, settings: {
      seed,
      lift: settings.lift,
      releaseInterval: settings.releaseInterval,
      maxBalloons: settings.maxBalloons,
      spawnRadius: settings.spawnRadius,
      spawnHeight: settings.spawnHeight,
      balloonSize: settings.balloonSize,
      friction: settings.friction,
    } })
    return () => worker.terminate()
  }, [seed, roofGeometry, settings.lift, settings.releaseInterval, settings.maxBalloons, settings.spawnRadius, settings.spawnHeight, settings.balloonSize, settings.friction])
  useEffect(() => {
    if (!imageSelection) return
    if (imageSelection.samples) { setImageSamples(quantizeSamples(imageSelection.samples)); return }
    let cancelled = false
    const image = new Image()
    image.onload = () => {
      if (cancelled) return
      const canvas = document.createElement('canvas')
      canvas.width = SAMPLE_GRID
      canvas.height = SAMPLE_GRID
      const context = canvas.getContext('2d', { willReadFrequently: true })
      if (!context) { setUploadError('This image could not be read.'); setPhase('upload'); return }
      const side = Math.min(image.naturalWidth, image.naturalHeight)
      const sx = (image.naturalWidth - side) / 2
      const sy = (image.naturalHeight - side) / 2
      context.imageSmoothingEnabled = true
      context.imageSmoothingQuality = 'high'
      context.drawImage(image, sx, sy, side, side, 0, 0, SAMPLE_GRID, SAMPLE_GRID)
      const pixels = context.getImageData(0, 0, SAMPLE_GRID, SAMPLE_GRID).data
      const samples = []
      for (let offset = 0; offset < pixels.length; offset += 4) {
        const hex = (value) => value.toString(16).padStart(2, '0')
        samples.push(`#${hex(pixels[offset])}${hex(pixels[offset + 1])}${hex(pixels[offset + 2])}`)
      }
      setImageSamples(quantizeSamples(samples))
    }
    image.onerror = () => { if (!cancelled) { setUploadError('This image could not be opened.'); setPhase('upload') } }
    image.src = imageSelection.src
    return () => { cancelled = true }
  }, [imageSelection])
  useEffect(() => {
    if (initialShare?.error) { setUploadError(initialShare.error); return }
    if (!initialShare?.image) return
    let cancelled = false
    decodeSamples(initialShare.image).then(samples => {
      if (cancelled) return
      setImageSelection({ src: samplesPreview(samples), samples, id: ++selectionId.current })
      setPhase('preparing')
    }).catch(() => {
      if (!cancelled) setUploadError('This share link could not be opened. Choose an image to start again.')
    })
    return () => { cancelled = true }
  }, [initialShare])
  useEffect(() => {
    setShareUrl('')
    setShareStatus('')
    if (imageSamples.length !== SAMPLE_GRID * SAMPLE_GRID) return
    let cancelled = false
    encodeSamples(imageSamples).then(encoded => {
      if (cancelled) return
      const url = new URL(window.location.href)
      url.searchParams.set('image', encoded)
      url.searchParams.set('seed', String(seed))
      url.searchParams.delete('sim')
      window.history.replaceState(window.history.state, '', url)
      setShareUrl(url.href)
    }).catch(() => { if (!cancelled) setShareStatus('Could not create the share link.') })
    return () => { cancelled = true }
  }, [imageSamples, seed])
  useEffect(() => {
    if (shareStatus !== 'Copied!') return
    const timer = window.setTimeout(() => setShareStatus(''), 2500)
    return () => window.clearTimeout(timer)
  }, [shareStatus])
  const copyShareLink = async () => {
    try {
      await navigator.clipboard.writeText(shareUrl)
      setShareStatus('Copied!')
    } catch {
      const field = document.createElement('textarea')
      field.value = shareUrl
      field.style.cssText = 'position:fixed;left:-9999px;top:0;'
      document.body.appendChild(field)
      field.select()
      const copied = document.execCommand('copy')
      field.remove()
      setShareStatus(copied ? 'Copied!' : 'Could not copy. Copy the URL from your address bar.')
    }
  }
  useEffect(() => () => { if (uploadedUrl.current) URL.revokeObjectURL(uploadedUrl.current) }, [])
  const selectImage = (src) => {
    setUploadError('')
    setShareUrl('')
    setShareStatus('')
    setImageSamples([])
    setPhase('preparing')
    setImageSelection({ src, id: ++selectionId.current })
  }
  const handleImageFile = (file) => {
    if (!file?.type.startsWith('image/')) return
    if (uploadedUrl.current) URL.revokeObjectURL(uploadedUrl.current)
    uploadedUrl.current = URL.createObjectURL(file)
    selectImage(uploadedUrl.current)
  }
  useEffect(() => {
    const handleKey = (event) => {
      if (event.code === 'F1') {
        event.preventDefault()
        if (!event.repeat) setToolsVisible(visible => !visible)
        return
      }
      if (event.repeat || event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return
      if (event.code === 'KeyC') set({ cameraMode: settings.cameraMode === 'Orbit' ? 'Pointer tilt' : 'Orbit' })
      if (event.code === 'KeyD') set({ debugPhysics: !settings.debugPhysics })
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [set, settings.cameraMode, settings.debugPhysics])
  useEffect(() => {
    if (phase !== 'preparing' || !simulation || imageSamples.length !== SAMPLE_GRID * SAMPLE_GRID || !imageSelection) return
    const finalPoses = simulation.frames[simulation.frames.length - 1].poses
    const finalById = new Map()
    for (let offset = 0; offset < finalPoses.length; offset += 8) {
      finalById.set(finalPoses[offset], { position: Array.from(finalPoses.slice(offset + 1, offset + 4)), rotation: Array.from(finalPoses.slice(offset + 4, offset + 8)) })
    }
    setBalloons(simulation.balloons.map((balloon) => {
      const pose = finalById.get(balloon.id)
      if (!pose) return balloon
      const { position, rotation } = pose
      const projected = new THREE.Vector3(...position).project(samplerCamera)
      const column = THREE.MathUtils.clamp(Math.floor((projected.x + 1) * SAMPLE_GRID / 2), 0, SAMPLE_GRID - 1)
      const row = THREE.MathUtils.clamp(Math.floor((1 - projected.y) * SAMPLE_GRID / 2), 0, SAMPLE_GRID - 1)
      return { ...balloon, restPosition: position, restRotation: rotation, restColor: imageSamples[row * SAMPLE_GRID + column] }
    }))
    setPlaybackFrames(simulation.frames)
    setPhase('playing')
  }, [phase, imageSamples, imageSelection, samplerCamera, simulation])
  const finishPlayback = () => {
    bodyRegistry.current.forEach((bodyRef) => bodyRef.current?.sleep())
    setPhase('finished')
  }
  return <main className="app-shell">
    <div className="site-title">balloon art</div>
    <Canvas shadows={rendering.shadows} frameloop="always" camera={{ position: [0, 1.35, 2], fov: 62 }} dpr={rendering.pixelRatio} gl={{ antialias: true, powerPreference: 'high-performance' }} style={{ cursor: phase === 'finished' ? 'grab' : 'default' }}>
      <Scene settings={settings} rendering={rendering} postEffects={postEffects} balloons={balloons} bodyRegistry={bodyRegistry} visualRegistry={visualRegistry} phase={phase} onRoofGeometry={onRoofGeometry} playbackFrames={playbackFrames} onPlaybackComplete={finishPlayback} />
    </Canvas>
    {phase === 'upload' && <div className="experience-gate">
      <div className="experience-card">
        <h1>Create Balloon Art</h1>
        <PhotoDropzone large onFile={handleImageFile} />
        {uploadError && <div className="upload-error" role="alert">{uploadError}</div>}
        <button className="sample-image" onClick={() => selectImage(CAT_SAMPLER_IMAGE)}><img src={CAT_SAMPLER_IMAGE} alt="" />Try a sample photo</button>
      </div>
    </div>}
    {phase === 'preparing' && <div className="precompute-screen" role="status" aria-live="polite">
      <div className="precompute-card">
        {imageSelection?.src && <img src={imageSelection.src} alt="Selected photo" />}
        <div><h1>{simulationError ? 'Could not prepare the balloons' : 'Finishing the balloon paths'}</h1>
          <p>{simulationError || 'The show will begin automatically.'}</p></div>
        {!simulationError && <span className="loading-spinner" aria-hidden="true" />}
        {simulationError && <button className="replay-button" onClick={() => window.location.reload()}>Try again</button>}
      </div>
    </div>}
    {(phase === 'playing' || phase === 'finished') && <>
      <div className="photo-tools">
        <PhotoDropzone src={imageSelection?.src} onFile={handleImageFile} />
        <div className="action-links">
          <span className="share-link-wrap">
            <button className="action-link" disabled={!shareUrl} onClick={copyShareLink} aria-describedby={shareStatus === 'Copied!' ? 'share-copy-tooltip' : undefined}>Share</button>
            {shareStatus === 'Copied!' && <span id="share-copy-tooltip" className="share-copy-tooltip" role="tooltip" aria-live="polite">Link Copied to your clipboard</span>}
          </span>
          {phase === 'finished' && <button className="action-link" onClick={() => setPhase('playing')}>Watch again</button>}
          <button className="action-link camera-mode-toggle" aria-label={settings.cameraMode === 'Orbit' ? 'Switch to standard camera' : 'Switch to free camera'} onClick={() => set({ cameraMode: settings.cameraMode === 'Orbit' ? 'Pointer tilt' : 'Orbit' })}>
            <span className={settings.cameraMode !== 'Orbit' ? 'is-active' : ''}>Standard</span> / <span className={settings.cameraMode === 'Orbit' ? 'is-active' : ''}>Free camera</span>
          </button>
        </div>
        <span className="share-status" role="status">{shareStatus !== 'Copied!' ? shareStatus : ''}</span>
      </div>
    </>}
    <footer className="site-footer">
      <span>Another</span> <a href="https://github.com/DaveSeidman/balloon-art" target="_blank" rel="noopener noreferrer">Digital Stunt</a>
      <span> by </span><a href="https://daveseidman.com" target="_blank" rel="noopener noreferrer">Dave Seidman</a>
    </footer>
    <Leva hidden={!toolsVisible} collapsed={false} theme={{ sizes: { rootWidth: '360px', controlWidth: '180px' } }} titleBar={{ title: 'balloon art' }} />
  </main>
}

useGLTF.preload(ROOF_URL)
useGLTF.preload(BALLOON_URL)
