import * as THREE from 'three';

// Water-mist jet from the robot's suppression turret: one muzzle speed shared by the turret's aim (the
// launch elevation) and the particle stream, so the jet lands where the turret points.

export const SPRAY_SPEED = 13; // m/s at the nozzle
export const GRAVITY = 9.81;

/** Low launch angle (rad) that carries a jet from `from` to `to` at SPRAY_SPEED; 0.6 rad if out of reach. */
export function launchElevation(from: THREE.Vector3, to: THREE.Vector3, speed = SPRAY_SPEED) {
  const R = Math.hypot(to.x - from.x, to.z - from.z);
  if (R < 0.5) return 0;
  const dy = to.y - from.y;
  const v2 = speed * speed;
  const disc = v2 * v2 - GRAVITY * (GRAVITY * R * R + 2 * dy * v2);
  if (disc < 0) return 0.6;
  return Math.atan((v2 - Math.sqrt(disc)) / (GRAVITY * R));
}
