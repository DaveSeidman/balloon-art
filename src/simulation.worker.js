import * as RAPIER from '@dimforge/rapier3d-compat'

const STEP = 1 / 60
const CAPTURE_EVERY = 4
const MAX_ANIMATION_SECONDS = 30
const RELEASE_WINDOW_SECONDS = 20
const LOW_ACTIVITY_SECONDS = 0.6

function keepSpeed(body) {
  body.resetTorques(false)
  const linear = body.linvel()
  const linearSpeed = Math.hypot(linear.x, linear.y, linear.z)
  if (linearSpeed > 3.5) {
    const scale = 3.5 / linearSpeed
    body.setLinvel({ x: linear.x * scale, y: linear.y * scale, z: linear.z * scale }, true)
  }
  const angular = body.angvel()
  const angularSpeed = Math.hypot(angular.x, angular.y, angular.z)
  if (angularSpeed > 4) {
    const scale = 4 / angularSpeed
    body.setAngvel({ x: angular.x * scale, y: angular.y * scale, z: angular.z * scale }, true)
  }
  const q = body.rotation()
  const upX = 2 * (q.x * q.y - q.z * q.w)
  const upZ = 2 * (q.y * q.z + q.x * q.w)
  if (upX * upX + upZ * upZ > 0.0016 || angularSpeed > 0.02) {
    body.addTorque({
      x: -upZ * 0.000006 - angular.x * 0.000004,
      y: -angular.y * 0.000004,
      z: upX * 0.000006 - angular.z * 0.000004,
    }, true)
  }
}

function capture(bodies, time) {
  const poses = new Float32Array(bodies.length * 8)
  for (let i = 0; i < bodies.length; i++) {
    const { id, body } = bodies[i]
    const p = body.translation()
    const q = body.rotation()
    const offset = i * 8
    poses[offset] = id
    poses[offset + 1] = p.x
    poses[offset + 2] = p.y
    poses[offset + 3] = p.z
    poses[offset + 4] = q.x
    poses[offset + 5] = q.y
    poses[offset + 6] = q.z
    poses[offset + 7] = q.w
  }
  return { time, poses }
}

export async function simulate({ vertices, indices, ceilingPosition, settings }) {
  await RAPIER.init()
  const world = new RAPIER.World({ x: 0, y: settings.lift, z: 0 })
  world.timestep = STEP
  const roof = RAPIER.ColliderDesc.trimesh(vertices, indices)
  roof.setTranslation(...ceilingPosition)
  world.createCollider(roof)

  const bodies = []
  const balloons = []
  const frames = [capture(bodies, 0)]
  const releaseInterval = Math.min(settings.releaseInterval, RELEASE_WINDOW_SECONDS / settings.maxBalloons)
  let nextRelease = releaseInterval
  let settledFor = 0
  let lastReleaseTime = 0
  let ceilingTop = -Infinity
  for (let i = 1; i < vertices.length; i += 3) ceilingTop = Math.max(ceilingTop, vertices[i] + ceilingPosition[1])
  const maxSteps = Math.ceil(MAX_ANIMATION_SECONDS / STEP)

  for (let tick = 1; tick <= maxSteps; tick++) {
    const time = tick * STEP
    while (bodies.length < settings.maxBalloons && time + 1e-8 >= nextRelease) {
      const id = bodies.length
      const angle = Math.random() * Math.PI * 2
      const radius = Math.sqrt(Math.random()) * settings.spawnRadius
      const position = [Math.cos(angle) * radius, settings.spawnHeight, Math.sin(angle) * radius]
      const scale = settings.balloonSize
      const body = world.createRigidBody(
        RAPIER.RigidBodyDesc.dynamic()
          .setTranslation(...position)
          .setLinearDamping(0.2)
          .setAngularDamping(0.65),
      )
      world.createCollider(RAPIER.ColliderDesc.ball(scale).setDensity(0.22).setRestitution(0.2).setFriction(settings.friction), body)
      world.createCollider(RAPIER.ColliderDesc.ball(scale * 0.13).setTranslation(0, -scale * 1.18, 0).setDensity(8).setRestitution(0.2).setFriction(settings.friction), body)
      bodies.push({ id, body })
      balloons.push({ id, position, scale })
      lastReleaseTime = time
      nextRelease += releaseInterval
    }

    const allReleased = bodies.length >= settings.maxBalloons
    if (tick % 15 === 0 && allReleased) {
      const settle = Math.min(1, (time - lastReleaseTime) / 4)
      for (const { body } of bodies) {
        body.setLinearDamping(0.2 + settle * 1.4)
        body.setAngularDamping(0.65 + settle * 2.5)
      }
    }
    for (const { body } of bodies) keepSpeed(body)
    world.step()

    let activity = 0
    let quietCount = 0
    let roomCount = 0
    if (allReleased) {
      for (const { body } of bodies) {
        // Balloons that have flown above the roof cannot delay interaction in the room.
        if (body.translation().y > ceilingTop + settings.balloonSize * 4) continue
        const linear = body.linvel()
        const angular = body.angvel()
        const speed = Math.hypot(linear.x, linear.y, linear.z)
          + Math.hypot(angular.x, angular.y, angular.z) * settings.balloonSize * 0.15
        activity += speed
        roomCount += 1
        if (body.isSleeping() || speed < settings.balloonSize) quietCount += 1
      }
    }
    const lowActivity = allReleased && roomCount > 0
      && quietCount / roomCount >= 0.95
      && activity / roomCount < settings.balloonSize * 0.6
    settledFor = lowActivity ? settledFor + STEP : 0
    const finished = settledFor >= LOW_ACTIVITY_SECONDS
    if (tick % CAPTURE_EVERY === 0 || finished || tick === maxSteps) {
      frames.push(capture(bodies, time))
    }
    if (finished) break
  }

  world.free()
  return { balloons, frames }
}

if (typeof self !== 'undefined') self.onmessage = async ({ data }) => {
  if (data.type !== 'simulate') return
  try {
    const { balloons, frames } = await simulate(data)
    self.postMessage({ type: 'complete', balloons, frames }, frames.map(({ poses }) => poses.buffer))
  } catch (error) {
    self.postMessage({ type: 'error', message: error instanceof Error ? error.message : String(error) })
  }
}
