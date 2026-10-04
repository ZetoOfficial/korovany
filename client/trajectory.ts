import { rules, stepSeconds, world, type Vec3 } from "./protocol.ts";

type Obstacle = Pick<
  (typeof world.obstacles)[number],
  "x" | "z" | "w" | "d" | "height"
>;
type Bounds = { low: Vec3; high: Vec3 };
const axes = ["x", "y", "z"] as const;
const boundsOf = (obstacle: Obstacle): Bounds => ({
  low: { x: obstacle.x - obstacle.w / 2, y: 0, z: obstacle.z - obstacle.d / 2 },
  high: {
    x: obstacle.x + obstacle.w / 2,
    y: obstacle.height,
    z: obstacle.z + obstacle.d / 2,
  },
});
const arenaBounds = world.obstacles.map(boundsOf);

function rayBox(origin: Vec3, direction: Vec3, box: Bounds, limit: number) {
  let near = 0,
    far = limit;
  let normal: Vec3 | undefined;
  for (const axis of axes) {
    if (Math.abs(direction[axis]) < 1e-9) {
      if (origin[axis] < box.low[axis] || origin[axis] > box.high[axis])
        return null;
      continue;
    }
    const a = (box.low[axis] - origin[axis]) / direction[axis];
    const b = (box.high[axis] - origin[axis]) / direction[axis];
    if (Math.min(a, b) > near) {
      normal = { x: 0, y: 0, z: 0 };
      normal[axis] = direction[axis] > 0 ? -1 : 1;
    }
    near = Math.max(near, Math.min(a, b));
    far = Math.min(far, Math.max(a, b));
    if (near > far) return null;
  }
  return { distance: near, normal };
}

// Mirror Go's fixed-step flight, swept wall intersections and travelled-range
// limit. Players are deliberately omitted: they can move before the impact.
export function traceBowTrajectory(
  origin: Vec3,
  yaw: number,
  pitch: number,
  drawTicks: number,
  obstacles?: readonly Obstacle[],
): { points: Vec3[]; end: "ground" | "wall" | "range"; normal?: Vec3 } {
  const charge = Math.max(0, Math.min(1, drawTicks / rules.bowDrawTicks));
  const speed =
    rules.bowMinSpeed + (rules.bowSpeed - rules.bowMinSpeed) * charge;
  const velocity = {
    x: -Math.sin(yaw) * Math.cos(pitch) * speed,
    y: Math.sin(pitch) * speed,
    z: -Math.cos(yaw) * Math.cos(pitch) * speed,
  };
  const bounds = obstacles ? obstacles.map(boundsOf) : arenaBounds;
  const points = [{ ...origin }];
  let remaining = rules.bowRange;
  for (;;) {
    const start = points[points.length - 1];
    const delta = {
      x: velocity.x * stepSeconds,
      y: velocity.y * stepSeconds - (rules.bowGravity * stepSeconds ** 2) / 2,
      z: velocity.z * stepSeconds,
    };
    const length = Math.hypot(delta.x, delta.y, delta.z);
    const direction = {
      x: delta.x / length,
      y: delta.y / length,
      z: delta.z / length,
    };
    let nearest = Math.min(length, remaining);
    let end: "ground" | "wall" | "range" | undefined =
      remaining <= length ? "range" : undefined;
    let normal: Vec3 | undefined;
    if (direction.y < 0 && start.y + direction.y * nearest <= 0) {
      nearest = -start.y / direction.y;
      end = "ground";
      normal = { x: 0, y: 1, z: 0 };
    }
    for (const box of bounds) {
      const hit = rayBox(start, direction, box, nearest);
      if (hit !== null) {
        nearest = hit.distance;
        end = "wall";
        normal = hit.normal;
      }
    }
    points.push({
      x: start.x + direction.x * nearest,
      y: start.y + direction.y * nearest,
      z: start.z + direction.z * nearest,
    });
    if (end) return { points, end, normal };
    velocity.y -= rules.bowGravity * stepSeconds;
    remaining -= nearest;
  }
}
